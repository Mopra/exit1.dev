import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

// Type definition for status updates
export interface StatusUpdateData {
  status?: string;
  lastChecked: number;
  lastHistoryAt?: number;
  responseTime?: number | null;
  lastStatusCode?: number;
  statusCode?: number; // Legacy alias for lastStatusCode
  lastError?: string | null;
  // Single owning region for where this check executes
  checkRegion?: "us-central1" | "europe-west1" | "asia-southeast1" | "vps-eu-1" | "vps-us-1";
  // Best-effort target geo metadata (persisted on the check doc for UI views like /checks Map)
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  targetMetadataLastChecked?: number;
  downtimeCount?: number;
  lastDowntime?: number;
  lastFailureTime?: number | null;
  consecutiveFailures?: number;
  consecutiveSuccesses?: number; // Added missing field
  detailedStatus?: string;
  // Phase timings (HTTP probes only). Persisted to Firestore on every
  // probe and surfaced to the VPS in-memory schedule via the status hook
  // so the live-chart stack can render DNS / Connect / TLS / TTFB
  // breakdown per probe.
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  redirectLocation?: string | null;
  nextCheckAt?: number;
  sslCertificate?: {
    valid: boolean;
    lastChecked?: number;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  // Durable last-alerted SSL state (see Website.sslAlertedState). Persisted on
  // transitions so the per-check probe and scheduled refresh agree on what the
  // user has already been told about, and the VPS in-memory schedule stays in
  // sync via the status hook.
  sslAlertedState?: 'ok' | 'warning' | 'error';
  disabled?: boolean;
  disabledAt?: number;
  disabledReason?: string;
  maintenanceMode?: boolean | null;
  maintenanceStartedAt?: number | null;
  maintenanceExpiresAt?: number | null;
  maintenanceDuration?: number | null;
  maintenanceReason?: string | null;
  maintenanceScheduledStart?: number | null;
  maintenanceScheduledDuration?: number | null;
  maintenanceScheduledReason?: string | null;
  maintenanceRecurringActiveUntil?: number | null;
  updatedAt: number;
  pendingDownEmail?: boolean;
  pendingDownSince?: number | null;
  pendingUpEmail?: boolean;
  pendingUpSince?: number | null;
  // Per-channel SMS retry flags (see Website.pendingDownSms/pendingUpSms).
  pendingDownSms?: boolean;
  pendingUpSms?: boolean;
  // Webhook re-drive flags (see Website.pendingDownWebhooks/pendingUpWebhooks).
  pendingDownWebhooks?: boolean;
  pendingUpWebhooks?: boolean;
  // Multi-region peer confirmation (Phase 2). All five fields are written
  // on every probe — null when peer was not consulted, populated otherwise.
  // peerCheckedAt IS NOT NULL is the canonical "peer was consulted" test.
  peerRegion?: string | null;
  peerStatus?: string | null;
  peerResponseTime?: number | null;
  peerCheckedAt?: number | null;
  peerReachable?: boolean | null;
  // Permanent-disagreement streak tracking (consumed by Step 7b notification).
  peerDisagreementStreakStartedAt?: number | null;
  peerDisagreementNotifiedAt?: number | null;
}

// Hard limit for memory safety
// OPTIMIZATION: Reduced from 1000 to 500 for ~50% memory reduction
// Trade-off: More frequent Firestore flushes but batch size remains 400
const MAX_BUFFER_SIZE = 500;
const MAX_PARALLEL_WRITES = 20;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_DROP = 10;
const FAILURE_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_FLUSH_HIGH_WATERMARK = 200;
const FIRESTORE_BATCH_SIZE = 400;
const DEFAULT_FLUSH_DELAY_MS = 1_500;
const IDLE_STOP_AFTER_MS = 25_000;
const LOG_SAMPLE_RATE = 0.05;
const LAST_CHECKED_BUCKET_MS = 2 * 60 * 1000;
const NEXT_CHECK_BUCKET_MS = 60 * 1000;
const RESPONSE_TIME_BUCKET_MS = 50;
// Bounded-staleness floor for the steady-state flush skip: a check whose
// material state hasn't changed skips its periodic flush write entirely,
// but never for longer than this — so doc timing fields (lastChecked,
// nextCheckAt, responseTime) stay bounded for the public API, restart
// hydration, and the WS-fallback UI instead of freezing at the last
// transition. Env-overridable like HEARTBEAT_DEFER_FLUSH_INTERVAL_MS
// (PM2 env edit + restart, no redeploy). Setting it to 0 (or negative)
// DISABLES the skip entirely — every flush writes through — giving ops a
// no-deploy kill knob alongside the heartbeat-defer admin toggle.
// NOTE: the true doc-staleness bound is this floor PLUS the deferred-flush
// interval (the floor only takes effect when the next flush evaluates the
// check) — ~25h with defaults. The UI copy and API docs say "up to a day";
// revisit both if either knob is raised.
const parsedDocRefreshMaxAgeMs = Number(process.env.CHECKS_DOC_REFRESH_MAX_AGE_MS);
const CHECKS_DOC_REFRESH_MAX_AGE_MS = Number.isFinite(parsedDocRefreshMaxAgeMs)
  ? parsedDocRefreshMaxAgeMs
  : 24 * 60 * 60 * 1000;
if (process.env.CHECKS_DOC_REFRESH_MAX_AGE_MS !== undefined) {
  logger.info(
    `[steady-skip] CHECKS_DOC_REFRESH_MAX_AGE_MS override: ${CHECKS_DOC_REFRESH_MAX_AGE_MS}ms` +
    (CHECKS_DOC_REFRESH_MAX_AGE_MS <= 0 ? ' (steady-state skip DISABLED)' : '')
  );
}
const lastWrittenHashes = new Map<string, string>();
// Material hash + commit time of the last write per check. Drives the
// steady-state skip: timing-only churn (which always changes the full hash)
// must not force a write while material state is unchanged and the doc is
// younger than CHECKS_DOC_REFRESH_MAX_AGE_MS.
const lastWrittenMaterial = new Map<string, { hash: string; writtenAt: number }>();
const logSampledDebug = (message: string, meta?: Record<string, unknown>) => {
  if (Math.random() < LOG_SAMPLE_RATE) {
    if (meta) {
      logger.debug(message, meta);
    } else {
      logger.debug(message);
    }
  }
};

interface FailureMeta {
  failures: number;
  nextRetryAt: number;
  firstFailureAt: number;
  lastErrorCode?: number | string;
  lastErrorMessage?: string;
}

interface FlushStats {
  successes: number;
  missing: number;
  failures: number;
  noops: number;
  steadySkips: number;
}

const normalizeStatusData = (data: StatusUpdateData) => {
  const {
    updatedAt: _updatedAt, // always changes; ignore for no-op comparison
    lastChecked,
    nextCheckAt,
    responseTime,
    ...stable
  } = data;
  void _updatedAt;

  // Bucket hot fields so UI recency updates still write, but jitter does not.
  // Sub-minute checks: use the actual values (no bucketing) so every run
  // produces a unique hash and writes to Firestore. Without this, 15s checks
  // get deduped for ~60-120s because they fall in the same time bucket.
  const isSubMinute = typeof lastChecked === "number" && typeof nextCheckAt === "number"
    && (nextCheckAt - lastChecked) < 60_000;
  const lastCheckedBucket = typeof lastChecked === "number"
    ? (isSubMinute ? lastChecked : Math.floor(lastChecked / LAST_CHECKED_BUCKET_MS))
    : undefined;
  const nextCheckBucket = typeof nextCheckAt === "number"
    ? (isSubMinute ? nextCheckAt : Math.floor(nextCheckAt / NEXT_CHECK_BUCKET_MS))
    : undefined;
  const responseTimeBucket =
    typeof responseTime === "number"
      ? Math.round(responseTime / RESPONSE_TIME_BUCKET_MS) * RESPONSE_TIME_BUCKET_MS
      : responseTime;

  return { ...stable, lastCheckedBucket, nextCheckBucket, responseTimeBucket };
};

type NormalizedStatusData = ReturnType<typeof normalizeStatusData>;

// Material fields: everything that represents check STATE rather than probe
// recency. String concat is ~5-10x faster than JSON.stringify for flat
// objects. IMPORTANT: every field in normalizeStatusData must appear in
// exactly one of materialHashOf/timingHashOf — omitting a field means
// changes to it would be treated as no-ops.
//
// Deliberately in the timing hash instead (their churn must not force a
// flush write): the lastChecked/nextCheckAt/responseTime buckets;
// lastHistoryAt (BigQuery history-sampling cursor — runtime reads it from
// the in-memory schedule, the doc copy only seeds restart hydration where
// an early re-sample is harmless); peerCheckedAt/peerResponseTime
// (per-consultation timing jitter — the peer verdict fields stay material);
// the dnsMs/connectMs/tlsMs/ttfbMs phase timings and
// sslCertificate.lastChecked (per-probe measurements, same staleness class
// as responseTime). A steady check whose probes only move timing fields
// produces an unchanged material hash and skips its flush write (see
// processBatchEntries).
const materialHashOf = (n: NormalizedStatusData) => {
  const ssl = n.sslCertificate;
  return `${n.status}|${n.lastStatusCode}|${n.statusCode}|${n.consecutiveFailures}|${n.consecutiveSuccesses}|${n.detailedStatus}|${n.lastError}|${n.checkRegion}|${n.targetCountry}|${n.targetRegion}|${n.targetCity}|${n.targetLatitude}|${n.targetLongitude}|${n.targetHostname}|${n.targetIp}|${n.targetIpsJson}|${n.targetIpFamily}|${n.targetAsn}|${n.targetOrg}|${n.targetIsp}|${n.targetMetadataLastChecked}|${n.downtimeCount}|${n.lastDowntime}|${n.lastFailureTime}|${n.disabled}|${n.disabledAt}|${n.disabledReason}|${n.pendingDownEmail}|${n.pendingDownSince}|${n.pendingUpEmail}|${n.pendingUpSince}|${n.pendingDownSms}|${n.pendingUpSms}|${n.pendingDownWebhooks}|${n.pendingUpWebhooks}|${ssl?.valid}|${ssl?.issuer}|${ssl?.subject}|${ssl?.validFrom}|${ssl?.validTo}|${ssl?.daysUntilExpiry}|${ssl?.error}|${n.sslAlertedState}|${n.maintenanceMode}|${n.maintenanceStartedAt}|${n.maintenanceExpiresAt}|${n.maintenanceDuration}|${n.maintenanceReason}|${n.maintenanceScheduledStart}|${n.maintenanceScheduledDuration}|${n.maintenanceScheduledReason}|${n.maintenanceRecurringActiveUntil}|${n.redirectLocation}|${n.peerRegion}|${n.peerStatus}|${n.peerReachable}|${n.peerDisagreementStreakStartedAt}|${n.peerDisagreementNotifiedAt}`;
};

const timingHashOf = (n: NormalizedStatusData) =>
  `${n.lastCheckedBucket}|${n.nextCheckBucket}|${n.responseTimeBucket}|${n.lastHistoryAt}|${n.peerCheckedAt}|${n.peerResponseTime}|${n.dnsMs}|${n.connectMs}|${n.tlsMs}|${n.ttfbMs}|${n.sslCertificate?.lastChecked}`;

// Compile-time coverage guard: every key of the normalized payload must be
// consumed by materialHashOf or timingHashOf. Adding a field to
// StatusUpdateData without classifying it in one of the hash template
// strings AND this union fails the build, instead of silently freezing the
// new field for up to the refresh floor. (sslCertificate counts as covered
// at the top level; its subfields are split inline — lastChecked is timing,
// the rest are material.)
type HashCoveredField =
  | 'status' | 'lastStatusCode' | 'statusCode' | 'consecutiveFailures'
  | 'consecutiveSuccesses' | 'detailedStatus' | 'lastError' | 'checkRegion'
  | 'targetCountry' | 'targetRegion' | 'targetCity' | 'targetLatitude'
  | 'targetLongitude' | 'targetHostname' | 'targetIp' | 'targetIpsJson'
  | 'targetIpFamily' | 'targetAsn' | 'targetOrg' | 'targetIsp'
  | 'targetMetadataLastChecked' | 'downtimeCount' | 'lastDowntime'
  | 'lastFailureTime' | 'disabled' | 'disabledAt' | 'disabledReason'
  | 'pendingDownEmail' | 'pendingDownSince' | 'pendingUpEmail'
  | 'pendingUpSince' | 'pendingDownSms' | 'pendingUpSms'
  | 'pendingDownWebhooks' | 'pendingUpWebhooks' | 'sslCertificate'
  | 'sslAlertedState' | 'maintenanceMode' | 'maintenanceStartedAt'
  | 'maintenanceExpiresAt' | 'maintenanceDuration' | 'maintenanceReason'
  | 'maintenanceScheduledStart' | 'maintenanceScheduledDuration'
  | 'maintenanceScheduledReason' | 'maintenanceRecurringActiveUntil'
  | 'redirectLocation' | 'peerRegion' | 'peerStatus' | 'peerReachable'
  | 'peerDisagreementStreakStartedAt' | 'peerDisagreementNotifiedAt'
  | 'lastHistoryAt' | 'peerCheckedAt' | 'peerResponseTime'
  | 'dnsMs' | 'connectMs' | 'tlsMs' | 'ttfbMs'
  | 'lastCheckedBucket' | 'nextCheckBucket' | 'responseTimeBucket';
type AssertNever<T extends never> = T;
// Exported only so noUnusedLocals doesn't strip the assertion; never import
// it. First element errors on a payload field missing from HashCoveredField;
// second errors on a HashCoveredField name that isn't in the payload.
export type HashCoverageChecks = [
  AssertNever<Exclude<keyof NormalizedStatusData, HashCoveredField>>,
  AssertNever<Exclude<HashCoveredField, keyof NormalizedStatusData>>,
];

// Status update buffer for batching updates
// Exported for flushStatusUpdates, but prefer using addStatusUpdate
export const statusUpdateBuffer = new Map<string, StatusUpdateData>();
const failureTracker = new Map<string, FailureMeta>();
let queuedFlushTimer: NodeJS.Timeout | null = null;
let queuedFlushTime = Infinity;
let idleStopTimer: NodeJS.Timeout | null = null;

// Optional hook for external consumers (e.g. VPS in-memory schedule) to observe status updates.
// Fires synchronously inside addStatusUpdate before the buffer is flushed.
let onStatusUpdateHook: ((checkId: string, data: StatusUpdateData) => void) | null = null;
export const setStatusUpdateHook = (hook: typeof onStatusUpdateHook) => { onStatusUpdateHook = hook; };

// ── Phase 7: Heartbeat-defer classifier ─────────────────────────────────
// When enabled, only state-transition updates go through the main flush
// path. Heartbeat-style updates (same status, just lastChecked moving)
// accumulate in `deferredHeartbeatBuffer` and flush on the VPS-side timer
// (HEARTBEAT_DEFER_FLUSH_INTERVAL_MS in vps/src/runner.ts — 15 min as of
// firestore-write-reduction.md Tier 1). This trades fallback freshness
// (`lastChecked` in Firestore stale up to one flush interval) for the
// dominant share of Firestore writes on the `checks` collection. Phases
// 1–6 made the frontend stop depending on Firestore for live freshness,
// which is what makes this trade safe.
//
// Toggled at runtime via `setHeartbeatDeferEnabled`. The VPS wires this
// to a Firestore `system_settings/heartbeat_defer` doc via onSnapshot so
// operators can flip the switch without redeploying. Disabling drains
// the deferred buffer immediately so subsequent writes flow through the
// existing path with no gap.
// INVARIANT: every field consulted by isTransition below MUST also be part
// of materialHashOf. A transition-classified update whose deciding field
// weren't material would be routed to the immediate flush path and then
// steady-skipped there (unchanged material hash + fresh writtenAt) —
// silently dropping a write the classifier promised was immediate.
interface LastWrittenState {
  status?: StatusUpdateData['status'];
  detailedStatus?: StatusUpdateData['detailedStatus'];
  disabled?: StatusUpdateData['disabled'];
  maintenanceMode?: StatusUpdateData['maintenanceMode'];
  lastError?: StatusUpdateData['lastError'];
  consecutiveFailures?: StatusUpdateData['consecutiveFailures'];
}

const lastWrittenSnapshot = new Map<string, LastWrittenState>();
const deferredHeartbeatBuffer = new Map<string, StatusUpdateData>();
let heartbeatDeferEnabled = false;
let writesDeferred = 0;
let writesImmediate = 0;
let writesPromotedFromDeferred = 0;
let writesSkippedSteadyState = 0;
let lastDeferredFlushAt = 0;

/**
 * Decide whether an incoming update is a state transition (must write
 * immediately) or a heartbeat (eligible for deferral). The first
 * observation of a check is always treated as a transition so the
 * baseline `lastWrittenSnapshot` gets seeded before any heartbeat can
 * be deferred.
 *
 * `consecutiveFailures` crosses zero is the only count-based transition
 * trigger — going from 0→1 (started failing) or N→0 (recovered) flips
 * downstream alerting, so it can't wait 5 min.
 */
function isTransition(checkId: string, data: StatusUpdateData): boolean {
  const prev = lastWrittenSnapshot.get(checkId);
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

  return false;
}

function recordLastWritten(checkId: string, data: StatusUpdateData): void {
  const prev = lastWrittenSnapshot.get(checkId) ?? {};
  lastWrittenSnapshot.set(checkId, {
    status: data.status ?? prev.status,
    detailedStatus: data.detailedStatus ?? prev.detailedStatus,
    disabled: data.disabled ?? prev.disabled,
    maintenanceMode: data.maintenanceMode ?? prev.maintenanceMode,
    lastError: 'lastError' in data ? data.lastError : prev.lastError,
    consecutiveFailures: data.consecutiveFailures ?? prev.consecutiveFailures,
  });
}

/**
 * Live toggle for the deferred-heartbeat path. Disabling drains the
 * deferred buffer into the main buffer immediately so the new
 * immediate-write semantic applies on the very next flush — no gap
 * where heartbeats sit indefinitely in a stale deferred bucket.
 */
export const setHeartbeatDeferEnabled = (enabled: boolean): void => {
  if (heartbeatDeferEnabled === enabled) return;
  heartbeatDeferEnabled = enabled;
  if (!enabled) {
    drainDeferredIntoMain();
    if (statusUpdateBuffer.size > 0) queueFlushAfter(0);
  }
  logger.info(`[heartbeat-defer] ${enabled ? 'ENABLED' : 'DISABLED'} (deferred buffer drained: ${enabled ? 0 : 'see preceding flush'})`);
};

export const isHeartbeatDeferEnabled = (): boolean => heartbeatDeferEnabled;

function drainDeferredIntoMain(): void {
  if (deferredHeartbeatBuffer.size === 0) return;
  for (const [checkId, data] of deferredHeartbeatBuffer) {
    const existing = statusUpdateBuffer.get(checkId);
    // Newest fields win on collision — defer-side has the freshest read.
    statusUpdateBuffer.set(checkId, existing ? { ...existing, ...data } : data);
    writesPromotedFromDeferred++;
  }
  deferredHeartbeatBuffer.clear();
}

/**
 * Periodic snapshot of the deferred buffer into the main flush path.
 * The VPS calls this on a 5-min timer; shutdown also calls it to avoid
 * losing the last batch of heartbeats.
 */
export const flushDeferredHeartbeats = async (): Promise<void> => {
  if (deferredHeartbeatBuffer.size === 0) return;
  const size = deferredHeartbeatBuffer.size;
  drainDeferredIntoMain();
  lastDeferredFlushAt = Date.now();
  logger.info(`[heartbeat-defer] flush: promoted ${size} deferred entries to main buffer`);
  await flushStatusUpdates();
};

export interface HeartbeatDeferStats {
  enabled: boolean;
  deferredBufferSize: number;
  trackedChecks: number;
  writesDeferred: number;
  writesImmediate: number;
  writesPromotedFromDeferred: number;
  writesSkippedSteadyState: number;
  lastFlushedAt: number;
}

export const getHeartbeatDeferStats = (): HeartbeatDeferStats => ({
  enabled: heartbeatDeferEnabled,
  deferredBufferSize: deferredHeartbeatBuffer.size,
  trackedChecks: lastWrittenSnapshot.size,
  writesDeferred,
  writesImmediate,
  writesPromotedFromDeferred,
  writesSkippedSteadyState,
  lastFlushedAt: lastDeferredFlushAt,
});

// Helper to safely add updates with memory management
export const addStatusUpdate = async (checkId: string, data: StatusUpdateData): Promise<void> => {
  // Fire hook FIRST — updates the in-memory schedule before any blocking I/O.
  // Critical for the VPS worker pool: the hook sets nextCheckAt and releases
  // the check from inFlight, so the dispatcher can reschedule it immediately
  // instead of waiting for the buffer flush to complete.
  if (onStatusUpdateHook) onStatusUpdateHook(checkId, data);

  // Phase 7: route heartbeat-style updates to the deferred buffer when
  // the flag is enabled. Transitions stay on the immediate path so
  // alerting/state changes still write within ~1.5s.
  if (heartbeatDeferEnabled && !isTransition(checkId, data)) {
    const existing = deferredHeartbeatBuffer.get(checkId);
    deferredHeartbeatBuffer.set(checkId, existing ? { ...existing, ...data } : data);
    writesDeferred++;
    return;
  }
  writesImmediate++;

  // If buffer is full, force a flush before adding
  if (statusUpdateBuffer.size >= MAX_BUFFER_SIZE) {
    // Only warn if we are actually growing past limit and not just busy flushing
    if (statusUpdateBuffer.size > MAX_BUFFER_SIZE + 100) {
      logger.warn(`Status buffer significantly over limit (${statusUpdateBuffer.size}), forcing flush...`);
    }
    // Attempt flush and WAIT for it if locked
    try {
       await flushStatusUpdates();
    } catch (err) {
       logger.error("Error in forced flush", err);
    }
  }

  statusUpdateBuffer.set(checkId, data);
  failureTracker.delete(checkId);

  // On-demand flush with quick path for bursts and idle auto-stop
  touchIdleTimer();
  if (statusUpdateBuffer.size >= QUICK_FLUSH_HIGH_WATERMARK) {
    queueFlushAfter(200);
  } else {
    queueFlushAfter(DEFAULT_FLUSH_DELAY_MS);
  }
};

// Exposed handle to indicate the on-demand scheduler is active.
export let statusFlushInterval: NodeJS.Timeout | null = null;

// NEW: Lock and Promise to track concurrent flushes
let isFlushing = false;
let currentFlushPromise: Promise<void> | null = null;
let isShuttingDown = false;

// Lets an external lifecycle owner (the VPS runner's shutdown()) flip the
// same flag the Cloud Functions signal handler uses: evaluateEntryState then
// force-promotes entries sitting in failure backoff to 'ready', so the final
// flush retries them instead of silently skipping them at exit.
export const markShuttingDown = (): void => { isShuttingDown = true; };

// QA: verify idle timer stops when buffer is empty and shutdown drains pending writes.
// Graceful shutdown handler.
//
// IMPORTANT: only registered inside Cloud Functions (K_SERVICE is set on
// Cloud Run / Gen2). The VPS runner imports this module too, and its own
// shutdown() owns the process lifecycle there — it drains in-flight checks
// for up to 25s and then calls flushStatusUpdates() itself. An import-time
// handler that process.exit(0)s as soon as THIS buffer is empty would
// preempt that drain and silently drop the BigQuery/heartbeat/NDJSON
// flushes on every deploy.
const handleShutdownSignal = async (signal: NodeJS.Signals) => {
  isShuttingDown = true;
  logger.info(`Received ${signal}, flushing status updates before shutdown...`);
  if (statusFlushInterval) {
    clearTimeout(statusFlushInterval);
    statusFlushInterval = null;
  }
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }

