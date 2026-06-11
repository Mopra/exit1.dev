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
import { decideSSLAlertTransition, type SSLAlertState } from './ssl-alert-state';

// Re-exported so external consumers can `import { SSLAlertState } from './alert'`.
export type { SSLAlertState } from './ssl-alert-state';

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
// tracking UP→DOWN transitions across all checks and tripping when too many
// DISTINCT USERS see flips in a short window. Counting distinct users
// (not distinct checks) is what separates an exit1-side fault — which hits
// many unrelated accounts at once — from a single customer's own outage,
// which lights up many of THEIR checks but only one owner.
//
// Restart artifacts (cold-start blips, in-memory state warm-up after deploy)
// are handled separately at the check level via the deploy-mode baseline:
// admins enable deploy_mode before deploying, the dispatcher pauses checks,
// and the first probe of each check after deploy_mode lifts silently re-
// establishes the baseline without alerting (see processOneCheck).

interface DownFlipEntry {
  ts: number;
  /** Owning user. Falls back to the entry's checkId when no userId is
   *  available, so the entry still counts as exactly one "owner". */
  userId: string;
}

interface SystemHealthGateState {
  /** Map of checkId → {ts, userId} for the last UP→DOWN flip of that check.
   *  Keyed by checkId so repeated flips of the same check collapse and the
   *  rolling-window eviction can walk entries by timestamp. */
  downFlips: Map<string, DownFlipEntry>;
  /** When the gate tripped (null = open / healthy) */
  trippedAt: number | null;
  /** Whether operator has been notified for this trip */
  notified: boolean;
  /** Snapshot of the trip stats at the moment the gate tripped, so the
   *  operator notification reports what tripped it — not whatever has
   *  accumulated since (entries continue to be recorded during cooldown). */
  lastTripStats: { distinctUsers: number; totalChecks: number } | null;
}

const systemHealthGate: SystemHealthGateState = {
  downFlips: new Map(),
  trippedAt: null,
  notified: false,
  lastTripStats: null,
};

/**
 * Record a status transition. Only UP→DOWN flips are tracked.
 * Called from triggerAlert before the suppression check so the gate
 * always has an accurate picture of what's happening.
 *
 * `userId` is the owning user for the check. If absent/empty, we fall back
 * to keying the entry's owner by its checkId so the entry still counts as
 * exactly one owner — never crashes, never drops the entry.
 */
function recordStatusTransition(
  checkId: string,
  userId: string | undefined | null,
  oldStatus: string,
  newStatus: string,
): void {
  const wasUp = oldStatus === 'online' || oldStatus === 'UP' || oldStatus === 'REDIRECT';
  const isDown = newStatus === 'offline' || newStatus === 'DOWN' || newStatus === 'REACHABLE_WITH_ERROR';
  if (!(wasUp && isDown)) return;
  let owner: string;
  if (typeof userId === 'string' && userId.length > 0) {
    owner = userId;
  } else {
    owner = checkId;
    logger.warn(
      `recordStatusTransition: missing userId for check ${checkId}; ` +
      `keying owner by checkId — entry still counts as one user for the system health gate.`
    );
  }
  systemHealthGate.downFlips.set(checkId, { ts: Date.now(), userId: owner });
}

/**
 * Check whether the system health gate is tripped (threshold-based: too many
 * DISTINCT USERS see UP→DOWN flips in a short window, indicating a
 * system-wide outage). Returns true if alerts should be SUPPRESSED.
 */
