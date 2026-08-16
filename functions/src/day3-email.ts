// ============================================================================
// DAY3 TRANSACTIONAL SEND ADAPTER (POST /emails)
//
// One message, one recipient — matching how every send site in this codebase
// already works (they loop and send per address so a single bad recipient
// can't take down the batch, and so per-recipient formatting is possible).
//
// Like day3-client.ts this module has no Firebase-function dependency, because
// alert-email.ts reaches it from inside the VPS runner.
// ============================================================================

import { randomUUID } from "crypto";
import { day3Request, type Day3RetryProfile } from "./day3-client";

/**
 * Retry timings for a transactional send. The client's defaults were tuned for
 * the contact backfill, where a request runs ~10s and holds its idempotency
 * lock that long; waiting 3-30s on a conflict is correct there. A send settles
 * in well under a second, and it can sit in the alert path on the VPS runner —
 * where a slow send delays every other check behind it — so both the attempt
 * count and the waits come down hard. Worst case here is ~2.3s, versus ~60s on
 * the default profile.
 */
const SEND_RETRY_PROFILE: Day3RetryProfile = {
  maxAttempts: 3,
  transientBaseMs: { read: 300, write: 400 },
  conflictBackoffMs: [500, 1_500],
  maxRetryAfterS: 5,
};

/**
 * Day3 error codes worth naming. Everything else is passed through as-is —
 * `day3Request` never throws, so callers always get a code to branch on.
 */
export const DAY3_DOMAIN_NOT_VERIFIED = "domain_not_verified";
export const DAY3_EMAIL_SUPPRESSED = "email_suppressed";

export interface Day3SendInput {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  /**
   * Set by the caller so a retry replays instead of sending twice. Generated
   * per send when omitted — a fresh UUID is correct for a one-shot message,
   * since only the in-request retry loop needs the key to be stable.
   */
  idempotencyKey?: string;
}

export interface Day3SendResult {
  ok: boolean;
  id: string | null;
  status: number;
  error: { code: string; message: string } | null;
}

interface Day3EmailResponse {
  id?: string;
  data?: { id?: string };
}

/**
 * Send one transactional email through Day3.
 *
 * `to` is sent as a single-element array: the documented shape is a list, and
 * passing a bare string risks the silent-drop behaviour Day3 applies to
 * unexpected field types elsewhere in the API.
 */
export async function sendDay3Email(
  apiKey: string,
  input: Day3SendInput,
): Promise<Day3SendResult> {
  const body: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
  };
  if (input.html) body.html = input.html;
  if (input.text) body.text = input.text;
  // Snake case to match the rest of the v1 surface (`first_name`,
  // `unsubscribed_at`, `default_subscribed`). Day3 drops unknown top-level
  // fields silently rather than rejecting them, so if this name is wrong the
  // symptom is a missing Reply-To header, not an error — worth an eyeball on
  // the first live feedback email.
  if (input.replyTo) body.reply_to = input.replyTo;

  const result = await day3Request<Day3EmailResponse>(apiKey, "/emails", {
    method: "POST",
    body,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    retry: SEND_RETRY_PROFILE,
  });

  if (!result.ok) {
    return {
      ok: false,
      id: null,
      status: result.status,
      error: result.error
        ? { code: result.error.code, message: result.error.message }
        : { code: "unknown_error", message: "Day3 send failed" },
    };
  }

  return {
    ok: true,
    id: result.data?.id ?? result.data?.data?.id ?? null,
    status: result.status,
    error: null,
  };
}