  // Phase 7: drain any deferred heartbeats first so the final flush
  // captures the latest known state for every check, not just the
  // transition-only fraction.
  if (deferredHeartbeatBuffer.size > 0) {
    logger.info(`Shutdown: draining ${deferredHeartbeatBuffer.size} deferred heartbeats`);
    drainDeferredIntoMain();
  }

  // Flush repeatedly until empty
  while (statusUpdateBuffer.size > 0) {
      logger.info(`Shutdown flush: ${statusUpdateBuffer.size} items remaining...`);
      await flushStatusUpdates();
  }

  process.exit(0);
};

if (process.env.K_SERVICE) {
  process.on('SIGTERM', () => { void handleShutdownSignal('SIGTERM'); });
  process.on('SIGINT', () => { void handleShutdownSignal('SIGINT'); });
}

export const initializeStatusFlush = () => {
  if (isShuttingDown) return;
  touchIdleTimer();
  if (statusUpdateBuffer.size > 0) {
    queueFlushAfter(DEFAULT_FLUSH_DELAY_MS);
  }
};

export const flushStatusUpdates = async (): Promise<void> => {
  // If buffer is empty, nothing to do
  if (statusUpdateBuffer.size === 0) return;

  // If already flushing, return the existing promise so callers can wait for it
  if (isFlushing) {
    return currentFlushPromise || Promise.resolve();
  }
  
  // Acquire lock
  isFlushing = true;
  
  // Execute flush logic and track the promise
  currentFlushPromise = (async () => {
    const size = statusUpdateBuffer.size;
    // Reduce log noise: only log at info when large; otherwise debug
    if (size >= 50) {
      logger.info(`Flushing status update buffer with ${size} entries`);
    } else {
      logger.debug(`Flushing status update buffer with ${size} entries`);
    }
    
    // We need to iterate on a SNAPSHOT of the buffer to avoid concurrent modification issues
    const entries = Array.from(statusUpdateBuffer.entries());

    const readyEntries: Array<[string, StatusUpdateData]> = [];
    let skipped = 0;
    let dropped = 0;

    for (const [checkId, data] of entries) {
      const state = evaluateEntryState(checkId, data);
      if (state === "ready") {
        readyEntries.push([checkId, data]);
      } else if (state === "skipped") {
        skipped += 1;
      } else {
        dropped += 1;
      }
    }

    if (readyEntries.length === 0) {
      if (skipped || dropped) {
        logSampledDebug(`No ready status updates to flush (skipped=${skipped}, dropped=${dropped})`);
      }
      return;
    }

    const stats: FlushStats = {
      successes: 0,
      missing: 0,
      failures: 0,
      noops: 0,
      steadySkips: 0,
    };

    for (let i = 0; i < readyEntries.length; i += FIRESTORE_BATCH_SIZE) {
      const batchEntries = readyEntries.slice(i, i + FIRESTORE_BATCH_SIZE);
      await processBatchEntries(batchEntries, stats);
    }

    if (stats.successes || stats.failures || stats.missing || stats.noops || stats.steadySkips) {
      const flushMsg = `Status flush: ${stats.successes} writes, ${stats.steadySkips} steady-state skips, ${stats.noops} no-op skips, ${stats.missing} missing, ${stats.failures} deferred, ${skipped} waiting, ${dropped} dropped`;
      if (stats.successes >= 50 || stats.failures > 0 || stats.missing > 0) {
        logger.info(flushMsg);
      } else {
        logger.debug(flushMsg);
      }
    } else {
      logger.debug(
        `Status flush: ${skipped} waiting, ${dropped} dropped, no writes needed`
      );
    }
  })().catch(error => {
    logger.error("Error during status flush:", error);
  }).finally(() => {
    // Release lock
    isFlushing = false;
    currentFlushPromise = null;
    
    if (statusUpdateBuffer.size > QUICK_FLUSH_HIGH_WATERMARK) {
      queueFlushAfter(200);
    }
    scheduleNextBackoffFlush();
    if (!isShuttingDown) {
      touchIdleTimer();
    }
  });

  return currentFlushPromise;
};

