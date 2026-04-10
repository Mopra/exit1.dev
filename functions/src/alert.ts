/**
 * Alert system entry point.
 *
 * This module orchestrates status and SSL alerts by coordinating webhooks,
 * email, and SMS delivery through the extracted sub-modules:
 *
 *   alert-helpers.ts   – shared types, constants, utilities, caches
 *   alert-throttle.ts  – per-check/per-user throttle & budget guards
 *   alert-webhook.ts   – webhook dispatch, retry queue, health tracking
 *   alert-email.ts     – email notifications (status, SSL, limit-reached)
 *   alert-sms.ts       – SMS notifications (status, SSL)
 *   alert-domain.ts    – domain intelligence alerts
 *
 * All public exports are re-exported here so existing consumers
 * (`import { ... } from './alert'`) continue to work unchanged.
 */

import * as logger from "firebase-functions/logger";
import { Website, WebhookEvent } from './types';

// ── Namespace imports for internal use ─────────────────────────────

import * as helpers from './alert-helpers';
import * as webhookModule from './alert-webhook';
import * as emailModule from './alert-email';
import * as smsModule from './alert-sms';
import { CONFIG } from './config';

// ── In-memory webhook throttle ──────────────────────────────────────
// Prevents alert storms from flapping checks. Keyed by `checkId__eventType`.
// Emails/SMS have Firestore-backed throttles; webhooks had none, causing
// hundreds of alerts when a check rapidly toggles DOWN→UP→DOWN.
const webhookThrottle = new Map<string, number>();

// Periodic cleanup of stale entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of webhookThrottle) {
    if (now - ts > 24 * 60 * 60 * 1000) webhookThrottle.delete(key);
  }
}, 5 * 60 * 1000);

function isWebhookThrottled(checkId: string, eventType: string): boolean {
  const key = `${checkId}__${eventType}`;
  const windowMs = CONFIG.WEBHOOK_THROTTLE_WINDOWS[eventType] ?? CONFIG.WEBHOOK_THROTTLE_DEFAULT_MS;
  const lastSent = webhookThrottle.get(key);
  const now = Date.now();
  if (lastSent && now - lastSent < windowMs) return true;
  webhookThrottle.set(key, now);
  return false;
}

// ── Per-user alert circuit breaker ──────────────────────────────────
// Safety net: if a user receives too many alerts in a short window,
// trip the breaker and suppress ALL alerts until cooldown expires.
// This catches systemic issues (VPS network problems, bugs) that would
// otherwise spam users with hundreds of false alerts.

interface CircuitBreakerState {
  /** Recent alert timestamps (rolling window) */
  timestamps: number[];
  /** When the breaker tripped (null = not tripped) */
  trippedAt: number | null;
  /** Whether we already sent the "alerts paused" email for this trip */
  notified: boolean;
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

// Periodic cleanup of idle breakers (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  const maxAge = CONFIG.ALERT_CIRCUIT_BREAKER_COOLDOWN_MS * 2;
  for (const [userId, state] of circuitBreakers) {
    const lastActivity = state.trippedAt ?? state.timestamps[state.timestamps.length - 1] ?? 0;
    if (now - lastActivity > maxAge) circuitBreakers.delete(userId);
  }
}, 10 * 60 * 1000);

/**
 * Check and update the per-user circuit breaker.
 * Returns true if the alert should be SUPPRESSED.
 */
function isCircuitBreakerTripped(userId: string): boolean {
  const now = Date.now();
  let state = circuitBreakers.get(userId);

  if (!state) {
    state = { timestamps: [now], trippedAt: null, notified: false };
    circuitBreakers.set(userId, state);
    return false;
  }

  // If currently tripped, check if cooldown has expired
  if (state.trippedAt) {
    if (now - state.trippedAt < CONFIG.ALERT_CIRCUIT_BREAKER_COOLDOWN_MS) {
      return true; // Still in cooldown — suppress
    }
    // Cooldown expired — reset the breaker
    state.trippedAt = null;
    state.notified = false;
    state.timestamps = [now];
    return false;
  }

  // Evict timestamps outside the rolling window
  const windowStart = now - CONFIG.ALERT_CIRCUIT_BREAKER_WINDOW_MS;
  state.timestamps = state.timestamps.filter(t => t >= windowStart);
  state.timestamps.push(now);

  // Check if threshold exceeded
  if (state.timestamps.length > CONFIG.ALERT_CIRCUIT_BREAKER_THRESHOLD) {
    state.trippedAt = now;
    logger.warn(`CIRCUIT BREAKER TRIPPED for user ${userId}: ${state.timestamps.length} alerts in ${CONFIG.ALERT_CIRCUIT_BREAKER_WINDOW_MS / 1000}s window. Suppressing all alerts for ${CONFIG.ALERT_CIRCUIT_BREAKER_COOLDOWN_MS / 60000} minutes.`);
    return true;
  }

  return false;
}

