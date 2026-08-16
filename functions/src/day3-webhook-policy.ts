// ============================================================================
// DAY3 WEBHOOK POLICY (pure logic — no Firestore, no I/O)
//
// Signature verification and event interpretation, split out from the endpoint
// so both are unit-testable without a request. Mirrors how
// email-suppression-policy.ts sits behind email-suppression.ts.
// ============================================================================

import { createHmac, timingSafeEqual } from "crypto";
import type { BounceKind } from "./email-suppression-policy";

// ----------------------------------------------------------------------------
// Wire format
// ----------------------------------------------------------------------------

export const DAY3_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "suppression.created",
] as const;

export type Day3EventType = (typeof DAY3_EVENT_TYPES)[number];

export type Day3SuppressionReason =
  | "hard_bounce"
  | "complaint"
  | "unsubscribe"
  | "manual"
  | "provider_suppressed";

/** Transactional send. `email` is the address THIS event is about. */
export interface Day3EmailObject {
  object: "email";
  email_id?: string;
  to?: string[];
  email?: string;
  subject?: string;
  provider_message_id?: string;
  bounce_type?: string;
  bounce_subtype?: string;
}

export interface Day3SuppressionObject {
  object: "suppression";
  email?: string;
  reason?: string;
  source?: string;
}

/**
 * Newsletter sends. We don't send campaigns through this path yet — the shape
 * is modelled only so a campaign event parses and no-ops instead of throwing.
 */
export interface Day3CampaignRecipientObject {
  object: "campaign_recipient";
  campaign_id?: string;
  recipient_id?: string;
  contact_id?: string;
  email?: string;
}

export type Day3EventData =
  | Day3EmailObject
  | Day3SuppressionObject
  | Day3CampaignRecipientObject
  | { object?: string; [key: string]: unknown };

export interface Day3WebhookEvent {
  id: string;
  type: string;
  created_at: string;
  data: Day3EventData;
}

// ----------------------------------------------------------------------------
// Signature verification
// ----------------------------------------------------------------------------

/** Replay bound. `t` is inside the signed string, so it can't be moved alone. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export type SignatureFailure =
  | "missing_header"
  | "malformed_header"
  | "timestamp_out_of_tolerance"
  | "no_match";

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: SignatureFailure };

interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

/**
 * Parse `t=<unix seconds>,v1=<hex>[,v1=<hex>]`. More than one `v1` appears
 * during a secret rotation, when Day3 signs with both the old and new secret.
 */
