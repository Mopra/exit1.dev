import { getFirestore, Timestamp, QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookPayload, WebhookEvent, EmailSettings, SmsSettings } from './types';
import { Resend } from 'resend';
import { CONFIG } from './config';
import { getResendCredentials, getTwilioCredentials } from './env';
import { normalizeEventList } from './webhook-events';
import { firestore } from './init';
import { statusUpdateBuffer } from './status-buffer';

// Interface for cached settings to reduce Firestore reads
export interface AlertSettingsCache {
  email?: EmailSettings | null;
  sms?: SmsSettings | null;
  webhooks?: WebhookSettings[];
}

// Context for the alert run to share cache, throttle, and budget state
export interface AlertContext {
  settings?: AlertSettingsCache;
  throttleCache?: Set<string>;
  budgetCache?: Map<string, number>;
  emailMonthlyBudgetCache?: Map<string, number>;
  smsThrottleCache?: Set<string>;
  smsBudgetCache?: Map<string, number>;
  smsMonthlyBudgetCache?: Map<string, number>;
}

const getResendClient = () => {
  const { apiKey, fromAddress } = getResendCredentials();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  return {
    resend: new Resend(apiKey),
    fromAddress,
  };
};

const MAX_PARALLEL_NOTIFICATIONS = 20;
const WEBHOOK_BATCH_DELAY_MS = 100;
const ALERT_BACKOFF_INITIAL_MS = 5_000;
const ALERT_BACKOFF_MAX_MS = 5 * 60 * 1000;
const ALERT_BACKOFF_MAX_RATE_LIMIT_MS = 30 * 60 * 1000; // 30 min for 429 errors
const ALERT_BACKOFF_JITTER_RATIO = 0.2; // +/- 20% jitter
const ALERT_FAILURE_TIMEOUT_MS = 30 * 60 * 1000;
const ALERT_MAX_FAILURES_BEFORE_DROP = 10;
const WEBHOOK_RETRY_BATCH_SIZE = CONFIG.WEBHOOK_RETRY_BATCH_SIZE || 25;
const WEBHOOK_RETRY_MAX_ATTEMPTS = CONFIG.WEBHOOK_RETRY_MAX_ATTEMPTS || 8;
const WEBHOOK_RETRY_TTL_MS = CONFIG.WEBHOOK_RETRY_TTL_MS || (48 * 60 * 60 * 1000);
const WEBHOOK_RETRY_DRAIN_INTERVAL_MS = CONFIG.WEBHOOK_RETRY_DRAIN_INTERVAL_MS || (30 * 1000);
const LOG_SAMPLE_RATE = 0.05;
const CACHE_PRUNE_INTERVAL_MS = 60_000;
const throttleWindowCache = new Map<string, { windowStart: number; windowEnd: number }>();
const budgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();
const emailMonthlyBudgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();
const smsThrottleWindowCache = new Map<string, { windowStart: number; windowEnd: number }>();
const smsBudgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();
const smsMonthlyBudgetWindowCache = new Map<string, { windowStart: number; windowEnd: number; count: number }>();
let lastCachePrune = 0;
let lastSmsCachePrune = 0;

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
      logger.info(`Flushed ${batchWrites.length} deferred budget writes`);
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
const ADMIN_STATUS_CACHE_TTL_MS = 60 * 60 * 1000;
const adminStatusCache = new Map<string, { value: boolean; expiresAt: number }>();
const ALERT_SETTINGS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes - extended from 5 min to reduce Firestore reads
const ALERT_SETTINGS_CACHE_MAX = 5000;
const alertSettingsCache = new Map<string, { value: AlertSettingsCache; expiresAt: number }>();

const getCachedAdminStatus = async (userId: string): Promise<boolean> => {
  const now = Date.now();
  const cached = adminStatusCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const snap = await firestore.collection('users').doc(userId).get();
    const data = snap.exists ? (snap.data() as { admin?: boolean }) : undefined;
    const isAdmin = data?.admin === true;
    adminStatusCache.set(userId, { value: isAdmin, expiresAt: now + ADMIN_STATUS_CACHE_TTL_MS });
    return isAdmin;
  } catch (error) {
    logger.warn(`Failed to read admin status for ${userId}`, error);
    return false;
  }
};

const resolveSmsTier = async (website: Website): Promise<'nano' | 'free'> => {
  const isPaidTier = website.userTier === 'nano' || (website.userTier as unknown) === 'premium';
  if (isPaidTier) {
    return 'nano';
  }
  const isAdmin = await getCachedAdminStatus(website.userId);
  return isAdmin ? 'nano' : 'free';
};

interface DeliveryFailureMeta {
  failures: number;
  nextRetryAt: number;
  firstFailureAt: number;
  lastErrorCode?: number | string;
  lastErrorMessage?: string;
}

type DeliveryState = 'ready' | 'skipped' | 'dropped';

type WebhookRetryChannel = 'status' | 'ssl';

interface WebhookAttemptContext {
  website: Website;
  eventType: WebhookEvent;
  channel: WebhookRetryChannel;
  previousStatus?: string;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  deliveryId: string;
}

type SerializedWebsite = Pick<Website, 'id' | 'userId' | 'name' | 'url' | 'status' | 'responseTime' | 'detailedStatus'>;

interface WebhookRetryRecord {
  deliveryId: string;
  userId: string;
  eventType: WebhookEvent;
  channel: WebhookRetryChannel;
  attempt: number;
  nextAttemptAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expireAt: Timestamp;
  website: SerializedWebsite;
  previousStatus?: string | null;
  sslCertificate?: WebhookAttemptContext['sslCertificate'] | null;
  webhook: WebhookSettings;
  lastError?: string;
  isRateLimited?: boolean;
}

const webhookFailureTracker = new Map<string, DeliveryFailureMeta>();
const emailFailureTracker = new Map<string, DeliveryFailureMeta>();
const smsFailureTracker = new Map<string, DeliveryFailureMeta>();

const throttleGuardTracker = new Map<string, DeliveryFailureMeta>();
const budgetGuardTracker = new Map<string, DeliveryFailureMeta>();
const emailMonthlyBudgetGuardTracker = new Map<string, DeliveryFailureMeta>();
const smsThrottleGuardTracker = new Map<string, DeliveryFailureMeta>();
const smsBudgetGuardTracker = new Map<string, DeliveryFailureMeta>();
const smsMonthlyBudgetGuardTracker = new Map<string, DeliveryFailureMeta>();
let isDrainingWebhookRetries = false;
let lastWebhookRetryDrain = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const emitAlertMetric = (name: string, data: Record<string, unknown>) => {
  logger.log('alert_metric', { name, ...data });
};

const sampledInfo = (message: string, meta?: Record<string, unknown>) => {
  if (Math.random() < LOG_SAMPLE_RATE) {
    if (meta) {
      logger.info(message, meta);
    } else {
      logger.info(message);
    }
  } else {
    if (meta) {
      logger.debug(message, meta);
    } else {
      logger.debug(message);
    }
  }
};

