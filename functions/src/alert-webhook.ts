import { getFirestore, Timestamp, QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookPayload, WebhookEvent } from './types';
import { CONFIG } from './config';
import { CLERK_SECRET_KEY_PROD } from './env';
import { createClerkClient } from '@clerk/backend';
import {
  DeliveryFailureMeta,
  SSLCertificateData,
  WebhookAttemptContext,
  WebhookRetryChannel,
  SerializedWebsite,
  WebhookSendFn,
  WebhookDispatchContext,
  MAX_PARALLEL_NOTIFICATIONS,
  WEBHOOK_BATCH_DELAY_MS,
  PER_URL_SEND_DELAY_MS,
  WEBHOOK_RETRY_BATCH_SIZE,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
  WEBHOOK_RETRY_TTL_MS,
  WEBHOOK_RETRY_DRAIN_INTERVAL_MS,
  formatDateForCheck,
  formatStatusCode,
  sleep,
  emitAlertMetric,
  getResendClient,
  calculateDeliveryBackoff,
  evaluateDeliveryState,
  markDeliverySuccess,
  recordDeliveryFailure,
  getWebhookTrackerKey,
  getRetryErrorMessage,
  extractHttpStatus,
  isNonRetryableError,
  isRateLimitError,
  isAlreadyExistsError,
  serializeWebsiteForRetry,
  hydrateWebsiteFromRetry,
  createWebhookDeliveryId,
} from './alert-helpers';

// ============================================================================
// FAILURE TRACKER
// ============================================================================

export const webhookFailureTracker = new Map<string, DeliveryFailureMeta>();

// ============================================================================
// PER-URL SEND CHAIN (serializes sends per URL to avoid rate limits)
// ============================================================================

// Per-URL send chain to serialize sends and avoid rate limiting (e.g. Discord 429s).
// When multiple checks alert to the same webhook URL concurrently, this ensures
// sends are sequential with a small delay rather than a parallel burst.
const urlSendChain = new Map<string, Promise<void>>();

const withUrlLock = async <T>(url: string, fn: () => Promise<T>): Promise<T> => {
  const prev = urlSendChain.get(url) ?? Promise.resolve();
  let resolve: () => void;
  const current = new Promise<void>(r => { resolve = r; });
  urlSendChain.set(url, current);

  // Wait for the previous send to this URL to finish
  await prev.catch(() => {});

  try {
    const result = await fn();
    await sleep(PER_URL_SEND_DELAY_MS);
    return result;
  } finally {
    resolve!();
  }
};

// ============================================================================
// WEBHOOK RETRY RECORDS
// ============================================================================

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

// ============================================================================
// WEBHOOK HEALTH UPDATES
// ============================================================================

// Update webhook health in Firestore on successful delivery
const updateWebhookHealthSuccess = async (webhook: WebhookSettings): Promise<void> => {
  if (!webhook.id) return; // Can't update without ID

  try {
    const firestore = getFirestore();
    await firestore.collection('webhooks').doc(webhook.id).update({
      lastDeliveryStatus: 'success',
      lastDeliveryAt: Date.now(),
      lastError: null,
      lastErrorAt: null,
    });
  } catch (error) {
    logger.warn(`Failed to update webhook health for ${webhook.id}:`, error);
  }
};

// Update webhook health in Firestore on failed delivery
const updateWebhookHealthFailure = async (
  webhook: WebhookSettings,
  error: unknown,
  isPermanent: boolean
): Promise<void> => {
  if (!webhook.id) return; // Can't update without ID

  try {
    const firestore = getFirestore();
    const errorMessage = error instanceof Error ? error.message : String(error);
    await firestore.collection('webhooks').doc(webhook.id).update({
      lastDeliveryStatus: isPermanent ? 'permanent_failure' : 'failed',
      lastDeliveryAt: Date.now(),
      lastError: errorMessage,
      lastErrorAt: Date.now(),
    });
  } catch (error) {
    logger.warn(`Failed to update webhook health for ${webhook.id}:`, error);
  }
};

// ============================================================================
// WEBHOOK FAILURE EMAIL NOTIFICATION
// ============================================================================

