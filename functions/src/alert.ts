import { getFirestore, Timestamp, QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookPayload, WebhookEvent, EmailSettings } from './types';
import { Resend } from 'resend';
import { CONFIG } from './config';
import { getResendCredentials } from './env';
import { normalizeEventList } from './webhook-events';

// Interface for cached settings to reduce Firestore reads
export interface AlertSettingsCache {
  email?: EmailSettings | null;
  webhooks?: WebhookSettings[];
}

// Context for the alert run to share cache, throttle, and budget state
export interface AlertContext {
  settings?: AlertSettingsCache;
  throttleCache?: Set<string>;
  budgetCache?: Map<string, number>;
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
const ALERT_FAILURE_TIMEOUT_MS = 30 * 60 * 1000;
const ALERT_MAX_FAILURES_BEFORE_DROP = 10;
const WEBHOOK_RETRY_BATCH_SIZE = CONFIG.WEBHOOK_RETRY_BATCH_SIZE || 25;
const WEBHOOK_RETRY_MAX_ATTEMPTS = CONFIG.WEBHOOK_RETRY_MAX_ATTEMPTS || 8;
const WEBHOOK_RETRY_TTL_MS = CONFIG.WEBHOOK_RETRY_TTL_MS || (48 * 60 * 60 * 1000);
const WEBHOOK_RETRY_DRAIN_INTERVAL_MS = CONFIG.WEBHOOK_RETRY_DRAIN_INTERVAL_MS || (30 * 1000);

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
}

const webhookFailureTracker = new Map<string, DeliveryFailureMeta>();
const emailFailureTracker = new Map<string, DeliveryFailureMeta>();
const throttleGuardTracker = new Map<string, DeliveryFailureMeta>();
const budgetGuardTracker = new Map<string, DeliveryFailureMeta>();
let isDrainingWebhookRetries = false;
let lastWebhookRetryDrain = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const emitAlertMetric = (name: string, data: Record<string, unknown>) => {
  logger.log('alert_metric', { name, ...data });
};

