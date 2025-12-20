import { onRequest, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { firestore, getUserTier } from "./init";
import { CONFIG } from "./config";
import { Website } from "./types";
import { RESEND_API_KEY, RESEND_FROM, CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from "./env";
import { statusFlushInterval, initializeStatusFlush, flushStatusUpdates, addStatusUpdate, StatusUpdateData, statusUpdateBuffer } from "./status-buffer";
import { checkRestEndpoint, storeCheckHistory, createCheckHistoryRecord } from "./check-utils";
import { triggerAlert, triggerSSLAlert, triggerDomainExpiryAlert, AlertSettingsCache, AlertContext, drainQueuedWebhookRetries } from "./alert";
import { EmailSettings, WebhookSettings } from "./types";
import { insertCheckHistory, BigQueryCheckHistory, flushBigQueryInserts } from "./bigquery";

type AlertReason = 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' | undefined;

const shouldRetryAlert = (reason?: AlertReason) => reason === 'flap' || reason === 'error' || reason === 'throttle';

const CHECK_RUN_LOCK_COLLECTION = "runtimeLocks";
const CHECK_RUN_LOCK_DOC = "checkAllChecks";
const CHECK_RUN_LOCK_TTL_MS = 25 * 60 * 1000;
const CHECK_RUN_LOCK_HEARTBEAT_MS = 60 * 1000;
const MAX_CHECK_QUERY_PAGES = 5;
const MAX_HISTORY_ENQUEUE_ATTEMPTS = 8;
const HISTORY_RETRY_INITIAL_DELAY_MS = 1_000;
const HISTORY_RETRY_MAX_DELAY_MS = 30_000;
const HISTORY_FAILURE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_FUNCTION_TIMEOUT_MS = 9 * 60 * 1000;
const EXECUTION_TIME_BUFFER_MS = 30 * 1000;
const MIN_TIME_FOR_NEW_BATCH_MS = 45 * 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface RetryOptions {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const retryWithBackoff = async <T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> => {
  let attempt = 0;
  let delay = options.initialDelayMs;

  while (attempt < options.attempts) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= options.attempts) {
        throw error;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, options.maxDelayMs);
    }
  }

  throw new Error("retryWithBackoff exhausted attempts");
};

const FIRESTORE_RETRY_OPTIONS: RetryOptions = {
  attempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
};

const withFirestoreRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  return retryWithBackoff(operation, FIRESTORE_RETRY_OPTIONS);
};

let schedulerShutdownHandlersRegistered = false;
let schedulerShutdownRequested = false;
let schedulerCleanupFn: (() => Promise<void>) | null = null;
let schedulerCleanupInFlight: Promise<void> | null = null;
let schedulerActiveLockId: string | null = null;
let schedulerSignalPendingCleanup = false;
let schedulerSignalCleanupTriggered = false;

const triggerSchedulerCleanup = (): Promise<void> | null => {
  if (!schedulerCleanupFn) {
    return null;
  }
  if (schedulerCleanupInFlight) {
    return schedulerCleanupInFlight;
  }
  schedulerCleanupInFlight = (async () => {
    try {
      await schedulerCleanupFn!();
    } catch (error) {
      logger.error("Error while draining check scheduler buffers during shutdown", error);
    } finally {
      schedulerCleanupFn = null;
      schedulerCleanupInFlight = null;
    }
  })();
  return schedulerCleanupInFlight;
};

const releaseSchedulerLockOnShutdown = (): Promise<void> | null => {
  if (!schedulerActiveLockId) {
    return null;
  }
  const lockId = schedulerActiveLockId;
  schedulerActiveLockId = null;
  return releaseCheckRunLock(lockId).catch(error =>
    logger.error("Failed to release check run lock during shutdown", error)
  );
};

const initiateSchedulerCleanupSequence = (): boolean => {
  if (schedulerSignalCleanupTriggered) {
    return true;
  }
  if (!schedulerCleanupFn) {
    schedulerSignalPendingCleanup = true;
    return false;
  }

  const cleanupPromise = triggerSchedulerCleanup();
  schedulerSignalPendingCleanup = false;
  schedulerSignalCleanupTriggered = true;

  if (cleanupPromise) {
    cleanupPromise.finally(() => {
      const releasePromise = releaseSchedulerLockOnShutdown();
      if (releasePromise) {
        releasePromise.catch(err => logger.error("Error releasing lock after cleanup", err));
      }
    });
  } else {
    const releasePromise = releaseSchedulerLockOnShutdown();
    if (releasePromise) {
      releasePromise.catch(err => logger.error("Error releasing lock after cleanup", err));
    }
  }

  return true;
};

const handleSchedulerSignal = (signal: NodeJS.Signals) => {
  if (!schedulerCleanupFn && !schedulerActiveLockId) {
    return;
  }
  if (schedulerShutdownRequested) {
    return;
  }
  schedulerShutdownRequested = true;
  logger.warn(`Received ${signal}; draining scheduler buffers before shutdown`);
  const started = initiateSchedulerCleanupSequence();
  if (!started) {
    logger.warn("Scheduler cleanup not ready; will trigger once initialization completes");
  }
};

const ensureSchedulerShutdownHandlers = () => {
  if (schedulerShutdownHandlersRegistered) {
    return;
  }
  process.on("SIGTERM", handleSchedulerSignal);
  process.on("SIGINT", handleSchedulerSignal);
  schedulerShutdownHandlersRegistered = true;
};