const pruneEmailCaches = (now: number = Date.now()) => {
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

const pruneSmsCaches = (now: number = Date.now()) => {
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

const applyJitter = (delay: number): number => {
  const jitter = delay * ALERT_BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(ALERT_BACKOFF_INITIAL_MS, Math.round(delay + jitter));
};

const calculateDeliveryBackoff = (failures: number, isRateLimited = false): number => {
  if (failures <= 0) return applyJitter(ALERT_BACKOFF_INITIAL_MS);
  const maxBackoff = isRateLimited ? ALERT_BACKOFF_MAX_RATE_LIMIT_MS : ALERT_BACKOFF_MAX_MS;
  const delay = ALERT_BACKOFF_INITIAL_MS * Math.pow(2, failures - 1);
  return applyJitter(Math.min(delay, maxBackoff));
};

const evaluateDeliveryState = (
  tracker: Map<string, DeliveryFailureMeta>,
  key: string
): DeliveryState => {
  const meta = tracker.get(key);
  if (!meta) {
    return 'ready';
  }

  const now = Date.now();
  const exceededFailures = meta.failures >= ALERT_MAX_FAILURES_BEFORE_DROP;
  const exceededTimeout = now - meta.firstFailureAt >= ALERT_FAILURE_TIMEOUT_MS;

  if (exceededFailures || exceededTimeout) {
    tracker.delete(key);
    logger.error(
      `Dropping alert delivery target ${key} after ${meta.failures} failures (${meta.lastErrorMessage || 'unknown error'})`
    );
    emitAlertMetric('delivery_dropped', { key, failures: meta.failures });
    return 'dropped';
  }

  if (now < meta.nextRetryAt) {
    return 'skipped';
  }

  return 'ready';
};

const markDeliverySuccess = (
  tracker: Map<string, DeliveryFailureMeta>,
  key: string
) => {
  if (tracker.has(key)) {
    tracker.delete(key);
  }
};

const recordDeliveryFailure = (
  tracker: Map<string, DeliveryFailureMeta>,
  key: string,
  error: unknown
) => {
  const now = Date.now();
  const previous = tracker.get(key);
  const failures = (previous?.failures ?? 0) + 1;
  const meta: DeliveryFailureMeta = {
    failures,
    nextRetryAt: now + calculateDeliveryBackoff(failures),
    firstFailureAt: previous?.firstFailureAt ?? now,
    lastErrorCode: (error as { code?: number | string })?.code,
    lastErrorMessage: (error as Error)?.message || String(error),
  };
  tracker.set(key, meta);

  if (failures === 1 || failures === 3 || failures === 5 || failures >= ALERT_MAX_FAILURES_BEFORE_DROP) {
    logger.warn(
      `Alert delivery target ${key} failed ${failures} time(s); next retry in ${meta.nextRetryAt - now}ms`,
      { code: meta.lastErrorCode }
    );
  }

  emitAlertMetric('delivery_failure', { key, failures, code: meta.lastErrorCode });
};

const getWebhookTrackerKey = (webhook: WebhookSettings) =>
  `webhook:${webhook.userId}:${webhook.id || webhook.url}`;

const getEmailTrackerKey = (userId: string, checkId: string, eventType: WebhookEvent) =>
  `email:${userId}:${checkId}:${eventType}`;

const getSmsTrackerKey = (userId: string, checkId: string, eventType: WebhookEvent) =>
  `sms:${userId}:${checkId}:${eventType}`;

const getGuardKey = (prefix: string, identifier: string) => `${prefix}:${identifier}`;

const getRetryErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'unknown error');

// Extract HTTP status code from error message (e.g., "HTTP 429: Too Many Requests")
const extractHttpStatus = (error: unknown): number | null => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(/HTTP (\d{3}):/);
  return match ? parseInt(match[1], 10) : null;
};

// HTTP 4xx errors that should NOT be retried (permanent client errors)
const isNonRetryableError = (error: unknown): boolean => {
  const status = extractHttpStatus(error);
  if (!status) return false;
  // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 405 Method Not Allowed, 410 Gone
  // Don't include 429 (rate limit) - that's retryable with longer backoff
  return [400, 401, 403, 404, 405, 410].includes(status);
};

// HTTP 429 Too Many Requests - retryable but needs longer backoff
const isRateLimitError = (error: unknown): boolean => {
  const status = extractHttpStatus(error);
  return status === 429;
};

const serializeWebsiteForRetry = (website: Website): SerializedWebsite => ({
  id: website.id,
  userId: website.userId,
  name: website.name,
  url: website.url,
  status: website.status,
  responseTime: website.responseTime,
  detailedStatus: website.detailedStatus,
});

const hydrateWebsiteFromRetry = (website: SerializedWebsite): Website => ({
  id: website.id,
  userId: website.userId,
  name: website.name,
  url: website.url,
  status: website.status,
  responseTime: website.responseTime,
  detailedStatus: website.detailedStatus,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
});

