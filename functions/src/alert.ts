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

// ── System-level health gate ────────────────────────────────────────
// Detects infrastructure-wide failures (VPS outage, network issues) by
// tracking the rate of UP→DOWN transitions across ALL checks. If too many
// unique checks flip DOWN in a short window, all alerting is suppressed
// to prevent mass false-alert spam. Monitors keep running — only
// notifications are paused.
//
// Also enforces a startup grace period: after process restart, all alerts
// are suppressed for STARTUP_GRACE_MS to let checks establish baseline
// state before firing notifications. This prevents false alerts caused
// by stale in-memory state after deployment.

const PROCESS_START_TIME = Date.now();
let startupGraceLogged = false;
let startupGraceCleared = false;

interface SystemHealthGateState {
  /** Map of checkId → timestamp when it flipped UP→DOWN */
  downFlips: Map<string, number>;
  /** When the gate tripped (null = open / healthy) */
  trippedAt: number | null;
  /** Whether operator has been notified for this trip */
  notified: boolean;
}

const systemHealthGate: SystemHealthGateState = {
  downFlips: new Map(),
  trippedAt: null,
  notified: false,
};

/**
 * Record a status transition. Only UP→DOWN flips are tracked.
 * Called from triggerAlert before the suppression check so the gate
 * always has an accurate picture of what's happening.
 */
function recordStatusTransition(checkId: string, oldStatus: string, newStatus: string): void {
  const wasUp = oldStatus === 'online' || oldStatus === 'UP' || oldStatus === 'REDIRECT';
  const isDown = newStatus === 'offline' || newStatus === 'DOWN' || newStatus === 'REACHABLE_WITH_ERROR';
  if (wasUp && isDown) {
    systemHealthGate.downFlips.set(checkId, Date.now());
  }
}

/**
 * Check whether the system health gate is tripped.
 * Returns true if alerts should be SUPPRESSED.
 */
function isSystemHealthGateTripped(): boolean {
  const now = Date.now();

  // Startup grace period: suppress all alerts for the first N seconds after
  // process start. This prevents false alerts from stale in-memory state
  // (empty status buffer, empty webhook throttle) after deployment restart.
  if (now - PROCESS_START_TIME < CONFIG.SYSTEM_HEALTH_GATE_STARTUP_GRACE_MS) {
    if (!startupGraceLogged) {
      startupGraceLogged = true;
      logger.info(`Startup grace period active: suppressing all alerts for ${CONFIG.SYSTEM_HEALTH_GATE_STARTUP_GRACE_MS / 1000}s after process start`);
    }
    return true;
  }

  // When grace ends, clear any DOWN flips that accumulated during the grace
  // period. Without this, restart-induced false failures could immediately
  // trip the threshold gate, extending suppression by another 10 minutes.
  if (!startupGraceCleared) {
    startupGraceCleared = true;
    systemHealthGate.downFlips.clear();
  }

  // If currently tripped, check if cooldown has expired
  if (systemHealthGate.trippedAt) {
    if (now - systemHealthGate.trippedAt < CONFIG.SYSTEM_HEALTH_GATE_COOLDOWN_MS) {
      return true; // Still in cooldown — suppress
    }
    // Cooldown expired — reset
    systemHealthGate.trippedAt = null;
    systemHealthGate.notified = false;
    systemHealthGate.downFlips.clear();
    return false;
  }

  // Evict flips outside the rolling window
  const windowStart = now - CONFIG.SYSTEM_HEALTH_GATE_WINDOW_MS;
  for (const [checkId, ts] of systemHealthGate.downFlips) {
    if (ts < windowStart) systemHealthGate.downFlips.delete(checkId);
  }

  // Check if threshold exceeded
  if (systemHealthGate.downFlips.size >= CONFIG.SYSTEM_HEALTH_GATE_THRESHOLD) {
    systemHealthGate.trippedAt = now;
    logger.warn(
      `SYSTEM HEALTH GATE TRIPPED: ${systemHealthGate.downFlips.size} unique checks flipped DOWN ` +
      `in ${CONFIG.SYSTEM_HEALTH_GATE_WINDOW_MS / 1000}s. ` +
      `Suppressing ALL alerts for ${CONFIG.SYSTEM_HEALTH_GATE_COOLDOWN_MS / 60000} minutes.`
    );
    return true;
  }

  return false;
}

/**
 * Send a one-time operator notification when the gate trips.
 * Fire-and-forget — failure to send should never block alerting logic.
 */
