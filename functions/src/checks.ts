import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as crypto from "crypto";
import { firestore, getUserTier, getUserTierLive } from "./init";
import { CONFIG } from "./config";
import { Website } from "./types";
import {
  RESEND_API_KEY,
  RESEND_FROM,
  CLERK_SECRET_KEY_DEV,
  CLERK_SECRET_KEY_PROD,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID,
} from "./env";
import { statusFlushInterval, initializeStatusFlush, flushStatusUpdates, addStatusUpdate, StatusUpdateData, statusUpdateBuffer } from "./status-buffer";
import { checkRestEndpoint, checkTcpEndpoint, checkUdpEndpoint, storeCheckHistory, createCheckHistoryRecord } from "./check-utils";
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from "./check-defaults";
import { triggerAlert, triggerSSLAlert, AlertSettingsCache, AlertContext, drainQueuedWebhookRetries, enableDeferredBudgetWrites, disableDeferredBudgetWrites, flushDeferredBudgetWrites } from "./alert";
import { EmailSettings, SmsSettings, WebhookSettings } from "./types";
import { insertCheckHistory, BigQueryCheckHistory, flushBigQueryInserts } from "./bigquery";
import { CheckRegion, pickNearestRegion } from "./check-region";
import { handleCheckDisabled } from "./check-events";

type AlertReason = 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' | undefined;

const shouldRetryAlert = (reason?: AlertReason) => reason === 'flap' || reason === 'error' || reason === 'throttle';

const CHECK_RUN_LOCK_COLLECTION = "runtimeLocks";
const CHECK_RUN_LOCK_DOC_PREFIX = "checkAllChecks";
const CHECK_RUN_LOCK_TTL_MS = 25 * 60 * 1000;
const CHECK_RUN_LOCK_HEARTBEAT_MS = 60 * 1000;
// OPTIMIZATION: Reduced from 5 to 3 pages to reduce memory from document loading
// 3 pages x 2000 = 6000 max checks per run (still plenty for typical loads)
const MAX_CHECK_QUERY_PAGES = 3;
const DEFAULT_FUNCTION_TIMEOUT_MS = 9 * 60 * 1000;
const EXECUTION_TIME_BUFFER_MS = 30 * 1000;
const MIN_TIME_FOR_NEW_BATCH_MS = 45 * 1000;

// Sparse orderIndex gap - consistent with client-side for reduced Firestore writes
const ORDER_INDEX_GAP = 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type CheckType = "website" | "rest_endpoint" | "tcp" | "udp";

const normalizeCheckType = (value: unknown): CheckType =>
  value === "rest_endpoint" || value === "tcp" || value === "udp" ? value : "website";

const getCanonicalUrlKey = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  const protocol = url.protocol.toLowerCase();
  let hostname = url.hostname.toLowerCase();
  hostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;

  let port = url.port;
  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    port = "";
  }

  let pathname = url.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  return `${protocol}//${hostname}${port ? `:${port}` : ""}${pathname}${url.search}`;
};

const getCanonicalUrlKeySafe = (rawUrl: string): string | null => {
  try {
    return getCanonicalUrlKey(rawUrl);
  } catch {
    return null;
  }
};

// Generate a short hash for URL indexing (used for duplicate detection)
const hashCanonicalUrl = (canonicalUrl: string): string => {
  return crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
};

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
let schedulerActiveLockDoc: string | null = null;
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
  const lockDoc = schedulerActiveLockDoc;
  schedulerActiveLockId = null;
  schedulerActiveLockDoc = null;
  if (!lockDoc) return null;
  return releaseCheckRunLock(lockId, lockDoc).catch(error =>
    logger.error("Failed to release check run lock during shutdown", error)
  );
};