const createWebhookDeliveryId = (webhook: WebhookSettings, website: Website, eventType: WebhookEvent): string => {
  return `${webhook.userId}:${website.id}:${eventType}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

const getWebhookRetryCollection = () => getFirestore().collection(CONFIG.WEBHOOK_RETRY_COLLECTION);

const createWebhookRetryRecord = (
  webhook: WebhookSettings,
  context: WebhookAttemptContext,
  error: unknown
): WebhookRetryRecord => {
  const now = Date.now();
  const attempt = 1;
  const rateLimited = isRateLimitError(error);
  const nextAttemptAt = now + calculateDeliveryBackoff(attempt, rateLimited);

  return {
    deliveryId: context.deliveryId,
    userId: webhook.userId,
    eventType: context.eventType,
    channel: context.channel,
    attempt,
    website: serializeWebsiteForRetry(context.website),
    previousStatus: context.previousStatus ?? context.website.status ?? null,
    sslCertificate: context.channel === 'ssl' ? context.sslCertificate ?? null : null,
    webhook,
    lastError: getRetryErrorMessage(error),
    isRateLimited: rateLimited,
    createdAt: Timestamp.fromMillis(now),
    updatedAt: Timestamp.fromMillis(now),
    nextAttemptAt: Timestamp.fromMillis(nextAttemptAt),
    expireAt: Timestamp.fromMillis(now + WEBHOOK_RETRY_TTL_MS),
  };
};

const isAlreadyExistsError = (error: unknown): boolean => {
  const err = error as { code?: number | string; status?: string; message?: string };
  const codeString = typeof err.code === 'number' ? String(err.code) : err.code;
  const message = (err.message || err.status || '').toUpperCase();
  return codeString === '6' || codeString === 'ALREADY_EXISTS' || message.includes('ALREADY EXISTS');
};

const queueWebhookRetry = async (
  webhook: WebhookSettings,
  context: WebhookAttemptContext,
  error: unknown
): Promise<void> => {
  // Don't retry permanent client errors (400, 401, 403, 404, 405, 410)
  if (isNonRetryableError(error)) {
    const status = extractHttpStatus(error);
    logger.warn(
      `Not queuing webhook retry for ${context.deliveryId}: HTTP ${status} is a non-retryable error`
    );
    emitAlertMetric('webhook_not_retryable', {
      deliveryId: context.deliveryId,
      eventType: context.eventType,
      channel: context.channel,
      httpStatus: status,
    });
    return;
  }

  try {
    const firestore = getFirestore();
    const docRef = firestore.collection(CONFIG.WEBHOOK_RETRY_COLLECTION).doc(context.deliveryId);
    const record = createWebhookRetryRecord(webhook, context, error);
    await docRef.create(record);
    emitAlertMetric('webhook_queued', {
      deliveryId: context.deliveryId,
      eventType: context.eventType,
      channel: context.channel,
      isRateLimited: isRateLimitError(error),
    });
  } catch (queueError) {
    if (isAlreadyExistsError(queueError)) {
      try {
        const now = Date.now();
        const docRef = getWebhookRetryCollection().doc(context.deliveryId);
        await docRef.set(
          {
            lastError: getRetryErrorMessage(error),
            nextAttemptAt: Timestamp.fromMillis(now + calculateDeliveryBackoff(1)),
            updatedAt: Timestamp.fromMillis(now),
            expireAt: Timestamp.fromMillis(now + WEBHOOK_RETRY_TTL_MS),
          },
          { merge: true }
        );
      } catch (updateErr) {
        logger.error(`Failed to update existing webhook retry ${context.deliveryId}`, updateErr);
      }
      return;
    }
    logger.error(`Failed to queue webhook retry ${context.deliveryId}`, queueError);
  }
};

const deliverRetryWebhook = async (record: WebhookRetryRecord): Promise<void> => {
  const website = hydrateWebsiteFromRetry(record.website);
  if (record.channel === 'ssl') {
    if (!record.sslCertificate) {
      throw new Error(`Missing SSL certificate data for retry ${record.deliveryId}`);
    }
    await sendSSLWebhook(record.webhook, website, record.eventType, record.sslCertificate);
  } else {
    await sendWebhook(record.webhook, website, record.eventType, record.previousStatus || 'unknown');
  }
};

const processWebhookRetryDoc = async (
  doc: QueryDocumentSnapshot<WebhookRetryRecord>
): Promise<void> => {
  const data = doc.data();
  try {
    await deliverRetryWebhook(data);
    await doc.ref.delete();
    emitAlertMetric('webhook_retry_delivered', {
      deliveryId: data.deliveryId,
      eventType: data.eventType,
      channel: data.channel,
    });
  } catch (error) {
    // Check if this is a non-retryable error (4xx client errors)
    if (isNonRetryableError(error)) {
      const status = extractHttpStatus(error);
      await doc.ref.delete();
      emitAlertMetric('webhook_retry_non_retryable', {
        deliveryId: data.deliveryId,
        eventType: data.eventType,
        channel: data.channel,
        httpStatus: status,
      });
      logger.warn(
        `Dropping webhook retry ${data.deliveryId}: HTTP ${status} is a non-retryable error`
      );
      return;
    }

    const nextAttempt = (data.attempt || 1) + 1;
    if (nextAttempt >= WEBHOOK_RETRY_MAX_ATTEMPTS) {
      await doc.ref.delete();
      emitAlertMetric('webhook_retry_dropped', {
        deliveryId: data.deliveryId,
        eventType: data.eventType,
        channel: data.channel,
      });
      logger.error(
        `Dropping webhook retry ${data.deliveryId} after ${nextAttempt} attempts: ${getRetryErrorMessage(error)}`
      );
      return;
    }

    // Update rate limit status based on current error
    const rateLimited = isRateLimitError(error) || data.isRateLimited;
    const now = Date.now();
    await doc.ref.update({
      attempt: nextAttempt,
      lastError: getRetryErrorMessage(error),
      isRateLimited: rateLimited,
      nextAttemptAt: Timestamp.fromMillis(now + calculateDeliveryBackoff(nextAttempt, rateLimited)),
      updatedAt: Timestamp.fromMillis(now),
    });
  }
};

const drainWebhookRetryQueue = async (): Promise<void> => {
  const now = Date.now();
  if (isDrainingWebhookRetries || now - lastWebhookRetryDrain < WEBHOOK_RETRY_DRAIN_INTERVAL_MS) {
    return;
  }
  isDrainingWebhookRetries = true;
  lastWebhookRetryDrain = now;

  try {
    const firestore = getFirestore();
    const snapshot = await firestore
      .collection(CONFIG.WEBHOOK_RETRY_COLLECTION)
      .where('nextAttemptAt', '<=', Timestamp.fromMillis(now))
      .orderBy('nextAttemptAt')
      .limit(WEBHOOK_RETRY_BATCH_SIZE)
      .get();

    if (snapshot.empty) {
      return;
    }

    await Promise.all(
      snapshot.docs.map(doc => processWebhookRetryDoc(doc as QueryDocumentSnapshot<WebhookRetryRecord>))
    );
  } catch (error) {
    logger.error('Error draining webhook retry queue', error);
  } finally {
    isDrainingWebhookRetries = false;
  }
};
// QA: drain once per run (not per alert) and verify queued retries still deliver.
// Expose draining so callers can run it once per execution instead of per alert.
export const drainQueuedWebhookRetries = async (): Promise<void> => drainWebhookRetryQueue();
const fetchAlertSettingsFromFirestore = async (userId: string): Promise<AlertSettingsCache> => {
  const firestore = getFirestore();
  const [emailDoc, smsDoc, webhooksSnapshot] = await Promise.all([
    firestore.collection('emailSettings').doc(userId).get(),
    firestore.collection('smsSettings').doc(userId).get(),
    firestore.collection('webhooks').where('userId', '==', userId).where('enabled', '==', true).get(),
  ]);

  return {
    email: emailDoc.exists ? (emailDoc.data() as EmailSettings) : null,
    sms: smsDoc.exists ? (smsDoc.data() as SmsSettings) : null,
    webhooks: webhooksSnapshot.docs.map(doc => doc.data() as WebhookSettings),
  };
};

const getCachedAlertSettings = (userId: string): AlertSettingsCache | null => {
  const cached = alertSettingsCache.get(userId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    alertSettingsCache.delete(userId);
    return null;
  }
  return cached.value;
};

const setCachedAlertSettings = (userId: string, settings: AlertSettingsCache): void => {
  alertSettingsCache.set(userId, {
    value: settings,
    expiresAt: Date.now() + ALERT_SETTINGS_CACHE_TTL_MS,
  });

  if (alertSettingsCache.size > ALERT_SETTINGS_CACHE_MAX) {
    alertSettingsCache.clear();
  }
};

const resolveAlertSettings = async (userId: string, context?: AlertContext): Promise<AlertSettingsCache> => {
  if (context?.settings) {
    return context.settings;
  }

  const cached = getCachedAlertSettings(userId);
  if (cached) {
    if (context) {
      context.settings = cached;
    }
    return cached;
  }

  const settings = await fetchAlertSettingsFromFirestore(userId);
  if (context) {
    context.settings = settings;
  }
  setCachedAlertSettings(userId, settings);
  return settings;
};

const filterWebhooksForEvent = (
  webhooks: WebhookSettings[] | undefined,
  eventType: WebhookEvent,
  checkId: string
) => {
  if (!webhooks?.length) {
    return [];
  }
  return webhooks.filter(webhook => {
    const allowedEvents = new Set(normalizeEventList(webhook.events));
    return allowedEvents.has(eventType) && webhookAppliesToCheck(webhook, checkId);
  });
};

const webhookAppliesToCheck = (webhook: WebhookSettings, checkId: string) => {
  const filter = webhook.checkFilter;
  if (!filter || filter.mode !== 'include') {
    return true;
  }
  if (!Array.isArray(filter.checkIds) || filter.checkIds.length === 0) {
    return false;
  }
  return filter.checkIds.includes(checkId);
};

type WebhookSendFn = (webhook: WebhookSettings) => Promise<void>;
type WebhookDispatchContext = Omit<WebhookAttemptContext, 'deliveryId'>;

const dispatchWebhooks = async (
  webhooks: WebhookSettings[],
  sendFn: WebhookSendFn,
  context: WebhookDispatchContext
): Promise<{ sent: number; queued: number; skipped: number }> => {
  const stats = { sent: 0, queued: 0, skipped: 0 };
  if (!webhooks.length) {
    return stats;
  }

  for (let i = 0; i < webhooks.length; i += MAX_PARALLEL_NOTIFICATIONS) {
    const batch = webhooks.slice(i, i + MAX_PARALLEL_NOTIFICATIONS);
    await Promise.all(
      batch.map(async webhook => {
        const outcome = await sendWebhookWithGuards(
          webhook,
          sendFn,
          { ...context, deliveryId: createWebhookDeliveryId(webhook, context.website, context.eventType) }
        );
        if (outcome === 'sent') {
          stats.sent += 1;
        } else if (outcome === 'queued') {
          stats.queued += 1;
        } else {
          stats.skipped += 1;
        }
      })
    );

    if (i + MAX_PARALLEL_NOTIFICATIONS < webhooks.length) {
      await sleep(WEBHOOK_BATCH_DELAY_MS);
    }
  }

  return stats;
};

const sendWebhookWithGuards = async (
  webhook: WebhookSettings,
  sendFn: WebhookSendFn,
  context: WebhookAttemptContext
): Promise<'sent' | 'skipped' | 'queued'> => {
  const trackerKey = getWebhookTrackerKey(webhook);
  const state = evaluateDeliveryState(webhookFailureTracker, trackerKey);

  if (state === 'skipped') {
    const meta = webhookFailureTracker.get(trackerKey);
    logger.warn(
      `Webhook delivery deferred for ${webhook.url} (${context.eventType}) due to backoff. Failures: ${meta?.failures || 0}, next retry: ${meta?.nextRetryAt ? new Date(meta.nextRetryAt).toISOString() : 'N/A'}`
    );
    emitAlertMetric('webhook_deferred', {
      key: trackerKey,
      eventType: context.eventType,
    });
    return 'skipped';
  }

  if (state === 'dropped') {
    const meta = webhookFailureTracker.get(trackerKey);
    logger.error(
      `Webhook delivery dropped for ${webhook.url} (${context.eventType}). Failures: ${meta?.failures || 0}, error: ${meta?.lastErrorMessage || 'unknown'}`
    );
    emitAlertMetric('webhook_dropped', {
      key: trackerKey,
      eventType: context.eventType,
    });
    return 'skipped';
  }

  try {
    await sendFn(webhook);
    markDeliverySuccess(webhookFailureTracker, trackerKey);
    emitAlertMetric('webhook_sent', { key: trackerKey, eventType: context.eventType });
    return 'sent';
  } catch (error) {
    recordDeliveryFailure(webhookFailureTracker, trackerKey, error);
    logger.error(
      `Failed to send webhook to ${webhook.url} for ${context.website.name}`,
      error
    );
    emitAlertMetric('webhook_failed', {
      key: trackerKey,
      eventType: context.eventType,
    });
    await queueWebhookRetry(webhook, context, error);
    return 'queued';
  }
};

type EmailSendFn = () => Promise<void>;

const sendEmailWithGuards = async (
  trackerKey: string,
  eventType: WebhookEvent,
  sendFn: EmailSendFn
): Promise<'sent' | 'skipped' | 'failed'> => {
  const state = evaluateDeliveryState(emailFailureTracker, trackerKey);

  if (state === 'skipped') {
    logger.info(
      `Email delivery deferred for ${trackerKey} (${eventType}) due to backoff`
    );
    emitAlertMetric('email_deferred', { key: trackerKey, eventType });
    return 'skipped';
  }

  if (state === 'dropped') {
    emitAlertMetric('email_dropped', { key: trackerKey, eventType });
    return 'failed';
  }

  try {
    await sendFn();
    markDeliverySuccess(emailFailureTracker, trackerKey);
    emitAlertMetric('email_sent', { key: trackerKey, eventType });
    return 'sent';
  } catch (error) {
    recordDeliveryFailure(emailFailureTracker, trackerKey, error);
    logger.error(`Failed to send email for ${trackerKey} (${eventType})`, error);
    emitAlertMetric('email_failed', { key: trackerKey, eventType });
    return 'failed';
  }
};

type SmsSendFn = () => Promise<void>;

const sendSmsWithGuards = async (
  trackerKey: string,
  eventType: WebhookEvent,
  sendFn: SmsSendFn
): Promise<'sent' | 'skipped' | 'failed'> => {
  const state = evaluateDeliveryState(smsFailureTracker, trackerKey);

  if (state === 'skipped') {
    logger.info(
      `SMS delivery deferred for ${trackerKey} (${eventType}) due to backoff`
    );
    emitAlertMetric('sms_deferred', { key: trackerKey, eventType });
    return 'skipped';
  }

  if (state === 'dropped') {
    emitAlertMetric('sms_dropped', { key: trackerKey, eventType });
    return 'failed';
  }

  try {
    await sendFn();
    markDeliverySuccess(smsFailureTracker, trackerKey);
    emitAlertMetric('sms_sent', { key: trackerKey, eventType });
    return 'sent';
  } catch (error) {
    recordDeliveryFailure(smsFailureTracker, trackerKey, error);
    logger.error(`Failed to send SMS for ${trackerKey} (${eventType})`, error);
    emitAlertMetric('sms_failed', { key: trackerKey, eventType });
    return 'failed';
  }
};

const deliverEmailAlert = async ({
  website,
  eventType,
  context,
  send,
}: {
  website: Website;
  eventType: WebhookEvent;
  context?: AlertContext;
  send: EmailSendFn;
}): Promise<'sent' | 'throttled' | 'error'> => {
  const throttleAllowed = await acquireEmailThrottleSlot(
    website.userId,
    website.id,
    eventType,
    context?.throttleCache
  );
  if (!throttleAllowed) {
    emitAlertMetric('email_throttled', { userId: website.userId, eventType });
    return 'throttled';
  }

  // Backward-compat: treat legacy "premium" tier as nano (only paid tier now).
  const emailTier = website.userTier === 'nano' || (website.userTier as unknown) === 'premium' ? 'nano' : 'free';

  const budgetAllowed = await acquireUserEmailBudget(
    website.userId,
    CONFIG.EMAIL_USER_BUDGET_WINDOW_MS,
    CONFIG.getEmailBudgetMaxPerWindowForTier(emailTier),
    context?.budgetCache
  );
  if (!budgetAllowed) {
    emitAlertMetric('email_budget_blocked', { userId: website.userId, eventType });
    return 'throttled';
  }

  const monthlyAllowed = await acquireUserEmailMonthlyBudget(
    website.userId,
    CONFIG.EMAIL_USER_MONTHLY_BUDGET_WINDOW_MS,
    CONFIG.getEmailMonthlyBudgetMaxPerWindowForTier(emailTier),
    context?.emailMonthlyBudgetCache
  );
  if (!monthlyAllowed) {
    emitAlertMetric('email_monthly_budget_blocked', { userId: website.userId, eventType });
    return 'throttled';
  }

  const trackerKey = getEmailTrackerKey(website.userId, website.id, eventType);
  const deliveryState = await sendEmailWithGuards(trackerKey, eventType, send);

  if (deliveryState === 'sent') {
    return 'sent';
  }

  return 'error';
};

const deliverSmsAlert = async ({
  website,
  eventType,
  context,
  send,
  smsTier,
}: {
  website: Website;
  eventType: WebhookEvent;
  context?: AlertContext;
  send: SmsSendFn;
  smsTier: 'nano' | 'free';
}): Promise<'sent' | 'throttled' | 'error'> => {
  const throttleAllowed = await acquireSmsThrottleSlot(
    website.userId,
    website.id,
    eventType,
    context?.smsThrottleCache
  );
  if (!throttleAllowed) {
    emitAlertMetric('sms_throttled', { userId: website.userId, eventType });
    return 'throttled';
  }

  const budgetAllowed = await acquireUserSmsBudget(
    website.userId,
    CONFIG.SMS_USER_BUDGET_WINDOW_MS,
    CONFIG.getSmsBudgetMaxPerWindowForTier(smsTier),
    context?.smsBudgetCache
  );
  if (!budgetAllowed) {
    emitAlertMetric('sms_budget_blocked', { userId: website.userId, eventType });
    return 'throttled';
  }

  const monthlyAllowed = await acquireUserSmsMonthlyBudget(
    website.userId,
    CONFIG.SMS_USER_MONTHLY_BUDGET_WINDOW_MS,
    CONFIG.SMS_USER_MONTHLY_BUDGET_MAX_PER_WINDOW,
    context?.smsMonthlyBudgetCache
  );
  if (!monthlyAllowed) {
    emitAlertMetric('sms_monthly_budget_blocked', { userId: website.userId, eventType });
    return 'throttled';
  }

  const trackerKey = getSmsTrackerKey(website.userId, website.id, eventType);
  const deliveryState = await sendSmsWithGuards(trackerKey, eventType, send);

  if (deliveryState === 'sent') {
    return 'sent';
  }

  return 'error';
};

export async function triggerAlert(
  website: Website,
  oldStatus: string,
  newStatus: string,
  counters?: { consecutiveFailures?: number; consecutiveSuccesses?: number },
  context?: AlertContext
): Promise<{ delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' }> {
  try {
    // OPTIMIZATION: Use buffered data instead of Firestore reads
    // The buffer contains the most recent status update data, eliminating need for verification reads
    const bufferedUpdate = statusUpdateBuffer.get(website.id);
    if (bufferedUpdate) {
      // Enrich website with buffered data - no Firestore read needed
      if (bufferedUpdate.detailedStatus) {
        website.detailedStatus = bufferedUpdate.detailedStatus as 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | undefined;
      }
      if (bufferedUpdate.lastError !== undefined) {
        website.lastError = bufferedUpdate.lastError;
      }
      const bufferedStatusCode = bufferedUpdate.lastStatusCode ?? bufferedUpdate.statusCode;
      if (bufferedStatusCode !== undefined) {
        website.lastStatusCode = bufferedStatusCode;
      }
    }
    // NOTE: Removed Firestore reads for status verification and error info.
    // The website object passed from checks.ts already contains the latest check result data.
    // Buffer enrichment above handles any additional fields that may have been updated.
    
    // Log the alert
    logger.info(`ALERT: Website ${website.name} (${website.url}) changed from ${oldStatus} to ${newStatus}`);
    logger.info(`ALERT: User ID: ${website.userId}`);
    
    // Determine webhook event type using the verified status
    const isOnline = newStatus === 'online' || newStatus === 'UP' || newStatus === 'REDIRECT';
    const isOffline = newStatus === 'offline' || newStatus === 'DOWN' || newStatus === 'REACHABLE_WITH_ERROR';
    const wasOffline = oldStatus === 'offline' || oldStatus === 'DOWN' || oldStatus === 'REACHABLE_WITH_ERROR';
    const wasOnline = oldStatus === 'online' || oldStatus === 'UP' || oldStatus === 'REDIRECT';
    
    let eventType: WebhookEvent;
    if (isOffline) {
      eventType = 'website_down';
    } else if (isOnline && wasOffline) {
      eventType = 'website_up';
    } else if (isOnline && !wasOnline) {
      eventType = 'website_up';
    } else {
      return { delivered: false, reason: 'none' };
    }

    const settings = await resolveAlertSettings(website.userId, context);
    const allWebhooks = settings.webhooks || [];
    const webhooks = filterWebhooksForEvent(allWebhooks, eventType, website.id);

    logger.info(`ALERT: Webhook check for ${website.name} - Total webhooks: ${allWebhooks.length}, Filtered for event ${eventType}: ${webhooks.length}`);
    if (allWebhooks.length > 0 && webhooks.length === 0) {
      logger.warn(`ALERT: Webhooks exist but none match event type ${eventType}. Available events: ${allWebhooks.map(w => w.events).join(', ')}`);
    }

    let webhookStats = { sent: 0, queued: 0, skipped: 0 };
    if (webhooks.length === 0) {
      logger.info(`ALERT: No active webhooks found for user ${website.userId} for event ${eventType}`);
    } else {
      logger.info(`ALERT: Dispatching ${webhooks.length} webhook(s) for ${website.name} (${oldStatus} -> ${newStatus}, event: ${eventType})`);
      webhookStats = await dispatchWebhooks(
        webhooks,
        webhook => sendWebhook(webhook, website, eventType, oldStatus),
        { website, eventType, channel: 'status', previousStatus: oldStatus }
      );
    }

    logger.info(
      `ALERT: Webhook processing completed for ${website.name} (sent=${webhookStats.sent}, queued=${webhookStats.queued}, deferred=${webhookStats.skipped})`
    );
    logger.info(`ALERT: Starting email notification process for user ${website.userId}`);
    
    const emailResult: { delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' } = await (async () => {
      try {
        const emailSettings = settings.email || null;

        if (emailSettings) {
          if (emailSettings.recipient && emailSettings.enabled !== false) {
            const globalAllows = (emailSettings.events || []).includes(eventType);
            const perCheck = emailSettings.perCheck?.[website.id];
            // Explicitly check if perCheck entry exists and has enabled property
            const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
            const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

            // Debug logging for email settings
            logger.debug(`EMAIL DEBUG: Check ${website.name} (id: ${website.id}), eventType: ${eventType}`);
            logger.debug(`EMAIL DEBUG: perCheck exists: ${!!perCheck}, perCheckEnabled: ${perCheckEnabled}, perCheckAllows: ${perCheckAllows}, globalAllows: ${globalAllows}`);
            logger.debug(`EMAIL DEBUG: perCheck object: ${JSON.stringify(perCheck)}`);
            logger.debug(`EMAIL DEBUG: All perCheck keys: ${Object.keys(emailSettings.perCheck || {}).join(', ')}`);

            // Logic:
            // - Only send when per-check is explicitly enabled.
            // - If per-check has events, use them; otherwise fall back to global events.
            const shouldSend =
              perCheckEnabled === true
                ? (perCheckAllows ?? globalAllows)
                : false;

            logger.debug(`EMAIL DEBUG: shouldSend: ${shouldSend} (perCheckEnabled=${perCheckEnabled}, perCheckAllows=${perCheckAllows}, globalAllows=${globalAllows})`);

            if (shouldSend) {
              const minN = Math.max(1, Number(emailSettings.minConsecutiveEvents) || 1);
              let consecutiveCount = 1;
              if (newStatus === 'offline') {
                consecutiveCount =
                  (counters?.consecutiveFailures ??
                    (website as Website & { consecutiveFailures?: number }).consecutiveFailures ??
                    0) as number;
              } else if (newStatus === 'online') {
                consecutiveCount =
                  (counters?.consecutiveSuccesses ??
                    (website as Website & { consecutiveSuccesses?: number }).consecutiveSuccesses ??
                    0) as number;
              }

              if (consecutiveCount < minN) {
                logger.info(
                  `Email suppressed by flap suppression for ${website.name} (${eventType}) - ${consecutiveCount}/${minN}`
                );
                return { delivered: false, reason: 'flap' };
              }

              const deliveryResult = await deliverEmailAlert({
                website,
                eventType,
                context,
                send: () => sendEmailNotification(emailSettings.recipient as string, website, eventType, oldStatus),
              });

              if (deliveryResult === 'sent') {
                logger.info(`Email sent successfully to ${emailSettings.recipient} for website ${website.name}`);
                return { delivered: true };
              }

              if (deliveryResult === 'throttled') {
                logger.info(`Email suppressed by throttle/budget for ${website.name} (${eventType})`);
                return { delivered: false, reason: 'throttle' };
              }

              return { delivered: false, reason: 'error' };
            } else {
              logger.info(`Email suppressed by settings for ${website.name} (${eventType})`);
              return { delivered: false, reason: 'settings' };
            }
          } else {
            logger.info(`No email recipient configured or email disabled for user ${website.userId}`);
            return { delivered: false, reason: 'missingRecipient' };
          }
        } else {
          logger.info(`No email settings found for user ${website.userId}`);
          return { delivered: false, reason: 'settings' };
        }
      } catch (emailError) {
        logger.error('Error processing email notifications:', emailError);
        return { delivered: false, reason: 'error' };
      }
    })();

    try {
      const smsSettings = settings.sms || null;
      const smsTier = await resolveSmsTier(website);

      if (smsTier !== 'nano') {
        logger.info(`SMS alerts skipped (non-nano tier) for user ${website.userId}`);
      } else if (smsSettings) {
        if (smsSettings.recipient && smsSettings.enabled !== false) {
          const globalAllows = (smsSettings.events || []).includes(eventType);
          const perCheck = smsSettings.perCheck?.[website.id];
          const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
          const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

          const shouldSend =
            perCheckEnabled === true
              ? (perCheckAllows ?? globalAllows)
              : false;

          if (shouldSend) {
            const minN = Math.max(1, Number(smsSettings.minConsecutiveEvents) || 1);
            let consecutiveCount = 1;
            if (newStatus === 'offline') {
              consecutiveCount =
                (counters?.consecutiveFailures ??
                  (website as Website & { consecutiveFailures?: number }).consecutiveFailures ??
                  0) as number;
            } else if (newStatus === 'online') {
              consecutiveCount =
                (counters?.consecutiveSuccesses ??
                  (website as Website & { consecutiveSuccesses?: number }).consecutiveSuccesses ??
                  0) as number;
            }

            if (consecutiveCount < minN) {
              logger.info(
                `SMS suppressed by flap suppression for ${website.name} (${eventType}) - ${consecutiveCount}/${minN}`
              );
            } else {
              const deliveryResult = await deliverSmsAlert({
                website,
                eventType,
                context,
                smsTier,
                send: () => sendSmsNotification(smsSettings.recipient as string, website, eventType, oldStatus),
              });

              if (deliveryResult === 'sent') {
                logger.info(`SMS sent successfully to ${smsSettings.recipient} for website ${website.name}`);
              } else if (deliveryResult === 'throttled') {
                logger.info(`SMS suppressed by throttle/budget for ${website.name} (${eventType})`);
              }
            }
          } else {
            logger.info(`SMS suppressed by settings for ${website.name} (${eventType})`);
          }
        } else {
          logger.info(`No SMS recipient configured or SMS disabled for user ${website.userId}`);
        }
      } else {
        logger.info(`No SMS settings found for user ${website.userId}`);
      }
    } catch (smsError) {
      logger.error('Error processing SMS notifications:', smsError);
    }

    return emailResult;
  } catch (error) {
    logger.error("Error in triggerAlert:", error);
    return { delivered: false, reason: 'error' };
  }
}

type SSLCertificateData = {
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  error?: string;
};

// Helper to determine SSL alert state: 'ok' | 'warning' | 'error'
function getSSLAlertState(sslCertificate: SSLCertificateData | null | undefined): 'ok' | 'warning' | 'error' {
  if (!sslCertificate) return 'ok'; // No SSL data means no alert state
  if (!sslCertificate.valid) return 'error';
  if (sslCertificate.daysUntilExpiry !== undefined && sslCertificate.daysUntilExpiry <= 30) return 'warning';
  return 'ok';
}

export async function triggerSSLAlert(
  website: Website,
  sslCertificate: SSLCertificateData,
  previousSslCertificate: SSLCertificateData | null | undefined,
  context?: AlertContext
): Promise<{ delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' }> {
  try {
    // Determine current and previous SSL alert states
    const currentState = getSSLAlertState(sslCertificate);
    const previousState = getSSLAlertState(previousSslCertificate);

    // Only alert on state changes (like online/offline logic)
    if (currentState === previousState) {
      logger.info(`SSL ALERT SKIPPED: No state change for ${website.name} (${website.url}) - state remains '${currentState}'`);
      return { delivered: false, reason: 'none' };
    }

    // Don't alert when transitioning TO 'ok' state (certificate was renewed/fixed)
    // We only want alerts for problems, not for fixes
    if (currentState === 'ok') {
      logger.info(`SSL ALERT SKIPPED: Certificate is now OK for ${website.name} (${website.url}) - transitioned from '${previousState}' to 'ok'`);
      return { delivered: false, reason: 'none' };
    }

    let eventType: WebhookEvent;
    let alertMessage: string;
    
    if (!sslCertificate.valid) {
      eventType = 'ssl_error';
      alertMessage = `SSL certificate is invalid: ${sslCertificate.error || 'Unknown error'}`;
    } else if (sslCertificate.daysUntilExpiry !== undefined && sslCertificate.daysUntilExpiry <= 30) {
      eventType = 'ssl_warning';
      alertMessage = `SSL certificate expires in ${sslCertificate.daysUntilExpiry} days`;
    } else {
      return { delivered: false, reason: 'none' };
    }

    logger.info(`SSL ALERT: State change detected for ${website.name} (${website.url}): '${previousState}' -> '${currentState}' - ${alertMessage}`);



    const settings = await resolveAlertSettings(website.userId, context);
    const webhooks = filterWebhooksForEvent(settings.webhooks, eventType, website.id);

    let webhookStats = { sent: 0, queued: 0, skipped: 0 };
    if (webhooks.length === 0) {
      logger.info(`No active webhooks found for user ${website.userId}`);
    } else {
      webhookStats = await dispatchWebhooks(
        webhooks,
        webhook => sendSSLWebhook(webhook, website, eventType, sslCertificate),
        { website, eventType, channel: 'ssl', sslCertificate }
      );
    }

    logger.info(
      `SSL ALERT: Webhook processing completed (sent=${webhookStats.sent}, queued=${webhookStats.queued}, deferred=${webhookStats.skipped})`
    );
    
    const emailResult: { delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' } = await (async () => {
      try {
        const emailSettings = settings.email || null;

        if (emailSettings) {
          if (emailSettings.recipient && emailSettings.enabled !== false) {
            const globalAllows = (emailSettings.events || []).includes(eventType);
            const perCheck = emailSettings.perCheck?.[website.id];
            // Explicitly check if perCheck entry exists and has enabled property
            const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
            const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

            // Debug logging for SSL email settings
            logger.debug(`SSL EMAIL DEBUG: Check ${website.name} (id: ${website.id}), eventType: ${eventType}`);
            logger.debug(`SSL EMAIL DEBUG: perCheck exists: ${!!perCheck}, perCheckEnabled: ${perCheckEnabled}, perCheckAllows: ${perCheckAllows}, globalAllows: ${globalAllows}`);
            logger.debug(`SSL EMAIL DEBUG: perCheck object: ${JSON.stringify(perCheck)}`);
            logger.debug(`SSL EMAIL DEBUG: All perCheck keys: ${Object.keys(emailSettings.perCheck || {}).join(', ')}`);

            // Logic:
            // - Only send when per-check is explicitly enabled.
            // - If per-check has events, use them; otherwise fall back to global events.
            const shouldSend = perCheckEnabled === true
              ? (perCheckAllows ?? globalAllows)
              : false;

            logger.debug(`SSL EMAIL DEBUG: shouldSend: ${shouldSend} (perCheckEnabled=${perCheckEnabled}, perCheckAllows=${perCheckAllows}, globalAllows=${globalAllows})`);

            if (shouldSend) {
              const deliveryResult = await deliverEmailAlert({
                website,
                eventType,
                context,
                send: () => sendSSLEmailNotification(emailSettings.recipient as string, website, eventType, sslCertificate),
              });

              if (deliveryResult === 'sent') {
                logger.info(`SSL email sent successfully to ${emailSettings.recipient} for website ${website.name}`);
                return { delivered: true };
              }

              if (deliveryResult === 'throttled') {
                logger.info(`SSL email suppressed by throttle/budget for ${website.name} (${eventType})`);
                return { delivered: false, reason: 'throttle' };
              }

              return { delivered: false, reason: 'error' };
            } else {
              logger.info(`SSL email suppressed by settings for ${website.name} (${eventType})`);
              return { delivered: false, reason: 'settings' };
            }
          } else {
            logger.info(`No email recipient configured for user ${website.userId}`);
            return { delivered: false, reason: 'missingRecipient' };
          }
        } else {
          logger.info(`No email settings found for user ${website.userId}`);
          return { delivered: false, reason: 'settings' };
        }
      } catch (emailError) {
        logger.error('Error processing SSL email notifications:', emailError);
        return { delivered: false, reason: 'error' };
      }
    })();

    try {
      const smsSettings = settings.sms || null;
      const smsTier = await resolveSmsTier(website);

      if (smsTier !== 'nano') {
        logger.info(`SSL SMS skipped (non-nano tier) for user ${website.userId}`);
      } else if (smsSettings) {
        if (smsSettings.recipient && smsSettings.enabled !== false) {
          const globalAllows = (smsSettings.events || []).includes(eventType);
          const perCheck = smsSettings.perCheck?.[website.id];
          const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
          const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

          const shouldSend = perCheckEnabled === true
            ? (perCheckAllows ?? globalAllows)
            : false;

          if (shouldSend) {
            const deliveryResult = await deliverSmsAlert({
              website,
              eventType,
              context,
              smsTier,
              send: () => sendSslSmsNotification(smsSettings.recipient as string, website, eventType, sslCertificate),
            });

            if (deliveryResult === 'sent') {
              logger.info(`SSL SMS sent successfully to ${smsSettings.recipient} for website ${website.name}`);
            } else if (deliveryResult === 'throttled') {
              logger.info(`SSL SMS suppressed by throttle/budget for ${website.name} (${eventType})`);
            }
          } else {
            logger.info(`SSL SMS suppressed by settings for ${website.name} (${eventType})`);
          }
        } else {
          logger.info(`No SMS recipient configured for user ${website.userId}`);
        }
      } else {
        logger.info(`No SMS settings found for user ${website.userId}`);
      }
    } catch (smsError) {
      logger.error('Error processing SSL SMS notifications:', smsError);
    }

    return emailResult;
  } catch (error) {
    logger.error("Error in triggerSSLAlert:", error);
    return { delivered: false, reason: 'error' };
  }
}

function getThrottleWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

async function acquireEmailThrottleSlot(
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
      logger.info(`Email suppressed by in-memory throttle cache for ${userId}/${checkId}/${eventType}`);
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
    
    logger.info(`Email throttle slot acquired for ${userId}/${checkId}/${eventType} with ${Math.round(windowMs / (60 * 60 * 1000) * 10) / 10}h window`);
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

      logger.info(`Throttle slot unavailable for ${userId}/${checkId}/${eventType}: already exists (${Math.round(windowMs / (60 * 60 * 1000) * 10) / 10}h window)`);
      return false;
    }
    recordDeliveryFailure(throttleGuardTracker, guardKey, error);
    logger.warn(`Throttle check failed (denying email) for ${userId}/${checkId}/${eventType}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('throttle_guard_error', { userId, checkId, eventType });
    return false;
  }
}