const calculateBackoffDelay = (failures: number): number => {
  if (failures <= 0) return BACKOFF_INITIAL_MS;
  const delay = BACKOFF_INITIAL_MS * Math.pow(2, failures - 1);
  return Math.min(delay, BACKOFF_MAX_MS);
};

function queueFlushAt(targetTime: number) {
  if (isShuttingDown) {
    return;
  }

  const now = Date.now();
  const delay = Math.max(targetTime - now, 0);

  if (queuedFlushTimer) {
    if (targetTime >= queuedFlushTime - 10) {
      return;
    }
    clearTimeout(queuedFlushTimer);
  }

  queuedFlushTime = targetTime;
  queuedFlushTimer = setTimeout(() => {
    queuedFlushTimer = null;
    queuedFlushTime = Infinity;
    flushStatusUpdates().catch(err => logger.error("Error in queued flush", err));
  }, delay);
}

function queueFlushAfter(delayMs: number) {
  queueFlushAt(Date.now() + Math.max(delayMs, 0));
}

function scheduleNextBackoffFlush() {
  if (isShuttingDown) return;
  const now = Date.now();
  let earliest: number | null = null;

  for (const meta of failureTracker.values()) {
    if (meta.nextRetryAt <= now) {
      queueFlushAfter(0);
      return;
    }
    if (earliest === null || meta.nextRetryAt < earliest) {
      earliest = meta.nextRetryAt;
    }
  }

  if (earliest !== null) {
    queueFlushAt(earliest);
  }
}