/**
 * If the breaker just tripped and we haven't notified yet, send a
 * one-time "alerts paused" email. Fire-and-forget.
 */
function maybeNotifyCircuitBreaker(userId: string, tier: 'free' | 'nano' | 'scale'): void {
  const state = circuitBreakers.get(userId);
  if (!state?.trippedAt || state.notified) return;
  state.notified = true;

  // Fire-and-forget: send notification email
  emailModule.sendAlertsPausedEmail(userId, tier, CONFIG.ALERT_CIRCUIT_BREAKER_COOLDOWN_MS)
    .catch(err => logger.warn('Failed to send circuit breaker notification:', err));
}

// ── Re-export everything for external consumers ────────────────────
// Using `export { X } from '...'` so names are available to importers
// of this module without conflicting with the namespace imports above.

// Types & interfaces
export type {
  AlertSettingsCache,
  AlertContext,
  AlertResult,
  SSLCertificateData,
  DeliveryFailureMeta as AlertDeliveryFailureMeta,
} from './alert-helpers';

// Helpers
export {
  resolveAlertSettings,
  fetchAlertSettingsFromFirestore,
  filterWebhooksForEvent,
  getSSLAlertState,
  resolvePerFolder,
  getEmailRecipientsForCheck,
  getEmailRecipients,
  getSmsRecipients,
  formatDateForCheck,
  formatDateOnlyForCheck,
  formatStatusCode,
  calculateDeliveryBackoff,
  evaluateDeliveryState,
  recordDeliveryFailure,
  markDeliverySuccess,
  createWebhookDeliveryId,
} from './alert-helpers';

// Throttle / budget
export {
  enableDeferredBudgetWrites,
  disableDeferredBudgetWrites,
  flushDeferredBudgetWrites,
} from './alert-throttle';

// Webhook
export {
  drainQueuedWebhookRetries,
  dispatchWebhooks,
  sendWebhook,
  sendSSLWebhook,
} from './alert-webhook';

// Email
export {
  sendEmailNotification,
  sendSSLEmailNotification,
  deliverEmailAlert,
  sendLimitReachedEmail,
} from './alert-email';

// SMS
export {
  sendSmsNotification,
  sendSslSmsNotification,
  sendSmsMessage,
  deliverSmsAlert,
} from './alert-sms';

// Domain
export {
  triggerDomainAlert,
  triggerDomainRenewalAlert,
} from './alert-domain';

// DNS
export {
  triggerDnsRecordAlert,
  triggerDnsResolutionFailedAlert,
} from './alert-dns';

// ============================================================================
// TRIGGER STATUS ALERT
// ============================================================================