const calculateDeliveryBackoff = (failures: number): number => {
  if (failures <= 0) return ALERT_BACKOFF_INITIAL_MS;
  const delay = ALERT_BACKOFF_INITIAL_MS * Math.pow(2, failures - 1);
  return Math.min(delay, ALERT_BACKOFF_MAX_MS);
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

const getGuardKey = (prefix: string, identifier: string) => `${prefix}:${identifier}`;

const getRetryErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'unknown error');

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
  const nextAttemptAt = now + calculateDeliveryBackoff(attempt);

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
  try {
    const firestore = getFirestore();
    const docRef = firestore.collection(CONFIG.WEBHOOK_RETRY_COLLECTION).doc(context.deliveryId);
    const record = createWebhookRetryRecord(webhook, context, error);
    await docRef.create(record);
    emitAlertMetric('webhook_queued', {
      deliveryId: context.deliveryId,
      eventType: context.eventType,
      channel: context.channel,
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

    const now = Date.now();
    await doc.ref.update({
      attempt: nextAttempt,
      lastError: getRetryErrorMessage(error),
      nextAttemptAt: Timestamp.fromMillis(now + calculateDeliveryBackoff(nextAttempt)),
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
const fetchAlertSettingsFromFirestore = async (userId: string): Promise<AlertSettingsCache> => {
  const firestore = getFirestore();
  const [emailDoc, webhooksSnapshot] = await Promise.all([
    firestore.collection('emailSettings').doc(userId).get(),
    firestore.collection('webhooks').where('userId', '==', userId).where('enabled', '==', true).get(),
  ]);

  return {
    email: emailDoc.exists ? (emailDoc.data() as EmailSettings) : null,
    webhooks: webhooksSnapshot.docs.map(doc => doc.data() as WebhookSettings),
  };
};

const resolveAlertSettings = async (userId: string, context?: AlertContext): Promise<AlertSettingsCache> => {
  if (context?.settings) {
    return context.settings;
  }

  const settings = await fetchAlertSettingsFromFirestore(userId);
  if (context) {
    context.settings = settings;
  }
  return settings;
};

const filterWebhooksForEvent = (webhooks: WebhookSettings[] | undefined, eventType: WebhookEvent) => {
  if (!webhooks?.length) {
    return [];
  }
  return webhooks.filter(webhook => {
    const allowedEvents = new Set(normalizeEventList(webhook.events));
    return allowedEvents.has(eventType);
  });
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
    logger.info(
      `Webhook delivery deferred for ${webhook.url} (${context.eventType}) due to backoff`
    );
    emitAlertMetric('webhook_deferred', {
      key: trackerKey,
      eventType: context.eventType,
    });
    return 'skipped';
  }

  if (state === 'dropped') {
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

  const budgetAllowed = await acquireUserEmailBudget(
    website.userId,
    CONFIG.EMAIL_USER_BUDGET_WINDOW_MS,
    CONFIG.EMAIL_USER_BUDGET_MAX_PER_WINDOW,
    context?.budgetCache
  );
  if (!budgetAllowed) {
    emitAlertMetric('email_budget_blocked', { userId: website.userId, eventType });
    return 'throttled';
  }

  const trackerKey = getEmailTrackerKey(website.userId, website.id, eventType);
  const deliveryState = await sendEmailWithGuards(trackerKey, eventType, send);

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
    await drainWebhookRetryQueue();
    // Log the alert
    logger.info(`ALERT: Website ${website.name} (${website.url}) changed from ${oldStatus} to ${newStatus}`);
    logger.info(`ALERT: User ID: ${website.userId}`);
    
    // Determine webhook event type
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
      eventType = 'website_error';
    }

    const settings = await resolveAlertSettings(website.userId, context);
    const webhooks = filterWebhooksForEvent(settings.webhooks, eventType);

    let webhookStats = { sent: 0, queued: 0, skipped: 0 };
    if (webhooks.length === 0) {
      logger.info(`No active webhooks found for user ${website.userId}`);
    } else {
      webhookStats = await dispatchWebhooks(
        webhooks,
        webhook => sendWebhook(webhook, website, eventType, oldStatus),
        { website, eventType, channel: 'status', previousStatus: oldStatus }
      );
    }

    logger.info(
      `ALERT: Webhook processing completed (sent=${webhookStats.sent}, queued=${webhookStats.queued}, deferred=${webhookStats.skipped})`
    );
    logger.info(`ALERT: Starting email notification process for user ${website.userId}`);
    
    try {
      const emailSettings = settings.email || null;

      if (emailSettings) {
        if (emailSettings.recipient && emailSettings.enabled !== false) {
          const globalAllows = (emailSettings.events || []).includes(eventType);
          const perCheck = emailSettings.perCheck?.[website.id];
          const perCheckEnabled = perCheck?.enabled;
          const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

          const shouldSend =
            perCheckEnabled === true
              ? (perCheckAllows ?? globalAllows)
              : perCheckEnabled === false
                ? false
                : globalAllows;

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
  } catch (error) {
    logger.error("Error in triggerAlert:", error);
    return { delivered: false, reason: 'error' };
  }
}

export async function triggerSSLAlert(
  website: Website,
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  },
  context?: AlertContext
): Promise<{ delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' }> {
  try {
    await drainWebhookRetryQueue();
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

    logger.info(`SSL ALERT: Website ${website.name} (${website.url}) - ${alertMessage}`);

    const settings = await resolveAlertSettings(website.userId, context);
    const webhooks = filterWebhooksForEvent(settings.webhooks, eventType);

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
    
    try {
      const emailSettings = settings.email || null;

      if (emailSettings) {
        if (emailSettings.recipient && emailSettings.enabled !== false) {
          const globalAllows = (emailSettings.events || []).includes(eventType);
          const perCheck = emailSettings.perCheck?.[website.id];
          const perCheckEnabled = perCheck?.enabled;
          const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

          const shouldSend = perCheckEnabled === true
            ? (perCheckAllows ?? globalAllows)
            : perCheckEnabled === false
              ? false
              : globalAllows;

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
    
    // Construct a unique key for this throttle window
    const docId = `${userId}__${checkId}__${eventType}__${windowStart}`;
    
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
  if (windowMs <= 0 || maxCount <= 0) {
    return true;
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

  try {
    const firestore = getFirestore();
    const now = Date.now();
    const windowStart = getThrottleWindowStart(now, windowMs);
    const docId = `${userId}__${windowStart}`;
    const docRef = firestore.collection(CONFIG.EMAIL_USER_BUDGET_COLLECTION).doc(docId);
    const ttlBufferMs = CONFIG.EMAIL_USER_BUDGET_TTL_BUFFER_MS || (5 * 60 * 1000);

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

// ... (rest of the file: sendWebhook, sendEmailNotification, sendSSLWebhook, sendSSLEmailNotification, triggerDomainExpiryAlert)
// Since I am rewriting the whole file, I need to include the rest.
// I'll copy the remaining functions from the previous read.

async function sendWebhook(
  webhook: WebhookSettings, 
  website: Website, 
  eventType: WebhookEvent, 
  previousStatus: string
): Promise<void> {
  // ... (same implementation as before)
  let payload: WebhookPayload | { text: string } | { content: string };
  
  const isSlack = webhook.webhookType === 'slack' || webhook.url.includes('hooks.slack.com');
  const isDiscord = webhook.webhookType === 'discord' || webhook.url.includes('discord.com') || webhook.url.includes('discordapp.com');

  if (isSlack) {
    const emoji = eventType === 'website_down' ? '🚨' : 
                  eventType === 'website_up' ? '✅' : 
                  eventType === 'ssl_error' ? '🔒' : 
                  eventType === 'ssl_warning' ? '⚠️' : '⚠️';
    
    const statusText = eventType === 'website_down' ? 'DOWN' : 
                      eventType === 'website_up' ? 'UP' : 
                      eventType === 'ssl_error' ? 'SSL ERROR' : 
                      eventType === 'ssl_warning' ? 'SSL WARNING' : 'ERROR';
    
    payload = {
      text: `${emoji} *${website.name}* is ${statusText}\nURL: ${website.url}\nTime: ${new Date().toLocaleString()}`
    };
  } else if (isDiscord) {
    const emoji = eventType === 'website_down' ? '🚨' : 
                  eventType === 'website_up' ? '✅' : 
                  eventType === 'ssl_error' ? '🔒' : 
                  eventType === 'ssl_warning' ? '⚠️' : '⚠️';
    
    const statusText = eventType === 'website_down' ? 'DOWN' : 
                      eventType === 'website_up' ? 'UP' : 
                      eventType === 'ssl_error' ? 'SSL ERROR' : 
                      eventType === 'ssl_warning' ? 'SSL WARNING' : 'ERROR';

    payload = {
      content: `${emoji} **${website.name}** is ${statusText}\nURL: ${website.url}\nTime: ${new Date().toLocaleString()}`
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

  const subject =
    eventType === 'website_down'
      ? `ALERT: ${website.name} is DOWN`
      : eventType === 'website_up'
        ? `RESOLVED: ${website.name} is UP`
        : `NOTICE: ${website.name} error`;

  const statusLabel = website.detailedStatus || website.status;
  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${subject}</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${new Date().toLocaleString()}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
          <div><strong>Site:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          <div><strong>Current:</strong> ${statusLabel}</div>
          ${website.responseTime ? `<div><strong>Response:</strong> ${website.responseTime}ms</div>` : ''}
          <div><strong>Previous:</strong> ${previousStatus}</div>
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8">Manage email alerts in your Exit1 settings.</p>
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
  const isDiscord = webhook.webhookType === 'discord' || webhook.url.includes('discord.com') || webhook.url.includes('discordapp.com');
  
  let payload: WebhookPayload | { content: string };

  if (isDiscord) {
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

export const triggerDomainExpiryAlert = async (
  website: Website,
  domainExpiry: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
    daysUntilExpiry?: number;
    error?: string;
  },
  context?: AlertContext
) => {
  try {
    const settings = await resolveAlertSettings(website.userId, context);
    const emailSettings = settings.email;
    if (!emailSettings?.recipient || emailSettings.enabled === false) {
      logger.info(`Skipping domain expiry alert (no recipient) for ${website.userId}`);
      return;
    }

    const isExpired = !domainExpiry.valid;
    const isExpiringSoon = domainExpiry.daysUntilExpiry !== undefined && domainExpiry.daysUntilExpiry <= 30;
    
    if (!isExpired && !isExpiringSoon) {
      return; // No alert needed
    }

    const eventType: WebhookEvent = isExpired ? 'ssl_error' : 'ssl_warning';
    const globalAllows = (emailSettings.events || []).includes(eventType);
    const perCheck = emailSettings.perCheck?.[website.id];
    const perCheckEnabled = perCheck?.enabled;
    const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

    const shouldSend =
      perCheckEnabled === true
        ? (perCheckAllows ?? globalAllows)
        : perCheckEnabled === false
          ? false
          : globalAllows;

    if (!shouldSend) {
      logger.info(`Domain alert suppressed by settings for ${website.name} (${eventType})`);
      return;
    }

    const subject = isExpired 
      ? `🚨 Domain Expired: ${website.name} (${website.url})`
      : `⚠️ Domain Expiring Soon: ${website.name} (${website.url})`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: ${isExpired ? '#dc2626' : '#f59e0b'};">
          ${isExpired ? '🚨 Domain Expired' : '⚠️ Domain Expiring Soon'}
        </h2>
        
        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3>${website.name}</h3>
          <p><strong>URL:</strong> ${website.url}</p>
          <p><strong>Domain:</strong> ${domainExpiry.domainName || 'Unknown'}</p>
          ${domainExpiry.registrar ? `<p><strong>Registrar:</strong> ${domainExpiry.registrar}</p>` : ''}
          ${domainExpiry.expiryDate ? `<p><strong>Expiry Date:</strong> ${new Date(domainExpiry.expiryDate).toLocaleDateString()}</p>` : ''}
          ${domainExpiry.daysUntilExpiry !== undefined ? `<p><strong>Days Until Expiry:</strong> ${domainExpiry.daysUntilExpiry}</p>` : ''}
          ${domainExpiry.error ? `<p><strong>Error:</strong> ${domainExpiry.error}</p>` : ''}
        </div>
        
        <p style="color: #6b7280; font-size: 14px;">
          This is an automated alert from Exit1.dev. Please renew your domain registration to avoid service disruption.
        </p>
      </div>
    `;

    const deliveryResult = await deliverEmailAlert({
      website,
      eventType,
      context,
      send: async () => {
        const { resend, fromAddress } = getResendClient();
        await resend.emails.send({
          from: fromAddress,
          to: emailSettings.recipient,
          subject,
          html,
        });
      },
    });

    if (deliveryResult === 'sent') {
      logger.info(`Domain expiry alert sent for ${website.name} to ${emailSettings.recipient}`);
    } else if (deliveryResult === 'throttled') {
      logger.info(`Domain expiry alert throttled for ${website.name}`);
    } else {
      logger.error(`Domain expiry alert failed for ${website.name}`);
    }
  } catch (error) {
    logger.error(`Failed to send domain expiry alert for ${website.name}:`, error);
  }
};

export const __alertTestHooks = {
  calculateDeliveryBackoff,
  evaluateDeliveryState,
  recordDeliveryFailure,
  markDeliverySuccess,
  createWebhookRetryRecord,
};

export type { DeliveryFailureMeta as AlertDeliveryFailureMeta };