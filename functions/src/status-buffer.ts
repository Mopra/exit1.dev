import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

// Type definition for status updates
export interface StatusUpdateData {
  status?: string;
  lastChecked: number;
  responseTime?: number | null;
  statusCode?: number;
  lastError?: string | null;
  downtimeCount?: number;
  lastDowntime?: number;
  lastFailureTime?: number;
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
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  disabled?: boolean;
  disabledAt?: number;
  disabledReason?: string;
  updatedAt: number;
  pendingDownEmail?: boolean;
  pendingDownSince?: number | null;
  pendingUpEmail?: boolean;
  pendingUpSince?: number | null;
}

// Hard limit for memory safety
const MAX_BUFFER_SIZE = 1000;
const MAX_PARALLEL_WRITES = 20;
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_DROP = 10;
const FAILURE_TIMEOUT_MS = 10 * 60 * 1000;
const QUICK_FLUSH_HIGH_WATERMARK = 200;
const FIRESTORE_BATCH_SIZE = 400;

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
}

// Status update buffer for batching updates
// Exported for flushStatusUpdates, but prefer using addStatusUpdate
export const statusUpdateBuffer = new Map<string, StatusUpdateData>();
const failureTracker = new Map<string, FailureMeta>();
let queuedFlushTimer: NodeJS.Timeout | null = null;
let queuedFlushTime = Infinity;

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
};

// Flush status updates every 30 seconds
export let statusFlushInterval: NodeJS.Timeout | null = null;

// NEW: Lock and Promise to track concurrent flushes
let isFlushing = false;
let currentFlushPromise: Promise<void> | null = null;
let isShuttingDown = false;

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  isShuttingDown = true;
  logger.info('Received SIGTERM, flushing status updates before shutdown...');
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
    statusFlushInterval = null;
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
    clearInterval(statusFlushInterval);
    statusFlushInterval = null;
  }
  
  // Flush repeatedly until empty
  while (statusUpdateBuffer.size > 0) {
      logger.info(`Shutdown flush: ${statusUpdateBuffer.size} items remaining...`);
      await flushStatusUpdates();
  }
  
  process.exit(0);
});

export const initializeStatusFlush = () => {
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
  }
  
  statusFlushInterval = setInterval(async () => {
    try {
      await flushStatusUpdates();
    } catch (error) {
      logger.error('Error flushing status updates:', error);
    }
  }, 30 * 1000); // Flush every 30 seconds
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
    logger.info(`Flushing status update buffer with ${size} entries`);
    
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
        logger.info(`No ready status updates to flush (skipped=${skipped}, dropped=${dropped})`);
      }
      return;
    }

    const stats: FlushStats = {
      successes: 0,
      missing: 0,
      failures: 0,
    };

    for (let i = 0; i < readyEntries.length; i += FIRESTORE_BATCH_SIZE) {
      const batchEntries = readyEntries.slice(i, i + FIRESTORE_BATCH_SIZE);
      await processBatchEntries(batchEntries, stats);
    }

    logger.info(
      `Status flush complete: ${stats.successes} updated, ${stats.missing} missing, ${stats.failures} deferred, ${skipped} waiting, ${dropped} dropped`
    );
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
  });

  return currentFlushPromise;
};

const calculateBackoffDelay = (failures: number): number => {
  if (failures <= 0) return BACKOFF_INITIAL_MS;
  const delay = BACKOFF_INITIAL_MS * Math.pow(2, failures - 1);
  return Math.min(delay, BACKOFF_MAX_MS);
};

const queueFlushAt = (targetTime: number) => {
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
};

const queueFlushAfter = (delayMs: number) => {
  queueFlushAt(Date.now() + Math.max(delayMs, 0));
};

const scheduleNextBackoffFlush = () => {
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
};

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

  for (const [checkId, data] of batchEntries) {
    const docRef = firestore.collection("checks").doc(checkId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    batch.update(docRef, data as any);
  }

  try {
    await batch.commit();
    for (const [checkId, data] of batchEntries) {
      markEntrySuccess(checkId, data);
      stats.successes += 1;
    }
  } catch (error) {
    logger.warn(
      `Batch commit failed for ${batchEntries.length} status updates, falling back to per-document writes`,
      error
    );
    await processEntriesIndividually(batchEntries, stats);
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
  const docRef = firestore.collection("checks").doc(checkId);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await docRef.update(data as any);
    markEntrySuccess(checkId, data);
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