function isSystemHealthGateTripped(): boolean {
  const now = Date.now();

  // If currently tripped, check if cooldown has expired
  if (systemHealthGate.trippedAt) {
    if (now - systemHealthGate.trippedAt < CONFIG.SYSTEM_HEALTH_GATE_COOLDOWN_MS) {
      return true; // Still in cooldown — suppress
    }
    // Cooldown expired — reset
    systemHealthGate.trippedAt = null;
    systemHealthGate.notified = false;
    systemHealthGate.lastTripStats = null;
    systemHealthGate.downFlips.clear();
    return false;
  }

  // Evict flips outside the rolling window
  const windowStart = now - CONFIG.SYSTEM_HEALTH_GATE_WINDOW_MS;
  for (const [checkId, entry] of systemHealthGate.downFlips) {
    if (entry.ts < windowStart) systemHealthGate.downFlips.delete(checkId);
  }

  // Count DISTINCT users among surviving entries.
  const distinctUsers = new Set<string>();
  for (const entry of systemHealthGate.downFlips.values()) {
    distinctUsers.add(entry.userId);
  }

  if (distinctUsers.size >= CONFIG.SYSTEM_HEALTH_GATE_USER_THRESHOLD) {
    const totalChecks = systemHealthGate.downFlips.size;
    systemHealthGate.trippedAt = now;
    systemHealthGate.lastTripStats = { distinctUsers: distinctUsers.size, totalChecks };
    logger.warn(
      `SYSTEM HEALTH GATE TRIPPED: ${distinctUsers.size} distinct users / ${totalChecks} checks DOWN ` +
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
    // Prefer the snapshot captured at trip time; fall back to live counts
    // for robustness if the snapshot is somehow missing.
    const distinctUsers = systemHealthGate.lastTripStats?.distinctUsers
      ?? new Set(Array.from(systemHealthGate.downFlips.values(), e => e.userId)).size;
    const totalChecks = systemHealthGate.lastTripStats?.totalChecks
      ?? systemHealthGate.downFlips.size;
    const windowSec = CONFIG.SYSTEM_HEALTH_GATE_WINDOW_MS / 1000;
    const cooldownMin = CONFIG.SYSTEM_HEALTH_GATE_COOLDOWN_MS / 60000;

    resend.emails.send({
      from: fromAddress,
      to: operatorEmail,
      subject: `[exit1] System health gate tripped — ${distinctUsers} distinct users / ${totalChecks} checks DOWN`,
      html: `
        <div style="font-family:monospace;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
          <h2 style="margin:0 0 12px 0;color:#f87171">System Health Gate Tripped</h2>
          <p><strong>${distinctUsers}</strong> distinct users (across <strong>${totalChecks}</strong> checks) saw UP→DOWN flips within <strong>${windowSec}s</strong>.</p>
          <p>All user notifications are <strong>suppressed for ${cooldownMin} minutes</strong>.</p>
          <p>Monitors continue running and recording data — only alerts are paused.</p>
          <p style="margin-top:16px;color:#94a3b8">Distinct-user counting is the signal for an exit1-wide fault. A single customer's own outage will hit many of THEIR checks but only one owner — it should not trip the gate. If this fired, investigate the VPS runner and network connectivity.</p>
        </div>
      `,
    }).catch(err => logger.warn('Failed to send system health gate operator notification:', err));
  } catch (err) {
    logger.warn('Failed to send system health gate operator notification:', err);
  }
}

/** Expose gate status for testing and observability. */
export function getSystemHealthGateStatus(): {
  tripped: boolean; reason: 'threshold' | null;
  /** Total check entries currently in the gate's rolling window. */
  downFlipCount: number;
  /** Distinct users among the current downFlip entries — the value compared
   *  against SYSTEM_HEALTH_GATE_USER_THRESHOLD. */
  distinctUserCount: number;
  trippedAt: number | null;
} {
  const now = Date.now();
  const inCooldown = systemHealthGate.trippedAt !== null &&
    (now - systemHealthGate.trippedAt) < CONFIG.SYSTEM_HEALTH_GATE_COOLDOWN_MS;
  const distinctUsers = new Set<string>();
  for (const entry of systemHealthGate.downFlips.values()) distinctUsers.add(entry.userId);
  return {
    tripped: inCooldown,
    reason: inCooldown ? 'threshold' : null,
    downFlipCount: systemHealthGate.downFlips.size,
    distinctUserCount: distinctUsers.size,
    trippedAt: systemHealthGate.trippedAt,
  };
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
  options?: { skipWebhooks?: boolean; skipEmail?: boolean; skipSms?: boolean }
): Promise<helpers.AlertResult> {
  // Suppress all alerts during maintenance mode
  if (website.maintenanceMode) {
    return { delivered: false, reason: 'maintenance_mode' };
  }

  // System health gate: only record REAL status transitions, not email/SMS retries.
  // Retries always set skipWebhooks: true to avoid duplicate webhook delivery —
  // that flag reliably distinguishes retries from genuine new transitions.
  if (!options?.skipWebhooks) {
    recordStatusTransition(website.id, website.userId, oldStatus, newStatus);
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
      // Channel skip — used by SMS-only retries so an already-delivered email
      // is not re-sent on the follow-up probe (would duplicate the alert).
      if (options?.skipEmail) {
        emailOutcome = 'skipped';
        return { delivered: false, reason: 'none' as const };
      }
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
      // Channel skip — used by email-only retries so an already-delivered SMS
      // is not re-sent on the follow-up probe (would duplicate the alert).
      const smsSettings = options?.skipSms ? null : (settings.sms || null);
      const smsTier = await helpers.resolveSmsTier(website);

      // SMS is enabled for tiers whose TIER_LIMITS.smsAlerts flag is true (Pro, Agency).
      // 'nano' and 'free' resolve to no SMS; legacy 'scale' was migrated to 'agency' in resolveSmsTier.
      if (options?.skipSms) {
        smsOutcome = 'skipped';
      } else if (smsTier !== 'pro' && smsTier !== 'agency') {
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
      const errSuffix = website.lastError ? ` err="${String(website.lastError).slice(0, 160)}"` : '';
      const codeSuffix = typeof website.lastStatusCode === 'number' ? ` code=${website.lastStatusCode}` : '';
      logger.info(`ALERT: ${website.name} ${oldStatus}->${newStatus} (${eventType})${codeSuffix}${errSuffix} wh=${webhookStats.sent}/${webhookStats.queued}/${webhookStats.skipped} email=${emailOutcome} sms=${smsOutcome}`);
    }

    // Per-channel retry flags: email/SMS may need retry even if webhooks succeeded.
    // The caller consumes BOTH independently — emailNeedsRetry drives
    // pendingUp/DownEmail and smsNeedsRetry drives pendingUp/DownSms — so a
    // transition that satisfies one channel but defers the other (different
    // minConsecutiveEvents per channel) doesn't drop the still-pending one.
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

export type SSLAlertResult = {
  delivered: boolean;
  reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' | 'maintenance_mode' | 'system_health_gate';
  // The value the caller should persist to check.sslAlertedState. Undefined
  // means "leave it unchanged" — e.g. nothing was delivered and no recent alert
  // exists, so the transition must be retried on the next evaluation. Set only
  // when we are confident the user has been (or just was) notified of the
  // current state, or when the cert returned to 'ok'.
  nextAlertedState?: SSLAlertState;
};

export async function triggerSSLAlert(
  website: Website,
  sslCertificate: helpers.SSLCertificateData,
  context?: helpers.AlertContext
): Promise<SSLAlertResult> {
  // Suppress all alerts during maintenance mode. Do NOT advance sslAlertedState,
  // so the transition is re-evaluated (and alerted) once maintenance ends.
  if (website.maintenanceMode) {
    return { delivered: false, reason: 'maintenance_mode' };
  }

  // System health gate: suppress if infrastructure is failing. Leave
  // sslAlertedState untouched so we retry once the gate clears.
  if (isSystemHealthGateTripped()) {
    maybeNotifyOperator();
    return { delivered: false, reason: 'system_health_gate' };
  }

  try {
    // Compare the freshly computed cert state against the DURABLE last-alerted
    // state (not a transient previous cert snapshot). This is what guarantees an
    // ok->warning edge is detected exactly once, regardless of which writer
    // recomputed the cert or whether the cert object was reused while "fresh".
    const currentState = helpers.getSSLAlertState(sslCertificate);
    const previousState: SSLAlertState = website.sslAlertedState ?? 'ok';
    const decision = decideSSLAlertTransition(currentState, previousState);

    // No change since we last notified — nothing to do.
    if (decision.kind === 'noop') {
      return { delivered: false, reason: 'none' };
    }

    // Certificate returned to a healthy state (renewed/fixed). We don't alert on
    // recovery, but we MUST record the reset so a future re-entry into
    // warning/error fires again.
    if (decision.kind === 'reset') {
      return { delivered: false, reason: 'none', nextAlertedState: 'ok' };
    }

    const eventType: WebhookEvent = decision.eventType;

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

      // SMS is enabled for tiers whose TIER_LIMITS.smsAlerts flag is true (Pro, Agency).
      // 'nano' and 'free' resolve to no SMS; legacy 'scale' was migrated to 'agency' in resolveSmsTier.
      if (smsTier !== 'pro' && smsTier !== 'agency') {
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

    // Advance the durable alert state only when we're confident the user has
    // been notified of `currentState`: either we delivered an alert now, or a
    // recent alert for this check+event was throttled (one already went out —
    // e.g. from the scheduled refresh writer racing the per-check probe).
    // Otherwise leave it unchanged so the transition is retried next cycle —
    // that is what makes a missed warning impossible rather than merely unlikely.
    const recentlyNotified = emailOutcome === 'throttle' || smsOutcome === 'throttle';
    const nextAlertedState: SSLAlertState | undefined =
      (anythingDelivered || recentlyNotified) ? currentState : undefined;

    return { ...emailResult, nextAlertedState };
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
  recordStatusTransition,
  isSystemHealthGateTripped,
  resetSystemHealthGate: (): void => {
    systemHealthGate.downFlips.clear();
    systemHealthGate.trippedAt = null;
    systemHealthGate.notified = false;
    systemHealthGate.lastTripStats = null;
  },
};