const createRunLockId = () =>
  `${process.env.K_SERVICE ?? "scheduler"}-${process.pid ?? ""}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const acquireCheckRunLock = async (lockId: string): Promise<boolean> => {
  const lockRef = firestore.collection(CHECK_RUN_LOCK_COLLECTION).doc(CHECK_RUN_LOCK_DOC);
  const now = Date.now();
  const expiresAt = now + CHECK_RUN_LOCK_TTL_MS;

  try {
    await firestore.runTransaction(async tx => {
      const snapshot = await tx.get(lockRef);
      if (snapshot.exists) {
        const data = snapshot.data() as { owner?: string; expiresAt?: number } | undefined;
        if (data?.expiresAt && data.expiresAt > now && data.owner !== lockId) {
          throw new Error("lock-active");
        }
      }
      tx.set(lockRef, { owner: lockId, expiresAt }, { merge: true });
    });
    return true;
  } catch (error) {
    if ((error as Error).message === "lock-active") {
      return false;
    }
    throw error;
  }
};

const releaseCheckRunLock = async (lockId: string): Promise<void> => {
  const lockRef = firestore.collection(CHECK_RUN_LOCK_COLLECTION).doc(CHECK_RUN_LOCK_DOC);
  await retryWithBackoff(
    async () => {
      await firestore.runTransaction(async tx => {
        const snapshot = await tx.get(lockRef);
        if (!snapshot.exists) return;
        const data = snapshot.data() as { owner?: string } | undefined;
        if (data?.owner !== lockId) return;
        tx.delete(lockRef);
      });
    },
    { attempts: 3, initialDelayMs: 500, maxDelayMs: 2_000 }
  ).catch(error => logger.error("Failed to release check run lock", error));
};

const extendCheckRunLock = async (lockId: string): Promise<void> => {
  const lockRef = firestore.collection(CHECK_RUN_LOCK_COLLECTION).doc(CHECK_RUN_LOCK_DOC);
  await firestore.runTransaction(async tx => {
    const snapshot = await tx.get(lockRef);
    if (!snapshot.exists) {
      throw new Error("lock-missing");
    }
    const data = snapshot.data() as { owner?: string } | undefined;
    if (data?.owner !== lockId) {
      throw new Error("lock-stolen");
    }
    tx.update(lockRef, { expiresAt: Date.now() + CHECK_RUN_LOCK_TTL_MS });
  });
};

interface DueCheckPage {
  checks: Website[];
  truncated: boolean;
}

const paginateDueChecks = async function* (now: number): AsyncGenerator<DueCheckPage> {
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (let page = 0; page < MAX_CHECK_QUERY_PAGES; page++) {
    let query = firestore
      .collection("checks")
      .where("nextCheckAt", "<=", now)
      .where("disabled", "==", false)
      .orderBy("nextCheckAt")
      .limit(CONFIG.MAX_WEBSITES_PER_RUN);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    const checks = snapshot.docs.map(doc => {
      const data = doc.data() as Website;
      return { ...data, id: doc.id };
    });

    const truncated = page === MAX_CHECK_QUERY_PAGES - 1 && snapshot.size === CONFIG.MAX_WEBSITES_PER_RUN;
    yield { checks, truncated };

    if (truncated || snapshot.size < CONFIG.MAX_WEBSITES_PER_RUN) {
      break;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }
};

interface TimeBudget {
  remaining(): number;
  exceeded(): boolean;
  shouldStartWork(): boolean;
}

const createTimeBudget = (): TimeBudget => {
  const start = Date.now();
  const configuredTimeoutMs =
    Number(process.env.FUNCTION_TIMEOUT_SEC ? Number(process.env.FUNCTION_TIMEOUT_SEC) * 1000 : DEFAULT_FUNCTION_TIMEOUT_MS);
  const maxDuration = Math.max(EXECUTION_TIME_BUFFER_MS * 2, configuredTimeoutMs - EXECUTION_TIME_BUFFER_MS);

  const remaining = () => Math.max(0, maxDuration - (Date.now() - start));
  return {
    remaining,
    exceeded: () => remaining() <= 0,
    shouldStartWork: () => remaining() >= MIN_TIME_FOR_NEW_BATCH_MS,
  };
};

const createLockHeartbeat = (lockId: string) => {
  let lastBeat = Date.now();
  return async () => {
    const now = Date.now();
    if (now - lastBeat < CHECK_RUN_LOCK_HEARTBEAT_MS) {
      return;
    }
    lastBeat = now;
    try {
      await extendCheckRunLock(lockId);
    } catch (error) {
      logger.warn("Failed to refresh check run lock heartbeat", error);
    }
  };
};

interface CheckRunStats {
  totalChecked: number;
  totalUpdated: number;
  totalFailed: number;
  totalSkipped: number;
  totalNoChanges: number;
  totalAutoDisabled: number;
  totalOnline: number;
  totalOffline: number;
}

interface ProcessChecksOptions {
  checks: Website[];
  batchSize: number;
  maxConcurrentChecks: number;
  timeBudget: TimeBudget;
  getUserSettings: (userId: string) => Promise<AlertSettingsCache>;
  enqueueHistoryRecord: (record: BigQueryCheckHistory) => Promise<void>;
  throttleCache: Set<string>;
  budgetCache: Map<string, number>;
  stats: CheckRunStats;
  heartbeat: () => Promise<void>;
}

interface HistoryFailureMeta {
  failures: number;
  firstFailureAt: number;
  nextRetryAt: number;
  lastErrorMessage?: string;
}

const processCheckBatches = async ({
  checks,
  batchSize,
  maxConcurrentChecks,
  timeBudget,
  getUserSettings,
  enqueueHistoryRecord,
  throttleCache,
  budgetCache,
  stats,
  heartbeat,
}: ProcessChecksOptions): Promise<{ aborted: boolean }> => {
  if (checks.length === 0) {
    return { aborted: false };
  }
  if (schedulerShutdownRequested) {
    logger.warn("Scheduler shutdown requested; skipping batch processing");
    return { aborted: true };
  }

  const allBatches: Website[][] = [];
  for (let i = 0; i < checks.length; i += batchSize) {
    const batch = checks.slice(i, i + batchSize);
    allBatches.push(batch);
  }

  const maxParallelBatches = Math.max(1, Math.ceil(maxConcurrentChecks / 50));
  let abortedForTime = false;

  for (let batchGroup = 0; batchGroup < allBatches.length; batchGroup += maxParallelBatches) {
    if (schedulerShutdownRequested) {
      logger.warn("Scheduler shutdown requested; aborting remaining batch groups");
      return { aborted: true };
    }
    if (!timeBudget.shouldStartWork()) {
      logger.warn(`Time budget nearly exhausted (${timeBudget.remaining()}ms remaining); deferring remaining batches`);
      return { aborted: true };
    }

    const parallelBatches = allBatches.slice(batchGroup, batchGroup + maxParallelBatches);

    const batchResults = await Promise.allSettled(
      parallelBatches.map(async (batch) => {
        const batchPromises: PromiseSettledResult<
          { id: string; status: string; responseTime?: number | null; skipped?: boolean; reason?: string }
        >[] = [];

        for (let j = 0; j < batch.length; j += maxConcurrentChecks) {
          if (schedulerShutdownRequested) {
            logger.warn("Scheduler shutdown requested; aborting in-flight batch work");
            abortedForTime = true;
            return batchPromises;
          }
          if (!timeBudget.shouldStartWork()) {
            logger.warn(`Time budget nearly exhausted (${timeBudget.remaining()}ms remaining); deferring remaining checks`);
            abortedForTime = true;
            return batchPromises;
          }

          const concurrentBatch = batch.slice(j, j + maxConcurrentChecks);
          const promises = concurrentBatch.map(async (check) => {
            if (schedulerShutdownRequested) {
              return { id: check.id, skipped: true, reason: "shutdown", status: check.status ?? "unknown" };
            }
            if (check.disabled) {
              return { id: check.id, skipped: true, reason: "disabled", status: check.status ?? "unknown" };
            }

            if (check.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES && !check.disabled) {
              await addStatusUpdate(check.id, {
                disabled: true,
                disabledAt: Date.now(),
                disabledReason: "Too many consecutive failures, automatically disabled",
                updatedAt: Date.now(),
                lastChecked: Date.now(),
              });
              return { id: check.id, skipped: true, reason: "auto-disabled-failures", status: check.status ?? "unknown" };
            }

            if (CONFIG.shouldDisableWebsite(check)) {
              await addStatusUpdate(check.id, {
                disabled: true,
                disabledAt: Date.now(),
                disabledReason: "Auto-disabled after extended downtime",
                updatedAt: Date.now(),
                lastChecked: Date.now(),
              });
              return { id: check.id, skipped: true, reason: "auto-disabled", status: check.status ?? "unknown" };
            }

            try {
              const now = Date.now();
              const checkResult = await checkRestEndpoint(check);
              let status = checkResult.status;
              const responseTime = checkResult.responseTime;
              const prevConsecutiveFailures = Number(check.consecutiveFailures || 0);
              const prevConsecutiveSuccesses = Number((check as Website & { consecutiveSuccesses?: number }).consecutiveSuccesses || 0);
              
              // For timeouts (statusCode -1) and server errors (5xx), require multiple consecutive failures
              // before marking as offline. This prevents false positives for transient issues.
              const isTimeout = checkResult.statusCode === -1;
              const isServerError = checkResult.statusCode >= 500 && checkResult.statusCode < 600;
              const isReachableWithError = checkResult.detailedStatus === 'REACHABLE_WITH_ERROR';
              const TRANSIENT_ERROR_THRESHOLD = 2; // Require 2 consecutive transient errors before marking as offline
              
              // Track consecutive failures for transient errors even if we keep status as online
              let nextConsecutiveFailures: number;
              let nextConsecutiveSuccesses: number;
              let suppressedTransientFailure = false;
              
              // IMMEDIATE RE-CHECK: Determine if we should schedule immediate re-check
              // This is calculated early so we can use it in all code paths below
              const immediateRecheckEnabled = check.immediateRecheckEnabled !== false; // Default to true
              // Handle edge cases: if lastChecked is 0/undefined or in the future, treat as not recent (allow immediate re-check)
              const lastCheckedTime = check.lastChecked || 0;
              // DEFENSIVE: Handle future timestamps (shouldn't happen but protect against clock skew/bugs)
              const timeSinceLastCheck = lastCheckedTime > 0 && lastCheckedTime <= now 
                ? now - lastCheckedTime 
                : Infinity;
              const isRecentCheck = timeSinceLastCheck < CONFIG.IMMEDIATE_RECHECK_WINDOW_MS;
              
              // CRITICAL: Handle transient errors (timeouts/server errors) to prevent false positive alerts
              // Timeouts are always REACHABLE_WITH_ERROR, but we check both conditions for safety
              if ((isTimeout || isServerError) && status === "offline" && isReachableWithError) {
                // If this is the first transient error, keep status as "online" but track the failure
                // Only mark as "offline" after multiple consecutive transient errors
                const errorCount = prevConsecutiveFailures + 1;
                if (errorCount < TRANSIENT_ERROR_THRESHOLD) {
                  suppressedTransientFailure = true;
                  status = "online"; // Keep as online for first transient error(s) - prevents false positive alerts
                  nextConsecutiveFailures = errorCount; // Still track the error
                  nextConsecutiveSuccesses = 0; // Reset success counter
                  const errorType = isTimeout ? "timeout" : `${checkResult.statusCode} error`;
                  logger.info(`${errorType} detected for ${check.url} but keeping status as online (${errorCount}/${TRANSIENT_ERROR_THRESHOLD} consecutive errors)`);
                } else {
                  // Enough consecutive transient errors - mark as offline
                  // CRITICAL: Explicitly set status to offline when threshold is reached
                  status = "offline";
                  nextConsecutiveFailures = errorCount;
                  nextConsecutiveSuccesses = 0;
                }
              } else if (isTimeout && status === "offline") {
                // DEFENSIVE: Handle timeout case even if detailedStatus is missing (shouldn't happen but be safe)
                // This ensures timeouts are always treated as transient errors to prevent false positives
                const errorCount = prevConsecutiveFailures + 1;
                if (errorCount < TRANSIENT_ERROR_THRESHOLD) {
                  suppressedTransientFailure = true;
                  status = "online"; // Keep as online for first timeout(s) - prevents false positive alerts
                  nextConsecutiveFailures = errorCount;
                  nextConsecutiveSuccesses = 0;
                  logger.info(`Timeout detected for ${check.url} but keeping status as online (${errorCount}/${TRANSIENT_ERROR_THRESHOLD} consecutive errors)`);
                } else {
                  // Enough consecutive transient errors - mark as offline
                  // CRITICAL: Explicitly set status to offline when threshold is reached
                  status = "offline";
                  nextConsecutiveFailures = errorCount;
                  nextConsecutiveSuccesses = 0;
                }
              } else {
                // Normal failure/success logic
                nextConsecutiveFailures = status === "offline" ? prevConsecutiveFailures + 1 : 0;
                nextConsecutiveSuccesses = status === "online" ? prevConsecutiveSuccesses + 1 : 0;
              }

              await enqueueHistoryRecord(createCheckHistoryRecord(check, checkResult));

              // IMMEDIATE RE-CHECK FEATURE: For any non-UP status (>= 300), schedule immediate re-check
              // to verify if it was a transient glitch before alerting. Only on first failure.
              // CRITICAL: Check original checkResult.status, not modified status variable, since transient
              // error handling may have changed status to "online" to prevent false positive alerts.
              // We still want to schedule immediate re-check even if status was changed to "online".
              // Note: Redirects (3xx) return status "online" but statusCode >= 300, so we include them
              // as they might indicate a change worth verifying (e.g., site moved from 200 to 301).
              const originalStatusWasOffline = checkResult.status === "offline";
              // Include all status codes >= 300 (3xx redirects, 4xx client errors, 5xx server errors)
              // Also include negative codes like -1 (timeout) which are < 300 but indicate issues
              const hasNonUpStatusCode = checkResult.statusCode >= 300 || checkResult.statusCode < 0;
              const isNonUpStatus = originalStatusWasOffline || hasNonUpStatusCode;
              // CRITICAL: Only schedule immediate re-check if this is truly the FIRST failure in a sequence
              // This means consecutiveFailures must go from 0 to 1. If it was already > 0, we're in an ongoing
              // failure sequence and should use normal scheduling.
              const isFirstFailure = nextConsecutiveFailures === 1 && prevConsecutiveFailures === 0;
              
              // Calculate nextCheckAt - use immediate re-check if conditions are met
              let nextCheckAt: number;
              if (immediateRecheckEnabled && isNonUpStatus && isFirstFailure && !isRecentCheck) {
                // Schedule immediate re-check to verify if this was a transient glitch
                nextCheckAt = now + CONFIG.IMMEDIATE_RECHECK_DELAY_MS;
                logger.info(`Scheduling immediate re-check for ${check.url} in ${CONFIG.IMMEDIATE_RECHECK_DELAY_MS}ms (statusCode: ${checkResult.statusCode}, detailedStatus: ${checkResult.detailedStatus}, originalStatus: ${checkResult.status}, currentStatus: ${status})`);
              } else {
                // Normal schedule
                nextCheckAt = CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES, now);
              }

              const hasChanges =
                check.status !== status ||
                check.lastStatusCode !== checkResult.statusCode ||
                Math.abs((check.responseTime || 0) - responseTime) > 100 ||
                (check.detailedStatus || null) !== (checkResult.detailedStatus || null) ||
                (check.lastError ?? null) !== (
                  status === "offline"
                    ? (checkResult.error ?? null)
                    : (suppressedTransientFailure ? (checkResult.error ?? null) : null)
                );

              if (!hasChanges) {
                const noChangeUpdate: Partial<Website> & {
                  lastChecked: number;
                  updatedAt: number;
                  nextCheckAt: number;
                  consecutiveFailures: number;
                  consecutiveSuccesses: number;
                  pendingDownEmail?: boolean;
                  pendingDownSince?: number | null;
                  pendingUpEmail?: boolean;
                  pendingUpSince?: number | null;
                } = {
                  lastChecked: now,
                  updatedAt: now,
                  nextCheckAt: nextCheckAt,
                  consecutiveFailures: nextConsecutiveFailures,
                  consecutiveSuccesses: nextConsecutiveSuccesses,
                };

                if (status === "offline" && (check as Website & { pendingDownEmail?: boolean }).pendingDownEmail) {
                  const settings = await getUserSettings(check.userId);
                  const result = await triggerAlert(
                    check,
                    "online",
                    "offline",
                    { consecutiveFailures: nextConsecutiveFailures },
                    { settings, throttleCache, budgetCache }
                  );
                  if (result.delivered) {
                    noChangeUpdate.pendingDownEmail = false;
                    noChangeUpdate.pendingDownSince = null;
                  } else if (shouldRetryAlert(result.reason)) {
                    noChangeUpdate.pendingDownEmail = true;
                    if (!(check as Website & { pendingDownSince?: number }).pendingDownSince) noChangeUpdate.pendingDownSince = now;
                  }
                }
                if (status === "online" && (check as Website & { pendingUpEmail?: boolean }).pendingUpEmail) {
                  const settings = await getUserSettings(check.userId);
                  const result = await triggerAlert(
                    check,
                    "offline",
                    "online",
                    { consecutiveSuccesses: nextConsecutiveSuccesses },
                    { settings, throttleCache, budgetCache }
                  );
                  if (result.delivered) {
                    noChangeUpdate.pendingUpEmail = false;
                    noChangeUpdate.pendingUpSince = null;
                  } else if (shouldRetryAlert(result.reason)) {
                    noChangeUpdate.pendingUpEmail = true;
                    if (!(check as Website & { pendingUpSince?: number }).pendingUpSince) noChangeUpdate.pendingUpSince = now;
                  }
                }
                await addStatusUpdate(check.id, noChangeUpdate);
                return { id: check.id, status, responseTime, skipped: true, reason: "no-changes" };
              }

              const updateData: Partial<Website> & {
                status: string;
                lastChecked: number;
                updatedAt: number;
                responseTime?: number | null | undefined;
                lastStatusCode?: number;
                consecutiveFailures: number;
                consecutiveSuccesses: number;
                detailedStatus?: string;
                nextCheckAt: number;
                sslCertificate?: {
                  valid: boolean;
                  lastChecked: number;
                  issuer?: string;
                  subject?: string;
                  validFrom?: number;
                  validTo?: number;
                  daysUntilExpiry?: number;
                  error?: string;
                };
                downtimeCount?: number;
                lastDowntime?: number;
                lastFailureTime?: number;
                lastError?: string | null | undefined;
                uptimeCount?: number;
                lastUptime?: number;
                pendingDownEmail?: boolean;
                pendingDownSince?: number | null;
                pendingUpEmail?: boolean;
                pendingUpSince?: number | null;
              } = {
                status,
                lastChecked: now,
                updatedAt: now,
                responseTime: status === "online" ? responseTime : undefined,
                lastStatusCode: checkResult.statusCode,
                consecutiveFailures: nextConsecutiveFailures,
                consecutiveSuccesses: nextConsecutiveSuccesses,
                detailedStatus: checkResult.detailedStatus,
                nextCheckAt: nextCheckAt,
                lastError:
                  status === "offline"
                    ? (checkResult.error ?? null)
                    : (suppressedTransientFailure ? (checkResult.error ?? null) : null),
              };

              if (checkResult.sslCertificate) {
                const cleanSslData = {
                  valid: checkResult.sslCertificate.valid,
                  lastChecked: now,
                  ...(checkResult.sslCertificate.issuer ? { issuer: checkResult.sslCertificate.issuer } : {}),
                  ...(checkResult.sslCertificate.subject ? { subject: checkResult.sslCertificate.subject } : {}),
                  ...(checkResult.sslCertificate.validFrom ? { validFrom: checkResult.sslCertificate.validFrom } : {}),
                  ...(checkResult.sslCertificate.validTo ? { validTo: checkResult.sslCertificate.validTo } : {}),
                  ...(checkResult.sslCertificate.daysUntilExpiry !== undefined
                    ? { daysUntilExpiry: checkResult.sslCertificate.daysUntilExpiry }
                    : {}),
                  ...(checkResult.sslCertificate.error ? { error: checkResult.sslCertificate.error } : {}),
                };
                updateData.sslCertificate = cleanSslData;
                const settings = await getUserSettings(check.userId);
                await triggerSSLAlert(check, checkResult.sslCertificate, { settings, throttleCache, budgetCache });
              }

              if (checkResult.domainExpiry) {
                const cleanDomainData = {
                  valid: checkResult.domainExpiry.valid,
                  lastChecked: now,
                  ...(checkResult.domainExpiry.registrar ? { registrar: checkResult.domainExpiry.registrar } : {}),
                  ...(checkResult.domainExpiry.domainName ? { domainName: checkResult.domainExpiry.domainName } : {}),
                  ...(checkResult.domainExpiry.expiryDate ? { expiryDate: checkResult.domainExpiry.expiryDate } : {}),
                  ...(checkResult.domainExpiry.daysUntilExpiry !== undefined
                    ? { daysUntilExpiry: checkResult.domainExpiry.daysUntilExpiry }
                    : {}),
                  ...(checkResult.domainExpiry.error ? { error: checkResult.domainExpiry.error } : {}),
                };
                updateData.domainExpiry = cleanDomainData;

                const isExpired = !checkResult.domainExpiry.valid;
                const isExpiringSoon =
                  checkResult.domainExpiry.daysUntilExpiry !== undefined && checkResult.domainExpiry.daysUntilExpiry <= 30;

                if (isExpired || isExpiringSoon) {
                  const settings = await getUserSettings(check.userId);
                  await triggerDomainExpiryAlert(check, checkResult.domainExpiry, { settings, throttleCache, budgetCache });
                }
              }

              if (status === "offline") {
                updateData.downtimeCount = (Number(check.downtimeCount) || 0) + 1;
                updateData.lastDowntime = now;
                updateData.lastFailureTime = now;
                updateData.lastError = checkResult.error || null;
              } else {
                updateData.lastError = null;
              }

              // CRITICAL FIX: For alert determination, we need the ACTUAL last known status.
              // The issue: When checks run concurrently, the buffer can be updated by another check
              // before we read it, causing us to miss alerts. We need to be smarter about which
              // source to trust.
              // 
              // Strategy: Use whichever source (buffer or DB) has a DIFFERENT status from what we detected.
              // This ensures we always catch status changes, even if one source is stale.
              // Priority: buffer (if different) > database (if different) > detected status (if both match)
              const bufferedUpdate = statusUpdateBuffer.get(check.id);
              const dbStatus = check.status || "unknown";
              
              let oldStatus: string;
              const bufferStatus = bufferedUpdate?.status && bufferedUpdate.status.trim().length > 0
                ? bufferedUpdate.status
                : null;
              
              // Use whichever source differs from detected status (most reliable indicator of previous status)
              if (bufferStatus && bufferStatus !== status) {
                // Buffer has different status - use it (it's the previous status)
                oldStatus = bufferStatus;
              } else if (dbStatus !== status && dbStatus !== "unknown") {
                // Database has different status - use it (even if buffer matches, DB might be more accurate)
                oldStatus = dbStatus;
              } else {
                // Both match detected status - no change (or both sources are stale)
                oldStatus = status; // Will be caught by the check below
              }
              
              // Log for debugging - show what we're comparing
              if (oldStatus !== status) {
                const source = (bufferStatus && bufferStatus !== status) ? 'buffer' : 'DB';
                logger.info(`ALERT CHECK: Status change detected for ${check.name}: ${oldStatus} -> ${status} (source: ${source}, buffer had: ${bufferedUpdate?.status || 'none'}, DB had: ${check.status || 'unknown'})`);
              } else {
                logger.warn(`ALERT CHECK: No status change detected for ${check.name}: status is ${status} (buffer had: ${bufferedUpdate?.status || 'none'}, DB had: ${check.status || 'unknown'}) - If status actually changed, this is a MISSED ALERT`);
              }
              
              // If we suppressed a transient failure (e.g. first 5xx/timeout), emit a website_error alert
              // so users can be notified about 502/504 incidents without flipping the check to "offline".
              if (suppressedTransientFailure && isFirstFailure && !isRecentCheck) {
                const settings = await getUserSettings(check.userId);
                const websiteForAlert: Website = {
                  ...(check as Website),
                  status: "online",
                  detailedStatus: checkResult.detailedStatus,
                  lastStatusCode: checkResult.statusCode,
                  lastError: checkResult.error ?? null,
                  consecutiveFailures: nextConsecutiveFailures,
                  consecutiveSuccesses: nextConsecutiveSuccesses,
                };

                await triggerAlert(
                  websiteForAlert,
                  "online",
                  "online",
                  { consecutiveFailures: nextConsecutiveFailures, consecutiveSuccesses: nextConsecutiveSuccesses },
                  { settings, throttleCache, budgetCache }
                );
              }

              if (oldStatus !== status && oldStatus !== "unknown") {
                // Status changed - send alert only on actual transitions (DOWN to UP or UP to DOWN)
                // Clear any pending retry flags since we're sending a fresh alert
                if (status === "offline") {
                  updateData.pendingUpEmail = false;
                  updateData.pendingUpSince = null;
                } else if (status === "online") {
                  updateData.pendingDownEmail = false;
                  updateData.pendingDownSince = null;
                }
                
                const settings = await getUserSettings(check.userId);
                const result = await triggerAlert(
                  check,
                  oldStatus,
                  status,
                  { consecutiveFailures: nextConsecutiveFailures, consecutiveSuccesses: nextConsecutiveSuccesses },
                  { settings, throttleCache, budgetCache }
                );
                if (result.delivered) {
                  if (status === "offline") {
                    updateData.pendingDownEmail = false;
                    updateData.pendingDownSince = null;
                  } else if (status === "online") {
                    updateData.pendingUpEmail = false;
                    updateData.pendingUpSince = null;
                  }
                } else if (shouldRetryAlert(result.reason)) {
                  if (status === "offline") {
                    updateData.pendingDownEmail = true;
                    updateData.pendingDownSince = now;
                  } else if (status === "online") {
                    updateData.pendingUpEmail = true;
                    updateData.pendingUpSince = now;
                  }
                }
              } else {
                // Status didn't change - only retry previously failed alerts
                // This ensures we don't send duplicate alerts when status stays the same
                if (status === "offline" && (check as Website & { pendingDownEmail?: boolean }).pendingDownEmail) {
                  const settings = await getUserSettings(check.userId);
                  const result = await triggerAlert(
                    check,
                    "online",
                    "offline",
                    { consecutiveFailures: nextConsecutiveFailures },
                    { settings, throttleCache, budgetCache }
                  );
                  if (result.delivered) {
                    updateData.pendingDownEmail = false;
                    updateData.pendingDownSince = null;
                  } else if (shouldRetryAlert(result.reason)) {
                    updateData.pendingDownEmail = true;
                    if (!(check as Website & { pendingDownSince?: number }).pendingDownSince) {
                      updateData.pendingDownSince = now;
                    }
                  }
                }
                if (status === "online" && (check as Website & { pendingUpEmail?: boolean }).pendingUpEmail) {
                  const settings = await getUserSettings(check.userId);
                  const result = await triggerAlert(
                    check,
                    "offline",
                    "online",
                    { consecutiveSuccesses: nextConsecutiveSuccesses },
                    { settings, throttleCache, budgetCache }
                  );
                  if (result.delivered) {
                    updateData.pendingUpEmail = false;
                    updateData.pendingUpSince = null;
                  } else if (shouldRetryAlert(result.reason)) {
                    updateData.pendingUpEmail = true;
                    if (!(check as Website & { pendingUpSince?: number }).pendingUpSince) {
                      updateData.pendingUpSince = now;
                    }
                  }
                }
              }
              await addStatusUpdate(check.id, updateData);
              return { id: check.id, status, responseTime };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : "Unknown error";
              const now = Date.now();

              await enqueueHistoryRecord(
                createCheckHistoryRecord(check, {
                  status: "offline",
                  responseTime: 0,
                  statusCode: 0,
                  error: errorMessage,
                })
              );

              const hasChanges = check.status !== "offline" || check.lastError !== errorMessage;

              if (!hasChanges) {
                await addStatusUpdate(check.id, {
                  lastChecked: now,
                  updatedAt: now,
                  nextCheckAt: CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES, now),
                });
                return { id: check.id, status: "offline", error: errorMessage, skipped: true, reason: "no-changes" };
              }

              const updateData: Partial<Website> & {
                status: string;
                lastChecked: number;
                updatedAt: number;
                lastError: string;
                downtimeCount: number;
                lastDowntime: number;
                lastFailureTime: number;
                consecutiveFailures: number;
                consecutiveSuccesses: number;
                detailedStatus: string;
                nextCheckAt: number;
                pendingDownEmail?: boolean;
                pendingDownSince?: number | null;
              } = {
                status: "offline",
                lastChecked: now,
                updatedAt: now,
                lastError: errorMessage,
                downtimeCount: (Number(check.downtimeCount) || 0) + 1,
                lastDowntime: now,
                lastFailureTime: now,
                consecutiveFailures: (check.consecutiveFailures || 0) + 1,
                consecutiveSuccesses: 0,
                detailedStatus: "DOWN",
                nextCheckAt: CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES, now),
              };

              // CRITICAL: Check buffer first to get the most recent status before determining oldStatus
              // This prevents duplicate alerts when status updates are buffered (flushed every 30s)
              const bufferedUpdate = statusUpdateBuffer.get(check.id);
              const effectiveOldStatus = bufferedUpdate?.status && bufferedUpdate.status.trim().length > 0
                ? bufferedUpdate.status
                : (check.status || "unknown");
              
              const oldStatus = effectiveOldStatus;
              const newStatus = "offline";
              
              if (oldStatus !== newStatus && oldStatus !== "unknown") {
                const settings = await getUserSettings(check.userId);
                const result = await triggerAlert(
                  check,
                  oldStatus,
                  newStatus,
                  { consecutiveFailures: updateData.consecutiveFailures as number },
                  { settings, throttleCache, budgetCache }
                );
                if (result.delivered) {
                  updateData.pendingDownEmail = false;
                  updateData.pendingDownSince = null;
                } else if (result.reason === "flap") {
                  updateData.pendingDownEmail = true;
                  updateData.pendingDownSince = now;
                }
              }
              await addStatusUpdate(check.id, updateData);
              return { id: check.id, status: "offline", error: errorMessage };
            }
          });

          const results = await Promise.allSettled(promises);
          batchPromises.push(...results);

          if (j + maxConcurrentChecks < batch.length && CONFIG.CONCURRENT_BATCH_DELAY_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.CONCURRENT_BATCH_DELAY_MS));
          }
        }

        return batchPromises;
      })
    );

    if (abortedForTime) {
      return { aborted: true };
    }

    let batchGroupRejected = false;
    batchResults.forEach((batchResult, batchIndex) => {
      if (batchResult.status === "fulfilled") {
        const batchPromises = batchResult.value;
        const results = batchPromises
          .map(r => (r.status === "fulfilled" ? r.value : null))
          .filter((r): r is NonNullable<typeof r> => r !== null);
        const batchUpdated = results.filter(r => !r.skipped).length;
        const batchFailed = batchPromises.filter(r => r.status === "rejected").length;
        const batchSkipped = results.filter(r => r.skipped).length;
        const batchNoChanges = results.filter(r => r.skipped && r.reason === "no-changes").length;
        const batchAutoDisabled = results.filter(
          r => r.skipped && (r.reason === "auto-disabled" || r.reason === "auto-disabled-failures")
        ).length;
        const batchOnline = results.filter(r => !r.skipped && r.status === "online").length;
        const batchOffline = results.filter(r => !r.skipped && r.status === "offline").length;

        stats.totalChecked += results.length + batchFailed;
        stats.totalUpdated += batchUpdated;
        stats.totalFailed += batchFailed;
        stats.totalSkipped += batchSkipped;
        stats.totalNoChanges += batchNoChanges;
        stats.totalAutoDisabled += batchAutoDisabled;
        stats.totalOnline += batchOnline;
        stats.totalOffline += batchOffline;
      } else {
        batchGroupRejected = true;
        logger.error(`Batch group ${batchGroup + batchIndex} execution failed; aborting pending checks`, batchResult.reason);
      }
    });

    if (batchGroupRejected) {
      throw new Error("Aborting check run after batch execution failure");
    }

    if (batchGroup + maxParallelBatches < allBatches.length && CONFIG.BATCH_DELAY_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY_MS));
    }

    await heartbeat();
  }

  return { aborted: false };
};

export const checkAllChecks = onSchedule({
  schedule: `every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`,
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async () => {
  ensureSchedulerShutdownHandlers();
  schedulerShutdownRequested = false;
  const lockId = createRunLockId();
  const lockAcquired = await acquireCheckRunLock(lockId);
  if (!lockAcquired) {
    logger.warn("Skipping check run because another instance is already processing checks");
    return;
  }
  schedulerActiveLockId = lockId;

  try {
    await drainQueuedWebhookRetries();
  } catch (error) {
    logger.warn("Failed to drain webhook retries at start of run", error);
  }

  const timeBudget = createTimeBudget();
  const heartbeat = createLockHeartbeat(lockId);

  try {
    const historyInsertTasks: Promise<void>[] = [];
    const historyFailureTracker = new Map<string, HistoryFailureMeta>();
    const HISTORY_PROMISE_BATCH_SIZE = 100;

    const flushPendingHistoryTasks = async () => {
      if (historyInsertTasks.length === 0) return;
      const pending = historyInsertTasks.splice(0, historyInsertTasks.length);
      const results = await Promise.allSettled(pending);
      results.forEach(result => {
        if (result.status === "rejected") {
          const failure = result.reason as { record: BigQueryCheckHistory; error: unknown; attempts: number } | undefined;
          logger.error(
            `History enqueue task failed for ${failure?.record?.website_id ?? "unknown check"} after ${failure?.attempts ?? 0} attempts`,
            failure?.error ?? result.reason
          );
        }
      });
    };

    let streamedHistoryCount = 0;
    let historyEnqueueFailures = 0;

    const clearHistoryFailure = (recordId: string) => {
      historyFailureTracker.delete(recordId);
    };

    const recordHistoryFailure = (
      record: BigQueryCheckHistory,
      error: unknown
    ): { action: "retry" | "drop"; failures: number; delay?: number } => {
      const now = Date.now();
      const previous = historyFailureTracker.get(record.id);
      const failures = (previous?.failures ?? 0) + 1;
      const delay = Math.min(
        HISTORY_RETRY_INITIAL_DELAY_MS * Math.pow(2, failures - 1),
        HISTORY_RETRY_MAX_DELAY_MS
      );
      const meta: HistoryFailureMeta = {
        failures,
        firstFailureAt: previous?.firstFailureAt ?? now,
        nextRetryAt: now + delay,
        lastErrorMessage: (error as Error)?.message,
      };
      historyFailureTracker.set(record.id, meta);

      if (failures === 1 || failures === 3 || failures === 5 || failures >= MAX_HISTORY_ENQUEUE_ATTEMPTS) {
        if (meta.lastErrorMessage) {
          logger.warn(
            `History buffer enqueue failed ${failures} time(s) for ${record.website_id}; retrying in ${delay}ms`,
            { error: meta.lastErrorMessage }
          );
        } else {
          logger.warn(
            `History buffer enqueue failed ${failures} time(s) for ${record.website_id}; retrying in ${delay}ms`
          );
        }
      }

      if (failures >= MAX_HISTORY_ENQUEUE_ATTEMPTS || now - meta.firstFailureAt >= HISTORY_FAILURE_TIMEOUT_MS) {
        historyFailureTracker.delete(record.id);
        logger.error(
          `Dropping history record ${record.website_id} after ${failures} failed enqueue attempts`,
          error
        );
        return { action: "drop", failures };
      }

      return { action: "retry", failures, delay };
    };

    const bufferHistoryRecord = async (record: BigQueryCheckHistory): Promise<void> => {
      // Loop to avoid deep recursion if Firestore/BigQuery is unavailable for a long time.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await insertCheckHistory(record);
          clearHistoryFailure(record.id);
          return;
        } catch (error) {
          const failure = recordHistoryFailure(record, error);
          if (failure.action === "drop") {
            historyEnqueueFailures += 1;
            throw { record, error, attempts: failure.failures };
          }

          if (schedulerShutdownRequested) {
            logger.warn(
              `Aborting history retry for ${record.website_id} because scheduler is shutting down`,
              { attempts: failure.failures }
            );
            throw { record, error, attempts: failure.failures };
          }

          const baseDelay = Math.max(failure.delay ?? HISTORY_RETRY_INITIAL_DELAY_MS, 0);
          const jitter = Math.floor(baseDelay * 0.25 * Math.random());
          await sleep(baseDelay + jitter);
        }
      }
    };

    schedulerCleanupFn = async () => {
      await flushPendingHistoryTasks();
      await flushBigQueryInserts();
      await flushStatusUpdates();
    };
    if ((schedulerShutdownRequested || schedulerSignalPendingCleanup) && !schedulerSignalCleanupTriggered) {
      initiateSchedulerCleanupSequence();
    }

    let runSucceeded = false;
    let cleanupSucceeded = false;
    let failureRecorded = false;

    const recordCircuitFailure = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).__failureCount = ((global as any).__failureCount || 0) + 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger.error(`Circuit breaker failure count: ${(global as any).__failureCount}`);
      failureRecorded = true;
    };

    try {
      // CACHE: Store user settings to avoid redundant reads
      const userSettingsCache = new Map<string, Promise<AlertSettingsCache>>();
      // NEW: In-memory throttle/budget caches for this run
      const throttleCache = new Set<string>();
      const budgetCache = new Map<string, number>();
      
    // Stream history rows into BigQuery buffer as they are produced without blocking checks
    const enqueueHistoryRecord = async (record: BigQueryCheckHistory) => {
      streamedHistoryCount += 1;
      if (streamedHistoryCount === 1 || streamedHistoryCount % 200 === 0) {
        logger.info(`Buffered ${streamedHistoryCount} history records this run`);
      }

      const task = bufferHistoryRecord(record);
      historyInsertTasks.push(task);

      if (historyInsertTasks.length >= HISTORY_PROMISE_BATCH_SIZE) {
        await flushPendingHistoryTasks();
      }
    };
    
    const getUserSettings = (userId: string): Promise<AlertSettingsCache> => {
      if (userSettingsCache.has(userId)) {
        return userSettingsCache.get(userId)!;
      }

      const promise = (async () => {
        try {
          // Run queries in parallel
          const [emailDoc, webhooksSnapshot] = await Promise.all([
            firestore.collection('emailSettings').doc(userId).get(),
            firestore.collection('webhooks').where("userId", "==", userId).where("enabled", "==", true).get()
          ]);

          const email = emailDoc.exists ? (emailDoc.data() as EmailSettings) : null;
          const webhooks = webhooksSnapshot.docs.map(d => d.data() as WebhookSettings);

          return { email, webhooks };
        } catch (err) {
          logger.error(`Failed to load settings for user ${userId}`, err);
          return { email: null, webhooks: [] };
        }
      })();

      userSettingsCache.set(userId, promise);
      return promise;
    };
    
    // Initialize status flush interval if not already running
    if (!statusFlushInterval) {
      initializeStatusFlush();
    }

    // Circuit breaker: Check if we're in a failure state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failureCount = (global as any).__failureCount || 0;
    if (failureCount > 5) {
      logger.error(`Circuit breaker open: ${failureCount} consecutive failures. Skipping this run.`);
      return;
    }

    const now = Date.now();
    let backlogDetected = false;
    let shutdownTriggeredDuringRun = false;
    let scheduledChecks = 0;
    let processedPages = 0;
    let lastBatchSize = CONFIG.getOptimalBatchSize(0);
    let lastMaxConcurrentChecks = CONFIG.getDynamicConcurrency(0);

    const stats: CheckRunStats = {
      totalChecked: 0,
      totalUpdated: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalNoChanges: 0,
      totalAutoDisabled: 0,
      totalOnline: 0,
      totalOffline: 0,
    };

    for await (const { checks: pageChecks, truncated } of paginateDueChecks(now)) {
      if (schedulerShutdownRequested) {
        backlogDetected = true;
        shutdownTriggeredDuringRun = true;
        logger.warn("Scheduler shutdown requested; deferring remaining due checks to next run");
        break;
      }
      if (timeBudget.exceeded()) {
        backlogDetected = true;
        logger.warn("Exceeded time budget before processing all due checks; deferring remainder");
        break;
      }

      if (pageChecks.length === 0) {
        continue;
      }

      processedPages += 1;
      backlogDetected ||= truncated;
      scheduledChecks += pageChecks.length;

      if (!timeBudget.shouldStartWork()) {
        backlogDetected = true;
        logger.warn(`Only ${timeBudget.remaining()}ms remaining; deferring ${pageChecks.length} queued checks`);
        break;
      }

      lastBatchSize = CONFIG.getOptimalBatchSize(scheduledChecks);
      lastMaxConcurrentChecks = CONFIG.getDynamicConcurrency(scheduledChecks);

      const { aborted } = await processCheckBatches({
        checks: pageChecks,
        batchSize: lastBatchSize,
        maxConcurrentChecks: lastMaxConcurrentChecks,
        timeBudget,
        getUserSettings,
        enqueueHistoryRecord,
        throttleCache,
        budgetCache,
        stats,
        heartbeat,
      });

      if (aborted) {
        backlogDetected = true;
        if (schedulerShutdownRequested) {
          shutdownTriggeredDuringRun = true;
        }
        break;
      }
    }

    if (scheduledChecks === 0) {
      logger.info("No checks need checking");
      return;
    }

    logger.info(`Starting check: ${scheduledChecks} checks across ${processedPages} page(s)`);
    if (backlogDetected) {
      logger.warn(
        `Due check backlog exceeds ${CONFIG.MAX_WEBSITES_PER_RUN * MAX_CHECK_QUERY_PAGES} documents or hit time budget; remaining work will run on the next tick`
      );
    }

    logger.info(`Performance settings: batchSize=${lastBatchSize}, concurrency=${lastMaxConcurrentChecks}`);

    // Ensure history enqueues complete before flushing buffer
    await flushPendingHistoryTasks();
    // CRITICAL FIX: Flush remaining buffers before function exits
    await flushBigQueryInserts();
    await flushStatusUpdates();

    // COMPREHENSIVE SUMMARY LOGGING
    const efficiency = stats.totalChecked > 0 ? Math.round((stats.totalNoChanges / stats.totalChecked) * 100) : 0;
    const uptime = stats.totalUpdated > 0 ? Math.round((stats.totalOnline / stats.totalUpdated) * 100) : 0;

    logger.info(`Run complete: ${stats.totalChecked} checked, ${stats.totalUpdated} updated, ${stats.totalFailed} failed`);
    logger.info(
      `Efficiency: ${efficiency}% no-changes, ${stats.totalSkipped} skipped (${stats.totalAutoDisabled} auto-disabled)`
    );
    logger.info(`Status: ${stats.totalOnline} online (${uptime}%), ${stats.totalOffline} offline`);
    logger.info(
      `History buffering: ${streamedHistoryCount} enqueue attempts, ${historyEnqueueFailures} failures`
    );
    if (shutdownTriggeredDuringRun) {
      logger.warn("Check run exited early in response to shutdown signal; all buffers flushed before exit");
    }

    // Log warnings for significant issues
    if (stats.totalFailed > 0) {
      logger.warn(`High failure rate: ${stats.totalFailed} failures out of ${stats.totalChecked} checks`);
    }
    if (stats.totalAutoDisabled > 0) {
      logger.warn(`Auto-disabled ${stats.totalAutoDisabled} dead sites`);
    }

    runSucceeded = true;
  } catch (error) {
    logger.error("Error in checkAllWebsites:", error);

    if (!failureRecorded) {
      recordCircuitFailure();
    }
  } finally {
    try {
      if (schedulerCleanupInFlight) {
        await schedulerCleanupInFlight;
      } else {
        await flushPendingHistoryTasks();
        // Ensure any buffered updates are written before the function exits
        await flushBigQueryInserts();
        await flushStatusUpdates();
      }
      cleanupSucceeded = true;
    } catch (cleanupError) {
      logger.error("Error during cleanup in checkAllWebsites:", cleanupError);
      if (!failureRecorded) {
        recordCircuitFailure();
      }
      // eslint-disable-next-line no-unsafe-finally
      throw cleanupError;
    } finally {
      schedulerCleanupFn = null;
      schedulerCleanupInFlight = null;
    }
  }

  if (runSucceeded && cleanupSucceeded) {
    // Circuit breaker: Reset on successful completion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).__failureCount = 0;
  }
  } finally {
    if (schedulerActiveLockId === lockId) {
      await releaseCheckRunLock(lockId);
    }
    schedulerActiveLockId = null;
    schedulerShutdownRequested = false;
    schedulerSignalPendingCleanup = false;
    schedulerSignalCleanupTriggered = false;
  }
});

// Simulated uptime/downtime endpoint
export const timeBasedDowntime = onRequest((req, res) => {
  const currentMinute = new Date().getMinutes();
  // 2 minutes offline, then 2 minutes online (4-minute cycle)
  // Minutes 0-1: offline, Minutes 2-3: online, Minutes 4-5: offline, etc.
  if ((currentMinute % 4) < 2) {
    res.status(503).send('Offline');
  } else {
    res.status(200).send('Online');
  }
});

// Simulated uptime/downtime endpoint - 10 minutes up, 10 minutes down
export const timeBasedDowntime10Min = onRequest((req, res) => {
  const currentMinute = new Date().getMinutes();
  // 10 minutes online, then 10 minutes offline (20-minute cycle)
  // Minutes 0-9: online, Minutes 10-19: offline, Minutes 20-29: online, etc.
  if ((currentMinute % 20) < 10) {
    res.status(200).send('Online');
  } else {
    res.status(503).send('Offline');
  }
});

// Simulated 502 endpoint (useful for testing "website_error" alerts without relying on a real proxy/gateway)
export const always502BadGateway = onRequest((req, res) => {
  res.status(502).send('Bad Gateway');
});

// Callable function to add a check or REST endpoint
export const addCheck = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  try {
    logger.info('addCheck function called with data:', JSON.stringify(request.data));

    const {
      url,
      name,
      checkFrequency,
      type = 'website',
      httpMethod = 'GET',
      expectedStatusCodes = [200, 201, 202],
      requestHeaders = {},
      requestBody = '',
      responseValidation = {}
    } = request.data || {};

    logger.info('Parsed data:', { url, name, checkFrequency, type });

    const uid = request.auth?.uid;
    if (!uid) {
      throw new Error("Authentication required");
    }

    logger.info('User authenticated:', uid);

    // SPAM PROTECTION: Check user's current check count
    const userChecks = await firestore.collection("checks").where("userId", "==", uid).get();

    logger.info('User checks count:', userChecks.size);

    // Enforce maximum checks per user
    if (userChecks.size >= CONFIG.MAX_CHECKS_PER_USER) {
      throw new Error(`You have reached the maximum limit of ${CONFIG.MAX_CHECKS_PER_USER} checks. Please delete some checks before adding new ones.`);
    }

    // RATE LIMITING: Check recent additions
    const now = Date.now();
    const oneMinuteAgo = now - (60 * 1000);
    const oneHourAgo = now - (60 * 60 * 1000);
    const oneDayAgo = now - (24 * 60 * 60 * 1000);

    const recentChecks = userChecks.docs.filter(doc => {
      const createdAt = doc.data().createdAt;
      return createdAt >= oneMinuteAgo || createdAt >= oneHourAgo || createdAt >= oneDayAgo;
    });

    const checksLastMinute = recentChecks.filter(doc => doc.data().createdAt >= oneMinuteAgo).length;
    const checksLastHour = recentChecks.filter(doc => doc.data().createdAt >= oneHourAgo).length;
    const checksLastDay = recentChecks.filter(doc => doc.data().createdAt >= oneDayAgo).length;

    if (checksLastMinute >= CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE) {
      throw new Error(`Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE} checks per minute. Please wait before adding more.`);
    }

    if (checksLastHour >= CONFIG.RATE_LIMIT_CHECKS_PER_HOUR) {
      throw new Error(`Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_HOUR} checks per hour. Please wait before adding more.`);
    }

    if (checksLastDay >= CONFIG.RATE_LIMIT_CHECKS_PER_DAY) {
      throw new Error(`Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_DAY} checks per day. Please wait before adding more.`);
    }

    // URL VALIDATION: Enhanced validation with spam protection
    const urlValidation = CONFIG.validateUrl(url);
    if (!urlValidation.valid) {
      throw new Error(`URL validation failed: ${urlValidation.reason}`);
    }

    logger.info('URL validation passed');

    // Validate REST endpoint parameters
    if (type === 'rest_endpoint') {
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(httpMethod)) {
        throw new Error("Invalid HTTP method. Must be one of: GET, POST, PUT, PATCH, DELETE, HEAD");
      }

      if (['POST', 'PUT', 'PATCH'].includes(httpMethod) && requestBody) {
        try {
          JSON.parse(requestBody);
        } catch {
          throw new Error("Request body must be valid JSON");
        }
      }

      if (!Array.isArray(expectedStatusCodes) || expectedStatusCodes.length === 0) {
        throw new Error("Expected status codes must be a non-empty array");
      }
    }

    // SUSPICIOUS PATTERN DETECTION: Check for spam patterns
    const existingChecks = userChecks.docs.map(doc => {
      const data = doc.data();
      return {
        url: data.url,
        name: data.name || data.url
      };
    });

    const patternCheck = CONFIG.detectSuspiciousPatterns(existingChecks, url, name);
    if (patternCheck.suspicious) {
      throw new Error(`Suspicious pattern detected: ${patternCheck.reason}. Please contact support if this is a legitimate use case.`);
    }

    // Check for duplicates within the same user and type
    const existing = await firestore.collection("checks").where("userId", "==", uid).where("url", "==", url).where("type", "==", type).get();
    if (!existing.empty) {
      const typeLabel = type === 'rest_endpoint' ? 'API' : 'website';
      throw new Error(`Check URL already exists in your ${typeLabel} list`);
    }

    logger.info('Duplicate check validation passed');

    // Get user tier and determine check frequency (use provided frequency or fall back to tier-based)
    const userTier = await getUserTier(uid);
    logger.info('User tier:', userTier);

    // We don't differentiate interval by tier; default to the global scheduler cadence.
    const finalCheckFrequency = checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES;
    logger.info('Final check frequency:', finalCheckFrequency);

    // Get the highest orderIndex to add new check at the top
    const maxOrderIndex = userChecks.docs.length > 0
      ? Math.max(...userChecks.docs.map(doc => doc.data().orderIndex || 0))
      : -1;

    logger.info('Max order index:', maxOrderIndex);

    // Add check with new cost optimization fields
    const docRef = await withFirestoreRetry(() =>
      firestore.collection("checks").add({
        url,
        name: name || url,
        userId: uid,
        userTier,
        checkFrequency: finalCheckFrequency,
        consecutiveFailures: 0,
        lastFailureTime: null,
        disabled: false,
        immediateRecheckEnabled: true, // Default to enabled for new checks
        createdAt: now,
        updatedAt: now,
        downtimeCount: 0,
        lastDowntime: null,
        status: "unknown",
        lastChecked: 0, // Will be checked on next scheduled run
        nextCheckAt: now, // Check immediately on next scheduler run
        orderIndex: maxOrderIndex + 1, // Add to top of list
        type,
        httpMethod,
        expectedStatusCodes,
        requestHeaders,
        requestBody,
        responseValidation
      })
    );

    logger.info(`Check added successfully: ${url} by user ${uid} (${userChecks.size + 1}/${CONFIG.MAX_CHECKS_PER_USER} total checks)`);

    return { id: docRef.id };
  } catch (error) {
    logger.error('Error in addCheck function:', error);
    throw error; // Re-throw to maintain the original error response
  }
});

// Callable function to get all checks for a user
export const getChecks = onCall({
  cors: true, // Enable CORS for this function
  maxInstances: 10, // Limit concurrent instances
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    const checksSnapshot = await firestore
      .collection("checks")
      .where("userId", "==", uid)
      .orderBy("orderIndex", "asc")
      .get();

    const checks = checksSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Website[];

    // Sort checks: those with orderIndex first, then by createdAt
    const sortedChecks = checks.sort((a, b) => {
      if (a.orderIndex !== undefined && b.orderIndex !== undefined) {
        return a.orderIndex - b.orderIndex;
      }
      if (a.orderIndex !== undefined) return -1;
      if (b.orderIndex !== undefined) return 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    return {
      success: true,
      data: sortedChecks,
      count: sortedChecks.length
    };
  } catch (error) {
    logger.error(`Failed to get checks for user ${uid}:`, error);
    throw new Error(`Failed to get checks: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});



