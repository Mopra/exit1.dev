import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { WebhookEvent } from './types';
import { CONFIG } from './config';
import {
  DeliveryFailureMeta,
  emitAlertMetric,
  sampledInfo,
  evaluateDeliveryState,
  markDeliverySuccess,
  recordDeliveryFailure,
  getGuardKey,
  getThrottleWindowStart,
  CACHE_PRUNE_INTERVAL_MS,
} from './alert-helpers';

// ============================================================================
// IN-MEMORY WINDOW CACHES
// ============================================================================

export const throttleWindowCache = new Map<string, { windowStart: number; windowEnd: number }>();
export const budgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();
export const emailMonthlyBudgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();
export const smsThrottleWindowCache = new Map<string, { windowStart: number; windowEnd: number }>();
export const smsBudgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();
export const smsMonthlyBudgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();

let lastCachePrune = 0;
let lastSmsCachePrune = 0;

// ============================================================================
// GUARD TRACKERS
// ============================================================================

export const throttleGuardTracker = new Map<string, DeliveryFailureMeta>();
export const budgetGuardTracker = new Map<string, DeliveryFailureMeta>();
export const emailMonthlyBudgetGuardTracker = new Map<string, DeliveryFailureMeta>();
export const smsThrottleGuardTracker = new Map<string, DeliveryFailureMeta>();
export const smsBudgetGuardTracker = new Map<string, DeliveryFailureMeta>();
export const smsMonthlyBudgetGuardTracker = new Map<string, DeliveryFailureMeta>();

// ============================================================================
// DEFERRED BUDGET WRITES
// ============================================================================

// OPTIMIZATION: Deferred budget writes - track pending writes in memory, flush at end of run
// This reduces Firestore writes from O(alerts) to O(unique users)
interface DeferredBudgetWrite {
  userId: string;
  collection: string;
  windowStart: number;
  windowEnd: number;
  count: number;
  ttlBufferMs: number;
}
const deferredBudgetWrites = new Map<string, DeferredBudgetWrite>();

// Track if we're in deferred write mode (during scheduler runs)
let deferredWriteMode = false;

export const enableDeferredBudgetWrites = () => {
  deferredWriteMode = true;
};

export const disableDeferredBudgetWrites = () => {
  deferredWriteMode = false;
};

export const flushDeferredBudgetWrites = async (): Promise<void> => {
  if (deferredBudgetWrites.size === 0) {
    return;
  }

  const writes = Array.from(deferredBudgetWrites.values());
  deferredBudgetWrites.clear();

  const firestore = getFirestore();
  const BATCH_SIZE = 400;

  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = firestore.batch();
    const batchWrites = writes.slice(i, i + BATCH_SIZE);

    for (const write of batchWrites) {
      const docId = `${write.userId}__${write.windowStart}`;
      const docRef = firestore.collection(write.collection).doc(docId);
      batch.set(docRef, {
        userId: write.userId,
        count: write.count,
        windowStart: write.windowStart,
        windowEnd: write.windowEnd,
        updatedAt: Date.now(),
        expireAt: Timestamp.fromMillis(write.windowEnd + write.ttlBufferMs),
      }, { merge: true });
    }

    try {
      await batch.commit();
    } catch (error) {
      logger.error(`Failed to flush deferred budget writes batch`, error);
      // Re-add failed writes for next flush attempt
      for (const write of batchWrites) {
        const key = `${write.collection}:${write.userId}:${write.windowStart}`;
        deferredBudgetWrites.set(key, write);
      }
    }
  }
};

const addDeferredBudgetWrite = (
  collection: string,
  userId: string,
  windowStart: number,
  windowEnd: number,
  count: number,
  ttlBufferMs: number
) => {
  const key = `${collection}:${userId}:${windowStart}`;
  deferredBudgetWrites.set(key, {
    userId,
    collection,
    windowStart,
    windowEnd,
    count,
    ttlBufferMs,
  });
};