function maybeNotifyOperator(): void {
  if (!systemHealthGate.trippedAt || systemHealthGate.notified) return;
  systemHealthGate.notified = true;

  const operatorEmail = CONFIG.SYSTEM_HEALTH_GATE_OPERATOR_EMAIL;
  if (!operatorEmail) return;

  try {
    const { resend, fromAddress } = helpers.getResendClient();
    const flippedCount = systemHealthGate.downFlips.size;
    const windowSec = CONFIG.SYSTEM_HEALTH_GATE_WINDOW_MS / 1000;
    const cooldownMin = CONFIG.SYSTEM_HEALTH_GATE_COOLDOWN_MS / 60000;

    resend.emails.send({
      from: fromAddress,
      to: operatorEmail,
      subject: `[exit1] System health gate tripped — ${flippedCount} checks DOWN`,
      html: `
        <div style="font-family:monospace;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
          <h2 style="margin:0 0 12px 0;color:#f87171">System Health Gate Tripped</h2>
          <p><strong>${flippedCount}</strong> unique checks flipped UP→DOWN within <strong>${windowSec}s</strong>.</p>
          <p>All user notifications are <strong>suppressed for ${cooldownMin} minutes</strong>.</p>
          <p>Monitors continue running and recording data — only alerts are paused.</p>
          <p style="margin-top:16px;color:#94a3b8">This usually indicates a VPS outage, network issue, or system-wide infrastructure problem. Investigate the VPS runner and network connectivity.</p>
        </div>
      `,
    }).catch(err => logger.warn('Failed to send system health gate operator notification:', err));
  } catch (err) {
    logger.warn('Failed to send system health gate operator notification:', err);
  }
}

/** Expose gate status for testing and observability. */
export function getSystemHealthGateStatus(): {
  tripped: boolean; reason: 'startup_grace' | 'threshold' | null;
  downFlipCount: number; trippedAt: number | null;
} {
  const now = Date.now();
  const inGrace = now - PROCESS_START_TIME < CONFIG.SYSTEM_HEALTH_GATE_STARTUP_GRACE_MS;
  const inCooldown = systemHealthGate.trippedAt !== null &&
    (now - systemHealthGate.trippedAt) < CONFIG.SYSTEM_HEALTH_GATE_COOLDOWN_MS;
  return {
    tripped: inGrace || inCooldown,
    reason: inGrace ? 'startup_grace' : inCooldown ? 'threshold' : null,
    downFlipCount: systemHealthGate.downFlips.size,
    trippedAt: systemHealthGate.trippedAt,
  };
}

/**
 * Post-grace confirmation window: the brief period right after the startup
 * grace ends. During this window, status changes should be recorded but
 * alerts deferred — each check gets one more cycle to confirm the transition
 * isn't a deployment artifact or transient blip.
 *
 * Timeline: [process start] --grace (5m)--> [grace ends] --post-grace (3m)--> [normal]
 */
const postGraceConfirmedChecks = new Set<string>();

export function isInPostGraceConfirmation(checkId?: string): boolean {
  const elapsed = Date.now() - PROCESS_START_TIME;
  const graceEnd = CONFIG.SYSTEM_HEALTH_GATE_STARTUP_GRACE_MS;
  const postGraceEnd = graceEnd + CONFIG.SYSTEM_HEALTH_GATE_POST_GRACE_MS;

  // Still in main grace period or past the post-grace window
  if (elapsed < graceEnd || elapsed >= postGraceEnd) {
    if (elapsed >= postGraceEnd && postGraceConfirmedChecks.size > 0) {
      postGraceConfirmedChecks.clear();
    }
    return false;
  }

  // In post-grace window: return true only if this check hasn't been confirmed yet
  if (checkId && postGraceConfirmedChecks.has(checkId)) {
    return false; // Already ran once in post-grace — confirmed, allow alerts
  }
  return true;
}

/**
 * Mark a check as having completed its first post-grace run.
 * The next time it's checked, isInPostGraceConfirmation will return false
 * and alerts will fire normally if there's a real status change.
 */
export function markPostGraceConfirmed(checkId: string): void {
  postGraceConfirmedChecks.add(checkId);
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

  // System health gate: only record REAL status transitions, not email/SMS retries.
  // Retries always set skipWebhooks: true to avoid duplicate webhook delivery —
  // that flag reliably distinguishes retries from genuine new transitions.
  if (!options?.skipWebhooks) {
    recordStatusTransition(website.id, oldStatus, newStatus);
  }
  if (isSystemHealthGateTripped()) {
    maybeNotifyOperator();
    return { delivered: false, reason: 'system_health_gate' };
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
                    await emailModule.sendEmailNotification(recipient, website, eventType, oldStatus, emailSettings.emailFormat || 'html');
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
): Promise<{ delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' | 'maintenance_mode' | 'system_health_gate' }> {
  // Suppress all alerts during maintenance mode
  if (website.maintenanceMode) {
    return { delivered: false, reason: 'maintenance_mode' };
  }

  // System health gate: suppress if infrastructure is failing
  // (SSL alerts don't record transitions — only status alerts contribute to the gate)
  if (isSystemHealthGateTripped()) {
    maybeNotifyOperator();
    return { delivered: false, reason: 'system_health_gate' };
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
                    await emailModule.sendSSLEmailNotification(recipient, website, eventType, sslCertificate, emailSettings.emailFormat || 'html');
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