// Callable function to update a check or REST endpoint
export const updateCheck = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const {
    id,
    url,
    name,
    checkFrequency,
    type,
    httpMethod,
    expectedStatusCodes,
    requestHeaders,
    requestBody,
    responseValidation,
    immediateRecheckEnabled
  } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Check ID required");
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  // Validate REST endpoint parameters if provided
  if (type === 'rest_endpoint') {
    if (httpMethod && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(httpMethod)) {
      throw new Error("Invalid HTTP method. Must be one of: GET, POST, PUT, PATCH, DELETE, HEAD");
    }

    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(httpMethod || 'GET')) {
      try {
        JSON.parse(requestBody);
      } catch {
        throw new Error("Request body must be valid JSON");
      }
    }

    if (expectedStatusCodes && (!Array.isArray(expectedStatusCodes) || expectedStatusCodes.length === 0)) {
      throw new Error("Expected status codes must be a non-empty array");
    }
  }

  // Check if check exists and belongs to user
  const checkDoc = await firestore.collection("checks").doc(id).get();
  if (!checkDoc.exists) {
    throw new Error("Check not found");
  }
  const checkData = checkDoc.data();
  if (checkData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }

  // Check for duplicates within the same user and type (excluding current check)
  const existing = await firestore.collection("checks")
    .where("userId", "==", uid)
    .where("url", "==", url)
    .where("type", "==", checkData.type)
    .get();

  const duplicateExists = existing.docs.some(doc => doc.id !== id);
  if (duplicateExists) {
    const typeLabel = checkData.type === 'rest_endpoint' ? 'API' : 'website';
    throw new Error(`Check URL already exists in your ${typeLabel} list`);
  }

  // Prepare update data
  const updateData: Record<string, unknown> = {
    url,
    name,
    updatedAt: Date.now(),
    lastChecked: 0, // Force re-check on next scheduled run
    nextCheckAt: Date.now(), // Check immediately on next scheduler run
  };

  // Add checkFrequency if provided
  if (checkFrequency !== undefined) updateData.checkFrequency = checkFrequency;

  // Add immediate re-check setting if provided
  if (immediateRecheckEnabled !== undefined) updateData.immediateRecheckEnabled = immediateRecheckEnabled;

  // Add REST endpoint fields if provided
  if (type !== undefined) updateData.type = type;
  if (httpMethod !== undefined) updateData.httpMethod = httpMethod;
  if (expectedStatusCodes !== undefined) updateData.expectedStatusCodes = expectedStatusCodes;
  if (requestHeaders !== undefined) updateData.requestHeaders = requestHeaders;
  if (requestBody !== undefined) updateData.requestBody = requestBody;
  if (responseValidation !== undefined) updateData.responseValidation = responseValidation;

  // Update check directly so caller gets immediate error feedback
  await withFirestoreRetry(() => firestore.collection("checks").doc(id).update(updateData));
  return { success: true };
});

