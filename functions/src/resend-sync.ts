// ============================================================================
// RESEND ADAPTER
//
// Resend-specific contact/topic/event plumbing. The provider-neutral half of
// this (property definitions, onboarding option sets, buildPropertiesForUser)
// lives in contact-model.ts and is shared with the Day3 adapter.
// ============================================================================

import * as logger from "firebase-functions/logger";
import { Resend } from "resend";
import { PROPERTY_DEFS, sleep } from "./contact-model";

// Topic IDs — Resend audience topics created manually in the Resend dashboard.
// All topics default to opt_in in Resend; we still explicitly opt new users in
// so preference-center tooling has concrete records to render.
export const RESEND_TOPICS = {
  reengagement: "96b517cd-a0ee-46c1-a024-bd71751f5d29",
  onboarding: "26b144fa-baf6-4251-9811-3abab0819aaa",
  promotions: "b4568a4b-8b6e-4979-adfb-39097cd3a72e",
  educational: "687a6891-521e-492f-b83b-77568ae471d5",
  product_updates: "750d26ea-1434-442e-b2c9-ba16feca9142",
} as const;

export const RESEND_TOPIC_IDS: string[] = Object.values(RESEND_TOPICS);

// Resend rate limit is 2 req/sec. Every API call that hits Resend should flow
// through this so we don't get 429s during backfills.
export const RESEND_RATE_LIMIT_MS = 600;

/**
 * Every address that has opted out in Resend, lowercased.
 *
 * Resend is the only system that holds this state: Day3 was seeded contacts-only
 * and opt-out status was never carried across, so every imported contact landed
 * as subscribed. The Day3 backfill joins against this set so that the day
 * marketing sending moves to Day3, the people who unsubscribed from Resend
 * aren't mailed again.
 *
 * Throws rather than returning a partial set. A half-read list reads as "these
 * people never opted out", which is precisely the failure this exists to
 * prevent — the caller must abort, not carry on with what it managed to get.
 */
export async function loadResendUnsubscribedEmails(
  apiKey: string,
): Promise<Set<string>> {
  const resend = new Resend(apiKey);
  const unsubscribed = new Set<string>();
  let after: string | undefined;
  let scanned = 0;

  for (;;) {
    const { data, error } = await resend.contacts.list({
      limit: 100,
      ...(after ? { after } : {}),
    });

    if (error || !data) {
      throw new Error(
        `Failed to list Resend contacts: ${error?.message || "unknown error"}`,
      );
    }

    for (const contact of data.data) {
      scanned++;
      if (contact.unsubscribed) {
        unsubscribed.add(contact.email.trim().toLowerCase());
      }
    }

    if (!data.has_more || data.data.length === 0) break;
    after = data.data[data.data.length - 1].id;
    await sleep(RESEND_RATE_LIMIT_MS);
  }

  logger.info("Loaded Resend opt-out state", {
    scanned,
    unsubscribed: unsubscribed.size,
  });
  return unsubscribed;
}

/**
 * Idempotently register every property in PROPERTY_DEFS. Resend returns an
 * "already exists" style error for duplicates which we swallow. Any other
 * failure is logged but does not abort — the caller still attempts the update
 * and gets a clean error if a property is genuinely missing.
 */
export async function registerResendSchema(apiKey: string): Promise<{
  created: string[];
  existed: string[];
  failed: Array<{ key: string; error: string }>;
}> {
  const resend = new Resend(apiKey);
  const created: string[] = [];
  const existed: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const def of PROPERTY_DEFS) {
    try {
      const createOpts =
        def.type === "string"
          ? {
              key: def.key,
              type: "string" as const,
              fallbackValue:
                typeof def.fallbackValue === "string"
                  ? def.fallbackValue
                  : null,
            }
          : {
              key: def.key,
              type: "number" as const,
              fallbackValue:
                typeof def.fallbackValue === "number"
                  ? def.fallbackValue
                  : null,
            };

      const { error } = await resend.contactProperties.create(createOpts);

      if (error) {
        const msg = error.message || "";
        if (/already exists|duplicate|unique/i.test(msg)) {
          existed.push(def.key);
        } else {
          failed.push({ key: def.key, error: msg });
          logger.warn("Failed to register Resend property", {
            key: def.key,
            error: msg,
          });
        }
      } else {
        created.push(def.key);
        logger.info("Registered Resend property", { key: def.key });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ key: def.key, error: message });
      logger.warn("Exception registering Resend property", {
        key: def.key,
        error: message,
      });
    }

    await sleep(RESEND_RATE_LIMIT_MS);
  }

  return { created, existed, failed };
}