export async function triggerAlert(
  website: Website,
  oldStatus: string,
  newStatus: string,
  counters?: { consecutiveFailures?: number; consecutiveSuccesses?: number },
  context?: helpers.AlertContext,
  options?: { skipWebhooks?: boolean }
): Promise<helpers.AlertResult> {
  // Suppress all alerts during maintenance mode
  if (website.maintenanceMode) {
    return { delivered: false, reason: 'maintenance_mode' };
  }

  // Circuit breaker: suppress ALL alerts if this user is being spammed
  if (isCircuitBreakerTripped(website.userId)) {
    const tier = (website.userTier as 'free' | 'nano' | 'scale') || 'free';
    maybeNotifyCircuitBreaker(website.userId, tier);
    return { delivered: false, reason: 'none' };
  }

  try {
    // NOTE: Do NOT enrich website from statusUpdateBuffer here.
    // triggerAlert is called BEFORE addStatusUpdate writes the current check result to the buffer,
    // so the buffer contains STALE data from a previous scheduler cycle. Reading it would overwrite
    // the fresh check result data (detailedStatus, lastStatusCode, lastError) already set by the caller,
    // causing false alerts (e.g. "IS DOWN" email with body showing "Current Status: UP").

    // Summary counters for single end-of-function log
    let webhookStats = { sent: 0, queued: 0, skipped: 0 };
    let emailOutcome: string = 'none';
    let smsOutcome: string = 'none';

    // Determine webhook event type using the verified status
    const isOnline = newStatus === 'online' || newStatus === 'UP' || newStatus === 'REDIRECT';
    const isOffline = newStatus === 'offline' || newStatus === 'DOWN' || newStatus === 'REACHABLE_WITH_ERROR';
    const wasOffline = oldStatus === 'offline' || oldStatus === 'DOWN' || oldStatus === 'REACHABLE_WITH_ERROR';
    const wasOnline = oldStatus === 'online' || oldStatus === 'UP' || oldStatus === 'REDIRECT';

    let eventType: WebhookEvent;

    // DNS checks: use standard website_down / website_up so webhooks configured
    // for those events fire correctly. DNS-specific events (dns_record_changed,
    // dns_resolution_failed) are sent separately via triggerDnsRecordAlert.
    if (website.type === 'dns') {
      if (isOffline) {
        eventType = 'website_down';
      } else if (isOnline && wasOffline) {
        eventType = 'website_up';
      } else {
        return { delivered: false, reason: 'none' };
      }
    } else if (isOffline) {
      eventType = 'website_down';
    } else if (isOnline && wasOffline) {
      eventType = 'website_up';
    } else if (isOnline && !wasOnline) {
      eventType = 'website_up';
    } else {
      return { delivered: false, reason: 'none' };
    }

    const settings = await helpers.resolveAlertSettings(website.userId, context);
    const allWebhooks = settings.webhooks || [];
    const webhooks = helpers.filterWebhooksForEvent(allWebhooks, eventType, website.id, website.folder);

    if (allWebhooks.length > 0 && webhooks.length !== allWebhooks.length) {
      logger.info(`Webhook filter: ${allWebhooks.length} total, ${webhooks.length} matched for ${eventType} on ${website.name} (id=${website.id})`);
    }

    if (webhooks.length > 0 && !options?.skipWebhooks) {
      if (isWebhookThrottled(website.id, eventType)) {
        webhookStats = { sent: 0, queued: 0, skipped: webhooks.length };
      } else {
        webhookStats = await webhookModule.dispatchWebhooks(
          webhooks,
          webhook => webhookModule.sendWebhook(webhook, website, eventType, oldStatus),
          { website, eventType, channel: 'status', previousStatus: oldStatus }
        );
      }
    }

    const emailResult: { delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' } = await (async () => {
      try {
        const emailSettings = settings.email || null;

        if (emailSettings) {
          // Get combined recipients (global + per-check + per-folder) for this specific check
          const emailRecipients = helpers.getEmailRecipientsForCheck(emailSettings, website.id, website.folder);
          if (emailRecipients.length > 0 && emailSettings.enabled !== false) {
            const globalAllows = (emailSettings.events || []).includes(eventType);
            const perCheck = emailSettings.perCheck?.[website.id];
            // Explicitly check if perCheck entry exists and has enabled property
            const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
            const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

            // Folder-level fallback: if no perCheck entry, check perFolder
            const perFolder = !perCheck ? helpers.resolvePerFolder(emailSettings, website.folder) : undefined;
            const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
            const perFolderAllows = perFolder?.events ? perFolder.events.includes(eventType) : undefined;

            // Logic:
            // - perCheck takes priority: if perCheck.enabled === true, send based on perCheck/global events
            // - perCheck.enabled === false explicitly excludes (even in 'all' mode)
            // - Otherwise fall back to perFolder (same logic)
            // - If checkFilter.mode === 'all', auto-include checks with no perCheck/perFolder override
            // - Otherwise (mode 'include' or absent), don't send
            const checkFilterMode = emailSettings.checkFilter?.mode;
            const defaultEventsAllow = emailSettings.checkFilter?.defaultEvents
              ? emailSettings.checkFilter.defaultEvents.includes(eventType) : undefined;
            const shouldSend = perCheckEnabled === true
              ? (perCheckAllows ?? globalAllows)
              : perCheckEnabled === false ? false
              : perFolderEnabled === true
                ? (perFolderAllows ?? globalAllows)
                : perFolderEnabled === false ? false
                : checkFilterMode === 'all' ? (defaultEventsAllow ?? globalAllows)
                : false;

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
                emailOutcome = 'flap';
                return { delivered: false, reason: 'flap' };
              }

              // Send to all recipients (global + per-check) - throttle/budget check happens once for the alert,
              // then we send to all recipients if allowed
              const deliveryResult = await emailModule.deliverEmailAlert({
                website,
                eventType,
                context,
                send: async () => {
                  // Send to all recipients (global + per-check) with delay to avoid Resend rate limit (2 req/sec)
                  for (let i = 0; i < emailRecipients.length; i++) {
                    const recipient = emailRecipients[i];
                    if (i > 0) {
                      await new Promise(resolve => setTimeout(resolve, 600));
                    }
                    await emailModule.sendEmailNotification(recipient, website, eventType, oldStatus);
                  }
                },
              });

              if (deliveryResult === 'sent') {
                emailOutcome = 'sent';
                return { delivered: true };
              }

              if (deliveryResult === 'throttled') {
                emailOutcome = 'throttle';
                return { delivered: false, reason: 'throttle' };
              }

              emailOutcome = 'error';
              return { delivered: false, reason: 'error' };
            } else {
              emailOutcome = 'settings';
              return { delivered: false, reason: 'settings' };
            }
          } else {
            emailOutcome = 'missingRecipient';
            return { delivered: false, reason: 'missingRecipient' };
          }
        } else {
          emailOutcome = 'settings';
          return { delivered: false, reason: 'settings' };
        }
      } catch (emailError) {
        logger.error('Error processing email notifications:', emailError);
        return { delivered: false, reason: 'error' };
      }
    })();

    try {
      const smsSettings = settings.sms || null;
      const smsTier = await helpers.resolveSmsTier(website);

      if (smsTier !== 'nano') {
        smsOutcome = 'tier';
      } else if (smsSettings) {
        const smsRecipients = helpers.getSmsRecipients(smsSettings);
        if (smsRecipients.length > 0 && smsSettings.enabled !== false) {
          const globalAllows = (smsSettings.events || []).includes(eventType);
          const perCheck = smsSettings.perCheck?.[website.id];
          const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
          const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

          const perFolder = !perCheck ? helpers.resolvePerFolder(smsSettings, website.folder) : undefined;
          const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
          const perFolderAllows = perFolder?.events ? perFolder.events.includes(eventType) : undefined;

          const smsCheckFilterMode = smsSettings.checkFilter?.mode;
          const smsDefaultEventsAllow = smsSettings.checkFilter?.defaultEvents
            ? smsSettings.checkFilter.defaultEvents.includes(eventType) : undefined;
          const shouldSend = perCheckEnabled === true
            ? (perCheckAllows ?? globalAllows)
            : perCheckEnabled === false ? false
            : perFolderEnabled === true
              ? (perFolderAllows ?? globalAllows)
              : perFolderEnabled === false ? false
              : smsCheckFilterMode === 'all' ? (smsDefaultEventsAllow ?? globalAllows)
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
              smsOutcome = 'flap';
            } else {
              // Send to all recipients - throttle/budget check happens once for the alert
              const deliveryResult = await smsModule.deliverSmsAlert({
                website,
                eventType,
                context,
                smsTier,
                send: async () => {
                  // Send to all recipients, continuing even if some fail
                  const results: { recipient: string; success: boolean; error?: string }[] = [];
                  for (const recipient of smsRecipients) {
                    try {
                      await smsModule.sendSmsNotification(recipient, website, eventType, oldStatus);
                      results.push({ recipient, success: true });
                    } catch (recipientError) {
                      const errorMsg = recipientError instanceof Error ? recipientError.message : String(recipientError);
                      logger.error(`SMS failed to ${recipient} for website ${website.name}: ${errorMsg}`);
                      results.push({ recipient, success: false, error: errorMsg });
                    }
                  }
                  // If all recipients failed, throw to trigger failure tracking
                  const successCount = results.filter(r => r.success).length;
                  if (successCount === 0) {
                    const errors = results.map(r => `${r.recipient}: ${r.error}`).join('; ');
                    throw new Error(`All SMS deliveries failed: ${errors}`);
                  }
                  // Log summary if some failed
                  if (successCount < results.length) {
                    const failedRecipients = results.filter(r => !r.success).map(r => r.recipient);
                    logger.warn(`SMS partially delivered for ${website.name}: ${successCount}/${results.length} succeeded. Failed: ${failedRecipients.join(', ')}`);
                  }
                },
              });

              if (deliveryResult === 'sent') {
                smsOutcome = 'sent';
              } else if (deliveryResult === 'throttled') {
                smsOutcome = 'throttle';
              } else {
                smsOutcome = 'error';
              }
            }
          } else {
            smsOutcome = 'settings';
          }
        } else {
          smsOutcome = 'missingRecipient';
        }
      } else {
        smsOutcome = 'settings';
      }
    } catch (smsError) {
      smsOutcome = 'error';
      logger.error('Error processing SMS notifications:', smsError);
    }

    // Single summary log: only emit when something was actually delivered
    const anythingDelivered = webhookStats.sent > 0 || emailOutcome === 'sent' || smsOutcome === 'sent';
    if (anythingDelivered) {
      logger.info(`ALERT: ${website.name} ${oldStatus}->${newStatus} (${eventType}) wh=${webhookStats.sent}/${webhookStats.queued}/${webhookStats.skipped} email=${emailOutcome} sms=${smsOutcome}`);
    }

    // Per-channel retry flags: email/SMS may need retry even if webhooks succeeded.
    // These are checked independently by the caller to set pendingUpEmail/pendingDownEmail.
    const emailRetryReasons = ['flap', 'error', 'throttle'];
    const emailNeedsRetry = emailRetryReasons.includes(emailOutcome);
    const smsNeedsRetry = smsOutcome === 'flap' || smsOutcome === 'error' || smsOutcome === 'throttle';

    // Return delivered=true if ANY channel succeeded.
    // Webhooks have their own retry mechanism (queueWebhookRetry), so a full
    // alert retry (pendingUpEmail/pendingDownEmail) should only trigger when
    // ALL channels failed — otherwise webhooks get re-sent on every retry cycle.
    // However, emailNeedsRetry/smsNeedsRetry let the caller retry just email/SMS
    // without re-dispatching webhooks (via skipWebhooks option).
    if (anythingDelivered) {
      return { delivered: true, emailNeedsRetry, smsNeedsRetry };
    }
    return { ...emailResult, emailNeedsRetry, smsNeedsRetry };
  } catch (error) {
    logger.error("Error in triggerAlert:", error);
    return { delivered: false, reason: 'error' };
  }
}