const initiateSchedulerCleanupSequence = (): boolean => {
  if (schedulerSignalCleanupTriggered) {
    return true;
  }
  if (!schedulerCleanupFn) {
    return false;
  }

  const cleanupPromise = triggerSchedulerCleanup();
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

const acquireCheckRunLock = async (lockId: string, lockDoc: string): Promise<boolean> => {
  const lockRef = firestore.collection(CHECK_RUN_LOCK_COLLECTION).doc(lockDoc);
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

const releaseCheckRunLock = async (lockId: string, lockDoc: string): Promise<void> => {
  const lockRef = firestore.collection(CHECK_RUN_LOCK_COLLECTION).doc(lockDoc);
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

const extendCheckRunLock = async (lockId: string, lockDoc: string): Promise<void> => {
  const lockRef = firestore.collection(CHECK_RUN_LOCK_COLLECTION).doc(lockDoc);
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

const paginateDueChecks = async function* (
  now: number,
  region: CheckRegion,
  opts?: { includeUnassigned?: boolean }
): AsyncGenerator<DueCheckPage> {
  let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (let page = 0; page < MAX_CHECK_QUERY_PAGES; page++) {
    let query = firestore
      .collection("checks")
      .where("nextCheckAt", "<=", now)
      .where("disabled", "==", false)
      .orderBy("nextCheckAt")
      .limit(CONFIG.MAX_WEBSITES_PER_RUN);

    // For US scheduler only: include legacy checks that don't yet have checkRegion set.
    // We then filter in-memory by region ownership.
    if (!opts?.includeUnassigned) {
      query = query.where("checkRegion", "==", region);
    }

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

const createLockHeartbeat = (lockId: string, lockDoc: string) => {
  let lastBeat = Date.now();
  return async () => {
    const now = Date.now();
    if (now - lastBeat < CHECK_RUN_LOCK_HEARTBEAT_MS) {
      return;
    }
    lastBeat = now;
    try {
      await extendCheckRunLock(lockId, lockDoc);
    } catch (error) {
      logger.warn("Failed to refresh check run lock heartbeat", error);
    }
  };
};

// NOTE: `getUserTier` returns 'free' | 'nano'. We keep 'premium' as backward-compat
// because older check docs may still have it cached.
const isNanoTier = (tier: unknown): boolean => tier === "nano" || tier === "premium";

const lockDocForRegion = (region: CheckRegion) => `${CHECK_RUN_LOCK_DOC_PREFIX}-${region}`;

// NOTE: We intentionally avoid Firestore queries for "missing fields" (not supported reliably).
// Legacy checks without `checkRegion` are handled by the US scheduler using an unfiltered due-query
// and then written back as part of the normal status update flow.

const runCheckScheduler = async (region: CheckRegion, opts?: { backfillMissing?: boolean }) => {
  ensureSchedulerShutdownHandlers();
  schedulerShutdownRequested = false;

  const lockId = createRunLockId();
  const lockDoc = lockDocForRegion(region);
  const lockAcquired = await acquireCheckRunLock(lockId, lockDoc);
  if (!lockAcquired) {
    logger.warn(`Skipping check run (${region}) because another instance is already processing checks`);
    return;
  }
  schedulerActiveLockId = lockId;
  schedulerActiveLockDoc = lockDoc;

  // Ensure SIGTERM/SIGINT can always flush buffers + release the lock.
  // We'll expand this cleanup function later once local helpers are defined.
  schedulerCleanupFn = async () => {
    await flushBigQueryInserts();
    await flushStatusUpdates();
    await flushDeferredBudgetWrites();
    disableDeferredBudgetWrites();
  };
  if (schedulerShutdownRequested && !schedulerSignalCleanupTriggered) {
    initiateSchedulerCleanupSequence();
  }

  // OPTIMIZATION: Enable deferred budget writes to batch Firestore writes
  enableDeferredBudgetWrites();

  try {
    await drainQueuedWebhookRetries();
  } catch (error) {
    logger.warn("Failed to drain webhook retries at start of run", error);
  }

  const includeUnassigned = Boolean(opts?.backfillMissing && region === "us-central1");

  const timeBudget = createTimeBudget();
  const heartbeat = createLockHeartbeat(lockId, lockDoc);

  try {
    // Per-run memoization for tier lookups (avoid per-check Firestore reads).
    const tierByUserId = new Map<string, Promise<Awaited<ReturnType<typeof getUserTier>>>>();
    const getEffectiveTierForUser = (uid: string) => {
      const existing = tierByUserId.get(uid);
      if (existing) return existing;
      const p = getUserTier(uid);
      tierByUserId.set(uid, p);
      return p;
    };

    const historyInsertTasks: Promise<void>[] = [];
    const HISTORY_PROMISE_BATCH_SIZE = 100;

    const flushPendingHistoryTasks = async () => {
      if (historyInsertTasks.length === 0) return;
      const pending = historyInsertTasks.splice(0, historyInsertTasks.length);
      const results = await Promise.allSettled(pending);
      results.forEach(result => {
        if (result.status === "rejected") {
          logger.error("History enqueue task failed", result.reason);
        }
      });
    };

    // Now that we have history tasks in scope, expand cleanup to flush everything.
    schedulerCleanupFn = async () => {
      await flushPendingHistoryTasks();
      await flushBigQueryInserts();
      await flushStatusUpdates();
      await flushDeferredBudgetWrites();
      disableDeferredBudgetWrites();
    };
    if ((schedulerShutdownRequested) && !schedulerSignalCleanupTriggered) {
      initiateSchedulerCleanupSequence();
    }

    // Stream history rows into BigQuery buffer as they are produced without blocking checks
    let streamedHistoryCount = 0;
    const enqueueHistoryRecord = async (record: BigQueryCheckHistory) => {
      streamedHistoryCount += 1;
      if (streamedHistoryCount === 1 || streamedHistoryCount % 200 === 0) {
        logger.info(`Buffered ${streamedHistoryCount} history records this run (${region})`);
      }

      const task = insertCheckHistory(record).catch((error) => {
        // Best-effort: checks should not fail because history enqueue failed.
        logger.error(`Failed to enqueue history record for ${record.website_id}`, {
          websiteId: record.website_id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      historyInsertTasks.push(task);

      if (historyInsertTasks.length >= HISTORY_PROMISE_BATCH_SIZE) {
        await flushPendingHistoryTasks();
      }
    };

    // CACHE: Store user settings to avoid redundant reads
    const userSettingsCache = new Map<string, Promise<AlertSettingsCache>>();
    // In-memory throttle/budget caches for this run
    const throttleCache = new Set<string>();
    const budgetCache = new Map<string, number>();
    const emailMonthlyBudgetCache = new Map<string, number>();
    const smsThrottleCache = new Set<string>();
    const smsBudgetCache = new Map<string, number>();
    const smsMonthlyBudgetCache = new Map<string, number>();

    const getUserSettings = (userId: string): Promise<AlertSettingsCache> => {
      if (userSettingsCache.has(userId)) {
        return userSettingsCache.get(userId)!;
      }

      const promise = (async () => {
        try {
          // Run queries in parallel
          const [emailDoc, smsDoc, webhooksSnapshot] = await Promise.all([
            firestore.collection('emailSettings').doc(userId).get(),
            firestore.collection('smsSettings').doc(userId).get(),
            firestore.collection('webhooks').where("userId", "==", userId).where("enabled", "==", true).get()
          ]);

          const email = emailDoc.exists ? (emailDoc.data() as EmailSettings) : null;
          const sms = smsDoc.exists ? (smsDoc.data() as SmsSettings) : null;
          const webhooks = webhooksSnapshot.docs.map(d => d.data() as WebhookSettings);

          return { email, sms, webhooks };
        } catch (err) {
          logger.error(`Failed to load settings for user ${userId}`, err);
          return { email: null, sms: null, webhooks: [] };
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
    if (failureCount > 0) {
      logger.warn(`Scheduler starting in failure state: ${failureCount} failures recorded`);
    }

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

    const now = Date.now();
    let processedPages = 0;
    let scheduledChecks = 0;
    let backlogDetected = false;
    let shutdownTriggeredDuringRun = false;
    let lastBatchSize = CONFIG.getOptimalBatchSize(0);
    let lastMaxConcurrentChecks = CONFIG.getDynamicConcurrency(0);

    for await (const { checks: pageChecks, truncated } of paginateDueChecks(now, region, { includeUnassigned })) {
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

      // If we included unassigned checks (US only), filter to only the checks owned by this region.
      const ownedChecks = includeUnassigned
        ? pageChecks.filter((c) => ((c.checkRegion as CheckRegion | undefined) ?? "us-central1") === region)
        : pageChecks;

      if (ownedChecks.length === 0) {
        continue;
      }

      processedPages += 1;
      backlogDetected ||= truncated;
      scheduledChecks += ownedChecks.length;

      if (!timeBudget.shouldStartWork()) {
        backlogDetected = true;
        logger.warn(`Only ${timeBudget.remaining()}ms remaining; deferring ${pageChecks.length} queued checks`);
        break;
      }

      lastBatchSize = CONFIG.getOptimalBatchSize(scheduledChecks);
      lastMaxConcurrentChecks = CONFIG.getDynamicConcurrency(scheduledChecks);

      const { aborted } = await processCheckBatches({
        checks: ownedChecks,
        batchSize: lastBatchSize,
        maxConcurrentChecks: lastMaxConcurrentChecks,
        timeBudget,
        getEffectiveTierForUser,
        getUserSettings,
        enqueueHistoryRecord,
        throttleCache,
        budgetCache,
        emailMonthlyBudgetCache,
        smsThrottleCache,
        smsBudgetCache,
        smsMonthlyBudgetCache,
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
      logger.info(`No checks need checking (${region})`);
      return;
    }

    logger.info(`Starting check (${region}): ${scheduledChecks} checks across ${processedPages} page(s)`);
    if (backlogDetected) {
      logger.warn(
        `Due check backlog exceeds ${CONFIG.MAX_WEBSITES_PER_RUN * MAX_CHECK_QUERY_PAGES} documents or hit time budget; remaining work will run on the next tick`
      );
    }

    logger.info(`Performance settings (${region}): batchSize=${lastBatchSize} maxConcurrentChecks=${lastMaxConcurrentChecks}`);

    await flushPendingHistoryTasks();
    await flushBigQueryInserts();
    await flushStatusUpdates();
    await flushDeferredBudgetWrites();

    if (shutdownTriggeredDuringRun) {
      logger.warn(`Scheduler shutdown triggered during run (${region}); completed partial work`);
    }
  } finally {
    // Always disable deferred writes and release lock
    disableDeferredBudgetWrites();
    if (schedulerActiveLockId === lockId && schedulerActiveLockDoc === lockDoc) {
      await releaseCheckRunLock(lockId, lockDoc);
    }
    schedulerActiveLockId = null;
    schedulerActiveLockDoc = null;
    schedulerShutdownRequested = false;
    schedulerSignalCleanupTriggered = false;
    schedulerCleanupFn = null;
    schedulerCleanupInFlight = null;
  }
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
  getEffectiveTierForUser: (uid: string) => Promise<Awaited<ReturnType<typeof getUserTier>>>;
  getUserSettings: (userId: string) => Promise<AlertSettingsCache>;
  enqueueHistoryRecord: (record: BigQueryCheckHistory) => Promise<void>;
  throttleCache: Set<string>;
  budgetCache: Map<string, number>;
  emailMonthlyBudgetCache: Map<string, number>;
  smsThrottleCache: Set<string>;
  smsBudgetCache: Map<string, number>;
  smsMonthlyBudgetCache: Map<string, number>;
  stats: CheckRunStats;
  heartbeat: () => Promise<void>;
}

const processCheckBatches = async ({
  checks,
  batchSize,
  maxConcurrentChecks,
  timeBudget,
  getEffectiveTierForUser,
  getUserSettings,
  enqueueHistoryRecord,
  throttleCache,
  budgetCache,
  emailMonthlyBudgetCache,
  smsThrottleCache,
  smsBudgetCache,
  smsMonthlyBudgetCache,
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

            if (CONFIG.shouldDisableWebsite(check)) {
              const disabledAt = Date.now();
              const disabledReason = "Auto-disabled after extended downtime";
              await addStatusUpdate(check.id, {
                disabled: true,
                disabledAt,
                disabledReason,
                updatedAt: disabledAt,
                lastChecked: disabledAt,
              });
              // Record history to BigQuery and send notification email
              // (replaces the old logCheckDisabled Firestore trigger)
              await handleCheckDisabled(check, disabledReason, disabledAt);
              return { id: check.id, skipped: true, reason: "auto-disabled", status: check.status ?? "unknown" };
            }

            try {
              const now = Date.now();
              const isRecheckAttempt =
                Number(check.consecutiveFailures || 0) > 0 &&
                typeof check.lastFailureTime === "number" &&
                now - check.lastFailureTime <= CONFIG.DOWN_CONFIRMATION_WINDOW_MS;
              const checkType = normalizeCheckType(check.type);
              const checkResult =
                checkType === "tcp"
                  ? await checkTcpEndpoint(check)
                  : checkType === "udp"
                    ? await checkUdpEndpoint(check)
                    : await checkRestEndpoint(check, { disableRange: isRecheckAttempt });
              let status = checkResult.status;
              const responseTime = checkResult.responseTime;
              const prevConsecutiveFailures = Number(check.consecutiveFailures || 0);
              const prevConsecutiveSuccesses = Number((check as Website & { consecutiveSuccesses?: number }).consecutiveSuccesses || 0);

              const observedStatus = status;
              const observedIsDown = observedStatus === "offline";
              const failureStartTime =
                observedIsDown
                  ? (prevConsecutiveFailures > 0 && check.lastFailureTime ? check.lastFailureTime : now)
                  : null;
              const withinConfirmationWindow =
                observedIsDown && failureStartTime
                  ? now - failureStartTime <= CONFIG.DOWN_CONFIRMATION_WINDOW_MS
                  : false;

              // IMMEDIATE RE-CHECK: Determine if we should schedule immediate re-check
              // This is calculated early so we can use it in all code paths below
              const immediateRecheckEnabled = check.immediateRecheckEnabled !== false; // Enabled by default unless explicitly disabled
              // Handle edge cases: if lastChecked is 0/undefined or in the future, treat as not recent (allow immediate re-check)
              const lastCheckedTime = check.lastChecked || 0;
              // DEFENSIVE: Handle future timestamps (shouldn't happen but protect against clock skew/bugs)
              const timeSinceLastCheck = lastCheckedTime > 0 && lastCheckedTime <= now
                ? now - lastCheckedTime
                : Infinity;
              const isRecentCheck = timeSinceLastCheck < CONFIG.IMMEDIATE_RECHECK_WINDOW_MS;

              // Normal failure/success logic (based on observed status, before confirmation)
              const nextConsecutiveFailures = observedIsDown ? prevConsecutiveFailures + 1 : 0;
              const nextConsecutiveSuccesses = observedIsDown ? 0 : prevConsecutiveSuccesses + 1;

              // DOWN confirmation: require multiple consecutive failures before declaring offline
              // Use per-check value or fall back to CONFIG default
              const requiredAttempts = check.downConfirmationAttempts ?? CONFIG.DOWN_CONFIRMATION_ATTEMPTS;
              const shouldConfirmDown =
                observedIsDown &&
                withinConfirmationWindow &&
                nextConsecutiveFailures < requiredAttempts;
              if (shouldConfirmDown) {
                status = "online";
              }

                const previousStatus = check.status ?? "unknown";
                const historySampleIntervalMs = CONFIG.HISTORY_SAMPLE_INTERVAL_MS;
                const historyBucket =
                  historySampleIntervalMs > 0 ? Math.floor(now / historySampleIntervalMs) : 0;
                const lastHistoryBucket =
                  historySampleIntervalMs > 0 && typeof check.lastHistoryAt === "number"
                    ? Math.floor(check.lastHistoryAt / historySampleIntervalMs)
                    : 0;
                const shouldSampleHistory =
                  historySampleIntervalMs > 0 &&
                  status === "online" &&
                  checkResult.status === "online" &&
                  historyBucket > lastHistoryBucket;
                const shouldRecordHistory = previousStatus !== status || shouldSampleHistory;
                if (shouldRecordHistory) {
                  await enqueueHistoryRecord(createCheckHistoryRecord(check, checkResult));
                }
                const historyRecordedAt = shouldRecordHistory ? now : undefined;

              // IMMEDIATE RE-CHECK FEATURE: For non-UP status, schedule immediate re-checks
              // to confirm a real outage before alerting.
              const originalStatusWasOffline = checkResult.status === "offline";
              // Include 4xx/5xx and negative codes; 401/403 are treated as UP
              const isAuthUpStatus = checkResult.statusCode === 401 || checkResult.statusCode === 403;
              const hasNonUpStatusCode =
                checkResult.statusCode < 0 ||
                (checkResult.statusCode >= 400 && checkResult.statusCode < 600 && !isAuthUpStatus);
              const isNonUpStatus = originalStatusWasOffline || hasNonUpStatusCode;
              const shouldImmediateConfirm =
                observedIsDown &&
                withinConfirmationWindow &&
                nextConsecutiveFailures < requiredAttempts;
              const isFirstFailure = nextConsecutiveFailures === 1 && prevConsecutiveFailures === 0;

              // Calculate nextCheckAt - use immediate re-check if conditions are met
              let nextCheckAt: number;
              if (immediateRecheckEnabled && shouldImmediateConfirm) {
                nextCheckAt = now + CONFIG.IMMEDIATE_RECHECK_DELAY_MS;
              } else if (immediateRecheckEnabled && isNonUpStatus && isFirstFailure && !isRecentCheck) {
                nextCheckAt = now + CONFIG.IMMEDIATE_RECHECK_DELAY_MS;
              } else {
                // Normal schedule
                nextCheckAt = CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES, now);
              }

              const regionMissing = !check.checkRegion;
              const currentRegion: CheckRegion = (check.checkRegion as CheckRegion | undefined) ?? "us-central1";

              // IMPORTANT: don't trust cached `check.userTier` (it can be stale after upgrades/downgrades).
              // Only fetch when the doc doesn't already indicate a paid tier; memoized per-user per-run.
              const effectiveTier = isNanoTier(check.userTier)
                ? "nano"
                : await getEffectiveTierForUser(check.userId);
              check.userTier = effectiveTier as Website["userTier"];

              // Region selection is based on target geo. If best-effort geo resolution fails this run,
              // fall back to the last cached target geo stored on the check doc.
              const targetLat = checkResult.targetLatitude ?? check.targetLatitude;
              const targetLon = checkResult.targetLongitude ?? check.targetLongitude;

              // If user has a manual region override, use it.
              // Otherwise, only auto-detect from target geo on first assignment (regionMissing).
              // Existing checks keep their current region to avoid orphaning when new regions
              // are deployed but their schedulers aren't running yet.
              // Use the updateCheckRegions admin function to batch-reassign checks to new regions.
              const desiredRegion: CheckRegion = check.checkRegionOverride
                ?? (regionMissing ? pickNearestRegion(targetLat, targetLon) : currentRegion);

              const hasChanges =
                check.status !== status ||
                regionMissing ||
                currentRegion !== desiredRegion ||
                (check.userTier ?? null) !== (effectiveTier ?? null) ||
                check.lastStatusCode !== checkResult.statusCode ||
                Math.abs((check.responseTime || 0) - responseTime) > 100 ||
                (check.detailedStatus || null) !== (checkResult.detailedStatus || null) ||
                (check.targetLatitude ?? null) !== (checkResult.targetLatitude ?? null) ||
                (check.targetLongitude ?? null) !== (checkResult.targetLongitude ?? null) ||
                (check.targetCountry ?? null) !== (checkResult.targetCountry ?? null) ||
                (check.targetRegion ?? null) !== (checkResult.targetRegion ?? null) ||
                (check.targetCity ?? null) !== (checkResult.targetCity ?? null) ||
                (check.targetHostname ?? null) !== (checkResult.targetHostname ?? null) ||
                (check.targetIp ?? null) !== (checkResult.targetIp ?? null) ||
                (check.targetIpsJson ?? null) !== (checkResult.targetIpsJson ?? null) ||
                (check.targetIpFamily ?? null) !== (checkResult.targetIpFamily ?? null) ||
                (check.targetAsn ?? null) !== (checkResult.targetAsn ?? null) ||
                (check.targetOrg ?? null) !== (checkResult.targetOrg ?? null) ||
                (check.targetIsp ?? null) !== (checkResult.targetIsp ?? null) ||
                (check.lastError ?? null) !== (
                  status === "offline" ? (checkResult.error ?? null) : null
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
                  targetMetadataLastChecked?: number;
                  sslCertificate?: Website["sslCertificate"];
                } = {
                  lastChecked: now,
                  updatedAt: now,
                  nextCheckAt: nextCheckAt,
                  consecutiveFailures: nextConsecutiveFailures,
                  consecutiveSuccesses: nextConsecutiveSuccesses,
                };
                if (observedIsDown && failureStartTime) {
                  noChangeUpdate.lastFailureTime = failureStartTime;
                } else if (nextConsecutiveFailures === 0 && check.lastFailureTime) {
                  noChangeUpdate.lastFailureTime = null;
                }
                if (historyRecordedAt) {
                  noChangeUpdate.lastHistoryAt = historyRecordedAt;
                }

                if (status === "offline" && (check as Website & { pendingDownEmail?: boolean }).pendingDownEmail) {
                  const settings = await getUserSettings(check.userId);
                  const result = await triggerAlert(
                    check,
                    "online",
                    "offline",
                    { consecutiveFailures: nextConsecutiveFailures },
                    { settings, throttleCache, budgetCache, emailMonthlyBudgetCache, smsThrottleCache, smsBudgetCache, smsMonthlyBudgetCache }
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
                    { settings, throttleCache, budgetCache, emailMonthlyBudgetCache, smsThrottleCache, smsBudgetCache, smsMonthlyBudgetCache }
                  );
                  if (result.delivered) {
                    noChangeUpdate.pendingUpEmail = false;
                    noChangeUpdate.pendingUpSince = null;
                  } else if (shouldRetryAlert(result.reason)) {
                    noChangeUpdate.pendingUpEmail = true;
                    if (!(check as Website & { pendingUpSince?: number }).pendingUpSince) noChangeUpdate.pendingUpSince = now;
                  }
                }
                if (typeof checkResult.targetMetadataLastChecked === "number") {
                  noChangeUpdate.targetMetadataLastChecked = checkResult.targetMetadataLastChecked;
                }
                if (typeof checkResult.securityMetadataLastChecked === "number") {
                  if (checkResult.sslCertificate) {
                    const cleanSslData = {
                      valid: checkResult.sslCertificate.valid,
                      lastChecked: checkResult.securityMetadataLastChecked,
                      ...(checkResult.sslCertificate.issuer ? { issuer: checkResult.sslCertificate.issuer } : {}),
                      ...(checkResult.sslCertificate.subject ? { subject: checkResult.sslCertificate.subject } : {}),
                      ...(checkResult.sslCertificate.validFrom ? { validFrom: checkResult.sslCertificate.validFrom } : {}),
                      ...(checkResult.sslCertificate.validTo ? { validTo: checkResult.sslCertificate.validTo } : {}),
                      ...(checkResult.sslCertificate.daysUntilExpiry !== undefined
                        ? { daysUntilExpiry: checkResult.sslCertificate.daysUntilExpiry }
                        : {}),
                      ...(checkResult.sslCertificate.error ? { error: checkResult.sslCertificate.error } : {}),
                    };
                    noChangeUpdate.sslCertificate = cleanSslData;
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
                lastFailureTime?: number | null;
                lastError?: string | null | undefined;
                uptimeCount?: number;
                lastUptime?: number;
                pendingDownEmail?: boolean;
                pendingDownSince?: number | null;
                pendingUpEmail?: boolean;
                pendingUpSince?: number | null;
                } = {
                  status,
                  checkRegion: desiredRegion,
                  userTier: effectiveTier as Website["userTier"],
                  lastChecked: now,
                  updatedAt: now,
                responseTime: status === "online" ? responseTime : undefined,
                lastStatusCode: checkResult.statusCode,
                consecutiveFailures: nextConsecutiveFailures,
                consecutiveSuccesses: nextConsecutiveSuccesses,
                detailedStatus: checkResult.detailedStatus,
                nextCheckAt: nextCheckAt,
                targetCountry: checkResult.targetCountry,
                targetRegion: checkResult.targetRegion,
                targetCity: checkResult.targetCity,
                targetLatitude: checkResult.targetLatitude,
                targetLongitude: checkResult.targetLongitude,
                targetHostname: checkResult.targetHostname,
                targetIp: checkResult.targetIp,
                targetIpsJson: checkResult.targetIpsJson,
                targetIpFamily: checkResult.targetIpFamily,
                targetAsn: checkResult.targetAsn,
                targetOrg: checkResult.targetOrg,
                targetIsp: checkResult.targetIsp,
                lastError: status === "offline" ? (checkResult.error ?? null) : null,
                };
                if (historyRecordedAt) {
                  updateData.lastHistoryAt = historyRecordedAt;
                }

              if (typeof checkResult.targetMetadataLastChecked === "number") {
                updateData.targetMetadataLastChecked = checkResult.targetMetadataLastChecked;
              }

              if (currentRegion !== desiredRegion) {
                logger.info("Auto-migrating check region based on target geo", {
                  checkId: check.id,
                  url: check.url,
                  from: currentRegion,
                  to: desiredRegion,
                  effectiveTier,
                  targetLat,
                  targetLon,
                });
              }

              if (checkResult.sslCertificate) {
                const sslLastChecked =
                  typeof checkResult.securityMetadataLastChecked === "number"
                    ? checkResult.securityMetadataLastChecked
                    : check.sslCertificate?.lastChecked ?? now;
                const cleanSslData = {
                  valid: checkResult.sslCertificate.valid,
                  lastChecked: sslLastChecked,
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
                // Pass previous SSL state for state-change detection (like online/offline alerts)
                await triggerSSLAlert(check, checkResult.sslCertificate, check.sslCertificate, { settings, throttleCache, budgetCache, emailMonthlyBudgetCache, smsThrottleCache, smsBudgetCache, smsMonthlyBudgetCache });
              }

              if (observedIsDown && failureStartTime) {
                updateData.lastFailureTime = failureStartTime;
              }
              if (status === "offline") {
                updateData.downtimeCount = (Number(check.downtimeCount) || 0) + 1;
                updateData.lastDowntime = now;
                updateData.lastError = checkResult.error || null;
              } else {
                updateData.lastError = null;
                if (nextConsecutiveFailures === 0 && check.lastFailureTime) {
                  updateData.lastFailureTime = null;
                }
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
                const websiteForAlert: Website = {
                  ...(check as Website),
                  status,
                  responseTime: responseTime,
                  responseTimeLimit: check.responseTimeLimit,
                  detailedStatus: checkResult.detailedStatus,
                  lastStatusCode: checkResult.statusCode,
                  lastError: status === "offline" ? (checkResult.error ?? null) : null,
                  consecutiveFailures: nextConsecutiveFailures,
                  consecutiveSuccesses: nextConsecutiveSuccesses,
                  dnsMs: checkResult.timings?.dnsMs,
                  connectMs: checkResult.timings?.connectMs,
                  tlsMs: checkResult.timings?.tlsMs,
                  ttfbMs: checkResult.timings?.ttfbMs,
                };
                const result = await triggerAlert(
                  websiteForAlert,
                  oldStatus,
                  status,
                  { consecutiveFailures: nextConsecutiveFailures, consecutiveSuccesses: nextConsecutiveSuccesses },
                  { settings, throttleCache, budgetCache, emailMonthlyBudgetCache, smsThrottleCache, smsBudgetCache, smsMonthlyBudgetCache }
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
                    { settings, throttleCache, budgetCache, emailMonthlyBudgetCache, smsThrottleCache, smsBudgetCache, smsMonthlyBudgetCache }
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
                    { settings, throttleCache, budgetCache, emailMonthlyBudgetCache, smsThrottleCache, smsBudgetCache, smsMonthlyBudgetCache }
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
              const prevConsecutiveFailures = Number(check.consecutiveFailures || 0);
              const nextConsecutiveFailures = prevConsecutiveFailures + 1;
              const failureStartTime =
                prevConsecutiveFailures > 0 && check.lastFailureTime
                  ? check.lastFailureTime
                  : now;

                if ((check.status ?? "unknown") !== "offline") {
                  await enqueueHistoryRecord(
                    createCheckHistoryRecord(check, {
                      status: "offline",
                      responseTime: 0,
                      statusCode: 0,
                      error: errorMessage,
                      // Include timing data for consistency - only totalMs is meaningful for errors
                      timings: { totalMs: 0 },
                    })
                  );
                }
                const historyRecordedAt = (check.status ?? "unknown") !== "offline" ? now : undefined;

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
                lastFailureTime: failureStartTime,
                consecutiveFailures: nextConsecutiveFailures,
                consecutiveSuccesses: 0,
                  detailedStatus: "DOWN",
                  nextCheckAt: CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES, now),
                };
                if (historyRecordedAt) {
                  updateData.lastHistoryAt = historyRecordedAt;
                }

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
                  { settings, throttleCache, budgetCache, emailMonthlyBudgetCache, smsThrottleCache, smsBudgetCache, smsMonthlyBudgetCache }
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
          r => r.skipped && r.reason === "auto-disabled"
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
  region: "us-central1",
  schedule: `every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`,
  memory: CONFIG.SCHEDULER_MEMORY,
  timeoutSeconds: CONFIG.SCHEDULER_TIMEOUT_SECONDS,
  maxInstances: CONFIG.SCHEDULER_MAX_INSTANCES,
  minInstances: CONFIG.SCHEDULER_MIN_INSTANCES,
  secrets: [
    CLERK_SECRET_KEY_PROD,
    CLERK_SECRET_KEY_DEV,
    RESEND_API_KEY,
    RESEND_FROM,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_FROM_NUMBER,
    TWILIO_MESSAGING_SERVICE_SID,
  ],
}, async () => {
  await runCheckScheduler("us-central1", { backfillMissing: true });
});

export const checkAllChecksEU = onSchedule({
  region: "europe-west1",
  schedule: `every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`,
  memory: CONFIG.SCHEDULER_MEMORY,
  timeoutSeconds: CONFIG.SCHEDULER_TIMEOUT_SECONDS,
  maxInstances: CONFIG.SCHEDULER_MAX_INSTANCES,
  minInstances: CONFIG.SCHEDULER_MIN_INSTANCES,
  secrets: [
    CLERK_SECRET_KEY_PROD,
    CLERK_SECRET_KEY_DEV,
    RESEND_API_KEY,
    RESEND_FROM,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_FROM_NUMBER,
    TWILIO_MESSAGING_SERVICE_SID,
  ],
}, async () => {
  await runCheckScheduler("europe-west1");
});

export const checkAllChecksAPAC = onSchedule({
  region: "asia-southeast1",
  schedule: `every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`,
  memory: CONFIG.SCHEDULER_MEMORY,
  timeoutSeconds: CONFIG.SCHEDULER_TIMEOUT_SECONDS,
  maxInstances: CONFIG.SCHEDULER_MAX_INSTANCES,
  minInstances: CONFIG.SCHEDULER_MIN_INSTANCES,
  secrets: [
    CLERK_SECRET_KEY_PROD,
    CLERK_SECRET_KEY_DEV,
    RESEND_API_KEY,
    RESEND_FROM,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_FROM_NUMBER,
    TWILIO_MESSAGING_SERVICE_SID,
  ],
}, async () => {
  await runCheckScheduler("asia-southeast1");
});

// Helper to get/update user check stats for rate limiting (reduces Firestore reads)
interface UserCheckStats {
  checkCount: number;
  maxOrderIndex: number;
  lastCheckAddedAt: number;
  checksAddedLastMinute: number;
  checksAddedLastHour: number;
  checksAddedLastDay: number;
  lastMinuteWindowStart: number;
  lastHourWindowStart: number;
  lastDayWindowStart: number;
  // URL hash index for O(1) duplicate detection - maps hash -> checkId
  urlHashes?: Record<string, string>;
}

const getUserCheckStats = async (uid: string): Promise<UserCheckStats | null> => {
  const doc = await firestore.collection("user_check_stats").doc(uid).get();
  if (!doc.exists) return null;
  return doc.data() as UserCheckStats;
};

const initializeUserCheckStats = async (uid: string): Promise<UserCheckStats> => {
  // Fallback: count checks from collection (only needed once per user or if stats are stale)
  const checksSnapshot = await firestore.collection("checks")
    .where("userId", "==", uid)
    .select("orderIndex", "createdAt", "url")
    .get();
  
  const now = Date.now();
  const oneMinuteAgo = now - (60 * 1000);
  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  
  let maxOrderIndex = 0;
  let checksLastMinute = 0;
  let checksLastHour = 0;
  let checksLastDay = 0;
  const urlHashes: Record<string, string> = {};
  
  checksSnapshot.docs.forEach(doc => {
    const data = doc.data();
    if (typeof data.orderIndex === 'number' && data.orderIndex > maxOrderIndex) {
      maxOrderIndex = data.orderIndex;
    }
    const createdAt = data.createdAt || 0;
    if (createdAt >= oneMinuteAgo) checksLastMinute++;
    if (createdAt >= oneHourAgo) checksLastHour++;
    if (createdAt >= oneDayAgo) checksLastDay++;
    
    // Build URL hash index for duplicate detection
    if (data.url) {
      const canonical = getCanonicalUrlKeySafe(data.url);
      if (canonical) {
        const hash = hashCanonicalUrl(canonical);
        urlHashes[hash] = doc.id;
      }
    }
  });
  
  const stats: UserCheckStats = {
    checkCount: checksSnapshot.size,
    maxOrderIndex,
    lastCheckAddedAt: now,
    checksAddedLastMinute: checksLastMinute,
    checksAddedLastHour: checksLastHour,
    checksAddedLastDay: checksLastDay,
    lastMinuteWindowStart: Math.floor(now / 60000) * 60000,
    lastHourWindowStart: Math.floor(now / 3600000) * 3600000,
    lastDayWindowStart: Math.floor(now / 86400000) * 86400000,
    urlHashes,
  };
  
  await firestore.collection("user_check_stats").doc(uid).set(stats);
  return stats;
};

const refreshRateLimitWindows = (stats: UserCheckStats, now: number): UserCheckStats => {
  const currentMinuteWindow = Math.floor(now / 60000) * 60000;
  const currentHourWindow = Math.floor(now / 3600000) * 3600000;
  const currentDayWindow = Math.floor(now / 86400000) * 86400000;
  
  // Reset counters if window has changed
  if (currentMinuteWindow > stats.lastMinuteWindowStart) {
    stats.checksAddedLastMinute = 0;
    stats.lastMinuteWindowStart = currentMinuteWindow;
  }
  if (currentHourWindow > stats.lastHourWindowStart) {
    stats.checksAddedLastHour = 0;
    stats.lastHourWindowStart = currentHourWindow;
  }
  if (currentDayWindow > stats.lastDayWindowStart) {
    stats.checksAddedLastDay = 0;
    stats.lastDayWindowStart = currentDayWindow;
  }
  
  return stats;
};

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
      httpMethod,
      expectedStatusCodes,
      requestHeaders = {},
      requestBody = '',
      responseValidation = {},
      responseTimeLimit,
      downConfirmationAttempts,
      cacheControlNoCache,
      checkRegionOverride,
      timezone
    } = request.data || {};

    logger.info('Parsed data:', { url, name, checkFrequency, type });

    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    logger.info('User authenticated:', uid);

    const now = Date.now();
    
    // OPTIMIZATION: Use cached user stats instead of querying all checks
    // This reduces reads from O(n) to O(1) for count/rate-limit checks
    let stats = await getUserCheckStats(uid);
    if (!stats) {
      // First time or stats missing - initialize from actual checks (one-time cost)
      stats = await initializeUserCheckStats(uid);
    } else {
      // Refresh rate limit windows based on current time
      stats = refreshRateLimitWindows(stats, now);
    }

    logger.info('User checks count:', stats.checkCount);

    // Get user tier early so we can enforce tier-based limits
    // Use live lookup to avoid stale cache after upgrade
    const userTier = await getUserTierLive(uid);
    logger.info('User tier:', userTier);

    // Enforce tier-based maximum checks per user
    const maxChecks = CONFIG.getMaxChecksForTier(userTier);
    if (stats.checkCount >= maxChecks) {
      throw new HttpsError("resource-exhausted", `You have reached the maximum of ${maxChecks} checks for your plan. Please delete some checks or upgrade your plan to add more.`);
    }

    // RATE LIMITING: Use cached counters instead of filtering all checks
    if (stats.checksAddedLastMinute >= CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE) {
      throw new HttpsError("resource-exhausted", `Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE} checks per minute. Please wait before adding more.`);
    }

    if (stats.checksAddedLastHour >= CONFIG.RATE_LIMIT_CHECKS_PER_HOUR) {
      throw new HttpsError("resource-exhausted", `Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_HOUR} checks per hour. Please wait before adding more.`);
    }

    if (stats.checksAddedLastDay >= CONFIG.RATE_LIMIT_CHECKS_PER_DAY) {
      throw new HttpsError("resource-exhausted", `Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_DAY} checks per day. Please wait before adding more.`);
    }

    const resolvedType = normalizeCheckType(type);

    // URL VALIDATION: Enhanced validation with spam protection
    const urlValidation = CONFIG.validateUrl(url, resolvedType);
    if (!urlValidation.valid) {
      throw new HttpsError("invalid-argument", `URL validation failed: ${urlValidation.reason}`);
    }

    logger.info('URL validation passed');

    // Map CheckType to Website["type"] for compatibility with default functions
    const websiteType: Website["type"] = resolvedType === "rest_endpoint" ? "rest" : resolvedType;
    const isHttpCheck = resolvedType === "website" || resolvedType === "rest_endpoint";
    const resolvedHttpMethod = isHttpCheck ? (httpMethod || getDefaultHttpMethod()) : undefined;
    const resolvedExpectedStatusCodes =
      isHttpCheck
        ? Array.isArray(expectedStatusCodes) && expectedStatusCodes.length > 0
          ? expectedStatusCodes
          : getDefaultExpectedStatusCodes(websiteType)
        : undefined;

    // Validate REST endpoint parameters
    if (resolvedType === 'rest_endpoint') {
      if (!resolvedHttpMethod || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(resolvedHttpMethod)) {
        throw new HttpsError("invalid-argument", "Invalid HTTP method. Must be one of: GET, POST, PUT, PATCH, DELETE, HEAD");
      }

      if (['POST', 'PUT', 'PATCH'].includes(resolvedHttpMethod) && requestBody) {
        try {
          JSON.parse(requestBody);
        } catch {
          throw new HttpsError("invalid-argument", "Request body must be valid JSON");
        }
      }

      if (!Array.isArray(resolvedExpectedStatusCodes) || resolvedExpectedStatusCodes.length === 0) {
        throw new HttpsError("invalid-argument", "Expected status codes must be a non-empty array");
      }
    }

    if (responseTimeLimit !== undefined && responseTimeLimit !== null) {
      if (typeof responseTimeLimit !== 'number' || !Number.isFinite(responseTimeLimit) || responseTimeLimit <= 0) {
        throw new HttpsError("invalid-argument", "Response time limit must be a positive number in milliseconds");
      }
      if (responseTimeLimit > CONFIG.RESPONSE_TIME_LIMIT_MAX_MS) {
        throw new HttpsError(
          "invalid-argument",
          `Response time limit cannot exceed ${CONFIG.RESPONSE_TIME_LIMIT_MAX_MS}ms`
        );
      }
    }

    if (downConfirmationAttempts !== undefined && downConfirmationAttempts !== null) {
      if (typeof downConfirmationAttempts !== 'number' || !Number.isFinite(downConfirmationAttempts)) {
        throw new HttpsError("invalid-argument", "Down confirmation attempts must be a number");
      }
      if (downConfirmationAttempts < 1 || downConfirmationAttempts > 99) {
        throw new HttpsError(
          "invalid-argument",
          "Down confirmation attempts must be between 1 and 99"
        );
      }
    }

    // OPTIMIZATION: Use URL hash index for O(1) duplicate detection
    // Instead of querying all checks, we check the hash index in user stats
    const canonicalUrl = getCanonicalUrlKey(url);
    const urlHash = hashCanonicalUrl(canonicalUrl);
    
    // Check hash index first (O(1) lookup)
    const existingCheckId = stats.urlHashes?.[urlHash];
    if (existingCheckId) {
      const typeLabel =
        resolvedType === 'rest_endpoint'
          ? 'API'
          : resolvedType === 'tcp'
            ? 'TCP'
            : resolvedType === 'udp'
              ? 'UDP'
              : 'website';
      throw new HttpsError("already-exists", `A ${typeLabel} check already exists for this URL`);
    }

    logger.info('Canonical duplicate check passed (hash index)');

    // Default to configured frequency for new checks unless user specifies otherwise
    const finalCheckFrequency = checkFrequency || CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES;
    logger.info('Final check frequency:', finalCheckFrequency);

    // Validate check frequency against tier limits
    const frequencyValidation = CONFIG.validateCheckFrequencyForTier(finalCheckFrequency, userTier);
    if (!frequencyValidation.valid) {
      throw new HttpsError("invalid-argument", frequencyValidation.reason || "Check frequency not allowed for your plan");
    }

    // Use cached maxOrderIndex from stats
    const maxOrderIndex = stats.maxOrderIndex;
    logger.info('Max order index:', maxOrderIndex);

    // Validate checkRegionOverride if provided
    const VALID_REGIONS_ADD: CheckRegion[] = ["us-central1", "europe-west1", "asia-southeast1"];
    if (checkRegionOverride !== undefined && checkRegionOverride !== null) {
      if (!VALID_REGIONS_ADD.includes(checkRegionOverride)) {
        throw new HttpsError("invalid-argument", `Invalid region. Must be one of: ${VALID_REGIONS_ADD.join(", ")}`);
      }
    }

    // Assign a single owning region for where the check executes.
    // If user specified a region override, use it; otherwise default to us-central1 and auto-detect after first check.
    const checkRegion: CheckRegion = checkRegionOverride ?? "us-central1";

    // Add check with new cost optimization fields
    const docRef = await withFirestoreRetry(() =>
      firestore.collection("checks").add({
        url,
        name: name || url,
        userId: uid,
        userTier,
        checkRegion,
        ...(checkRegionOverride ? { checkRegionOverride } : {}),
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
        orderIndex: maxOrderIndex + ORDER_INDEX_GAP, // Sparse indexing - add to bottom with gap
        type: resolvedType,
        ...(isHttpCheck
          ? {
            httpMethod: resolvedHttpMethod,
            expectedStatusCodes: resolvedExpectedStatusCodes,
            requestHeaders,
            requestBody,
            responseValidation,
            cacheControlNoCache: cacheControlNoCache === true,
          }
          : {}),
        ...(typeof responseTimeLimit === 'number' ? { responseTimeLimit } : {}),
        ...(typeof downConfirmationAttempts === 'number' ? { downConfirmationAttempts } : {}),
        ...(typeof timezone === 'string' && timezone ? { timezone } : {})
      })
    );

    // Update user stats atomically (1 write instead of re-reading all checks)
    // Include URL hash in the index for duplicate detection
    await firestore.collection("user_check_stats").doc(uid).set({
      checkCount: stats.checkCount + 1,
      maxOrderIndex: maxOrderIndex + ORDER_INDEX_GAP,
      lastCheckAddedAt: now,
      checksAddedLastMinute: stats.checksAddedLastMinute + 1,
      checksAddedLastHour: stats.checksAddedLastHour + 1,
      checksAddedLastDay: stats.checksAddedLastDay + 1,
      lastMinuteWindowStart: stats.lastMinuteWindowStart,
      lastHourWindowStart: stats.lastHourWindowStart,
      lastDayWindowStart: stats.lastDayWindowStart,
      [`urlHashes.${urlHash}`]: docRef.id,
    }, { merge: true });

    logger.info(`Check added successfully: ${url} by user ${uid} (${stats.checkCount + 1}/${CONFIG.MAX_CHECKS_PER_USER} total checks)`);

    return { id: docRef.id };
  } catch (error) {
    logger.error('Error in addCheck function:', error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", error instanceof Error ? error.message : "Unknown error");
  }
});

// Callable function to bulk add checks (used by bulk import - bypasses per-minute rate limit)
export const bulkAddChecks = onCall({
  cors: true,
  maxInstances: 5,
  timeoutSeconds: 120,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  try {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const { checks: items } = request.data || {};
    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpsError("invalid-argument", "checks must be a non-empty array");
    }

    const MAX_BULK_IMPORT = 200;
    if (items.length > MAX_BULK_IMPORT) {
      throw new HttpsError("invalid-argument", `Maximum ${MAX_BULK_IMPORT} checks per bulk import`);
    }

    const now = Date.now();

    // Get user stats once for the entire batch
    let stats = await getUserCheckStats(uid);
    if (!stats) {
      stats = await initializeUserCheckStats(uid);
    } else {
      stats = refreshRateLimitWindows(stats, now);
    }

    // Get user tier once for all checks
    const userTier = await getUserTierLive(uid);

    // Check total capacity (current + new must not exceed tier limit)
    const maxChecks = CONFIG.getMaxChecksForTier(userTier);
    if (stats.checkCount + items.length > maxChecks) {
      const remaining = Math.max(0, maxChecks - stats.checkCount);
      throw new HttpsError(
        "resource-exhausted",
        `Adding ${items.length} checks would exceed the maximum of ${maxChecks} for your plan. You currently have ${stats.checkCount} checks (${remaining} remaining).`
      );
    }

    // Enforce per-day rate limit (but skip per-minute since this is a bulk operation)
    if (stats.checksAddedLastDay + items.length > CONFIG.RATE_LIMIT_CHECKS_PER_DAY) {
      throw new HttpsError(
        "resource-exhausted",
        `Rate limit exceeded: Adding ${items.length} checks would exceed the daily limit of ${CONFIG.RATE_LIMIT_CHECKS_PER_DAY}. Please try again tomorrow.`
      );
    }

    let currentOrderIndex = stats.maxOrderIndex;
    let addedCount = 0;
    const urlHashUpdates: Record<string, string> = {};
    const results: Array<{ url: string; name?: string; success: boolean; id?: string; error?: string }> = [];

    for (const item of items) {
      try {
        const {
          url,
          name,
          checkFrequency,
          type = 'website',
          httpMethod,
          expectedStatusCodes,
          requestHeaders = {},
          requestBody = '',
          responseValidation = {},
          responseTimeLimit,
          downConfirmationAttempts,
          cacheControlNoCache,
        } = item;

        const resolvedType = normalizeCheckType(type);

        // URL validation
        const urlValidation = CONFIG.validateUrl(url, resolvedType);
        if (!urlValidation.valid) {
          results.push({ url, name, success: false, error: `URL validation failed: ${urlValidation.reason}` });
          continue;
        }

        // Duplicate detection via hash index
        const canonicalUrl = getCanonicalUrlKey(url);
        const urlHash = hashCanonicalUrl(canonicalUrl);

        if (stats.urlHashes?.[urlHash] || urlHashUpdates[urlHash]) {
          results.push({ url, name, success: false, error: "A check already exists for this URL" });
          continue;
        }

        // Map type for compatibility
        const websiteType: Website["type"] = resolvedType === "rest_endpoint" ? "rest" : resolvedType;
        const isHttpCheck = resolvedType === "website" || resolvedType === "rest_endpoint";
        const resolvedHttpMethod = isHttpCheck ? (httpMethod || getDefaultHttpMethod()) : undefined;
        const resolvedExpectedStatusCodes =
          isHttpCheck
            ? Array.isArray(expectedStatusCodes) && expectedStatusCodes.length > 0
              ? expectedStatusCodes
              : getDefaultExpectedStatusCodes(websiteType)
            : undefined;

        // Validate REST params
        if (resolvedType === 'rest_endpoint') {
          if (!resolvedHttpMethod || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(resolvedHttpMethod)) {
            results.push({ url, name, success: false, error: "Invalid HTTP method" });
            continue;
          }
          if (['POST', 'PUT', 'PATCH'].includes(resolvedHttpMethod) && requestBody) {
            try { JSON.parse(requestBody); } catch {
              results.push({ url, name, success: false, error: "Request body must be valid JSON" });
              continue;
            }
          }
          if (!Array.isArray(resolvedExpectedStatusCodes) || resolvedExpectedStatusCodes.length === 0) {
            results.push({ url, name, success: false, error: "Expected status codes must be a non-empty array" });
            continue;
          }
        }

        // Validate response time limit
        if (responseTimeLimit !== undefined && responseTimeLimit !== null) {
          if (typeof responseTimeLimit !== 'number' || !Number.isFinite(responseTimeLimit) || responseTimeLimit <= 0) {
            results.push({ url, name, success: false, error: "Response time limit must be a positive number" });
            continue;
          }
          if (responseTimeLimit > CONFIG.RESPONSE_TIME_LIMIT_MAX_MS) {
            results.push({ url, name, success: false, error: `Response time limit cannot exceed ${CONFIG.RESPONSE_TIME_LIMIT_MAX_MS}ms` });
            continue;
          }
        }

        // Validate down confirmation attempts
        if (downConfirmationAttempts !== undefined && downConfirmationAttempts !== null) {
          if (typeof downConfirmationAttempts !== 'number' || !Number.isFinite(downConfirmationAttempts)) {
            results.push({ url, name, success: false, error: "Down confirmation attempts must be a number" });
            continue;
          }
          if (downConfirmationAttempts < 1 || downConfirmationAttempts > 99) {
            results.push({ url, name, success: false, error: "Down confirmation attempts must be between 1 and 99" });
            continue;
          }
        }

        // Check frequency validation
        const finalCheckFrequency = checkFrequency || CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES;
        const frequencyValidation = CONFIG.validateCheckFrequencyForTier(finalCheckFrequency, userTier);
        if (!frequencyValidation.valid) {
          results.push({ url, name, success: false, error: frequencyValidation.reason || "Check frequency not allowed for your plan" });
          continue;
        }

        currentOrderIndex += ORDER_INDEX_GAP;
        const checkRegion: CheckRegion = "us-central1";

        const docRef = await withFirestoreRetry(() =>
          firestore.collection("checks").add({
            url,
            name: name || url,
            userId: uid,
            userTier,
            checkRegion,
            checkFrequency: finalCheckFrequency,
            consecutiveFailures: 0,
            lastFailureTime: null,
            disabled: false,
            immediateRecheckEnabled: true,
            createdAt: now,
            updatedAt: now,
            downtimeCount: 0,
            lastDowntime: null,
            status: "unknown",
            lastChecked: 0,
            nextCheckAt: now,
            orderIndex: currentOrderIndex,
            type: resolvedType,
            ...(isHttpCheck
              ? {
                httpMethod: resolvedHttpMethod,
                expectedStatusCodes: resolvedExpectedStatusCodes,
                requestHeaders,
                requestBody,
                responseValidation,
                cacheControlNoCache: cacheControlNoCache === true,
              }
              : {}),
            ...(typeof responseTimeLimit === 'number' ? { responseTimeLimit } : {}),
            ...(typeof downConfirmationAttempts === 'number' ? { downConfirmationAttempts } : {}),
          })
        );

        urlHashUpdates[urlHash] = docRef.id;
        addedCount++;
        results.push({ url, name, success: true, id: docRef.id });
      } catch (itemError) {
        results.push({
          url: item.url || 'unknown',
          name: item.name,
          success: false,
          error: itemError instanceof Error ? itemError.message : 'Unknown error',
        });
      }
    }

    // Update user stats once for the entire batch
    if (addedCount > 0) {
      const hashEntries: Record<string, string> = {};
      for (const [hash, id] of Object.entries(urlHashUpdates)) {
        hashEntries[`urlHashes.${hash}`] = id;
      }

      await firestore.collection("user_check_stats").doc(uid).set({
        checkCount: stats.checkCount + addedCount,
        maxOrderIndex: currentOrderIndex,
        lastCheckAddedAt: now,
        checksAddedLastMinute: stats.checksAddedLastMinute + addedCount,
        checksAddedLastHour: stats.checksAddedLastHour + addedCount,
        checksAddedLastDay: stats.checksAddedLastDay + addedCount,
        lastMinuteWindowStart: stats.lastMinuteWindowStart,
        lastHourWindowStart: stats.lastHourWindowStart,
        lastDayWindowStart: stats.lastDayWindowStart,
        ...hashEntries,
      }, { merge: true });
    }

    logger.info(`Bulk import: ${addedCount}/${items.length} checks added for user ${uid}`);

    return { results };
  } catch (error) {
    logger.error('Error in bulkAddChecks:', error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error instanceof Error ? error.message : "Unknown error");
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
    throw new HttpsError("internal", `Failed to get checks: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});



// Callable function to update a check or REST endpoint
export const updateCheck = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
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
    immediateRecheckEnabled,
    downConfirmationAttempts,
    responseTimeLimit,
    cacheControlNoCache,
    checkRegionOverride,
    timezone
  } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  if (!id) {
    throw new HttpsError("invalid-argument", "Check ID required");
  }

  // Validate checkRegionOverride if provided
  const VALID_REGIONS: CheckRegion[] = ["us-central1", "europe-west1", "asia-southeast1"];
  if (checkRegionOverride !== undefined && checkRegionOverride !== null) {
    if (!VALID_REGIONS.includes(checkRegionOverride)) {
      throw new HttpsError("invalid-argument", `Invalid region. Must be one of: ${VALID_REGIONS.join(", ")}`);
    }
  }

  if (responseTimeLimit !== undefined && responseTimeLimit !== null) {
    if (typeof responseTimeLimit !== 'number' || !Number.isFinite(responseTimeLimit) || responseTimeLimit <= 0) {
      throw new HttpsError("invalid-argument", "Response time limit must be a positive number in milliseconds");
    }
    if (responseTimeLimit > CONFIG.RESPONSE_TIME_LIMIT_MAX_MS) {
      throw new HttpsError(
        "invalid-argument",
        `Response time limit cannot exceed ${CONFIG.RESPONSE_TIME_LIMIT_MAX_MS}ms`
      );
    }
  }

  if (downConfirmationAttempts !== undefined && downConfirmationAttempts !== null) {
    if (typeof downConfirmationAttempts !== 'number' || !Number.isFinite(downConfirmationAttempts)) {
      throw new HttpsError("invalid-argument", "Down confirmation attempts must be a number");
    }
    if (downConfirmationAttempts < 1 || downConfirmationAttempts > 99) {
      throw new HttpsError(
        "invalid-argument",
        "Down confirmation attempts must be between 1 and 99"
      );
    }
  }

  // Check if check exists and belongs to user
  const checkDoc = await firestore.collection("checks").doc(id).get();
  if (!checkDoc.exists) {
    throw new HttpsError("not-found", "Check not found");
  }
  const checkData = checkDoc.data();
  if (checkData?.userId !== uid) {
    throw new HttpsError("permission-denied", "Insufficient permissions");
  }

    const targetType = normalizeCheckType(type ?? checkData.type);

    const urlValidation = CONFIG.validateUrl(url, targetType);
    if (!urlValidation.valid) {
      throw new HttpsError("invalid-argument", `URL validation failed: ${urlValidation.reason}`);
    }

    if (targetType === 'rest_endpoint') {
      const effectiveMethod = httpMethod ?? checkData.httpMethod ?? getDefaultHttpMethod();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(effectiveMethod)) {
        throw new HttpsError("invalid-argument", "Invalid HTTP method. Must be one of: GET, POST, PUT, PATCH, DELETE, HEAD");
      }

      if (requestBody && ['POST', 'PUT', 'PATCH'].includes(effectiveMethod)) {
        try {
          JSON.parse(requestBody);
        } catch {
          throw new HttpsError("invalid-argument", "Request body must be valid JSON");
        }
      }

      if (expectedStatusCodes && (!Array.isArray(expectedStatusCodes) || expectedStatusCodes.length === 0)) {
        throw new HttpsError("invalid-argument", "Expected status codes must be a non-empty array");
      }
    }

    // OPTIMIZATION: Use URL hash index for O(1) duplicate detection
    const canonicalUrl = getCanonicalUrlKey(url);
    const newUrlHash = hashCanonicalUrl(canonicalUrl);
    
    // Get old URL hash to update index if URL changed
    const oldCanonicalUrl = getCanonicalUrlKeySafe(checkData.url);
    const oldUrlHash = oldCanonicalUrl ? hashCanonicalUrl(oldCanonicalUrl) : null;
    const urlChanged = oldUrlHash !== newUrlHash;
    
    // Check hash index for duplicate (exclude current check by checking if hash points to this check)
    let stats = await getUserCheckStats(uid);
    if (!stats) {
      stats = await initializeUserCheckStats(uid);
    }
    
    const existingCheckId = stats.urlHashes?.[newUrlHash];
    if (existingCheckId && existingCheckId !== id) {
      const typeLabel =
        targetType === 'rest_endpoint'
          ? 'API'
          : targetType === 'tcp'
            ? 'TCP'
            : targetType === 'udp'
              ? 'UDP'
              : 'website';
      throw new HttpsError("already-exists", `A ${typeLabel} check already exists for this URL`);
    }

  // Validate check frequency against tier limits if frequency is being updated
  // Use live lookup for tier-gated actions to avoid stale cache after upgrade
  if (checkFrequency !== undefined) {
    const userTier = await getUserTierLive(uid);
    const frequencyValidation = CONFIG.validateCheckFrequencyForTier(checkFrequency, userTier);
    if (!frequencyValidation.valid) {
      throw new HttpsError("invalid-argument", frequencyValidation.reason || "Check frequency not allowed for your plan");
    }
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

  // Add down confirmation attempts if provided
  if (downConfirmationAttempts !== undefined) updateData.downConfirmationAttempts = downConfirmationAttempts;

  if (responseTimeLimit !== undefined) updateData.responseTimeLimit = responseTimeLimit;

  // Add REST endpoint fields if provided
  if (type !== undefined) updateData.type = type;
  if (httpMethod !== undefined) updateData.httpMethod = httpMethod;
  if (expectedStatusCodes !== undefined) updateData.expectedStatusCodes = expectedStatusCodes;
  if (requestHeaders !== undefined) updateData.requestHeaders = requestHeaders;
  if (requestBody !== undefined) updateData.requestBody = requestBody;
  if (responseValidation !== undefined) updateData.responseValidation = responseValidation;
  if (cacheControlNoCache !== undefined) updateData.cacheControlNoCache = cacheControlNoCache;
  if (timezone !== undefined) updateData.timezone = timezone || null;

  // Handle region override: null clears the override (back to auto), a valid region pins it
  if (checkRegionOverride !== undefined) {
    updateData.checkRegionOverride = checkRegionOverride; // null or a valid region string
    // When user sets a manual region, also update checkRegion immediately so the correct scheduler picks it up
    if (checkRegionOverride !== null) {
      updateData.checkRegion = checkRegionOverride;
    }
  }

  // Update check directly so caller gets immediate error feedback
  try {
    await withFirestoreRetry(() => firestore.collection("checks").doc(id).update(updateData));
    
    // Update URL hash index if URL changed
    if (urlChanged) {
      const { FieldValue } = await import("firebase-admin/firestore");
      const hashUpdate: Record<string, unknown> = {
        [`urlHashes.${newUrlHash}`]: id,
      };
      if (oldUrlHash) {
        hashUpdate[`urlHashes.${oldUrlHash}`] = FieldValue.delete();
      }
      await firestore.collection("user_check_stats").doc(uid).set(hashUpdate, { merge: true });
    }
    
    return { success: true };
  } catch (error) {
    logger.error(`Failed to update check ${id} for user ${uid}:`, error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", error instanceof Error ? error.message : "Unknown error");
  }
});

// Callable function to delete a website
export const deleteWebsite = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const { id } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  if (!id) {
    throw new HttpsError("invalid-argument", "Website ID required");
  }
  // Check if website exists and belongs to user
  const websiteDoc = await firestore.collection("checks").doc(id).get();
  if (!websiteDoc.exists) {
    throw new HttpsError("not-found", "Website not found");
  }
  const websiteData = websiteDoc.data();
  if (websiteData?.userId !== uid) {
    throw new HttpsError("permission-denied", "Insufficient permissions");
  }

  // Remove check from all status pages that reference it
  const statusPagesSnapshot = await firestore
    .collection("status_pages")
    .where("userId", "==", uid)
    .where("checkIds", "array-contains", id)
    .get();

  if (!statusPagesSnapshot.empty) {
    const { FieldValue } = await import("firebase-admin/firestore");
    const batch = firestore.batch();
    statusPagesSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, {
        checkIds: FieldValue.arrayRemove(id),
        updatedAt: Date.now(),
      });
    });
    await batch.commit();
    logger.info(`[deleteWebsite] Removed check ${id} from ${statusPagesSnapshot.size} status page(s)`);
  }

  // Get URL hash before deleting to remove from index
  const urlToDelete = websiteData?.url;
  const canonicalUrlToDelete = urlToDelete ? getCanonicalUrlKeySafe(urlToDelete) : null;
  const urlHashToDelete = canonicalUrlToDelete ? hashCanonicalUrl(canonicalUrlToDelete) : null;

  // Delete website
  await withFirestoreRetry(() => firestore.collection("checks").doc(id).delete());
  
  // Update user stats to decrement check count and remove URL hash
  const { FieldValue: FV } = await import("firebase-admin/firestore");
  const statsUpdate: Record<string, unknown> = {
    checkCount: FV.increment(-1),
  };
  if (urlHashToDelete) {
    statsUpdate[`urlHashes.${urlHashToDelete}`] = FV.delete();
  }
  await firestore.collection("user_check_stats").doc(uid).set(statsUpdate, { merge: true });
  
  return { success: true };
});

// Function to enable/disable a check manually
export const toggleCheckStatus = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [RESEND_API_KEY, RESEND_FROM], // Needed for handleCheckDisabled email notifications
}, async (request) => {
  const { id, disabled, reason } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }
  if (!id) {
    throw new HttpsError("invalid-argument", "Check ID required");
  }

  // Check if check exists and belongs to user
  const checkDoc = await firestore.collection("checks").doc(id).get();
  if (!checkDoc.exists) {
    throw new HttpsError("not-found", "Check not found");
  }
  const checkData = checkDoc.data();
  if (checkData?.userId !== uid) {
    throw new HttpsError("permission-denied", "Insufficient permissions");
  }

  const now = Date.now();
  const disabledReason = reason || "Manually disabled by user";
  const updateData: Record<string, unknown> = {
    disabled: disabled,
    updatedAt: now
  };

  if (disabled) {
    updateData.disabledAt = now;
    updateData.disabledReason = disabledReason;
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

  // If disabling, record history to BigQuery and send notification email
  // (replaces the old logCheckDisabled Firestore trigger)
  if (disabled) {
    const website: Website = { ...(checkData as Website), id };
    await handleCheckDisabled(website, disabledReason, now);
    await flushBigQueryInserts(); // Ensure history is persisted immediately
  }

  return {
    success: true,
    disabled,
    message: disabled ? "Check disabled" : "Check enabled"
  };
});



// Optional: Manual trigger for immediate checking (for testing)
export const manualCheck = onCall({
  secrets: [
    RESEND_API_KEY,
    RESEND_FROM,
    CLERK_SECRET_KEY_PROD,
    CLERK_SECRET_KEY_DEV,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_FROM_NUMBER,
    TWILIO_MESSAGING_SERVICE_SID,
  ],
}, async (request) => {
  const { checkId } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  if (checkId) {
    // Check specific check
    const checkDoc = await firestore.collection("checks").doc(checkId).get();
    if (!checkDoc.exists) {
      throw new HttpsError("not-found", "Check not found");
    }
    const checkData = checkDoc.data() as Website;
    if (checkData?.userId !== uid) {
      throw new HttpsError("permission-denied", "Insufficient permissions");
    }
    const website: Website = { ...checkData, id: checkDoc.id };

    const alertContext: AlertContext = {
      throttleCache: new Set<string>(),
      budgetCache: new Map<string, number>(),
      emailMonthlyBudgetCache: new Map<string, number>(),
      smsThrottleCache: new Set<string>(),
      smsBudgetCache: new Map<string, number>(),
      smsMonthlyBudgetCache: new Map<string, number>()
    };

    // Perform immediate check using the same logic as scheduled checks
    try {
      const checkType = normalizeCheckType(website.type);
      const checkResult =
        checkType === "tcp"
          ? await checkTcpEndpoint(website)
          : checkType === "udp"
            ? await checkUdpEndpoint(website)
            : await checkRestEndpoint(website);
      const status = checkResult.status;
      const responseTime = checkResult.responseTime;
      const prevConsecutiveFailures = Number(website.consecutiveFailures || 0);
      const nextConsecutiveFailures = status === 'online' ? 0 : prevConsecutiveFailures + 1;

      // Store check history using optimized approach
      await storeCheckHistory(website, checkResult);

      const now = Date.now();
      // Use live tier to avoid stale cached tier on the check doc (e.g., after upgrades).
      const effectiveTier = await getUserTier(uid);
      website.userTier = effectiveTier as Website["userTier"];
      const targetLat = checkResult.targetLatitude ?? website.targetLatitude;
      const targetLon = checkResult.targetLongitude ?? website.targetLongitude;

        const updateData: StatusUpdateData & { lastStatusCode?: number; userTier?: Website["userTier"] } = {
          status,
          checkRegion: website.checkRegionOverride
            ?? (website.checkRegion as CheckRegion | undefined)
            ?? pickNearestRegion(targetLat, targetLon),
          userTier: effectiveTier as Website["userTier"],
          lastChecked: now,
          lastHistoryAt: now,
          updatedAt: now,
        responseTime: status === 'online' ? responseTime : null,
        lastStatusCode: checkResult.statusCode,
        consecutiveFailures: nextConsecutiveFailures,
        detailedStatus: checkResult.detailedStatus,
        targetCountry: checkResult.targetCountry,
        targetRegion: checkResult.targetRegion,
        targetCity: checkResult.targetCity,
        targetLatitude: checkResult.targetLatitude,
        targetLongitude: checkResult.targetLongitude,
        targetHostname: checkResult.targetHostname,
        targetIp: checkResult.targetIp,
        targetIpsJson: checkResult.targetIpsJson,
        targetIpFamily: checkResult.targetIpFamily,
        targetAsn: checkResult.targetAsn,
        targetOrg: checkResult.targetOrg,
        targetIsp: checkResult.targetIsp,
        nextCheckAt: CONFIG.getNextCheckAtMs(website.checkFrequency || CONFIG.CHECK_INTERVAL_MINUTES, now)
      };

      if (typeof checkResult.targetMetadataLastChecked === "number") {
        updateData.targetMetadataLastChecked = checkResult.targetMetadataLastChecked;
      }

      // Add SSL certificate information if available
      if (checkResult.sslCertificate) {
        const sslLastChecked =
          typeof checkResult.securityMetadataLastChecked === "number"
            ? checkResult.securityMetadataLastChecked
            : website.sslCertificate?.lastChecked ?? now;
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
          lastChecked: sslLastChecked
        };

        if (checkResult.sslCertificate.issuer) cleanSslData.issuer = checkResult.sslCertificate.issuer;
        if (checkResult.sslCertificate.subject) cleanSslData.subject = checkResult.sslCertificate.subject;
        if (checkResult.sslCertificate.validFrom) cleanSslData.validFrom = checkResult.sslCertificate.validFrom;
        if (checkResult.sslCertificate.validTo) cleanSslData.validTo = checkResult.sslCertificate.validTo;
        if (checkResult.sslCertificate.daysUntilExpiry !== undefined) cleanSslData.daysUntilExpiry = checkResult.sslCertificate.daysUntilExpiry;
        if (checkResult.sslCertificate.error) cleanSslData.error = checkResult.sslCertificate.error;

        updateData.sslCertificate = cleanSslData;

        // Trigger SSL alerts if needed (with state-change detection like online/offline alerts)
        if (checkResult.sslCertificate) {
          await triggerSSLAlert(website, checkResult.sslCertificate, website.sslCertificate, alertContext);
        }
      }


      if (status === 'offline') {
        updateData.downtimeCount = (Number(website.downtimeCount) || 0) + 1;
        updateData.lastDowntime = now;
        updateData.lastFailureTime =
          prevConsecutiveFailures > 0 && website.lastFailureTime
            ? website.lastFailureTime
            : now;
        updateData.lastError = checkResult.error || null;
      } else {
        updateData.lastError = null;
        if (nextConsecutiveFailures === 0 && website.lastFailureTime) {
          updateData.lastFailureTime = null;
        }
      }

      // CRITICAL: Check buffer first to get the most recent status before determining oldStatus
      // This prevents duplicate alerts when status updates are buffered
      // Must check BEFORE adding update to buffer
      const bufferedUpdate = statusUpdateBuffer.get(checkId);
      const effectiveOldStatus = bufferedUpdate?.status && bufferedUpdate.status.trim().length > 0
        ? bufferedUpdate.status
        : (website.status || 'unknown');

      const oldStatus = effectiveOldStatus;

      await addStatusUpdate(checkId, updateData);

      if (oldStatus !== status && oldStatus !== 'unknown') {
        // Pass counters so flap suppression uses the NEW consecutive count, not the old one
        const counters = {
          consecutiveFailures: nextConsecutiveFailures,
          consecutiveSuccesses: status === 'online' ? 1 : 0,
        };
        // Enrich website with timing data for the alert email
        const websiteForAlert: Website = {
          ...website,
          dnsMs: checkResult.timings?.dnsMs,
          connectMs: checkResult.timings?.connectMs,
          tlsMs: checkResult.timings?.tlsMs,
          ttfbMs: checkResult.timings?.ttfbMs,
        };
        await triggerAlert(websiteForAlert, oldStatus, status, counters, alertContext);
      }
      return { status, lastChecked: Date.now() };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const now = Date.now();
      const prevConsecutiveFailures = Number(website.consecutiveFailures || 0);
      const nextConsecutiveFailures = prevConsecutiveFailures + 1;
      const failureStartTime =
        prevConsecutiveFailures > 0 && website.lastFailureTime
          ? website.lastFailureTime
          : now;

      // Store check history for error case using optimized approach
      await storeCheckHistory(website, {
        status: 'offline',
        responseTime: 0,
        statusCode: 0,
        error: errorMessage,
        // Include timing data for consistency - only totalMs is meaningful for errors
        timings: { totalMs: 0 },
      });

        const updateData: StatusUpdateData = {
          status: 'offline',
          lastChecked: now,
          lastHistoryAt: now,
          updatedAt: now,
          lastError: errorMessage,
        downtimeCount: (Number(website.downtimeCount) || 0) + 1,
        lastDowntime: now,
        lastFailureTime: failureStartTime,
        consecutiveFailures: nextConsecutiveFailures,
        detailedStatus: 'DOWN'
      };

      // CRITICAL: Check buffer first to get the most recent status before determining oldStatus
      // Must check BEFORE adding update to buffer
      const bufferedUpdate = statusUpdateBuffer.get(checkId);
      const effectiveOldStatus = bufferedUpdate?.status && bufferedUpdate.status.trim().length > 0
        ? bufferedUpdate.status
        : (website.status || 'unknown');

      const oldStatus = effectiveOldStatus;
      const newStatus = 'offline';

      await addStatusUpdate(checkId, updateData);

      if (oldStatus !== newStatus && oldStatus !== 'unknown') {
        // Pass counters so flap suppression uses the NEW consecutive count, not the old one
        const counters = {
          consecutiveFailures: nextConsecutiveFailures,
          consecutiveSuccesses: 0,
        };
        await triggerAlert(website, oldStatus, newStatus, counters, alertContext);
      }
      return { status: 'offline', error: errorMessage };
    } finally {
      await flushBigQueryInserts();
      await flushStatusUpdates();
    }
  }

  throw new Error("Check ID required");
});

// Callable function to force-update check regions for all user's checks
// Useful for migrating existing checks to nearest region
export const updateCheckRegions = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    // Get user tier first - force refresh by clearing cache
    // First, clear the cached tier to force a fresh lookup
    const userRef = firestore.collection('users').doc(uid);
    await userRef.set({ tier: null, tierUpdatedAt: 0 }, { merge: true });

    const userTier = await getUserTier(uid);
    logger.info(`Updating check regions for user ${uid}, tier: ${userTier}`);

    // Get all user's checks
    const checksSnapshot = await firestore
      .collection("checks")
      .where("userId", "==", uid)
      .get();

    if (checksSnapshot.empty) {
      return { success: true, updated: 0, message: "No checks found" };
    }

    logger.info(`Found ${checksSnapshot.size} checks for user ${uid}`);

    const updates: Array<{ id: string; from: CheckRegion; to: CheckRegion }> = [];
    const checksNeedingGeo: Array<{ doc: FirebaseFirestore.QueryDocumentSnapshot; check: Website }> = [];
    let batch = firestore.batch();
    let batchCount = 0;
    const skippedChecks: Array<{ id: string; reason: string }> = [];

    // First pass: process checks that already have geo data
    for (const doc of checksSnapshot.docs) {
      const check = doc.data() as Website;
      const currentRegion: CheckRegion = (check.checkRegion as CheckRegion | undefined) ?? "us-central1";

      // Skip checks with a manual region override — user has pinned the region
      if (check.checkRegionOverride) {
        skippedChecks.push({ id: doc.id, reason: `Manual region override (${check.checkRegionOverride})` });
        continue;
      }

      // Use existing target geo if available
      const targetLat = check.targetLatitude;
      const targetLon = check.targetLongitude;

      if (typeof targetLat === "number" && typeof targetLon === "number") {
        const desiredRegion = pickNearestRegion(targetLat, targetLon);

        logger.info(`Check ${doc.id} (${check.url}): current=${currentRegion}, desired=${desiredRegion}, lat=${targetLat}, lon=${targetLon}`);

        if (currentRegion !== desiredRegion) {
          logger.info(`Updating check ${doc.id} from ${currentRegion} to ${desiredRegion}`);
          batch.update(doc.ref, {
            checkRegion: desiredRegion,
            updatedAt: Date.now()
          });
          updates.push({ id: doc.id, from: currentRegion, to: desiredRegion });
          batchCount++;

          // Firestore batch limit is 500, commit and start new batch if needed
          if (batchCount >= 500) {
            await batch.commit();
            batch = firestore.batch(); // Create new batch for next set of updates
            batchCount = 0;
          }
        } else {
          skippedChecks.push({ id: doc.id, reason: `Already correct region (${currentRegion})` });
        }
      } else {
        // Collect checks that need geo data from history
        logger.debug(`Check ${doc.id} (${check.url}) missing geo data on document, will check BigQuery`);
        checksNeedingGeo.push({ doc, check });
      }
    }

    // Second pass: fetch geo data from BigQuery for checks missing it
    if (checksNeedingGeo.length > 0) {
      logger.info(`Fetching geo data from BigQuery for ${checksNeedingGeo.length} checks`);

      const { getCheckHistory } = await import('./bigquery.js');

      // Query BigQuery for the most recent entry with geo data for each check
      for (const { doc, check } of checksNeedingGeo) {
        try {
          logger.info(`Fetching BigQuery history for check ${doc.id} (${check.url})`);
          // Get the most recent check history entry (limit 1, sorted by timestamp desc)
          const history = await getCheckHistory(check.id, uid, 1, 0);
          const historyArray = Array.isArray(history) ? history : [];

          logger.info(`BigQuery returned ${historyArray.length} history entries for check ${doc.id}`);

          if (historyArray.length > 0) {
            const latest = historyArray[0] as {
              target_latitude?: number | null;
              target_longitude?: number | null;
            };

            const targetLat = latest.target_latitude ?? undefined;
            const targetLon = latest.target_longitude ?? undefined;

            logger.info(`Check ${doc.id} history geo: lat=${targetLat}, lon=${targetLon}`);

            if (typeof targetLat === "number" && typeof targetLon === "number") {
              const currentRegion: CheckRegion = (check.checkRegion as CheckRegion | undefined) ?? "us-central1";
              const desiredRegion = pickNearestRegion(targetLat, targetLon);

              logger.info(`Check ${doc.id} (${check.url}) from BigQuery: current=${currentRegion}, desired=${desiredRegion}, lat=${targetLat}, lon=${targetLon}`);

              if (currentRegion !== desiredRegion) {
                logger.info(`Updating check ${doc.id} from ${currentRegion} to ${desiredRegion} (from BigQuery)`);
                batch.update(doc.ref, {
                  checkRegion: desiredRegion,
                  targetLatitude: targetLat, // Also update the check doc with geo data
                  targetLongitude: targetLon,
                  updatedAt: Date.now()
                });
                updates.push({ id: doc.id, from: currentRegion, to: desiredRegion });
                batchCount++;

                // Firestore batch limit is 500, commit and start new batch if needed
                if (batchCount >= 500) {
                  await batch.commit();
                  batch = firestore.batch();
                  batchCount = 0;
                }
              } else {
                logger.info(`Check ${doc.id} already has correct region ${currentRegion}, but updating geo data on document`);
                // Even if region is correct, update the check doc with geo data for future use
                batch.update(doc.ref, {
                  targetLatitude: targetLat,
                  targetLongitude: targetLon,
                  updatedAt: Date.now()
                });
                batchCount++;
                if (batchCount >= 500) {
                  await batch.commit();
                  batch = firestore.batch();
                  batchCount = 0;
                }
              }
            } else {
              logger.warn(`Check ${doc.id} (${check.url}) has no geo data in history (lat=${targetLat}, lon=${targetLon})`);
              skippedChecks.push({ id: doc.id, reason: `No geo data in BigQuery history` });
            }
          } else {
            logger.warn(`Check ${doc.id} (${check.url}) has no history entries in BigQuery`);
            skippedChecks.push({ id: doc.id, reason: `No history entries in BigQuery` });
          }
        } catch (error) {
          logger.error(`Failed to fetch geo data from BigQuery for check ${doc.id}:`, error);
          skippedChecks.push({ id: doc.id, reason: `BigQuery error: ${error instanceof Error ? error.message : String(error)}` });
          // Continue with other checks
        }
      }
    }

    // Commit remaining updates
    if (batchCount > 0) {
      await batch.commit();
    }

    logger.info(`Updated ${updates.length} check regions for user ${uid}`, {
      updates: updates.map(u => ({ id: u.id, from: u.from, to: u.to })),
      skipped: skippedChecks.length,
      checksNeedingGeo: checksNeedingGeo.length
    });

    return {
      success: true,
      updated: updates.length,
      updates: updates.map(u => ({ id: u.id, from: u.from, to: u.to })),
      skipped: skippedChecks.length,
      debug: {
        totalChecks: checksSnapshot.size,
        checksWithGeo: checksSnapshot.size - checksNeedingGeo.length,
        checksNeedingGeo: checksNeedingGeo.length,
        skipped: skippedChecks.slice(0, 10) // First 10 for debugging
      }
    };
  } catch (error) {
    logger.error(`Failed to update check regions for user ${uid}:`, error);
    throw new Error(`Failed to update check regions: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});
