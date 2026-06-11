/**
 * Pure helpers for the per-channel alert retry bookkeeping.
 *
 * Extracted from checks.ts so the (subtle, regression-prone) retry-flag logic
 * can be unit-tested in isolation — mirroring the ssl-alert-state.ts pattern.
 *
 * Background — the "no recovery SMS" bug: email and SMS each have their own
 * `minConsecutiveEvents` debounce. A recovery transition fires on the FIRST
 * online probe (consecutiveSuccesses=1). If email's threshold is 1 it sends
 * immediately, but if SMS's threshold is 2 the SMS is deferred ("flap") to a
 * retry on the next probe. The old code collapsed both channels into a single
 * `pendingUp/DownEmail` flag driven solely by the EMAIL outcome — so when email
 * succeeded it cleared the flag and the deferred SMS retry was lost forever.
 * Tracking the two channels separately fixes this.
 */

import type { AlertResult } from './alert';

export type AlertReason =
  | 'flap' | 'settings' | 'missingRecipient' | 'throttle'
  | 'none' | 'error' | 'maintenance_mode' | 'system_health_gate' | undefined;

/** Reasons that warrant a follow-up retry. `settings`/`missingRecipient`/
 *  `maintenance_mode`/`system_health_gate` are deliberate suppressions and are
 *  NOT retried. */
export const shouldRetryAlert = (reason?: AlertReason): boolean =>
  reason === 'flap' || reason === 'error' || reason === 'throttle';

/** The mutable subset of fields applyPendingRetryFlags writes. */
export interface PendingRetryFlags {
  pendingDownEmail?: boolean;
  pendingDownSince?: number | null;
  pendingUpEmail?: boolean;
  pendingUpSince?: number | null;
  pendingDownSms?: boolean;
  pendingUpSms?: boolean;
}

/** Apply pending email/SMS retry flags based on an alert result.
 *  Handles the case where webhooks succeeded but email/SMS need retry —
 *  sets pendingUp/DownEmail and pendingUp/DownSms so the next check cycle
 *  retries with skipWebhooks to avoid duplicate webhook delivery.
 *
 *  Email and SMS are tracked on SEPARATE flags because a single transition can
 *  satisfy one channel while still debouncing the other — e.g. a recovery where
 *  email minConsecutiveEvents=1 sends immediately but SMS minConsecutiveEvents=2
 *  must wait for a second consecutive success. Collapsing both into one flag
 *  silently dropped the still-pending channel's retry (the "no recovery SMS"
 *  bug). `result.reason` is email-centric, so it only feeds the email flag;
 *  smsNeedsRetry is the authoritative SMS signal. */
export function applyPendingRetryFlags(
  updateData: PendingRetryFlags & Record<string, unknown>,
  result: AlertResult,
  status: string,
  now: number,
  check: { pendingDownSince?: number | null; pendingUpSince?: number | null },
): void {
  // When delivered=true, triggerAlert returns no `reason`, so shouldRetryAlert
  // is false and this reduces to plain emailNeedsRetry — preserving the prior
  // "delivered && !emailNeedsRetry ⇒ clear" semantics while adding the SMS axis.
  const emailNeedsRetry = Boolean(result.emailNeedsRetry) || shouldRetryAlert(result.reason);
  const smsNeedsRetry = result.smsNeedsRetry === true;
  if (status === "offline") {
    if (emailNeedsRetry) {
      updateData.pendingDownEmail = true;
      if (!check.pendingDownSince) updateData.pendingDownSince = now;
    } else {
      updateData.pendingDownEmail = false;
      updateData.pendingDownSince = null;
    }
    updateData.pendingDownSms = smsNeedsRetry;
  } else if (status === "online") {
    if (emailNeedsRetry) {
      updateData.pendingUpEmail = true;
      if (!check.pendingUpSince) updateData.pendingUpSince = now;
    } else {
      updateData.pendingUpEmail = false;
      updateData.pendingUpSince = null;
    }
    updateData.pendingUpSms = smsNeedsRetry;
  }
}