export function parseDay3Signature(header: string | undefined): ParsedSignature | null {
  if (!header || typeof header !== "string") return null;

  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!value) continue;

    if (key === "t") {
      // Seconds, not milliseconds. A non-numeric t is malformed, not "0".
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Constant-time hex compare that tolerates length and encoding mismatches. */
const hexEquals = (a: string, b: string): boolean => {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
};

/**
 * Verify `Day3-Signature` against the RAW request body.
 *
 * The signed string is `` `${t}.${rawBody}` ``, so the bytes must be exactly
 * what Day3 sent — parsing and re-serializing the JSON changes key order and
 * whitespace and fails every signature. Callers must pass `req.rawBody`.
 */
export function verifyDay3Signature(input: {
  header: string | undefined;
  rawBody: string;
  secret: string;
  nowMs: number;
  toleranceMs?: number;
}): SignatureResult {
  if (!input.header) return { ok: false, reason: "missing_header" };

  const parsed = parseDay3Signature(input.header);
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const tolerance = input.toleranceMs ?? SIGNATURE_TOLERANCE_MS;
  const skewMs = Math.abs(input.nowMs - parsed.timestamp * 1000);
  if (skewMs > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const expected = createHmac("sha256", input.secret)
    .update(`${parsed.timestamp}.${input.rawBody}`)
    .digest("hex");

  // Compare against every v1 element — during a rotation only one will match.
  for (const candidate of parsed.signatures) {
    if (hexEquals(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "no_match" };
}

// ----------------------------------------------------------------------------
// Event interpretation
// ----------------------------------------------------------------------------

/**
 * What the receiver should do with an event. Exactly one event type writes to
 * `emailSuppressions` — see `suppressionFromEvent` for why.
 */
export type Day3EventAction =
  | { kind: "suppress"; email: string; bounceKind: BounceKind; reason: string }
  | { kind: "informational"; email: string | null; note: string }
  | { kind: "ignore"; note: string };

/** Only these mean the address is actually dead. */
const PERMANENT_BOUNCE_TYPES = new Set(["permanent", "undetermined"]);

export const isPermanentBounceType = (bounceType: string | undefined): boolean =>
  PERMANENT_BOUNCE_TYPES.has(String(bounceType ?? "").toLowerCase());

/**
 * Map a Day3 suppression reason onto our bounce vocabulary.
 *
 * `unsubscribe` and `manual` are deliberately `permanent`: both are a standing
 * decision that this address should stop receiving mail, and our policy only
 * clears `permanent` when a human clears it on the Emails page. Treating them
 * as transient would silently resume sending after the backoff expired.
 */
export function bounceKindForSuppressionReason(reason: string | undefined): BounceKind {
  switch (String(reason ?? "").toLowerCase()) {
    case "complaint":
      return "complaint";
    case "hard_bounce":
    case "provider_suppressed":
    case "unsubscribe":
    case "manual":
      return "permanent";
    default:
      // An unrecognised reason still means Day3 stopped delivering to it.
      // Suppress rather than guess it was harmless.
      return "permanent";
  }
}

const readEmail = (data: Day3EventData): string | null => {
  const record = data as Record<string, unknown>;
  if (typeof record.email === "string" && record.email.trim()) return record.email.trim();
  // Transactional sends carry `to` as an array; `email` is the per-event
  // address and is preferred, but fall back to a single-recipient `to`.
  const to = record.to;
  if (Array.isArray(to) && to.length === 1 && typeof to[0] === "string" && to[0].trim()) {
    return to[0].trim();
  }
  return null;
};

/**
 * Decide what one event means.
 *
 * **`suppression.created` is the only writer.** Day3 emits a matching
 * suppression alongside every permanent bounce and complaint, so treating
 * bounces as informational keeps a single writer into `emailSuppressions` and
 * makes the handler order-independent: it does not matter whether `bounced`
 * or `suppression.created` lands first, and a duplicate of either cannot
 * double-count. That is what the "do not assume ordering" requirement needs.
 */
export function classifyDay3Event(event: Day3WebhookEvent): Day3EventAction {
  const objectType = (event.data as { object?: string })?.object;
  const email = readEmail(event.data ?? {});

  if (objectType === "campaign_recipient") {
    // Newsletter path — parsed so it can't crash us, but no logic hangs off it.
    return { kind: "ignore", note: "campaign_recipient events are not handled yet" };
  }

  switch (event.type) {
    case "suppression.created": {
      if (!email) return { kind: "ignore", note: "suppression without an email" };
      const rawReason = (event.data as Day3SuppressionObject)?.reason;
      return {
        kind: "suppress",
        email,
        bounceKind: bounceKindForSuppressionReason(rawReason),
        reason: `Day3 suppression: ${rawReason ?? "unspecified"}`,
      };
    }

    case "email.bounced": {
      const bounceType = (event.data as Day3EmailObject)?.bounce_type;
      // Transient is a soft bounce — a full mailbox or greylisting. Recording
      // it as a suppression would block a mailbox that is going to recover.
      return {
        kind: "informational",
        email,
        note: isPermanentBounceType(bounceType)
          ? `permanent bounce (${bounceType}) — suppression.created will carry the write`
          : `transient bounce (${bounceType ?? "unspecified"}) — not suppressed`,
      };
    }

    case "email.complained":
      return {
        kind: "informational",
        email,
        note: "complaint — suppression.created will carry the write",
      };

    case "email.sent":
    case "email.delivered":
    case "email.failed":
      // We keep no per-message state today. Logging beats inventing a table.
      return { kind: "informational", email, note: event.type };

    default:
      return { kind: "ignore", note: `unhandled event type: ${event.type}` };
  }
}