// Callable function to delete a website
export const deleteWebsite = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const { id } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Website ID required");
  }
  // Check if website exists and belongs to user
  const websiteDoc = await firestore.collection("checks").doc(id).get();
  if (!websiteDoc.exists) {
    throw new Error("Website not found");
  }
  const websiteData = websiteDoc.data();
  if (websiteData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }
  // Delete website
  await withFirestoreRetry(() => firestore.collection("checks").doc(id).delete());
  return { success: true };
});

// Function to enable/disable a check manually
export const toggleCheckStatus = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const { id, disabled, reason } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Check ID required");
  }

  // Check if check exists and belongs to user
  const checkDoc = await firestore.collection("checks").doc(id).get();
  if (!checkDoc.exists) {
    throw new Error("Check not found");
  }
  const checkData = checkDoc.data();
  if (checkData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }

  const now = Date.now();
  const updateData: Record<string, unknown> = {
    disabled: disabled,
    updatedAt: now
  };

  if (disabled) {
    updateData.disabledAt = now;
    updateData.disabledReason = reason || "Manually disabled by user";
  } else {
    updateData.disabledAt = null;
    updateData.disabledReason = null;
    // Reset failure tracking when re-enabling to ensure immediate checking
    updateData.consecutiveFailures = 0;
    updateData.lastFailureTime = null;
    updateData.lastChecked = 0; // Force immediate check on next run
    updateData.nextCheckAt = Date.now(); // Check immediately on next scheduler run
    updateData.status = "unknown"; // Reset status to trigger fresh check
  }

  await withFirestoreRetry(() => firestore.collection("checks").doc(id).update(updateData));

  return {
    success: true,
    disabled,
    message: disabled ? "Check disabled" : "Check enabled"
  };
});