function touchIdleTimer() {
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
  }
  if (isShuttingDown) {
    return;
  }

  idleStopTimer = setTimeout(() => {
    if (statusUpdateBuffer.size === 0 && failureTracker.size === 0) {
      idleStopTimer = null;
      statusFlushInterval = null;
      return;
    }
    queueFlushAfter(0);
    touchIdleTimer();
  }, IDLE_STOP_AFTER_MS);

  // Preserve external checks that look for a non-null handle
  statusFlushInterval = idleStopTimer;
}

const dropBufferedEntry = (checkId: string, snapshotData: StatusUpdateData, reason: string) => {
  const currentData = statusUpdateBuffer.get(checkId);
  if (currentData === snapshotData) {
    statusUpdateBuffer.delete(checkId);
  }
  failureTracker.delete(checkId);
  logger.warn(`${reason} (${checkId})`);
};

const markEntrySuccess = (checkId: string, snapshotData: StatusUpdateData) => {
  const currentData = statusUpdateBuffer.get(checkId);
  if (currentData === snapshotData) {
    statusUpdateBuffer.delete(checkId);
  }
  failureTracker.delete(checkId);
  // Phase 7: record what we just wrote so isTransition can detect the
  // next genuine state change vs heartbeat. Runs regardless of whether
  // the defer flag is on — the snapshot needs to be populated before
  // toggling the flag, so we maintain it unconditionally.
  recordLastWritten(checkId, snapshotData);
};