// Send email notification to user about permanent webhook failure
export const sendWebhookFailureEmail = async (webhook: WebhookSettings, error: unknown): Promise<void> => {
  try {
    // Check if we've already notified about this failure recently (within 24 hours)
    const now = Date.now();
    const notificationThreshold = 24 * 60 * 60 * 1000; // 24 hours
    if (webhook.permanentFailureNotifiedAt && (now - webhook.permanentFailureNotifiedAt) < notificationThreshold) {
      logger.info(`Skipping webhook failure email for ${webhook.id}: already notified within 24 hours`);
      return;
    }

    // Get user email from Clerk
    const clerkSecretKey = CLERK_SECRET_KEY_PROD.value();
    if (!clerkSecretKey) {
      logger.warn('Cannot send webhook failure email: Clerk secret key not found');
      return;
    }

    const clerkClient = createClerkClient({ secretKey: clerkSecretKey });
    let user;
    try {
      user = await clerkClient.users.getUser(webhook.userId);
    } catch (clerkError: unknown) {
      const err = clerkError as { status?: number; errors?: Array<{ code?: string }> };
      if (err?.status === 404 || err?.errors?.[0]?.code === 'resource_not_found') {
        logger.warn(`Cannot send webhook failure email: user ${webhook.userId} not found in Clerk (likely deleted)`);
        return;
      }
      throw clerkError;
    }
    const userEmail = user.primaryEmailAddress?.emailAddress || user.emailAddresses[0]?.emailAddress;

    if (!userEmail) {
      logger.warn(`Cannot send webhook failure email for user ${webhook.userId}: no email address found`);
      return;
    }

    const { resend, fromAddress } = getResendClient();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const baseUrl = process.env.FRONTEND_URL || 'https://app.exit1.dev';
    const webhooksUrl = `${baseUrl}/webhooks`;

    const subject = `ACTION REQUIRED: Webhook "${webhook.name}" has permanently failed`;

    const html = `
      <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
        <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
          <h2 style="margin:0 0 8px 0;color:#ef4444">⚠️ Webhook Failure Alert</h2>
          <p style="margin:0 0 12px 0;color:#94a3b8">${formatDateForCheck(new Date())}</p>

          <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2)">
            <p style="margin:0 0 12px 0;color:#e2e8f0">Your webhook has permanently failed and will not receive any more notifications:</p>
            <div><strong>Webhook Name:</strong> ${webhook.name}</div>
            <div><strong>Webhook URL:</strong> <code style="background:rgba(148,163,184,0.1);padding:2px 6px;border-radius:4px;color:#38bdf8">${webhook.url}</code></div>
            <div><strong>Error:</strong> <code style="background:rgba(148,163,184,0.1);padding:2px 6px;border-radius:4px;color:#fca5a5">${errorMessage}</code></div>
          </div>

          <div style="margin:16px 0;padding:12px;border-radius:8px;background:rgba(148,163,184,0.06);border:1px solid rgba(148,163,184,0.1)">
            <p style="margin:0 0 8px 0;color:#e2e8f0;font-weight:500">What this means:</p>
            <ul style="margin:0;padding-left:20px;color:#94a3b8">
              <li>The webhook URL is invalid, deleted, or unauthorized</li>
              <li>Exit1 will NOT retry sending to this webhook</li>
              <li>You will NOT receive notifications for events configured for this webhook</li>
            </ul>
          </div>

          <div style="margin:16px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
            <p style="margin:0 0 8px 0;color:#e2e8f0;font-weight:500">What to do:</p>
            <ol style="margin:0;padding-left:20px;color:#94a3b8">
              <li>Check your webhook service (Slack, Discord, etc.) to verify the webhook still exists</li>
              <li>If the webhook was deleted, create a new one and update it in Exit1</li>
              <li>If the webhook still exists, check the permissions and URL</li>
              <li>Delete this webhook if you no longer need it</li>
            </ol>
          </div>

          <div style="margin:16px 0 0 0;text-align:center">
            <a href="${webhooksUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:12px;font-weight:500">Manage Webhooks</a>
          </div>

          <p style="margin:16px 0 0 0;color:#94a3b8;font-size:14px">This is an automated notification from Exit1. You will receive this email once per day maximum for each permanently failed webhook.</p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: fromAddress,
      to: userEmail,
      subject,
      html,
    });

    logger.info(`Sent webhook failure email to ${userEmail} for webhook ${webhook.id}`);

    // Update the webhook to track that we sent this notification
    if (webhook.id) {
      const firestore = getFirestore();
      await firestore.collection('webhooks').doc(webhook.id).update({
        permanentFailureNotifiedAt: now,
      });
    }
  } catch (error) {
    logger.error('Failed to send webhook failure email:', error);
  }
};

// ============================================================================
// WEBHOOK RETRY QUEUE
// ============================================================================

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

let isDrainingWebhookRetries = false;
let lastWebhookRetryDrain = 0;

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

// ============================================================================
// WEBHOOK DISPATCH ORCHESTRATION
// ============================================================================

export const dispatchWebhooks = async (
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

  // Serialize sends to the same URL to avoid rate limiting (e.g. Discord 429s)
  return withUrlLock(webhook.url, async () => {
    try {
      await sendFn(webhook);
      markDeliverySuccess(webhookFailureTracker, trackerKey);
      emitAlertMetric('webhook_sent', { key: trackerKey, eventType: context.eventType });

      // Update webhook health in Firestore
      await updateWebhookHealthSuccess(webhook);

      return 'sent' as const;
    } catch (error) {
      // Check if this is a permanent failure (webhook URL is invalid/deleted)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isPermanentFailure = /HTTP (404|401|403|410)/.test(errorMessage);

      if (isPermanentFailure) {
        logger.error(
          `Webhook permanently failed (invalid/deleted URL) for ${webhook.url} - ${context.website.name}. ` +
          `Error: ${errorMessage}. Webhook will not be retried. Please check your webhook configuration.`
        );
        emitAlertMetric('webhook_permanent_failure', {
          key: trackerKey,
          eventType: context.eventType,
        });

        // Update webhook health in Firestore
        await updateWebhookHealthFailure(webhook, error, true);

        // Send email notification to user (fire and forget)
        sendWebhookFailureEmail(webhook, error).catch(err => {
          logger.error('Failed to send webhook failure email:', err);
        });

        return 'skipped' as const;
      }

      recordDeliveryFailure(webhookFailureTracker, trackerKey, error);
      logger.error(
        `Failed to send webhook to ${webhook.url} for ${context.website.name}`,
        error
      );
      emitAlertMetric('webhook_failed', {
        key: trackerKey,
        eventType: context.eventType,
      });

      // Update webhook health in Firestore
      await updateWebhookHealthFailure(webhook, error, false);

      await queueWebhookRetry(webhook, context, error);
      return 'queued' as const;
    }
  });
};

// ============================================================================
// SEND WEBHOOK (status alerts)
// ============================================================================

export async function sendWebhook(
  webhook: WebhookSettings,
  website: Website,
  eventType: WebhookEvent,
  previousStatus: string
): Promise<void> {
  let payload: WebhookPayload | { text: string } | { content: string } | object;

  const isSlack = webhook.webhookType === 'slack' || webhook.url.includes('hooks.slack.com');
  const isDiscord = webhook.webhookType === 'discord' || webhook.url.includes('discord.com') || webhook.url.includes('discordapp.com');
  const isTeams = webhook.webhookType === 'teams' || webhook.url.includes('.webhook.office.com') || webhook.url.includes('.logic.azure.com');

  // Optional response time (informational only)
  const responseTimeMessage = website.responseTime ? `Response Time: ${website.responseTime}ms` : '';
  const isProtocolCheckWh = website.type === 'ping' || website.type === 'websocket';
  // Status code is meaningless for ping/websocket checks — skip it to avoid misleading labels
  const statusCodeMessage = isProtocolCheckWh ? null : formatStatusCode(website.lastStatusCode);
  // Error reason and target IP — especially useful for ping check diagnostics
  const errorMessage = (website.lastError && eventType === 'website_down') ? website.lastError : '';
  const targetIpMessage = website.targetIp ? `Target IP: ${website.targetIp}` : '';

  if (isSlack) {
    const emoji = eventType === 'website_down' ? '🚨' :
                  eventType === 'website_up' ? '✅' :
                  eventType === 'ssl_error' ? '🔒' :
                  eventType === 'ssl_warning' ? '⚠️' : '⚠️';

    const statusText = eventType === 'website_down' ? 'DOWN' :
                      eventType === 'website_up' ? 'UP' :
                      eventType === 'ssl_error' ? 'SSL ERROR' :
                      eventType === 'ssl_warning' ? 'SSL WARNING' : 'ALERT';

    let message = `${emoji} *${website.name}* is ${statusText}\nURL: ${website.url}\nTime: ${formatDateForCheck(new Date(), website.timezone)}`;

    if (responseTimeMessage) {
      message += `\n${responseTimeMessage}`;
    }
    if (statusCodeMessage) {
      message += `\nStatus Code: ${statusCodeMessage}`;
    }
    if (errorMessage) {
      message += `\nError: ${errorMessage}`;
    }
    if (targetIpMessage) {
      message += `\n${targetIpMessage}`;
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

    let message = `${emoji} **${website.name}** is ${statusText}\nURL: ${website.url}\nTime: ${formatDateForCheck(new Date(), website.timezone)}`;

    if (responseTimeMessage) {
      message += `\n**${responseTimeMessage}**`;
    }
    if (statusCodeMessage) {
      message += `\n**Status Code: ${statusCodeMessage}**`;
    }
    if (errorMessage) {
      message += `\n**Error: ${errorMessage}**`;
    }
    if (targetIpMessage) {
      message += `\n${targetIpMessage}`;
    }

    payload = { content: message };
  } else if (isTeams) {
    const emoji = eventType === 'website_down' ? '🚨' :
                  eventType === 'website_up' ? '✅' :
                  eventType === 'ssl_error' ? '🔒' :
                  eventType === 'ssl_warning' ? '⚠️' : '⚠️';

    const statusText = eventType === 'website_down' ? 'DOWN' :
                      eventType === 'website_up' ? 'UP' :
                      eventType === 'ssl_error' ? 'SSL ERROR' :
                      eventType === 'ssl_warning' ? 'SSL WARNING' : 'ALERT';

    const summaryText = `${emoji} ${website.name} is ${statusText}`;
    const containerStyle = (eventType === 'website_down') ? 'attention' :
                           (eventType === 'website_up') ? 'good' : 'warning';

    const cardBody: object[] = [
      {
        type: "Container",
        style: containerStyle,
        items: [
          {
            type: "TextBlock",
            text: summaryText,
            weight: "Bolder",
            size: "Medium",
            wrap: true,
          },
        ],
      },
      {
        type: "FactSet",
        facts: [
          { title: "URL", value: website.url },
          { title: "Time", value: formatDateForCheck(new Date(), website.timezone) },
          ...(responseTimeMessage ? [{ title: "Response Time", value: `${website.responseTime}ms` }] : []),
          ...(statusCodeMessage ? [{ title: "Status Code", value: statusCodeMessage }] : []),
          ...(errorMessage ? [{ title: "Error", value: errorMessage }] : []),
          ...(targetIpMessage ? [{ title: "Target IP", value: website.targetIp! }] : []),
        ],
      },
    ];

    payload = {
      type: "message",
      summary: summaryText,
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: cardBody,
        },
      }],
    };
  } else {
    const emoji = eventType === 'website_down' ? '🚨' :
                  eventType === 'website_up' ? '✅' :
                  eventType === 'ssl_error' ? '🔒' :
                  eventType === 'ssl_warning' ? '⚠️' : '⚠️';
    const statusText = eventType === 'website_down' ? 'DOWN' :
                      eventType === 'website_up' ? 'UP' :
                      eventType === 'ssl_error' ? 'SSL ERROR' :
                      eventType === 'ssl_warning' ? 'SSL WARNING' : 'ALERT';

    payload = {
      event: eventType,
      summary: `${emoji} ${website.name} is ${statusText}`,
      timestamp: Date.now(),
      website: {
        id: website.id,
        name: website.name,
        url: website.url,
        type: website.type || 'website',
        status: website.status || 'unknown',
        responseTime: website.responseTime,
        responseTimeLimit: website.responseTimeLimit,
        responseTimeExceeded: typeof website.responseTimeLimit === 'number' && website.responseTimeLimit > 0 && typeof website.responseTime === 'number' && website.responseTime > website.responseTimeLimit,
        lastStatusCode: website.lastStatusCode,
        statusCodeInfo: statusCodeMessage || undefined,
        error: errorMessage || undefined,
        targetIp: website.targetIp || undefined,
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

    // Consume response body to release the connection back to the pool
    const body = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
    }

  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ============================================================================
// SEND SSL WEBHOOK
// ============================================================================

export async function sendSSLWebhook(
  webhook: WebhookSettings,
  website: Website,
  eventType: WebhookEvent,
  sslCertificate: SSLCertificateData
): Promise<void> {
  const isSlack = webhook.webhookType === 'slack' || webhook.url.includes('hooks.slack.com');
  const isDiscord = webhook.webhookType === 'discord' || webhook.url.includes('discord.com') || webhook.url.includes('discordapp.com');
  const isTeams = webhook.webhookType === 'teams' || webhook.url.includes('.webhook.office.com') || webhook.url.includes('.logic.azure.com');

  let payload: WebhookPayload | { text: string } | { content: string } | object;

  if (isSlack) {
    const emoji = eventType === 'ssl_error' ? '🔒' : '⚠️';
    const statusText = eventType === 'ssl_error' ? 'SSL ERROR' : 'SSL WARNING';
    const errorMsg = sslCertificate.error ? `\nError: ${sslCertificate.error}` : '';
    const expiryMsg = sslCertificate.daysUntilExpiry !== undefined ? `\nExpires in: ${sslCertificate.daysUntilExpiry} days` : '';

    payload = {
      text: `${emoji} *${website.name}* - ${statusText}\nURL: ${website.url}\nTime: ${formatDateForCheck(new Date(), website.timezone)}${errorMsg}${expiryMsg}`
    };
  } else if (isDiscord) {
    const emoji = eventType === 'ssl_error' ? '🔒' : '⚠️';
    const statusText = eventType === 'ssl_error' ? 'SSL ERROR' : 'SSL WARNING';
    const errorMsg = sslCertificate.error ? `\nError: ${sslCertificate.error}` : '';
    const expiryMsg = sslCertificate.daysUntilExpiry !== undefined ? `\nExpires in: ${sslCertificate.daysUntilExpiry} days` : '';

    payload = {
      content: `${emoji} **${website.name}** - ${statusText}\nURL: ${website.url}\nTime: ${formatDateForCheck(new Date(), website.timezone)}${errorMsg}${expiryMsg}`
    };
  } else if (isTeams) {
    const emoji = eventType === 'ssl_error' ? '🔒' : '⚠️';
    const statusText = eventType === 'ssl_error' ? 'SSL ERROR' : 'SSL WARNING';
    const summaryText = `${emoji} ${website.name} - ${statusText}`;
    const containerStyle = eventType === 'ssl_error' ? 'attention' : 'warning';

    const facts: { title: string; value: string }[] = [
      { title: "URL", value: website.url },
      { title: "Time", value: formatDateForCheck(new Date(), website.timezone) },
    ];
    if (sslCertificate.error) {
      facts.push({ title: "Error", value: sslCertificate.error });
    }
    if (sslCertificate.daysUntilExpiry !== undefined) {
      facts.push({ title: "Expires in", value: `${sslCertificate.daysUntilExpiry} days` });
    }

    payload = {
      type: "message",
      summary: summaryText,
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: [
            {
              type: "Container",
              style: containerStyle,
              items: [
                {
                  type: "TextBlock",
                  text: summaryText,
                  weight: "Bolder",
                  size: "Medium",
                  wrap: true,
                },
              ],
            },
            {
              type: "FactSet",
              facts,
            },
          ],
        },
      }],
    };
  } else {
    const emoji = eventType === 'ssl_error' ? '🔒' : '⚠️';
    const statusText = eventType === 'ssl_error' ? 'SSL ERROR' : 'SSL WARNING';

    payload = {
      event: eventType,
      summary: `${emoji} ${website.name} - ${statusText}`,
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

    // Consume response body to release the connection back to the pool
    const body = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
    }

  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ============================================================================
// TEST HOOKS (exported for testing)
// ============================================================================

// Expose createWebhookRetryRecord for test hooks
export { createWebhookRetryRecord };