// Seed a budget count from Firestore when in-memory caches miss (e.g. after cold start).
// Without this, deferred-mode budget tracking starts from 0 and overwrites the real count.
async function seedBudgetCountFromFirestore(
  collection: string,
  userId: string,
  windowStart: number
): Promise<number> {
  try {
    const firestore = getFirestore();
    const docId = `${userId}__${windowStart}`;
    const snap = await firestore.collection(collection).doc(docId).get();
    if (snap.exists) {
      return Number((snap.data() as { count?: unknown }).count || 0);
    }
  } catch (error) {
    logger.warn(`Failed to seed budget count from Firestore (${collection}/${userId}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

// ============================================================================
// CACHE PRUNING
// ============================================================================

export const pruneEmailCaches = (now: number = Date.now()) => {
  if (now - lastCachePrune < CACHE_PRUNE_INTERVAL_MS) {
    return;
  }
  lastCachePrune = now;

  for (const [key, entry] of throttleWindowCache.entries()) {
    if (entry.windowEnd <= now) {
      throttleWindowCache.delete(key);
    }
  }

  for (const [userId, entry] of budgetWindowCache.entries()) {
    if (entry.windowEnd <= now) {
      budgetWindowCache.delete(userId);
    }
  }

  for (const [userId, entry] of emailMonthlyBudgetWindowCache.entries()) {
    if (entry.windowEnd <= now) {
      emailMonthlyBudgetWindowCache.delete(userId);
    }
  }
};

export const pruneSmsCaches = (now: number = Date.now()) => {
  if (now - lastSmsCachePrune < CACHE_PRUNE_INTERVAL_MS) {
    return;
  }
  lastSmsCachePrune = now;

  for (const [key, entry] of smsThrottleWindowCache.entries()) {
    if (entry.windowEnd <= now) {
      smsThrottleWindowCache.delete(key);
    }
  }

  for (const [userId, entry] of smsBudgetWindowCache.entries()) {
    if (entry.windowEnd <= now) {
      smsBudgetWindowCache.delete(userId);
    }
  }

  for (const [userId, entry] of smsMonthlyBudgetWindowCache.entries()) {
    if (entry.windowEnd <= now) {
      smsMonthlyBudgetWindowCache.delete(userId);
    }
  }
};

// ============================================================================
// EMAIL THROTTLE
// ============================================================================

export async function acquireEmailThrottleSlot(
  userId: string,
  checkId: string,
  eventType: WebhookEvent,
  cache?: Set<string>
): Promise<boolean> {
  pruneEmailCaches();
  const guardKey = getGuardKey('throttle', `${userId}:${checkId}:${eventType}`);
  try {
    const guardState = evaluateDeliveryState(throttleGuardTracker, guardKey);
    if (guardState === 'skipped' || guardState === 'dropped') {
      logger.warn(`Throttle guard active for ${userId}/${checkId}/${eventType}, denying send until backoff expires`);
      emitAlertMetric('throttle_guard_block', { userId, checkId, eventType });
      return false;
    }

    // Get event-specific throttle window, fallback to default
    const windowMs = CONFIG.EMAIL_THROTTLE_WINDOWS[eventType] || CONFIG.EMAIL_THROTTLE_WINDOW_MS;
    const now = Date.now();
    const windowStart = getThrottleWindowStart(now, windowMs);
    const windowEnd = windowStart + windowMs;

    // Construct a unique key for this throttle window
    const docId = `${userId}__${checkId}__${eventType}__${windowStart}`;
    const cachedWindow = throttleWindowCache.get(docId);
    if (cachedWindow && cachedWindow.windowEnd > now) {
      cache?.add(docId);
      sampledInfo(`Email suppressed by in-memory throttle cache for ${userId}/${checkId}/${eventType}`);
      return false;
    }

    // Check in-memory cache first (avoid Firestore write if already throttled)
    if (cache && cache.has(docId)) {
      return false;
    }

    const firestore = getFirestore();
    const docRef = firestore.collection(CONFIG.EMAIL_THROTTLE_COLLECTION).doc(docId);
    await docRef.create({
      userId,
      checkId,
      eventType,
      windowStart,
      windowEnd: windowStart + windowMs,
      createdAt: now,
      expireAt: Timestamp.fromMillis(windowStart + windowMs + (10 * 60 * 1000)), // keep small buffer past window
    });

    // Add to cache on success
    if (cache) {
      cache.add(docId);
    }
    throttleWindowCache.set(docId, { windowStart, windowEnd });
    markDeliverySuccess(throttleGuardTracker, guardKey);

    return true;
  } catch (error) {
    // Only suppress on already-exists; otherwise, log and allow send to avoid dropping alerts
    const err = error as unknown as { code?: number | string; status?: string; message?: string };
    const codeString = typeof err.code === 'number' ? String(err.code) : (err.code || err.status || '');
    const message = (err.message || '').toUpperCase();
    const alreadyExists = codeString === '6' || codeString === 'ALREADY_EXISTS' || message.includes('ALREADY_EXISTS') || message.includes('ALREADY EXISTS');

    if (alreadyExists) {
      const windowMs = CONFIG.EMAIL_THROTTLE_WINDOWS[eventType] || CONFIG.EMAIL_THROTTLE_WINDOW_MS;

      // Also update cache if it exists but wasn't in cache (e.g. from previous run or other instance)
      if (cache) {
        const now = Date.now();
        const windowStart = getThrottleWindowStart(now, windowMs);
        const docId = `${userId}__${checkId}__${eventType}__${windowStart}`;
        cache.add(docId);
      }
      const windowStart = getThrottleWindowStart(Date.now(), windowMs);
      throttleWindowCache.set(`${userId}__${checkId}__${eventType}__${windowStart}`, {
        windowStart,
        windowEnd: windowStart + windowMs,
      });

      return false;
    }
    recordDeliveryFailure(throttleGuardTracker, guardKey, error);
    logger.warn(`Throttle check failed (denying email) for ${userId}/${checkId}/${eventType}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('throttle_guard_error', { userId, checkId, eventType });
    return false;
  }
}

// ============================================================================
// EMAIL BUDGET (short-window)
// ============================================================================

export async function acquireUserEmailBudget(
  userId: string,
  windowMs: number,
  maxCount: number,
  cache?: Map<string, number>
): Promise<boolean> {
  pruneEmailCaches();
  if (windowMs <= 0 || maxCount <= 0) {
    return true;
  }

  const now = Date.now();
  const windowStart = getThrottleWindowStart(now, windowMs);
  const windowEnd = windowStart + windowMs;

  const cachedBudget = budgetWindowCache.get(userId);
  if (cachedBudget && cachedBudget.windowStart === windowStart && cachedBudget.count >= maxCount) {
    cache?.set(userId, cachedBudget.count);
    sampledInfo(`Email suppressed by budget cache for ${userId}`, { count: cachedBudget.count, max: maxCount });
    return false;
  }

  // Check in-memory cache first
  if (cache) {
    const currentCount = cache.get(userId);
    if (currentCount !== undefined && currentCount >= maxCount) {
      return false;
    }
  }

  const guardKey = getGuardKey('budget', userId);
  const guardState = evaluateDeliveryState(budgetGuardTracker, guardKey);
  if (guardState === 'skipped' || guardState === 'dropped') {
    logger.warn(`Budget guard active for ${userId}, denying send until backoff expires`);
    emitAlertMetric('budget_guard_block', { userId });
    return false;
  }

  const ttlBufferMs = CONFIG.EMAIL_USER_BUDGET_TTL_BUFFER_MS || (5 * 60 * 1000);

  // OPTIMIZATION: In deferred write mode, use memory-only tracking
  // Firestore writes will be batched at end of scheduler run
  if (deferredWriteMode && cache) {
    let currentCount = cache.get(userId) ?? cachedBudget?.count ?? undefined;
    if (currentCount === undefined) {
      currentCount = await seedBudgetCountFromFirestore(CONFIG.EMAIL_USER_BUDGET_COLLECTION, userId, windowStart);
      cache.set(userId, currentCount);
      budgetWindowCache.set(userId, { windowStart, windowEnd, count: currentCount });
    }
    if (currentCount >= maxCount) {
      cache.set(userId, currentCount);
      return false;
    }
    const newCount = currentCount + 1;
    cache.set(userId, newCount);
    budgetWindowCache.set(userId, { windowStart, windowEnd, count: newCount });
    addDeferredBudgetWrite(CONFIG.EMAIL_USER_BUDGET_COLLECTION, userId, windowStart, windowEnd, newCount, ttlBufferMs);
    markDeliverySuccess(budgetGuardTracker, guardKey);
    return true;
  }

  try {
    const firestore = getFirestore();
    const docId = `${userId}__${windowStart}`;
    const docRef = firestore.collection(CONFIG.EMAIL_USER_BUDGET_COLLECTION).doc(docId);

    const result = await firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      const currentCount = snapshot.exists ? Number(snapshot.data()?.count || 0) : 0;

      if (currentCount >= maxCount) {
        return { allowed: false, count: currentCount };
      }

      const newCount = currentCount + 1;
      const windowEnd = windowStart + windowMs;
      const timestamp = Timestamp.fromMillis(now);
      const expireAt = Timestamp.fromMillis(windowEnd + ttlBufferMs);

      if (snapshot.exists) {
        tx.update(docRef, {
          count: newCount,
          updatedAt: timestamp,
        });
      } else {
        tx.set(docRef, {
          userId,
          windowStart,
          windowEnd,
          count: newCount,
          createdAt: timestamp,
          updatedAt: timestamp,
          expireAt,
        });
      }

      return { allowed: true, count: newCount };
    });

    // Update cache with new count from Firestore
    if (cache && result.allowed) {
      cache.set(userId, result.count);
    } else if (cache && !result.allowed) {
      cache.set(userId, result.count); // Ensure cache knows we hit limit
    }
    budgetWindowCache.set(userId, { windowStart, windowEnd, count: result.count });

    if (result.allowed) {
      markDeliverySuccess(budgetGuardTracker, guardKey);
    }

    return result.allowed;
  } catch (error) {
    recordDeliveryFailure(budgetGuardTracker, guardKey, error);
    logger.warn(`User email budget check failed (denying email) for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('budget_guard_error', { userId });
    return false;
  }
}

// ============================================================================
// EMAIL MONTHLY BUDGET
// ============================================================================

export async function acquireUserEmailMonthlyBudget(
  userId: string,
  windowMs: number,
  maxCount: number,
  cache?: Map<string, number>
): Promise<boolean> {
  pruneEmailCaches();
  if (windowMs <= 0 || maxCount <= 0) {
    return false;
  }

  const now = Date.now();
  const windowStart = getThrottleWindowStart(now, windowMs);
  const windowEnd = windowStart + windowMs;

  const cachedBudget = emailMonthlyBudgetWindowCache.get(userId);
  if (cachedBudget && cachedBudget.windowStart === windowStart && cachedBudget.count >= maxCount) {
    cache?.set(userId, cachedBudget.count);
    sampledInfo(`Email monthly budget suppressed for ${userId}`, { count: cachedBudget.count, max: maxCount });
    return false;
  }

  if (cache) {
    const currentCount = cache.get(userId);
    if (currentCount !== undefined && currentCount >= maxCount) {
      return false;
    }
  }

  const guardKey = getGuardKey('email_monthly_budget', userId);
  const guardState = evaluateDeliveryState(emailMonthlyBudgetGuardTracker, guardKey);
  if (guardState === 'skipped' || guardState === 'dropped') {
    logger.warn(`Email monthly budget guard active for ${userId}, denying send until backoff expires`);
    emitAlertMetric('email_monthly_budget_guard_block', { userId });
    return false;
  }

  const ttlBufferMs = CONFIG.EMAIL_USER_MONTHLY_BUDGET_TTL_BUFFER_MS;

  // OPTIMIZATION: In deferred write mode, use memory-only tracking
  if (deferredWriteMode && cache) {
    let currentCount = cache.get(userId) ?? cachedBudget?.count ?? undefined;
    if (currentCount === undefined) {
      currentCount = await seedBudgetCountFromFirestore(CONFIG.EMAIL_USER_MONTHLY_BUDGET_COLLECTION, userId, windowStart);
      cache.set(userId, currentCount);
      emailMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count: currentCount });
    }
    if (currentCount >= maxCount) {
      cache.set(userId, currentCount);
      return false;
    }
    const newCount = currentCount + 1;
    cache.set(userId, newCount);
    emailMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count: newCount });
    addDeferredBudgetWrite(CONFIG.EMAIL_USER_MONTHLY_BUDGET_COLLECTION, userId, windowStart, windowEnd, newCount, ttlBufferMs);
    markDeliverySuccess(emailMonthlyBudgetGuardTracker, guardKey);
    return true;
  }

  try {
    const firestore = getFirestore();
    const docId = `${userId}__${windowStart}`;
    const docRef = firestore.collection(CONFIG.EMAIL_USER_MONTHLY_BUDGET_COLLECTION).doc(docId);
    const snap = await docRef.get();

    let count = 0;
    if (snap.exists) {
      count = Number((snap.data() as { count?: unknown }).count || 0);
    }

    if (count >= maxCount) {
      if (cache) {
        cache.set(userId, count);
      }
      emailMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count });
      markDeliverySuccess(emailMonthlyBudgetGuardTracker, guardKey);
      return false;
    }

    const nextCount = count + 1;
    await docRef.set(
      {
        userId,
        count: nextCount,
        windowStart,
        windowEnd,
        updatedAt: now,
        expireAt: Timestamp.fromMillis(windowEnd + ttlBufferMs),
      },
      { merge: true }
    );

    if (cache) {
      cache.set(userId, nextCount);
    }
    emailMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count: nextCount });
    markDeliverySuccess(emailMonthlyBudgetGuardTracker, guardKey);
    return true;
  } catch (error) {
    recordDeliveryFailure(emailMonthlyBudgetGuardTracker, guardKey, error);
    logger.warn(`User email monthly budget check failed (denying email) for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('email_monthly_budget_guard_error', { userId });
    return false;
  }
}