/**
 * Update a contact's custom properties. If the contact doesn't exist yet,
 * create it with the properties attached — that's the shape we want for the
 * subscription webhook where the user may not yet be in Resend (e.g. legacy
 * signups that pre-date the clerk webhook).
 */
export async function upsertContactProperties(
  resend: Resend,
  email: string,
  properties: Record<string, string>,
  fallback: {
    firstName?: string | null;
    lastName?: string | null;
  } = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await resend.contacts.update({
      email,
      properties,
    });

    if (!error) return { success: true };

    const msg = error.message || "";
    const isMissing = /not found|does not exist/i.test(msg);

    if (!isMissing) {
      return { success: false, error: msg };
    }

    // Contact missing — create with properties attached.
    const { error: createError } = await resend.contacts.create({
      email,
      firstName: fallback.firstName || undefined,
      lastName: fallback.lastName || undefined,
      properties,
    });

    if (createError) {
      return { success: false, error: createError.message };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

interface SyncTopicsOptions {
  /**
   * When true, preserves any existing subscription state — only topics without
   * an explicit record are opted in. Use for bulk resyncs to avoid overwriting
   * manual opt-outs. Adds one extra API call per user.
   */
  preserveExisting?: boolean;
}

/**
 * Opt a contact in to every tracked topic. Resend topic defaults handle this
 * for new contacts automatically, but we still write explicit records so the
 * future preference center has data to render. When preserveExisting is set,
 * any topic with an existing opt_out is left untouched.
 */
export async function syncContactTopics(
  resend: Resend,
  email: string,
  options: SyncTopicsOptions = {},
): Promise<{ success: boolean; updated: number; error?: string }> {
  try {
    let targetIds = RESEND_TOPIC_IDS;

    if (options.preserveExisting) {
      const { data, error } = await resend.contacts.topics.list({
        email,
        limit: 100,
      });
      if (error) {
        const msg = error.message || "";
        // Contact not found — nothing to preserve, fall through with full opt-in.
        if (!/not found|does not exist/i.test(msg)) {
          return { success: false, updated: 0, error: msg };
        }
      } else {
        const recorded = new Set((data?.data ?? []).map((t) => t.id));
        targetIds = RESEND_TOPIC_IDS.filter((id) => !recorded.has(id));
      }
    }

    if (targetIds.length === 0) {
      return { success: true, updated: 0 };
    }

    const { error } = await resend.contacts.topics.update({
      email,
      topics: targetIds.map((id) => ({ id, subscription: "opt_in" as const })),
    });

    if (error) {
      return { success: false, updated: 0, error: error.message };
    }
    return { success: true, updated: targetIds.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, updated: 0, error: message };
  }
}

/**
 * Fire a custom event into Resend to trigger an automation. `eventName` must
 * match the event's Name in the Resend dashboard under Automations → Events
 * (e.g. "user.created"). The contact should already exist in Resend before
 * sending — automations that reference contact properties otherwise have
 * nothing to render.
 *
 * Called via REST because resend-node 6.x doesn't expose events on the SDK
 * surface yet (canary only). REST contract derived from the canary SDK
 * source (src/events/events.ts → POST /events/send with body
 * { event, email, payload }) — note this differs from the create-event
 * endpoint POST /events which takes { name } and would 409 on duplicates.
 */
export async function triggerResendEvent(
  apiKey: string,
  email: string,
  eventName: string,
  payload?: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/events/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        event: eventName,
        email,
        ...(payload ? { payload } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${body}` };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