async function acquireUserEmailBudget(
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
      logger.info(`Email suppressed by in-memory budget cache for ${userId} (${currentCount}/${maxCount})`);
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
    const currentCount = cache.get(userId) ?? cachedBudget?.count ?? 0;
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

async function acquireUserEmailMonthlyBudget(
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
      logger.info(`Email monthly budget suppressed by in-memory cache for ${userId} (${currentCount}/${maxCount})`);
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
    const currentCount = cache.get(userId) ?? cachedBudget?.count ?? 0;
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

async function acquireSmsThrottleSlot(
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
      logger.info(`SMS suppressed by in-memory throttle cache for ${userId}/${checkId}/${eventType}`);
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

    logger.info(`SMS throttle slot acquired for ${userId}/${checkId}/${eventType} with ${Math.round(windowMs / (60 * 60 * 1000) * 10) / 10}h window`);
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

      logger.info(`SMS throttle slot unavailable for ${userId}/${checkId}/${eventType}: already exists (${Math.round(windowMs / (60 * 60 * 1000) * 10) / 10}h window)`);
      return false;
    }
    recordDeliveryFailure(smsThrottleGuardTracker, guardKey, error);
    logger.warn(`SMS throttle check failed (denying SMS) for ${userId}/${checkId}/${eventType}: ${error instanceof Error ? error.message : String(error)}`);
    emitAlertMetric('sms_throttle_guard_error', { userId, checkId, eventType });
    return false;
  }
}

