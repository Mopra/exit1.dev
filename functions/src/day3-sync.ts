// ============================================================================
// DAY3 CONTACT SYNC
//
// Contact-level operations against the Day3 audience. Mirrors resend-sync.ts,
// but the two differ in ways worth knowing:
//
//   - Segments are live filters, not membership lists. Writing plan_tier is
//     enough; there is no membership sync (cf. syncSegmentsToResend).
//   - Topics were created with default_subscribed: true, so new contacts are
//     opted in without a per-contact write.
//   - There is no events/automations API in v1, so automation events stay
//     Resend-only.
//   - created_at cannot be backdated. Real signup dates survive only in the
//     signup_date attribute.
// ============================================================================

import * as logger from "firebase-functions/logger";
import { day3Request, type Day3Error } from "./day3-client";
import { DAY3_AUDIENCE_ID, DAY3_BATCH_SIZE } from "./day3-config";

export interface Day3ContactInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Custom attributes. Every value must already be a string. */
  attributes: Record<string, string>;
  /**
   * True to opt this contact out. Only ever meaningful as `true` — see
   * buildDay3Payload for why the subscribed case must stay unwritten.
   */
  unsubscribed?: boolean;
}

export interface Day3Contact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  attributes: Record<string, string>;
  status: string;
}

const contactsPath = () => `/audiences/${DAY3_AUDIENCE_ID}/contacts`;

/**
 * Day3 canonicalizes emails (trim + lowercase) before anything else, so
 * `Ada@Acme.com` and `ada@acme.com` are the same contact. We normalize on our
 * side too, because two such rows in one batch payload count as a duplicate and
 * reject the *entire* request.
 */
export const normalizeDay3Email = (email: string): string =>
  email.trim().toLowerCase();

/**
 * Day3's `attributes` must be a flat map of string → string. A number or
 * boolean anywhere in a batch fails schema validation and rejects the whole
 * batch with 400 invalid_request — not just the offending row. buildPropertiesForUser
 * is typed to return strings, but this coerces defensively at the boundary so a
 * future caller passing a raw Firestore value can't take down an entire import.
 */
export function assertStringAttributes(
  attributes: Record<string, unknown>,
  context: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value;
      continue;
    }
    logger.warn("Coerced non-string Day3 attribute value", {
      context, key, type: typeof value,
    });
    out[key] = String(value);
  }
  return out;
}

/**
 * Reserved top-level columns. Putting these in `attributes` is silently ignored
 * by Day3, so we strip them out and surface a warning rather than losing data
 * quietly.
 */
const RESERVED_ATTRIBUTE_KEYS = new Set(["email", "first_name", "last_name"]);

