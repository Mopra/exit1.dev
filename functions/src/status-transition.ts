/**
 * Pure heartbeat-vs-transition classifier for the status buffer.
 *
 * Extracted from status-buffer.ts (same pattern as ssl-alert-state.ts) so the
 * classification rules can be unit-tested in isolation: status-buffer.ts
 * imports ./init, which initializes firebase-admin at module load, so it can't
 * be imported by a plain unit test.
 *
 * When heartbeat-defer is enabled, only updates classified as TRANSITIONS take
 * the immediate (~1.5s) write path; everything else parks in the deferred
 * buffer for up to HEARTBEAT_DEFER_FLUSH_INTERVAL_MS (60 min default, set in
 * vps/src/runner.ts). That makes the field list below load-bearing for
 * alerting correctness: any field a downstream alert decision reads back from
 * Firestore must classify as a transition when it changes, or another writer
 * can act on the stale value for up to an hour.
 *
 * INVARIANT (enforced at the materialHashOf site in status-buffer.ts): every
 * field consulted by isTransition MUST also be part of materialHashOf. A
 * transition-classified update whose deciding field weren't material would be
 * routed to the immediate flush path and then steady-skipped there (unchanged
 * material hash + fresh writtenAt), silently dropping a write the classifier
 * promised was immediate.
 */

/** The subset of StatusUpdateData the classifier consults and snapshots. */
export interface TransitionFields {
  status?: string;
  detailedStatus?: string;
  disabled?: boolean;
  maintenanceMode?: boolean | null;
  lastError?: string | null;
  consecutiveFailures?: number;
  sslAlertedState?: 'ok' | 'warning' | 'error';
}

/** Per-check snapshot of the transition fields as last written to Firestore. */
export type LastWrittenState = TransitionFields;

/**
 * Decide whether an incoming update is a state transition (must write
 * immediately) or a heartbeat (eligible for deferral). An absent previous
 * snapshot always classifies as a transition so the baseline gets seeded
 * before any heartbeat can be deferred.
 *
 * `consecutiveFailures` crosses zero is the only count-based transition
 * trigger: going from 0->1 (started failing) or N->0 (recovered) flips
 * downstream alerting, so it can't wait for the deferred flush.
 */
export function isTransition(prev: LastWrittenState | undefined, data: TransitionFields): boolean {
  if (!prev) return true;

  if (data.status !== undefined && data.status !== prev.status) return true;
  if (data.detailedStatus !== undefined && data.detailedStatus !== prev.detailedStatus) return true;
  if (data.disabled !== undefined && data.disabled !== prev.disabled) return true;
  if (data.maintenanceMode !== undefined && data.maintenanceMode !== prev.maintenanceMode) return true;

  // lastError: null vs string vs different string all count as transitions.
  // Normalize undefined to null for the comparison so a missing field
  // doesn't show up as a transition every cycle.
  if ('lastError' in data) {
    const prevErr = prev.lastError ?? null;
    const newErr = data.lastError ?? null;
    if (prevErr !== newErr) return true;
  }

  if (data.consecutiveFailures !== undefined) {
    const prevCount = prev.consecutiveFailures ?? 0;
    const newCount = data.consecutiveFailures;
    if ((prevCount === 0) !== (newCount === 0)) return true;
  }

  // sslAlertedState advances gate SSL alerting ACROSS writers: the 6-hourly
  // security refresh decides ok->warning/error off the value it reads back
  // from Firestore. When this advance sat in the deferred buffer, the refresh
  // re-read the stale 'ok' and duplicated the ssl_warning the VPS had already
  // sent (kairandles, 2026-08-25: VPS alert 16:10 UTC, refresh re-alert
  // 17:06 UTC). A change here must take the immediate path.
  if (data.sslAlertedState !== undefined && data.sslAlertedState !== prev.sslAlertedState) return true;

  return false;
}

/**
 * Fold a just-written update into the previous snapshot. Fields absent from
 * the update keep their previous value (lastError distinguishes an explicit
 * null from an absent field, matching isTransition's comparison).
 */
export function mergeLastWritten(prev: LastWrittenState | undefined, data: TransitionFields): LastWrittenState {
  const base = prev ?? {};
  return {
    status: data.status ?? base.status,
    detailedStatus: data.detailedStatus ?? base.detailedStatus,
    disabled: data.disabled ?? base.disabled,
    maintenanceMode: data.maintenanceMode ?? base.maintenanceMode,
    lastError: 'lastError' in data ? data.lastError : base.lastError,
    consecutiveFailures: data.consecutiveFailures ?? base.consecutiveFailures,
    sslAlertedState: data.sslAlertedState ?? base.sslAlertedState,
  };
}