async function acquireUserSmsBudget(
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
      logger.info(`SMS suppressed by in-memory budget cache for ${userId} (${currentCount}/${maxCount})`);
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
    const currentCount = cache.get(userId) ?? cachedBudget?.count ?? 0;
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

async function acquireUserSmsMonthlyBudget(
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
      logger.info(`SMS monthly budget suppressed by in-memory cache for ${userId} (${currentCount}/${maxCount})`);
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
    const currentCount = cache.get(userId) ?? cachedBudget?.count ?? 0;
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

// ... (rest of the file: sendWebhook, sendEmailNotification, sendSSLWebhook, sendSSLEmailNotification)
// Since I am rewriting the whole file, I need to include the rest.
// I'll copy the remaining functions from the previous read.

async function sendWebhook(
  webhook: WebhookSettings, 
  website: Website, 
  eventType: WebhookEvent, 
  previousStatus: string
): Promise<void> {
  let payload: WebhookPayload | { text: string } | { content: string };
  
  const isSlack = webhook.webhookType === 'slack' || webhook.url.includes('hooks.slack.com');
  const isDiscord = webhook.webhookType === 'discord' || webhook.url.includes('discord.com') || webhook.url.includes('discordapp.com');

  // Optional response time (informational only)
  const responseTimeMessage = website.responseTime ? `Response Time: ${website.responseTime}ms` : '';

  if (isSlack) {
    const emoji = eventType === 'website_down' ? '🚨' : 
                  eventType === 'website_up' ? '✅' : 
                  eventType === 'ssl_error' ? '🔒' : 
                  eventType === 'ssl_warning' ? '⚠️' : '⚠️';
    
    const statusText = eventType === 'website_down' ? 'DOWN' : 
                      eventType === 'website_up' ? 'UP' : 
                      eventType === 'ssl_error' ? 'SSL ERROR' : 
                      eventType === 'ssl_warning' ? 'SSL WARNING' : 'ALERT';
    
    let message = `${emoji} *${website.name}* is ${statusText}\nURL: ${website.url}\nTime: ${new Date().toLocaleString()}`;
    
    if (responseTimeMessage) {
      message += `\n${responseTimeMessage}`;
    }
    
    payload = { text: message };
  } else if (isDiscord) {
    const emoji = eventType === 'website_down' ? '🚨' : 
                  eventType === 'website_up' ? '✅' : 
                  eventType === 'ssl_error' ? '🔒' : 
                  eventType === 'ssl_warning' ? '⚠️' : '⚠️';
    
    const statusText = eventType === 'website_down' ? 'DOWN' : 
                      eventType === 'website_up' ? 'UP' : 
                      eventType === 'ssl_error' ? 'SSL ERROR' : 
                      eventType === 'ssl_warning' ? 'SSL WARNING' : 'ALERT';

    let message = `${emoji} **${website.name}** is ${statusText}\nURL: ${website.url}\nTime: ${new Date().toLocaleString()}`;
    
    if (responseTimeMessage) {
      message += `\n**${responseTimeMessage}**`;
    }
    
    payload = { content: message };
  } else {
    payload = {
      event: eventType,
      timestamp: Date.now(),
      website: {
        id: website.id,
        name: website.name,
        url: website.url,
        status: website.status || 'unknown',
        responseTime: website.responseTime,
        responseTimeLimit: website.responseTimeLimit,
      },
      previousStatus,
      userId: website.userId,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Exit1-Website-Monitor/1.0',
    ...webhook.headers,
  };

  if (webhook.secret) {
    const crypto = await import('crypto');
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    headers['X-Exit1-Signature'] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    logger.info(`Webhook delivered successfully: ${webhook.url} (${response.status})`);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
} 

async function sendEmailNotification(
  toEmail: string,
  website: Website,
  eventType: WebhookEvent,
  previousStatus: string
): Promise<void> {
  const { resend, fromAddress } = getResendClient();

  const statusLabel = website.detailedStatus || website.status;

  const subject =
    eventType === 'website_down'
      ? `ALERT: ${website.name} is DOWN`
      : eventType === 'website_up'
        ? `RESOLVED: ${website.name} is UP`
        : `NOTICE: ${website.name} alert`;

  // Build response time info (informational only)
  let responseTimeHtml = '';
  if (website.responseTime) {
    responseTimeHtml = `<div><strong>Response Time:</strong> <span style="color:#38bdf8">${website.responseTime}ms</span></div>`;
  }

  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${subject}</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${new Date().toLocaleString()}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
          <div><strong>Site:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          <div><strong>Current Status:</strong> ${statusLabel}</div>
          ${responseTimeHtml}
          <div><strong>Previous Status:</strong> ${previousStatus}</div>
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8;font-size:14px">Manage email alerts in your Exit1 settings.</p>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: toEmail,
    subject,
    html,
  });
}

const normalizeSmsBody = (value: string, maxLength: number = 320) => {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return compact.slice(0, maxLength).trimEnd();
};

const buildStatusSmsBody = (website: Website, eventType: WebhookEvent, previousStatus?: string) => {
  const statusLabel =
    eventType === 'website_down'
      ? 'DOWN'
      : eventType === 'website_up'
        ? 'UP'
        : 'ALERT';

  let message = `Exit1 ${statusLabel}: ${website.name}`;
  if (eventType === 'website_up' && previousStatus) {
    message += ` (was ${previousStatus})`;
  }
  message += ` ${website.url}`;

  return normalizeSmsBody(message);
};

const buildSslSmsBody = (
  website: Website,
  eventType: WebhookEvent,
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  }
) => {
  const label = eventType === 'ssl_error' ? 'SSL error' : 'SSL warning';
  let message = `Exit1 ${label}: ${website.name} ${website.url}`;

  if (sslCertificate.error) {
    message += ` ${sslCertificate.error}`;
  }
  if (sslCertificate.daysUntilExpiry !== undefined) {
    message += ` Expires in ${sslCertificate.daysUntilExpiry}d`;
  }

  return normalizeSmsBody(message);
};

const sendSmsMessage = async (toPhone: string, body: string): Promise<void> => {
  const { accountSid, authToken, fromNumber, messagingServiceSid } = getTwilioCredentials();
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID is not configured');
  }

  if (!messagingServiceSid && !fromNumber) {
    throw new Error('TWILIO_FROM_NUMBER is not configured');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({
    To: toPhone,
    Body: body,
  });

  if (messagingServiceSid) {
    params.set('MessagingServiceSid', messagingServiceSid);
  } else if (fromNumber) {
    params.set('From', fromNumber);
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    let message = `Twilio request failed (${response.status})`;
    try {
      const data = (await response.json()) as { message?: string };
      if (data?.message) {
        message = data.message;
      }
    } catch {
      // Ignore JSON parse errors.
    }
    throw new Error(message);
  }
};

const sendSmsNotification = async (
  toPhone: string,
  website: Website,
  eventType: WebhookEvent,
  previousStatus: string
): Promise<void> => {
  const body = buildStatusSmsBody(website, eventType, previousStatus);
  await sendSmsMessage(toPhone, body);
};

const sendSslSmsNotification = async (
  toPhone: string,
  website: Website,
  eventType: WebhookEvent,
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  }
): Promise<void> => {
  const body = buildSslSmsBody(website, eventType, sslCertificate);
  await sendSmsMessage(toPhone, body);
};

