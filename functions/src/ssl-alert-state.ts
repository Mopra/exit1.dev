/**
 * Pure SSL alert state machine.
 *
 * Kept deliberately dependency-free (no Firebase / Resend / config imports) so
 * it can be unit-tested in isolation and reused by BOTH writers that observe a
 * certificate: the per-check probe path (processOneCheck) and the scheduled
 * refreshSecurityMetadata job.
 *
 * The whole point of this module is that SSL alerting is driven by a DURABLE
 * "last alerted state" rather than a transient previous-certificate snapshot.
 * That is what guarantees an ok->warning crossing is detected exactly once and
 * can never be silently swallowed by whichever writer advances the cert across
 * the threshold first.
 *
 * The warning band is split into reminder bands (30, 14, 7, 3 and 1 days), so
 * a cert nobody renews keeps producing ssl_warning alerts as it gets closer to
 * expiry instead of going quiet for 30 days after the first one (kairandles,
 * 2026-09-19: one warning at 30 days, then silence until the cert expired).
 * 'warning' is the 30-day band, which keeps every sslAlertedState already
 * persisted before the bands existed meaningful.
 */

export type SSLAlertState =
  | 'ok'
  | 'warning'
  | 'warning_14'
  | 'warning_7'
  | 'warning_3'
  | 'warning_1'
  | 'error';

/** Minimal certificate shape needed to classify alert state. */
export interface SSLCertLike {
  valid: boolean;
  daysUntilExpiry?: number;
}

// Certificates valid but within this many days of expiry are in the
// "warning" band. Must stay in sync with the ssl_warning semantics.
export const SSL_WARNING_THRESHOLD_DAYS = 30;

/** Reminder bands inside the warning window, nearest-to-expiry last. */
export const SSL_REMINDER_BANDS: ReadonlyArray<{ days: number; state: SSLAlertState }> = [
  { days: 30, state: 'warning' },
  { days: 14, state: 'warning_14' },
  { days: 7, state: 'warning_7' },
  { days: 3, state: 'warning_3' },
  { days: 1, state: 'warning_1' },
];

// Higher = more urgent. Drives "escalation alerts, de-escalation doesn't".
const URGENCY: Record<SSLAlertState, number> = {
  ok: 0,
  warning: 1,
  warning_14: 2,
  warning_7: 3,
  warning_3: 4,
  warning_1: 5,
  error: 6,
};

/** Coerce a persisted value (possibly from an older or newer build) to a known state. */
export function normalizeSSLAlertState(value: unknown): SSLAlertState {
  return typeof value === 'string' && value in URGENCY ? (value as SSLAlertState) : 'ok';
}

/**
 * Classify a certificate into an alert state.
 *   no cert          -> 'ok'      (nothing to alert on)
 *   invalid/expired  -> 'error'
 *   valid & <= 30d   -> the tightest reminder band it falls in
 *   otherwise        -> 'ok'
 */
export function getSSLAlertState(cert: SSLCertLike | null | undefined): SSLAlertState {
  if (!cert) return 'ok';
  if (!cert.valid) return 'error';
  const days = cert.daysUntilExpiry;
  if (days === undefined || days > SSL_WARNING_THRESHOLD_DAYS) return 'ok';
  let state: SSLAlertState = 'warning';
  for (const band of SSL_REMINDER_BANDS) {
    if (days <= band.days) state = band.state;
  }
  return state;
}

export type SSLAlertDecision =
  | { kind: 'noop' }                                            // no change since last notification
  | { kind: 'reset' }                                           // recovered to 'ok': persist, do not alert
  | { kind: 'rebase'; state: SSLAlertState }                    // less urgent band: persist, do not alert
  | { kind: 'alert'; eventType: 'ssl_warning' | 'ssl_error' };  // attempt to notify

/**
 * Decide what to do given the freshly computed cert state and the DURABLE
 * last-alerted state (what the user was last told about).
 *
 *   current === lastAlerted        -> noop
 *   current === 'ok'               -> reset (cert renewed/fixed; record it, no alert)
 *   current === 'error'            -> alert ssl_error
 *   lastAlerted === 'error'        -> alert ssl_warning (cert fixed but still expiring)
 *   current more urgent band       -> alert ssl_warning (a reminder)
 *   current less urgent band       -> rebase (renewed onto a short cert; the
 *                                     next band crossing alerts again)
 */
export function decideSSLAlertTransition(
  currentState: SSLAlertState,
  lastAlertedState: SSLAlertState,
): SSLAlertDecision {
  if (currentState === lastAlertedState) return { kind: 'noop' };
  if (currentState === 'ok') return { kind: 'reset' };
  if (currentState === 'error') return { kind: 'alert', eventType: 'ssl_error' };
  if (lastAlertedState === 'error' || URGENCY[currentState] > URGENCY[lastAlertedState]) {
    return { kind: 'alert', eventType: 'ssl_warning' };
  }
  return { kind: 'rebase', state: currentState };
}
