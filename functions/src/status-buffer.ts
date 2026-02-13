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
  checkRegion?: "us-central1" | "europe-west1" | "asia-southeast1";
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
  nextCheckAt?: number;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
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
const lastWrittenHashes = new Map<string, string>();
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
  const lastCheckedBucket =
    typeof lastChecked === "number" ? Math.floor(lastChecked / LAST_CHECKED_BUCKET_MS) : undefined;
  const nextCheckBucket =
    typeof nextCheckAt === "number" ? Math.floor(nextCheckAt / NEXT_CHECK_BUCKET_MS) : undefined;
  const responseTimeBucket =
    typeof responseTime === "number"
      ? Math.round(responseTime / RESPONSE_TIME_BUCKET_MS) * RESPONSE_TIME_BUCKET_MS
      : responseTime;

  return { ...stable, lastCheckedBucket, nextCheckBucket, responseTimeBucket };
};

const hashStatusData = (data: StatusUpdateData) => {
  const n = normalizeStatusData(data);
  // String concat is ~5-10x faster than JSON.stringify for flat objects.
  // IMPORTANT: Every field in normalizeStatusData must appear here.
  // Omitting a field means changes to it would be treated as no-ops.
  const ssl = n.sslCertificate;
  return `${n.status}|${n.lastStatusCode}|${n.statusCode}|${n.consecutiveFailures}|${n.consecutiveSuccesses}|${n.detailedStatus}|${n.lastCheckedBucket}|${n.nextCheckBucket}|${n.responseTimeBucket}|${n.lastError}|${n.checkRegion}|${n.targetCountry}|${n.targetRegion}|${n.targetCity}|${n.targetLatitude}|${n.targetLongitude}|${n.targetHostname}|${n.targetIp}|${n.targetIpsJson}|${n.targetIpFamily}|${n.targetAsn}|${n.targetOrg}|${n.targetIsp}|${n.targetMetadataLastChecked}|${n.downtimeCount}|${n.lastDowntime}|${n.lastFailureTime}|${n.lastHistoryAt}|${n.disabled}|${n.disabledAt}|${n.disabledReason}|${n.pendingDownEmail}|${n.pendingDownSince}|${n.pendingUpEmail}|${n.pendingUpSince}|${ssl?.valid}|${ssl?.issuer}|${ssl?.subject}|${ssl?.validFrom}|${ssl?.validTo}|${ssl?.daysUntilExpiry}|${ssl?.error}|${n.maintenanceMode}|${n.maintenanceStartedAt}|${n.maintenanceExpiresAt}|${n.maintenanceDuration}|${n.maintenanceReason}|${n.maintenanceScheduledStart}|${n.maintenanceScheduledDuration}|${n.maintenanceScheduledReason}|${n.maintenanceRecurringActiveUntil}`;
};

// Status update buffer for batching updates
// Exported for flushStatusUpdates, but prefer using addStatusUpdate
export const statusUpdateBuffer = new Map<string, StatusUpdateData>();
const failureTracker = new Map<string, FailureMeta>();
let queuedFlushTimer: NodeJS.Timeout | null = null;
let queuedFlushTime = Infinity;
let idleStopTimer: NodeJS.Timeout | null = null;

// Helper to safely add updates with memory management
export const addStatusUpdate = async (checkId: string, data: StatusUpdateData): Promise<void> => {
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

// QA: verify idle timer stops when buffer is empty and shutdown drains pending writes.
// Graceful shutdown handler
process.on('SIGTERM', async () => {
  isShuttingDown = true;
  logger.info('Received SIGTERM, flushing status updates before shutdown...');
  if (statusFlushInterval) {
    clearTimeout(statusFlushInterval);
    statusFlushInterval = null;
  }
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }
  
  // Flush repeatedly until empty
  while (statusUpdateBuffer.size > 0) {
      logger.info(`Shutdown flush: ${statusUpdateBuffer.size} items remaining...`);
      await flushStatusUpdates();
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  isShuttingDown = true;
  logger.info('Received SIGINT, flushing status updates before shutdown...');
  if (statusFlushInterval) {
    clearTimeout(statusFlushInterval);
    statusFlushInterval = null;
  }
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }
  
  // Flush repeatedly until empty
  while (statusUpdateBuffer.size > 0) {
      logger.info(`Shutdown flush: ${statusUpdateBuffer.size} items remaining...`);
      await flushStatusUpdates();
  }
  
  process.exit(0);
});

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
    };

    for (let i = 0; i < readyEntries.length; i += FIRESTORE_BATCH_SIZE) {
      const batchEntries = readyEntries.slice(i, i + FIRESTORE_BATCH_SIZE);
      await processBatchEntries(batchEntries, stats);
    }

    if (stats.successes || stats.failures || stats.missing || stats.noops) {
      const flushMsg = `Status flush: ${stats.successes} writes, ${stats.noops} no-op skips, ${stats.missing} missing, ${stats.failures} deferred, ${skipped} waiting, ${dropped} dropped`;
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

  for (const [checkId, data] of batchEntries) {
    const nextHash = hashStatusData(data);
    const lastHash = lastWrittenHashes.get(checkId);
    if (lastHash && lastHash === nextHash) {
      markEntrySuccess(checkId, data);
      stats.noops += 1;
      continue;
    }
    entriesToWrite.push([checkId, data]);
    pendingHashes.set(checkId, nextHash);
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
  const nextHash = hashStatusData(data);
  const lastHash = lastWrittenHashes.get(checkId);
  if (lastHash && lastHash === nextHash) {
    markEntrySuccess(checkId, data);
    stats.noops += 1;
    return;
  }

  const docRef = firestore.collection("checks").doc(checkId);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await docRef.update(data as any);
    markEntrySuccess(checkId, data);
    lastWrittenHashes.set(checkId, nextHash);
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