// ============================================================================
// SMS THROTTLE
// ============================================================================

export async function acquireSmsThrottleSlot(
  userId: string,
  checkId: string,
  eventType: WebhookEvent,
  cache?: Set<string>
): Promise<boolean> {
  pruneSmsCaches();
  const guardKey = getGuardKey('sms_throttle', `${userId}:${checkId}:${eventType}`);
  try {
    const guardState = evaluateDeliveryState(smsThrottleGuardTracker, guardKey);
    if (guardState === 'skipped' || guardState === 'dropped') {
      logger.warn(`SMS throttle guard active for ${userId}/${checkId}/${eventType}, denying send until backoff expires`);
      emitAlertMetric('sms_throttle_guard_block', { userId, checkId, eventType });
      return false;
    }

    const windowMs = CONFIG.SMS_THROTTLE_WINDOWS[eventType] || CONFIG.SMS_THROTTLE_WINDOW_MS;
    const now = Date.now();
    const windowStart = getThrottleWindowStart(now, windowMs);
    const windowEnd = windowStart + windowMs;

    const docId = `${userId}__${checkId}__${eventType}__${windowStart}`;
    const cachedWindow = smsThrottleWindowCache.get(docId);
    if (cachedWindow && cachedWindow.windowEnd > now) {
      cache?.add(docId);
      sampledInfo(`SMS suppressed by in-memory throttle cache for ${userId}/${checkId}/${eventType}`);
      return false;
    }

    if (cache && cache.has(docId)) {
      return false;
    }

    const firestore = getFirestore();
    const docRef = firestore.collection(CONFIG.SMS_THROTTLE_COLLECTION).doc(docId);
    await docRef.create({
      userId,
      checkId,
      eventType,
      windowStart,
      windowEnd: windowStart + windowMs,
      createdAt: now,
      expireAt: Timestamp.fromMillis(windowStart + windowMs + (10 * 60 * 1000)),
    });

    if (cache) {
      cache.add(docId);
    }
    smsThrottleWindowCache.set(docId, { windowStart, windowEnd });
    markDeliverySuccess(smsThrottleGuardTracker, guardKey);

    return true;
  } catch (error) {
    const err = error as unknown as { code?: number | string; status?: string; message?: string };
    const codeString = typeof err.code === 'number' ? String(err.code) : (err.code || err.status || '');
    const message = (err.message || '').toUpperCase();
    const alreadyExists = codeString === '6' || codeString === 'ALREADY_EXISTS' || message.includes('ALREADY_EXISTS') || message.includes('ALREADY EXISTS');

    if (alreadyExists) {
      const windowMs = CONFIG.SMS_THROTTLE_WINDOWS[eventType] || CONFIG.SMS_THROTTLE_WINDOW_MS;
      if (cache) {
        const now = Date.now();
        const windowStart = getThrottleWindowStart(now, windowMs);
        const docId = `${userId}__${checkId}__${eventType}__${windowStart}`;
        cache.add(docId);
      }
      const windowStart = getThrottleWindowStart(Date.now(), windowMs);
      smsThrottleWindowCache.set(`${userId}__${checkId}__${eventType}__${windowStart}`, {
        windowStart,
        windowEnd: windowStart + windowMs,
      });

      return false;
    }
    recordDeliveryFailure(smsThrottleGuardTracker, guardKey, error);
    logger.warn(`SMS throttle check failed (denying SMS) for ${userId}/${checkId}/${eventType}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('sms_throttle_guard_error', { userId, checkId, eventType });
    return false;
  }
}

// ============================================================================
// SMS BUDGET (short-window)
// ============================================================================

export async function acquireUserSmsBudget(
  userId: string,
  windowMs: number,
  maxCount: number,
  cache?: Map<string, number>
): Promise<boolean> {
  pruneSmsCaches();
  if (windowMs <= 0 || maxCount <= 0) {
    return false;
  }

  const now = Date.now();
  const windowStart = getThrottleWindowStart(now, windowMs);
  const windowEnd = windowStart + windowMs;

  const cachedBudget = smsBudgetWindowCache.get(userId);
  if (cachedBudget && cachedBudget.windowStart === windowStart && cachedBudget.count >= maxCount) {
    cache?.set(userId, cachedBudget.count);
    sampledInfo(`SMS suppressed by budget cache for ${userId}`, { count: cachedBudget.count, max: maxCount });
    return false;
  }

  if (cache) {
    const currentCount = cache.get(userId);
    if (currentCount !== undefined && currentCount >= maxCount) {
      return false;
    }
  }

  const guardKey = getGuardKey('sms_budget', userId);
  const guardState = evaluateDeliveryState(smsBudgetGuardTracker, guardKey);
  if (guardState === 'skipped' || guardState === 'dropped') {
    logger.warn(`SMS budget guard active for ${userId}, denying send until backoff expires`);
    emitAlertMetric('sms_budget_guard_block', { userId });
    return false;
  }

  const ttlBufferMs = CONFIG.SMS_USER_BUDGET_TTL_BUFFER_MS;

  // OPTIMIZATION: In deferred write mode, use memory-only tracking
  if (deferredWriteMode && cache) {
    let currentCount = cache.get(userId) ?? cachedBudget?.count ?? undefined;
    if (currentCount === undefined) {
      currentCount = await seedBudgetCountFromFirestore(CONFIG.SMS_USER_BUDGET_COLLECTION, userId, windowStart);
      cache.set(userId, currentCount);
      smsBudgetWindowCache.set(userId, { windowStart, windowEnd, count: currentCount });
    }
    if (currentCount >= maxCount) {
      cache.set(userId, currentCount);
      return false;
    }
    const newCount = currentCount + 1;
    cache.set(userId, newCount);
    smsBudgetWindowCache.set(userId, { windowStart, windowEnd, count: newCount });
    addDeferredBudgetWrite(CONFIG.SMS_USER_BUDGET_COLLECTION, userId, windowStart, windowEnd, newCount, ttlBufferMs);
    markDeliverySuccess(smsBudgetGuardTracker, guardKey);
    return true;
  }

  try {
    const firestore = getFirestore();
    const docId = `${userId}__${windowStart}`;
    const docRef = firestore.collection(CONFIG.SMS_USER_BUDGET_COLLECTION).doc(docId);
    const snap = await docRef.get();

    let count = 0;
    if (snap.exists) {
      count = Number((snap.data() as { count?: unknown }).count || 0);
    }

    if (count >= maxCount) {
      if (cache) {
        cache.set(userId, count);
      }
      smsBudgetWindowCache.set(userId, { windowStart, windowEnd, count });
      markDeliverySuccess(smsBudgetGuardTracker, guardKey);
      return false;
    }

    const nextCount = count + 1;
    await docRef.set(
      {
        userId,
        count: nextCount,
        windowStart,
        windowEnd,
        updatedAt: now,
        expireAt: Timestamp.fromMillis(windowEnd + ttlBufferMs),
      },
      { merge: true }
    );

    if (cache) {
      cache.set(userId, nextCount);
    }
    smsBudgetWindowCache.set(userId, { windowStart, windowEnd, count: nextCount });
    markDeliverySuccess(smsBudgetGuardTracker, guardKey);
    return true;
  } catch (error) {
    recordDeliveryFailure(smsBudgetGuardTracker, guardKey, error);
    logger.warn(`User SMS budget check failed (denying SMS) for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('sms_budget_guard_error', { userId });
    return false;
  }
}

// ============================================================================
// SMS MONTHLY BUDGET
// ============================================================================

export async function acquireUserSmsMonthlyBudget(
  userId: string,
  windowMs: number,
  maxCount: number,
  cache?: Map<string, number>
): Promise<boolean> {
  pruneSmsCaches();
  if (windowMs <= 0 || maxCount <= 0) {
    return false;
  }

  const now = Date.now();
  const windowStart = getThrottleWindowStart(now, windowMs);
  const windowEnd = windowStart + windowMs;

  const cachedBudget = smsMonthlyBudgetWindowCache.get(userId);
  if (cachedBudget && cachedBudget.windowStart === windowStart && cachedBudget.count >= maxCount) {
    cache?.set(userId, cachedBudget.count);
    sampledInfo(`SMS monthly budget suppressed for ${userId}`, { count: cachedBudget.count, max: maxCount });
    return false;
  }

  if (cache) {
    const currentCount = cache.get(userId);
    if (currentCount !== undefined && currentCount >= maxCount) {
      return false;
    }
  }

  const guardKey = getGuardKey('sms_monthly_budget', userId);
  const guardState = evaluateDeliveryState(smsMonthlyBudgetGuardTracker, guardKey);
  if (guardState === 'skipped' || guardState === 'dropped') {
    logger.warn(`SMS monthly budget guard active for ${userId}, denying send until backoff expires`);
    emitAlertMetric('sms_monthly_budget_guard_block', { userId });
    return false;
  }

  const ttlBufferMs = CONFIG.SMS_USER_MONTHLY_BUDGET_TTL_BUFFER_MS;

  // OPTIMIZATION: In deferred write mode, use memory-only tracking
  if (deferredWriteMode && cache) {
    let currentCount = cache.get(userId) ?? cachedBudget?.count ?? undefined;
    if (currentCount === undefined) {
      currentCount = await seedBudgetCountFromFirestore(CONFIG.SMS_USER_MONTHLY_BUDGET_COLLECTION, userId, windowStart);
      cache.set(userId, currentCount);
      smsMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count: currentCount });
    }
    if (currentCount >= maxCount) {
      cache.set(userId, currentCount);
      return false;
    }
    const newCount = currentCount + 1;
    cache.set(userId, newCount);
    smsMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count: newCount });
    addDeferredBudgetWrite(CONFIG.SMS_USER_MONTHLY_BUDGET_COLLECTION, userId, windowStart, windowEnd, newCount, ttlBufferMs);
    markDeliverySuccess(smsMonthlyBudgetGuardTracker, guardKey);
    return true;
  }

  try {
    const firestore = getFirestore();
    const docId = `${userId}__${windowStart}`;
    const docRef = firestore.collection(CONFIG.SMS_USER_MONTHLY_BUDGET_COLLECTION).doc(docId);
    const snap = await docRef.get();

    let count = 0;
    if (snap.exists) {
      count = Number((snap.data() as { count?: unknown }).count || 0);
    }

    if (count >= maxCount) {
      if (cache) {
        cache.set(userId, count);
      }
      smsMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count });
      markDeliverySuccess(smsMonthlyBudgetGuardTracker, guardKey);
      return false;
    }

    const nextCount = count + 1;
    await docRef.set(
      {
        userId,
        count: nextCount,
        windowStart,
        windowEnd,
        updatedAt: now,
        expireAt: Timestamp.fromMillis(windowEnd + ttlBufferMs),
      },
      { merge: true }
    );

    if (cache) {
      cache.set(userId, nextCount);
    }
    smsMonthlyBudgetWindowCache.set(userId, { windowStart, windowEnd, count: nextCount });
    markDeliverySuccess(smsMonthlyBudgetGuardTracker, guardKey);
    return true;
  } catch (error) {
    recordDeliveryFailure(smsMonthlyBudgetGuardTracker, guardKey, error);
    logger.warn(`User SMS monthly budget check failed (denying SMS) for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('sms_monthly_budget_guard_error', { userId });
    return false;
  }
}