// Optional: Manual trigger for immediate checking (for testing)
export const manualCheck = onCall({
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async (request) => {
  const { checkId } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  if (checkId) {
    // Check specific check
    const checkDoc = await firestore.collection("checks").doc(checkId).get();
    if (!checkDoc.exists) {
      throw new Error("Check not found");
    }
    const checkData = checkDoc.data();
    if (checkData?.userId !== uid) {
      throw new Error("Insufficient permissions");
    }

    const alertContext: AlertContext = {
      throttleCache: new Set<string>(),
      budgetCache: new Map<string, number>()
    };

    // Perform immediate check using the same logic as scheduled checks
    try {
      const checkResult = await checkRestEndpoint(checkData as Website);
      const status = checkResult.status;
      const responseTime = checkResult.responseTime;

      // Store check history using optimized approach
      await storeCheckHistory(checkData as Website, checkResult);

      const now = Date.now();
      const updateData: StatusUpdateData & { lastStatusCode?: number } = {
        status,
        lastChecked: now,
        updatedAt: now,
        responseTime: status === 'online' ? responseTime : null,
        lastStatusCode: checkResult.statusCode,
        consecutiveFailures: status === 'online' ? 0 : (checkData.consecutiveFailures || 0) + 1,
        detailedStatus: checkResult.detailedStatus,
        nextCheckAt: CONFIG.getNextCheckAtMs(checkData.checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES, now)
      };

      // Add SSL certificate information if available
      if (checkResult.sslCertificate) {
        // Clean SSL certificate data to remove undefined values
        const cleanSslData: {
          valid: boolean;
          lastChecked: number;
          issuer?: string;
          subject?: string;
          validFrom?: number;
          validTo?: number;
          daysUntilExpiry?: number;
          error?: string;
        } = {
          valid: checkResult.sslCertificate.valid,
          lastChecked: Date.now()
        };

        if (checkResult.sslCertificate.issuer) cleanSslData.issuer = checkResult.sslCertificate.issuer;
        if (checkResult.sslCertificate.subject) cleanSslData.subject = checkResult.sslCertificate.subject;
        if (checkResult.sslCertificate.validFrom) cleanSslData.validFrom = checkResult.sslCertificate.validFrom;
        if (checkResult.sslCertificate.validTo) cleanSslData.validTo = checkResult.sslCertificate.validTo;
        if (checkResult.sslCertificate.daysUntilExpiry !== undefined) cleanSslData.daysUntilExpiry = checkResult.sslCertificate.daysUntilExpiry;
        if (checkResult.sslCertificate.error) cleanSslData.error = checkResult.sslCertificate.error;

        updateData.sslCertificate = cleanSslData;

        // Trigger SSL alerts if needed
        if (checkResult.sslCertificate) {
          await triggerSSLAlert(checkData as Website, checkResult.sslCertificate, alertContext);
        }
      }

      // Add domain expiry information if available
      if (checkResult.domainExpiry) {
        // Clean domain expiry data to remove undefined values
        const cleanDomainData: {
          valid: boolean;
          lastChecked: number;
          registrar?: string;
          domainName?: string;
          expiryDate?: number;
          daysUntilExpiry?: number;
          error?: string;
        } = {
          valid: checkResult.domainExpiry.valid,
          lastChecked: Date.now()
        };

        if (checkResult.domainExpiry.registrar) cleanDomainData.registrar = checkResult.domainExpiry.registrar;
        if (checkResult.domainExpiry.domainName) cleanDomainData.domainName = checkResult.domainExpiry.domainName;
        if (checkResult.domainExpiry.expiryDate) cleanDomainData.expiryDate = checkResult.domainExpiry.expiryDate;
        if (checkResult.domainExpiry.daysUntilExpiry !== undefined) cleanDomainData.daysUntilExpiry = checkResult.domainExpiry.daysUntilExpiry;
        if (checkResult.domainExpiry.error) cleanDomainData.error = checkResult.domainExpiry.error;

        updateData.domainExpiry = cleanDomainData;

        // Trigger domain expiry alerts if needed
        if (checkResult.domainExpiry) {
          const isExpired = !checkResult.domainExpiry.valid;
          const isExpiringSoon = checkResult.domainExpiry.daysUntilExpiry !== undefined &&
            checkResult.domainExpiry.daysUntilExpiry <= 30;

          if (isExpired || isExpiringSoon) {
            await triggerDomainExpiryAlert(checkData as Website, checkResult.domainExpiry, alertContext);
          }
        }
      }

      if (status === 'offline') {
        updateData.downtimeCount = (Number(checkData.downtimeCount) || 0) + 1;
        updateData.lastDowntime = Date.now();
        updateData.lastFailureTime = Date.now();
        updateData.lastError = checkResult.error || null;
      } else {
        updateData.lastError = null;
      }

      // CRITICAL: Check buffer first to get the most recent status before determining oldStatus
      // This prevents duplicate alerts when status updates are buffered
      // Must check BEFORE adding update to buffer
      const bufferedUpdate = statusUpdateBuffer.get(checkId);
      const effectiveOldStatus = bufferedUpdate?.status && bufferedUpdate.status.trim().length > 0
        ? bufferedUpdate.status
        : (checkData.status || 'unknown');
      
      const oldStatus = effectiveOldStatus;

      await addStatusUpdate(checkId, updateData);

      if (oldStatus !== status && oldStatus !== 'unknown') {
        await triggerAlert(checkData as Website, oldStatus, status, undefined, alertContext);
      }
      return { status, lastChecked: Date.now() };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const now = Date.now();

      // Store check history for error case using optimized approach
      await storeCheckHistory(checkData as Website, {
        status: 'offline',
        responseTime: 0,
        statusCode: 0,
        error: errorMessage
      });

      const updateData: StatusUpdateData = {
        status: 'offline',
        lastChecked: now,
        updatedAt: now,
        lastError: errorMessage,
        downtimeCount: (Number(checkData.downtimeCount) || 0) + 1,
        lastDowntime: now,
        lastFailureTime: now,
        consecutiveFailures: (checkData.consecutiveFailures || 0) + 1,
        detailedStatus: 'DOWN'
      };

      // CRITICAL: Check buffer first to get the most recent status before determining oldStatus
      // Must check BEFORE adding update to buffer
      const bufferedUpdate = statusUpdateBuffer.get(checkId);
      const effectiveOldStatus = bufferedUpdate?.status && bufferedUpdate.status.trim().length > 0
        ? bufferedUpdate.status
        : (checkData.status || 'unknown');
      
      const oldStatus = effectiveOldStatus;
      const newStatus = 'offline';
      
      await addStatusUpdate(checkId, updateData);

      if (oldStatus !== newStatus && oldStatus !== 'unknown') {
        await triggerAlert(checkData as Website, oldStatus, newStatus, undefined, alertContext);
      }
      return { status: 'offline', error: errorMessage };
    } finally {
      await flushBigQueryInserts();
      await flushStatusUpdates();
    }
  }

  throw new Error("Check ID required");
});