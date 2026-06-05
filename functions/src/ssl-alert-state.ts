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
 */

export type SSLAlertState = 'ok' | 'warning' | 'error';

/** Minimal certificate shape needed to classify alert state. */
export interface SSLCertLike {
  valid: boolean;
  daysUntilExpiry?: number;
}

// Certificates valid but within this many days of expiry are in the
// "warning" band. Must stay in sync with the ssl_warning semantics.
export const SSL_WARNING_THRESHOLD_DAYS = 30;

/**
 * Classify a certificate into an alert state.
 *   no cert          -> 'ok'      (nothing to alert on)
 *   invalid/expired  -> 'error'
 *   valid & <= 30d   -> 'warning'
 *   otherwise        -> 'ok'
 */
export function getSSLAlertState(cert: SSLCertLike | null | undefined): SSLAlertState {
  if (!cert) return 'ok';
  if (!cert.valid) return 'error';
  if (cert.daysUntilExpiry !== undefined && cert.daysUntilExpiry <= SSL_WARNING_THRESHOLD_DAYS) {
    return 'warning';
  }
  return 'ok';
}

export type SSLAlertDecision =
  | { kind: 'noop' }                                            // no change since last notification
  | { kind: 'reset' }                                           // recovered to 'ok' — persist, do not alert
  | { kind: 'alert'; eventType: 'ssl_warning' | 'ssl_error' };  // attempt to notify

/**
 * Decide what to do given the freshly computed cert state and the DURABLE
 * last-alerted state (what the user was last told about).
 *
 *   current === lastAlerted  -> noop
 *   current === 'ok'         -> reset (cert renewed/fixed; record it, no alert)
 *   current === 'warning'    -> alert ssl_warning
 *   current === 'error'      -> alert ssl_error
 */
export function decideSSLAlertTransition(
  currentState: SSLAlertState,
  lastAlertedState: SSLAlertState,
): SSLAlertDecision {
  if (currentState === lastAlertedState) return { kind: 'noop' };
  if (currentState === 'ok') return { kind: 'reset' };
  return { kind: 'alert', eventType: currentState === 'error' ? 'ssl_error' : 'ssl_warning' };
}
