/**
 * Pure helpers for the per-channel alert retry bookkeeping.
 *
 * Extracted from checks.ts so the (subtle, regression-prone) retry-flag logic
 * can be unit-tested in isolation — mirroring the ssl-alert-state.ts pattern.
 *
 * Background — the "deferred alert dropped" bug: on a single transition one
 * channel can deliver while the other is deferred. SMS has its own per-user
 * budget/throttle and can also hit a transient send error, so a down/recovery
 * alert may go out on email/webhook immediately while the SMS is deferred to a
 * retry on the next probe. The old code collapsed both channels into a single
 * `pendingUp/DownEmail` flag driven solely by the EMAIL outcome — so when email
 * succeeded it cleared the flag and the deferred SMS retry was lost forever.
 * Tracking the two channels separately fixes this.
 *
 * (The per-channel minConsecutiveEvents debounce that originally produced this
 * deferral was removed; the per-check Down-confirmation gate now handles flap
 * suppression. The budget/throttle/send-error deferral shape remains.)
 */

import type { AlertResult } from './alert';

export type AlertReason =
  | 'flap' | 'settings' | 'missingRecipient' | 'throttle'
  | 'none' | 'error' | 'maintenance_mode' | 'system_health_gate'
  | 'check_disabled' | undefined;

/** Reasons that warrant a follow-up retry. `settings`/`missingRecipient`/
 *  `maintenance_mode`/`system_health_gate`/`check_disabled` are deliberate
 *  suppressions and are NOT retried. */
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
 *  satisfy one channel while the other is still deferred — e.g. a recovery where
 *  email sends immediately but SMS is blocked by its per-user budget/throttle
 *  (or a transient send error) and must retry on the next probe. Collapsing both
 *  into one flag silently dropped the still-pending channel's retry (the
 *  "deferred alert dropped" bug). `result.reason` is email-centric, so it only
 *  feeds the email flag; smsNeedsRetry is the authoritative SMS signal. */
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