const evaluateEntryState = (checkId: string, snapshotData: StatusUpdateData): "ready" | "skipped" | "dropped" => {
  const meta = failureTracker.get(checkId);
  if (!meta) return "ready";

  const now = Date.now();
  const exceededFailures = meta.failures >= MAX_FAILURES_BEFORE_DROP;
  const exceededTimeout = now - meta.firstFailureAt >= FAILURE_TIMEOUT_MS;

  if (exceededFailures || exceededTimeout) {
    dropBufferedEntry(
      checkId,
      snapshotData,
      `Dropping status update after ${meta.failures} failures${meta.lastErrorMessage ? ` (${meta.lastErrorMessage})` : ""}`
    );
    return "dropped";
  }

  if (isShuttingDown) {
    return "ready";
  }

  if (now < meta.nextRetryAt) {
    return "skipped";
  }

  return "ready";
};

const recordFailure = (checkId: string, error: unknown) => {
  const now = Date.now();
  const previous = failureTracker.get(checkId);
  const failures = (previous?.failures ?? 0) + 1;
  const meta: FailureMeta = {
    failures,
    nextRetryAt: now + calculateBackoffDelay(failures),
    firstFailureAt: previous?.firstFailureAt ?? now,
    lastErrorCode: (error as { code?: number | string })?.code,
    lastErrorMessage: (error as Error)?.message,
  };

  failureTracker.set(checkId, meta);
  scheduleNextBackoffFlush();

  if (failures === 1 || failures === 3 || failures === 5 || failures >= MAX_FAILURES_BEFORE_DROP) {
    logger.warn(
      `Status update for ${checkId} failed ${failures} time(s); next retry in ${meta.nextRetryAt - now}ms`,
      { code: meta.lastErrorCode }
    );
  }
};