// ============================================================================
// TRIGGER SSL ALERT
// ============================================================================

export async function triggerSSLAlert(
  website: Website,
  sslCertificate: helpers.SSLCertificateData,
  previousSslCertificate: helpers.SSLCertificateData | null | undefined,
  context?: helpers.AlertContext
): Promise<{ delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' | 'maintenance_mode' }> {
  // Suppress all alerts during maintenance mode
  if (website.maintenanceMode) {
    return { delivered: false, reason: 'maintenance_mode' };
  }

  // Circuit breaker: suppress ALL alerts if this user is being spammed
  if (isCircuitBreakerTripped(website.userId)) {
    const tier = (website.userTier as 'free' | 'nano' | 'scale') || 'free';
    maybeNotifyCircuitBreaker(website.userId, tier);
    return { delivered: false, reason: 'none' };
  }

  try {
    // Determine current and previous SSL alert states
    const currentState = helpers.getSSLAlertState(sslCertificate);
    const previousState = helpers.getSSLAlertState(previousSslCertificate);

    // Only alert on state changes (like online/offline logic)
    if (currentState === previousState) {
      return { delivered: false, reason: 'none' };
    }

    // Don't alert when transitioning TO 'ok' state (certificate was renewed/fixed)
    // We only want alerts for problems, not for fixes
    if (currentState === 'ok') {
      return { delivered: false, reason: 'none' };
    }

    let eventType: WebhookEvent;

    if (!sslCertificate.valid) {
      eventType = 'ssl_error';
    } else if (sslCertificate.daysUntilExpiry !== undefined && sslCertificate.daysUntilExpiry <= 30) {
      eventType = 'ssl_warning';
    } else {
      return { delivered: false, reason: 'none' };
    }

    // Summary counters for single end-of-function log
    let webhookStats = { sent: 0, queued: 0, skipped: 0 };
    let emailOutcome: string = 'none';
    let smsOutcome: string = 'none';

    const settings = await helpers.resolveAlertSettings(website.userId, context);
    const webhooks = helpers.filterWebhooksForEvent(settings.webhooks, eventType, website.id, website.folder);

    if (webhooks.length > 0) {
      if (isWebhookThrottled(website.id, eventType)) {
        webhookStats = { sent: 0, queued: 0, skipped: webhooks.length };
      } else {
        webhookStats = await webhookModule.dispatchWebhooks(
          webhooks,
          webhook => webhookModule.sendSSLWebhook(webhook, website, eventType, sslCertificate),
          { website, eventType, channel: 'ssl', sslCertificate }
        );
      }
    }

    const emailResult: { delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' } = await (async () => {
      try {
        const emailSettings = settings.email || null;

        if (emailSettings) {
          // Get combined recipients (global + per-check + per-folder) for this specific check
          const emailRecipients = helpers.getEmailRecipientsForCheck(emailSettings, website.id, website.folder);
          if (emailRecipients.length > 0 && emailSettings.enabled !== false) {
            const globalAllows = (emailSettings.events || []).includes(eventType);
            const perCheck = emailSettings.perCheck?.[website.id];
            // Explicitly check if perCheck entry exists and has enabled property
            const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
            const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

            // Folder-level fallback: if no perCheck entry, check perFolder
            const perFolder = !perCheck ? helpers.resolvePerFolder(emailSettings, website.folder) : undefined;
            const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
            const perFolderAllows = perFolder?.events ? perFolder.events.includes(eventType) : undefined;

            // Logic: perCheck > perFolder > checkFilter 'all' > don't send
            const checkFilterMode = emailSettings.checkFilter?.mode;
            const defaultEventsAllow = emailSettings.checkFilter?.defaultEvents
              ? emailSettings.checkFilter.defaultEvents.includes(eventType) : undefined;
            const shouldSend = perCheckEnabled === true
              ? (perCheckAllows ?? globalAllows)
              : perCheckEnabled === false ? false
              : perFolderEnabled === true
                ? (perFolderAllows ?? globalAllows)
                : perFolderEnabled === false ? false
                : checkFilterMode === 'all' ? (defaultEventsAllow ?? globalAllows)
                : false;

            if (shouldSend) {
              // Send to all recipients (global + per-check + per-folder) - throttle/budget check happens once for the alert
              const deliveryResult = await emailModule.deliverEmailAlert({
                website,
                eventType,
                context,
                send: async () => {
                  // Send to all recipients (global + per-check) with delay to avoid Resend rate limit (2 req/sec)
                  for (let i = 0; i < emailRecipients.length; i++) {
                    const recipient = emailRecipients[i];
                    if (i > 0) {
                      await new Promise(resolve => setTimeout(resolve, 600));
                    }
                    await emailModule.sendSSLEmailNotification(recipient, website, eventType, sslCertificate);
                  }
                },
              });

              if (deliveryResult === 'sent') {
                emailOutcome = 'sent';
                return { delivered: true };
              }

              if (deliveryResult === 'throttled') {
                emailOutcome = 'throttle';
                return { delivered: false, reason: 'throttle' };
              }

              emailOutcome = 'error';
              return { delivered: false, reason: 'error' };
            } else {
              emailOutcome = 'settings';
              return { delivered: false, reason: 'settings' };
            }
          } else {
            emailOutcome = 'missingRecipient';
            return { delivered: false, reason: 'missingRecipient' };
          }
        } else {
          emailOutcome = 'settings';
          return { delivered: false, reason: 'settings' };
        }
      } catch (emailError) {
        emailOutcome = 'error';
        logger.error('Error processing SSL email notifications:', emailError);
        return { delivered: false, reason: 'error' };
      }
    })();

    try {
      const smsSettings = settings.sms || null;
      const smsTier = await helpers.resolveSmsTier(website);

      if (smsTier !== 'nano') {
        smsOutcome = 'tier';
      } else if (smsSettings) {
        const smsRecipients = helpers.getSmsRecipients(smsSettings);
        if (smsRecipients.length > 0 && smsSettings.enabled !== false) {
          const globalAllows = (smsSettings.events || []).includes(eventType);
          const perCheck = smsSettings.perCheck?.[website.id];
          const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
          const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

          const perFolder = !perCheck ? helpers.resolvePerFolder(smsSettings, website.folder) : undefined;
          const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
          const perFolderAllows = perFolder?.events ? perFolder.events.includes(eventType) : undefined;

          const smsCheckFilterMode = smsSettings.checkFilter?.mode;
          const smsDefaultEventsAllow = smsSettings.checkFilter?.defaultEvents
            ? smsSettings.checkFilter.defaultEvents.includes(eventType) : undefined;
          const shouldSend = perCheckEnabled === true
            ? (perCheckAllows ?? globalAllows)
            : perCheckEnabled === false ? false
            : perFolderEnabled === true
              ? (perFolderAllows ?? globalAllows)
              : perFolderEnabled === false ? false
              : smsCheckFilterMode === 'all' ? (smsDefaultEventsAllow ?? globalAllows)
              : false;

          if (shouldSend) {
            // Send to all recipients - throttle/budget check happens once for the alert
            const deliveryResult = await smsModule.deliverSmsAlert({
              website,
              eventType,
              context,
              smsTier,
              send: async () => {
                // Send to all recipients, continuing even if some fail
                const results: { recipient: string; success: boolean; error?: string }[] = [];
                for (const recipient of smsRecipients) {
                  try {
                    await smsModule.sendSslSmsNotification(recipient, website, eventType, sslCertificate);
                    results.push({ recipient, success: true });
                  } catch (recipientError) {
                    const errorMsg = recipientError instanceof Error ? recipientError.message : String(recipientError);
                    logger.error(`SSL SMS failed to ${recipient} for website ${website.name}: ${errorMsg}`);
                    results.push({ recipient, success: false, error: errorMsg });
                  }
                }
                // If all recipients failed, throw to trigger failure tracking
                const successCount = results.filter(r => r.success).length;
                if (successCount === 0) {
                  const errors = results.map(r => `${r.recipient}: ${r.error}`).join('; ');
                  throw new Error(`All SSL SMS deliveries failed: ${errors}`);
                }
                // Log summary if some failed
                if (successCount < results.length) {
                  const failedRecipients = results.filter(r => !r.success).map(r => r.recipient);
                  logger.warn(`SSL SMS partially delivered for ${website.name}: ${successCount}/${results.length} succeeded. Failed: ${failedRecipients.join(', ')}`);
                }
              },
            });

            if (deliveryResult === 'sent') {
              smsOutcome = 'sent';
            } else if (deliveryResult === 'throttled') {
              smsOutcome = 'throttle';
            } else {
              smsOutcome = 'error';
            }
          } else {
            smsOutcome = 'settings';
          }
        } else {
          smsOutcome = 'missingRecipient';
        }
      } else {
        smsOutcome = 'settings';
      }
    } catch (smsError) {
      smsOutcome = 'error';
      logger.error('Error processing SSL SMS notifications:', smsError);
    }

    // Single summary log: only emit when something was actually delivered
    const anythingDelivered = webhookStats.sent > 0 || emailOutcome === 'sent' || smsOutcome === 'sent';
    if (anythingDelivered) {
      logger.info(`SSL ALERT: ${website.name} ${previousState}->${currentState} (${eventType}) wh=${webhookStats.sent}/${webhookStats.queued}/${webhookStats.skipped} email=${emailOutcome} sms=${smsOutcome}`);
    }

    return emailResult;
  } catch (error) {
    logger.error("Error in triggerSSLAlert:", error);
    return { delivered: false, reason: 'error' };
  }
}

// ============================================================================
// TEST HOOKS
// ============================================================================

export const __alertTestHooks = {
  calculateDeliveryBackoff: helpers.calculateDeliveryBackoff,
  evaluateDeliveryState: helpers.evaluateDeliveryState,
  recordDeliveryFailure: helpers.recordDeliveryFailure,
  markDeliverySuccess: helpers.markDeliverySuccess,
  createWebhookRetryRecord: webhookModule.createWebhookRetryRecord,
};