export const buildDay3Payload = (input: Day3ContactInput, context: string) => {
  const attributes = assertStringAttributes(input.attributes, context);

  for (const key of RESERVED_ATTRIBUTE_KEYS) {
    if (key in attributes) {
      logger.warn("Dropped reserved key from Day3 attributes", { context, key });
      delete attributes[key];
    }
  }

  return {
    email: normalizeDay3Email(input.email),
    ...(input.firstName ? { first_name: input.firstName } : {}),
    ...(input.lastName ? { last_name: input.lastName } : {}),
    // Write the opt-out, never the opt-in. Omitting `status` leaves Day3's
    // stored value untouched (verified live), so a re-run can't resurrect
    // someone who unsubscribed in Day3 since the last import — whereas an
    // explicit status:"subscribed" would do exactly that, silently, to every
    // opted-out contact on every run.
    //
    // It must be `status` and not `unsubscribed_at`: /contacts/batch silently
    // drops unsubscribed_at (200, updated:1, contact still subscribed — the
    // §3 gotcha-4 failure mode), while `status` is honoured and Day3 stamps
    // unsubscribed_at itself. Verified against the live API 2026-08-14.
    ...(input.unsubscribed ? { status: "unsubscribed" } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };
};

/**
 * Create-or-update one contact. `attributes` is a shallow merge on Day3's side:
 * absent keys survive, so omitting a property we couldn't derive preserves
 * whatever is already there rather than blanking it.
 */
export async function upsertDay3Contact(
  apiKey: string,
  input: Day3ContactInput,
): Promise<{ success: boolean; error?: string; code?: string }> {
  const result = await day3Request<Day3Contact>(apiKey, contactsPath(), {
    method: "POST",
    query: { upsert: true },
    body: buildDay3Payload(input, "upsertDay3Contact"),
  });

  if (result.ok) return { success: true };

  // A suppressed address is a correct refusal, not a failure to retry: the
  // account-wide suppression list beats everything.
  if (result.error?.code === "email_suppressed") {
    logger.info("Day3 contact not created — address is suppressed", {
      email: normalizeDay3Email(input.email),
    });
    return { success: false, error: "email_suppressed", code: "email_suppressed" };
  }

  return {
    success: false,
    error: result.error?.message || `HTTP ${result.status}`,
    code: result.error?.code,
  };
}

/**
 * Erase a contact (GDPR delete). Note this genuinely erases the record — to
 * stop mailing someone while keeping it, PATCH status to "unsubscribed"
 * instead.
 */
export async function deleteDay3Contact(
  apiKey: string,
  email: string,
): Promise<{ success: boolean; error?: string }> {
  const encoded = encodeURIComponent(normalizeDay3Email(email));
  const result = await day3Request(apiKey, `${contactsPath()}/${encoded}`, {
    method: "DELETE",
  });

  // Already gone is success as far as the caller is concerned.
  if (result.ok || result.error?.code === "not_found") return { success: true };

  return { success: false, error: result.error?.message || `HTTP ${result.status}` };
}

export interface Day3BatchRowFailure {
  index: number;
  email: string;
  code: string;
  message: string;
}

export interface Day3BatchOutcome {
  ok: boolean;
  created: number;
  updated: number;
  failed: number;
  rowFailures: Day3BatchRowFailure[];
  /** Set when the whole request was rejected rather than individual rows. */
  requestError: Day3Error | null;
}

interface Day3BatchResponse {
  object: string;
  summary: { created: number; updated: number; failed: number };
  results: Array<{
    index: number;
    status: string;
    id?: string;
    error?: { code?: string; message?: string };
  }>;
}

/**
 * De-duplicate case-insensitively, last write wins. Two rows whose emails
 * differ only in case are a duplicate to Day3 and reject the whole payload, so
 * this must run before every batch call.
 */
export function dedupeByEmail(inputs: Day3ContactInput[]): Day3ContactInput[] {
  const byEmail = new Map<string, Day3ContactInput>();
  for (const input of inputs) {
    byEmail.set(normalizeDay3Email(input.email), input);
  }
  return [...byEmail.values()];
}

export function chunkForDay3<T>(items: T[], size = DAY3_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Bulk create-or-update, up to DAY3_BATCH_SIZE contacts in one request. This is
 * the only sane way to import — never loop single creates.
 *
 * A 200 does NOT mean everything worked: individual rows can fail while the
 * call succeeds, so the caller must inspect rowFailures. The whole request is
 * rejected only for caller bugs (>1,000 items, duplicate emails in one payload,
 * unknown topic id) or a plan limit.
 */
export async function batchUpsertDay3Contacts(
  apiKey: string,
  inputs: Day3ContactInput[],
  idempotencyKey: string,
): Promise<Day3BatchOutcome> {
  const empty: Day3BatchOutcome = {
    ok: true, created: 0, updated: 0, failed: 0, rowFailures: [], requestError: null,
  };
  if (inputs.length === 0) return empty;

  if (inputs.length > DAY3_BATCH_SIZE) {
    return {
      ...empty,
      ok: false,
      requestError: {
        code: "batch_too_large",
        message: `${inputs.length} items exceeds the ${DAY3_BATCH_SIZE} limit`,
      },
    };
  }

  const payload = inputs.map((input) => buildDay3Payload(input, "batchUpsertDay3Contacts"));

  // upsert belongs in the BODY here, not the query string. `?upsert=true` is
  // silently ignored on this endpoint and every existing contact then comes
  // back as a contact_already_exists row failure — verified against the live
  // API. (The single-contact POST is the opposite: there it's a query param.)
  const result = await day3Request<Day3BatchResponse>(
    apiKey,
    `${contactsPath()}/batch`,
    {
      method: "POST",
      body: { upsert: true, contacts: payload },
      idempotencyKey,
    },
  );

  if (!result.ok || !result.data) {
    return { ...empty, ok: false, requestError: result.error };
  }

  const { summary, results } = result.data;
  const rowFailures: Day3BatchRowFailure[] = (results ?? [])
    .filter((row) => row.status === "failed")
    .map((row) => ({
      index: row.index,
      email: payload[row.index]?.email ?? "(unknown)",
      code: row.error?.code || "unknown",
      message: row.error?.message || "",
    }));

  return {
    ok: true,
    created: summary?.created ?? 0,
    updated: summary?.updated ?? 0,
    failed: summary?.failed ?? rowFailures.length,
    rowFailures,
    requestError: null,
  };
}

/** Total contacts currently in the audience — used for parity verification. */
export async function getDay3ContactCount(
  apiKey: string,
): Promise<{ ok: boolean; total: number | null; error?: string }> {
  const result = await day3Request<{ contact_counts?: { total?: number } }>(
    apiKey,
    `/audiences/${DAY3_AUDIENCE_ID}`,
  );
  if (!result.ok) {
    return { ok: false, total: null, error: result.error?.message };
  }
  return { ok: true, total: result.data?.contact_counts?.total ?? null };
}

/** Fetch one contact by email, for spot-checking a migration. */
export async function getDay3Contact(
  apiKey: string,
  email: string,
): Promise<{ ok: boolean; contact: Day3Contact | null; error?: string }> {
  const encoded = encodeURIComponent(normalizeDay3Email(email));
  const result = await day3Request<Day3Contact>(apiKey, `${contactsPath()}/${encoded}`);
  if (!result.ok) {
    return { ok: false, contact: null, error: result.error?.code };
  }
  return { ok: true, contact: result.data };
}