const processBatchEntries = async (
  batchEntries: Array<[string, StatusUpdateData]>,
  stats: FlushStats
) => {
  if (batchEntries.length === 0) return;
  const batch = firestore.batch();

  // Track hashes so we only write when state meaningfully changed
  const entriesToWrite: Array<[string, StatusUpdateData]> = [];
  const pendingHashes = new Map<string, string>();
  const pendingMaterial = new Map<string, string>();

  for (const [checkId, data] of batchEntries) {
    const n = normalizeStatusData(data);
    const materialHash = materialHashOf(n);
    const nextHash = `${materialHash}|${timingHashOf(n)}`;
    const lastHash = lastWrittenHashes.get(checkId);
    if (lastHash && lastHash === nextHash) {
      markEntrySuccess(checkId, data);
      stats.noops += 1;
      continue;
    }
    // Steady-state skip: only timing fields moved since the last committed
    // write and the doc is still within the freshness floor — drop the write
    // entirely. The next material change (or the floor lapsing) writes the
    // full payload with fresh timing fields. Gated on the heartbeat-defer
    // flag so the existing admin kill switch also restores full
    // write-through here, and Cloud Functions contexts (flag never enabled
    // there) keep per-flush timing freshness. Bypassed during shutdown so
    // the final drain persists the freshest timing state — restart
    // hydration then starts from shutdown-time docs, not the floor bound.
    const prevMaterial = lastWrittenMaterial.get(checkId);
    if (
      heartbeatDeferEnabled &&
      !isShuttingDown &&
      CHECKS_DOC_REFRESH_MAX_AGE_MS > 0 &&
      prevMaterial &&
      prevMaterial.hash === materialHash &&
      Date.now() - prevMaterial.writtenAt < CHECKS_DOC_REFRESH_MAX_AGE_MS
    ) {
      markEntrySuccess(checkId, data);
      writesSkippedSteadyState++;
      stats.steadySkips += 1;
      continue;
    }
    entriesToWrite.push([checkId, data]);
    pendingHashes.set(checkId, nextHash);
    pendingMaterial.set(checkId, materialHash);
  }

  if (entriesToWrite.length === 0) {
    return;
  }

  for (const [checkId, data] of entriesToWrite) {
    const docRef = firestore.collection("checks").doc(checkId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    batch.update(docRef, data as any);
  }

  try {
    await batch.commit();
    for (const [checkId, data] of entriesToWrite) {
      markEntrySuccess(checkId, data);
      const hash = pendingHashes.get(checkId);
      if (hash) {
        lastWrittenHashes.set(checkId, hash);
      }
      const material = pendingMaterial.get(checkId);
      if (material) {
        lastWrittenMaterial.set(checkId, { hash: material, writtenAt: Date.now() });
      }
      stats.successes += 1;
    }
  } catch (error) {
    logger.warn(
      `Batch commit failed for ${entriesToWrite.length} status updates, falling back to per-document writes`,
      error
    );
    await processEntriesIndividually(entriesToWrite, stats);
  }
};

const processEntriesIndividually = async (
  entries: Array<[string, StatusUpdateData]>,
  stats: FlushStats
) => {
  for (let i = 0; i < entries.length; i += MAX_PARALLEL_WRITES) {
    const chunk = entries.slice(i, i + MAX_PARALLEL_WRITES);
    await Promise.all(chunk.map(([checkId, data]) => processSingleEntry(checkId, data, stats)));
  }
};

const processSingleEntry = async (
  checkId: string,
  data: StatusUpdateData,
  stats: FlushStats
) => {
  const n = normalizeStatusData(data);
  const materialHash = materialHashOf(n);
  const nextHash = `${materialHash}|${timingHashOf(n)}`;
  const lastHash = lastWrittenHashes.get(checkId);
  if (lastHash && lastHash === nextHash) {
    markEntrySuccess(checkId, data);
    stats.noops += 1;
    return;
  }
  // Steady-state skip — same rule (defer-flag gate, shutdown bypass, zero
  // disables) as processBatchEntries.
  const prevMaterial = lastWrittenMaterial.get(checkId);
  if (
    heartbeatDeferEnabled &&
    !isShuttingDown &&
    CHECKS_DOC_REFRESH_MAX_AGE_MS > 0 &&
    prevMaterial &&
    prevMaterial.hash === materialHash &&
    Date.now() - prevMaterial.writtenAt < CHECKS_DOC_REFRESH_MAX_AGE_MS
  ) {
    markEntrySuccess(checkId, data);
    writesSkippedSteadyState++;
    stats.steadySkips += 1;
    return;
  }

  const docRef = firestore.collection("checks").doc(checkId);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await docRef.update(data as any);
    markEntrySuccess(checkId, data);
    lastWrittenHashes.set(checkId, nextHash);
    lastWrittenMaterial.set(checkId, { hash: materialHash, writtenAt: Date.now() });
    stats.successes += 1;
  } catch (error) {
    if (isNotFoundError(error)) {
      dropBufferedEntry(checkId, data, "Dropping status update for deleted check");
      stats.missing += 1;
    } else {
      recordFailure(checkId, error);
      stats.failures += 1;
      logger.error(`Failed to update status for ${checkId}:`, error);
    }
  }
};

const isNotFoundError = (error: unknown): boolean => {
  if (!error) return false;
  const code = (error as { code?: number | string })?.code;
  if (code === 5 || code === "5" || code === "not-found") {
    return true;
  }
  const message = (error as Error)?.message ?? "";
  return message.toLowerCase().includes("not found") || message.toLowerCase().includes("missing");
};