async function sendSSLWebhook(
  webhook: WebhookSettings, 
  website: Website, 
  eventType: WebhookEvent, 
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  }
): Promise<void> {
  const isSlack = webhook.webhookType === 'slack' || webhook.url.includes('hooks.slack.com');
  const isDiscord = webhook.webhookType === 'discord' || webhook.url.includes('discord.com') || webhook.url.includes('discordapp.com');
  
  let payload: WebhookPayload | { text: string } | { content: string };

  if (isSlack) {
    const emoji = eventType === 'ssl_error' ? '🔒' : '⚠️';
    const statusText = eventType === 'ssl_error' ? 'SSL ERROR' : 'SSL WARNING';
    const errorMsg = sslCertificate.error ? `\nError: ${sslCertificate.error}` : '';
    const expiryMsg = sslCertificate.daysUntilExpiry !== undefined ? `\nExpires in: ${sslCertificate.daysUntilExpiry} days` : '';
    
    payload = {
      text: `${emoji} *${website.name}* - ${statusText}\nURL: ${website.url}\nTime: ${new Date().toLocaleString()}${errorMsg}${expiryMsg}`
    };
  } else if (isDiscord) {
    const emoji = eventType === 'ssl_error' ? '🔒' : '⚠️';
    const statusText = eventType === 'ssl_error' ? 'SSL ERROR' : 'SSL WARNING';
    const errorMsg = sslCertificate.error ? `\nError: ${sslCertificate.error}` : '';
    const expiryMsg = sslCertificate.daysUntilExpiry !== undefined ? `\nExpires in: ${sslCertificate.daysUntilExpiry} days` : '';
    
    payload = {
      content: `${emoji} **${website.name}** - ${statusText}\nURL: ${website.url}\nTime: ${new Date().toLocaleString()}${errorMsg}${expiryMsg}`
    };
  } else {
    payload = {
      event: eventType,
      timestamp: Date.now(),
      website: {
        id: website.id,
        name: website.name,
        url: website.url,
        status: website.status || 'unknown',
        responseTime: website.responseTime,
        lastError: undefined,
        detailedStatus: website.detailedStatus,
        sslCertificate: {
          valid: sslCertificate.valid,
          issuer: sslCertificate.issuer,
          subject: sslCertificate.subject,
          validFrom: sslCertificate.validFrom,
          validTo: sslCertificate.validTo,
          daysUntilExpiry: sslCertificate.daysUntilExpiry,
          error: sslCertificate.error,
        },
      },
      userId: website.userId,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Exit1-Website-Monitor/1.0',
    ...webhook.headers,
  };

  if (webhook.secret) {
    const crypto = await import('crypto');
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    headers['X-Exit1-Signature'] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    logger.info(`SSL webhook delivered successfully: ${webhook.url} (${response.status})`);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function sendSSLEmailNotification(
  toEmail: string,
  website: Website,
  eventType: WebhookEvent,
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  }
): Promise<void> {
  const { resend, fromAddress } = getResendClient();

  const subject =
    eventType === 'ssl_error'
      ? `SSL ERROR: ${website.name} certificate is invalid`
      : `SSL WARNING: ${website.name} certificate expires soon`;

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleDateString();
  };

  const sslDetails = `
    <div style="margin:8px 0;padding:8px;border-radius:6px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2)">
      <div><strong>Certificate Status:</strong> ${sslCertificate.valid ? 'Valid' : 'Invalid'}</div>
      ${sslCertificate.issuer ? `<div><strong>Issuer:</strong> ${sslCertificate.issuer}</div>` : ''}
      ${sslCertificate.subject ? `<div><strong>Subject:</strong> ${sslCertificate.subject}</div>` : ''}
      ${sslCertificate.validFrom ? `<div><strong>Valid From:</strong> ${formatDate(sslCertificate.validFrom)}</div>` : ''}
      ${sslCertificate.validTo ? `<div><strong>Valid Until:</strong> ${formatDate(sslCertificate.validTo)}</div>` : ''}
      ${sslCertificate.daysUntilExpiry !== undefined ? `<div><strong>Days Until Expiry:</strong> ${sslCertificate.daysUntilExpiry}</div>` : ''}
      ${sslCertificate.error ? `<div><strong>Error:</strong> ${sslCertificate.error}</div>` : ''}
    </div>
  `;

  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${subject}</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${new Date().toLocaleString()}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
          <div><strong>Site:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          ${sslDetails}
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8">Manage SSL alerts in your Exit1 settings.</p>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: toEmail,
    subject,
    html,
  });
}

export const __alertTestHooks = {
  calculateDeliveryBackoff,
  evaluateDeliveryState,
  recordDeliveryFailure,
  markDeliverySuccess,
  createWebhookRetryRecord,
};

export type { DeliveryFailureMeta as AlertDeliveryFailureMeta };
