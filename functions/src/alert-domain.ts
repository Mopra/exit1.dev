import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookEvent, EmailSettings, SmsSettings } from './types';
import { normalizeEventList } from './webhook-events';
import { firestore } from './init';
import {
  formatDateForCheck,
  formatDateOnlyForCheck,
  getResendClient,
  getEmailRecipientsForCheck,
  getSmsRecipients,
  resolvePerFolder,
  webhookAppliesToCheck,
} from './alert-helpers';
import { sendSmsMessage } from './alert-sms';

// ============================================================================
// TYPES
// ============================================================================

interface DomainAlertPayload {
  event: WebhookEvent;
  checkId: string;
  checkName: string;
  checkUrl: string;
  domain: string;
  daysUntilExpiry: number;
  expiryDate?: number;
  registrar?: string;
  threshold: number;
  timestamp: number;
}

interface DomainRenewalPayload {
  event: WebhookEvent;
  checkId: string;
  checkName: string;
  domain: string;
  oldExpiryDate?: number;
  newExpiryDate: number;
  registrar?: string;
  timestamp: number;
}

// ============================================================================
// TRIGGER DOMAIN ALERT
// ============================================================================

/**
 * Trigger domain expiry alert (used by domain-intelligence.ts)
 */
export async function triggerDomainAlert(
  check: Website,
  threshold: number,
  daysUntilExpiry: number
): Promise<void> {
  const domainExpiry = check.domainExpiry;
  if (!domainExpiry) return;

  const event: WebhookEvent = daysUntilExpiry <= 0 ? 'domain_expired' : 'domain_expiring';

  const payload: DomainAlertPayload = {
    event,
    checkId: check.id,
    checkName: check.name,
    checkUrl: check.url,
    domain: domainExpiry.domain,
    daysUntilExpiry,
    expiryDate: domainExpiry.expiryDate,
    registrar: domainExpiry.registrar,
    threshold,
    timestamp: Date.now(),
  };

  logger.info(`Triggering domain alert for ${domainExpiry.domain}`, {
    event,
    daysUntilExpiry,
    threshold
  });

  // Send webhooks
  await dispatchDomainWebhooks(check.userId, event, payload, check.id, check.folder);

  // Send email
  await sendDomainAlertEmail(check.userId, check, payload);

  // Send SMS (Nano only, domain alerts are critical)
  await sendDomainAlertSms(check.userId, check, payload);
}

// ============================================================================
// TRIGGER DOMAIN RENEWAL ALERT
// ============================================================================

/**
 * Trigger domain renewal alert
 */
export async function triggerDomainRenewalAlert(
  check: Website,
  newExpiryDate: number
): Promise<void> {
  const domainExpiry = check.domainExpiry;
  if (!domainExpiry) return;

  const event: WebhookEvent = 'domain_renewed';

  const payload: DomainRenewalPayload = {
    event,
    checkId: check.id,
    checkName: check.name,
    domain: domainExpiry.domain,
    oldExpiryDate: domainExpiry.expiryDate,
    newExpiryDate,
    registrar: domainExpiry.registrar,
    timestamp: Date.now(),
  };

  logger.info(`Triggering domain renewal alert for ${domainExpiry.domain}`, {
    oldExpiryDate: domainExpiry.expiryDate,
    newExpiryDate
  });

  // Send webhooks
  await dispatchDomainWebhooks(check.userId, event, payload, check.id, check.folder);

  // Send email (positive event)
  await sendDomainRenewalEmail(check.userId, check, payload);

  // SMS not needed for renewals (positive event)
}

// ============================================================================
// DISPATCH DOMAIN WEBHOOKS
// ============================================================================

/**
 * Dispatch domain webhooks to user's configured endpoints
 */
async function dispatchDomainWebhooks(
  userId: string,
  event: WebhookEvent,
  payload: DomainAlertPayload | DomainRenewalPayload,
  checkId: string,
  checkFolder?: string | null
): Promise<void> {
  try {
    const webhooksSnap = await firestore.collection('webhooks')
      .where('userId', '==', userId)
      .where('enabled', '==', true)
      .get();

    if (webhooksSnap.empty) return;

    const webhooks = webhooksSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() } as WebhookSettings))
      .filter(wh => {
        const events = normalizeEventList(wh.events);
        if (!events.includes(event)) return false;

        return webhookAppliesToCheck(wh, checkId, checkFolder);
      });

    await Promise.allSettled(
      webhooks.map(webhook => sendDomainWebhook(webhook, payload))
    );
  } catch (error) {
    logger.warn('Failed to dispatch domain webhooks', { error, userId });
  }
}

// ============================================================================
// SEND DOMAIN WEBHOOK
// ============================================================================

/**
 * Send domain webhook to a specific endpoint
 */
async function sendDomainWebhook(
  webhook: WebhookSettings,
  payload: DomainAlertPayload | DomainRenewalPayload
): Promise<void> {
  const isSlack = webhook.webhookType === 'slack' || webhook.url.includes('hooks.slack.com');
  const isDiscord = webhook.webhookType === 'discord' || webhook.url.includes('discord.com') || webhook.url.includes('discordapp.com');
  const isTeams = webhook.webhookType === 'teams' || webhook.url.includes('.webhook.office.com') || webhook.url.includes('.logic.azure.com');

  let body: string;

  if (isSlack) {
    const emoji = payload.event === 'domain_expired' ? '🚨' :
                  payload.event === 'domain_expiring' ? '⏰' : '🎉';
    const statusText = payload.event === 'domain_expired' ? 'EXPIRED' :
                      payload.event === 'domain_expiring' ? 'EXPIRING SOON' : 'RENEWED';

    let message = `${emoji} *Domain ${statusText}*\nDomain: ${payload.domain}`;
    if ('daysUntilExpiry' in payload) {
      message += `\nExpires in: ${payload.daysUntilExpiry} days`;
    }
    if ('newExpiryDate' in payload) {
      message += `\nNew expiry: ${new Date(payload.newExpiryDate).toLocaleDateString()}`;
    }
    message += `\nCheck: ${payload.checkName}`;

    body = JSON.stringify({ text: message });
  } else if (isDiscord) {
    const emoji = payload.event === 'domain_expired' ? '🚨' :
                  payload.event === 'domain_expiring' ? '⏰' : '🎉';
    const statusText = payload.event === 'domain_expired' ? 'EXPIRED' :
                      payload.event === 'domain_expiring' ? 'EXPIRING SOON' : 'RENEWED';

    let message = `${emoji} **Domain ${statusText}**\nDomain: ${payload.domain}`;
    if ('daysUntilExpiry' in payload) {
      message += `\nExpires in: ${payload.daysUntilExpiry} days`;
    }
    if ('newExpiryDate' in payload) {
      message += `\nNew expiry: ${new Date(payload.newExpiryDate).toLocaleDateString()}`;
    }
    message += `\nCheck: ${payload.checkName}`;

    body = JSON.stringify({ content: message });
  } else if (isTeams) {
    const emoji = payload.event === 'domain_expired' ? '🚨' :
                  payload.event === 'domain_expiring' ? '⏰' : '🎉';
    const statusText = payload.event === 'domain_expired' ? 'EXPIRED' :
                      payload.event === 'domain_expiring' ? 'EXPIRING SOON' : 'RENEWED';
    const summaryText = `${emoji} Domain ${statusText}: ${payload.domain}`;
    const containerStyle = payload.event === 'domain_expired' ? 'attention' :
                          payload.event === 'domain_expiring' ? 'warning' : 'good';

    const facts: { title: string; value: string }[] = [
      { title: "Domain", value: payload.domain },
    ];
    if ('daysUntilExpiry' in payload) {
      facts.push({ title: "Expires in", value: `${payload.daysUntilExpiry} days` });
    }
    if ('newExpiryDate' in payload) {
      facts.push({ title: "New expiry", value: new Date(payload.newExpiryDate).toLocaleDateString() });
    }
    facts.push({ title: "Check", value: payload.checkName });

    body = JSON.stringify({
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
    });
  } else {
    const emoji = payload.event === 'domain_expired' ? '🚨' :
                  payload.event === 'domain_expiring' ? '⏰' : '🎉';
    const statusText = payload.event === 'domain_expired' ? 'EXPIRED' :
                      payload.event === 'domain_expiring' ? 'EXPIRING SOON' : 'RENEWED';
    const domain = 'domain' in payload ? payload.domain : '';

    body = JSON.stringify({
      ...payload,
      summary: `${emoji} Domain ${statusText}: ${domain}`,
    });
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
      .update(body)
      .digest('hex');
    headers['X-Exit1-Signature'] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Consume response body to release the connection back to the pool
    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseBody || response.statusText}`);
    }

    logger.info(`Domain webhook delivered: ${webhook.url}`);
  } catch (error) {
    clearTimeout(timeoutId);
    logger.warn(`Domain webhook failed: ${webhook.url}`, { error });
  }
}

// ============================================================================
// SEND DOMAIN ALERT EMAIL
// ============================================================================

/**
 * Send domain expiry alert email
 */
async function sendDomainAlertEmail(
  userId: string,
  check: Website,
  payload: DomainAlertPayload
): Promise<void> {
  try {
    // Get email settings
    const emailDoc = await firestore.collection('emailSettings').doc(userId).get();
    if (!emailDoc.exists) return;

    const emailSettings = emailDoc.data() as EmailSettings;
    // Get combined recipients (global + per-check + per-folder) for this specific check
    const emailRecipients = getEmailRecipientsForCheck(emailSettings, check.id, check.folder);
    if (!emailSettings.enabled || emailRecipients.length === 0) return;

    // Domain alert filtering: respect checkFilter mode and per-check/per-folder overrides
    const globalAllows = normalizeEventList(emailSettings.events).includes(payload.event);
    const perCheck = emailSettings.perCheck?.[check.id];
    const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
    const perCheckAllows = perCheck?.events ? perCheck.events.includes(payload.event) : undefined;
    const perFolder = !perCheck ? resolvePerFolder(emailSettings, check.folder) : undefined;
    const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
    const perFolderAllows = perFolder?.events ? perFolder.events.includes(payload.event) : undefined;
    const checkFilterMode = emailSettings.checkFilter?.mode;
    const defaultEventsAllow = emailSettings.checkFilter?.defaultEvents
      ? emailSettings.checkFilter.defaultEvents.includes(payload.event) : undefined;
    // Domain alerts default to sending (true) instead of false when no override exists,
    // but still respect checkFilter 'include' mode (only send if explicitly opted in)
    const shouldSend = perCheckEnabled === false ? false
      : perCheck ? (perCheckAllows ?? globalAllows)
      : perFolderEnabled === false ? false
      : perFolder ? (perFolderAllows ?? globalAllows)
      : checkFilterMode === 'all' ? (defaultEventsAllow ?? globalAllows ?? true)
      : checkFilterMode === 'include' ? false
      : true; // No checkFilter configured — domain alerts send by default
    if (!shouldSend) return;

    const { resend, fromAddress } = getResendClient();

    const isExpired = payload.event === 'domain_expired';
    const subject = isExpired
      ? `DOMAIN EXPIRED: ${payload.domain}`
      : `Domain Expiring Soon: ${payload.domain} (${payload.daysUntilExpiry} days)`;

    const formatDate = (timestamp?: number) => formatDateOnlyForCheck(timestamp, check.timezone);

    const urgencyColor = isExpired ? '#ef4444' :
                         payload.daysUntilExpiry <= 7 ? '#f97316' :
                         payload.daysUntilExpiry <= 14 ? '#eab308' : '#3b82f6';

    const html = `
      <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
        <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
          <h2 style="margin:0 0 8px 0;color:${urgencyColor}">${isExpired ? '🚨' : '⏰'} ${subject}</h2>
          <p style="margin:0 0 12px 0;color:#94a3b8">${formatDateForCheck(new Date(), check.timezone)}</p>

          <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid ${urgencyColor}40">
            <div><strong>Domain:</strong> ${payload.domain}</div>
            <div><strong>Check:</strong> ${check.name}</div>
            <div><strong>URL:</strong> <a href="${check.url}" style="color:#38bdf8">${check.url}</a></div>
            ${payload.registrar ? `<div><strong>Registrar:</strong> ${payload.registrar}</div>` : ''}
            <div><strong>Expiry Date:</strong> ${formatDate(payload.expiryDate)}</div>
            ${!isExpired ? `<div style="font-size:18px;font-weight:bold;margin-top:8px;color:${urgencyColor}">Expires in ${payload.daysUntilExpiry} days</div>` : ''}
          </div>

          <p style="margin:16px 0 0 0;color:#94a3b8">
            ${isExpired
              ? 'Your domain has expired. Renew immediately to avoid losing it.'
              : 'Renew your domain before it expires to avoid service disruption.'}
          </p>
        </div>
      </div>
    `;

    // Send to all recipients
    for (const recipient of emailRecipients) {
      await resend.emails.send({
        from: fromAddress,
        to: recipient,
        subject,
        html,
      });
      logger.info(`Domain alert email sent to ${recipient}`);
    }
  } catch (error) {
    logger.warn('Failed to send domain alert email', { error, userId });
  }
}

// ============================================================================
// SEND DOMAIN RENEWAL EMAIL
// ============================================================================

/**
 * Send domain renewal confirmation email
 */
async function sendDomainRenewalEmail(
  userId: string,
  check: Website,
  payload: DomainRenewalPayload
): Promise<void> {
  try {
    // Get email settings
    const emailDoc = await firestore.collection('emailSettings').doc(userId).get();
    if (!emailDoc.exists) return;

    const emailSettings = emailDoc.data() as EmailSettings;
    // Get combined recipients (global + per-check + per-folder) for this specific check
    const emailRecipients = getEmailRecipientsForCheck(emailSettings, check.id, check.folder);
    if (!emailSettings.enabled || emailRecipients.length === 0) return;

    // Domain alert filtering: respect checkFilter mode and per-check/per-folder overrides
    const globalAllows = normalizeEventList(emailSettings.events).includes(payload.event);
    const perCheck = emailSettings.perCheck?.[check.id];
    const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
    const perCheckAllows = perCheck?.events ? perCheck.events.includes(payload.event) : undefined;
    const perFolder = !perCheck ? resolvePerFolder(emailSettings, check.folder) : undefined;
    const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
    const perFolderAllows = perFolder?.events ? perFolder.events.includes(payload.event) : undefined;
    const checkFilterMode = emailSettings.checkFilter?.mode;
    const defaultEventsAllow = emailSettings.checkFilter?.defaultEvents
      ? emailSettings.checkFilter.defaultEvents.includes(payload.event) : undefined;
    const shouldSend = perCheckEnabled === false ? false
      : perCheck ? (perCheckAllows ?? globalAllows)
      : perFolderEnabled === false ? false
      : perFolder ? (perFolderAllows ?? globalAllows)
      : checkFilterMode === 'all' ? (defaultEventsAllow ?? globalAllows ?? true)
      : checkFilterMode === 'include' ? false
      : true;
    if (!shouldSend) return;

    const { resend, fromAddress } = getResendClient();

    const formatDate = (timestamp?: number) => formatDateOnlyForCheck(timestamp, check.timezone);

    const subject = `Domain Renewed: ${payload.domain}`;

    const html = `
      <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
        <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
          <h2 style="margin:0 0 8px 0;color:#22c55e">🎉 Domain Renewed</h2>
          <p style="margin:0 0 12px 0;color:#94a3b8">${formatDateForCheck(new Date(), check.timezone)}</p>

          <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3)">
            <div><strong>Domain:</strong> ${payload.domain}</div>
            <div><strong>Check:</strong> ${payload.checkName}</div>
            ${payload.registrar ? `<div><strong>Registrar:</strong> ${payload.registrar}</div>` : ''}
            ${payload.oldExpiryDate ? `<div><strong>Previous Expiry:</strong> ${formatDate(payload.oldExpiryDate)}</div>` : ''}
            <div><strong>New Expiry:</strong> ${formatDate(payload.newExpiryDate)}</div>
          </div>

          <p style="margin:16px 0 0 0;color:#94a3b8">
            Your domain registration has been extended. No further action is needed.
          </p>
        </div>
      </div>
    `;

    // Send to all recipients
    for (const recipient of emailRecipients) {
      await resend.emails.send({
        from: fromAddress,
        to: recipient,
        subject,
        html,
      });
      logger.info(`Domain renewal email sent to ${recipient}`);
    }
  } catch (error) {
    logger.warn('Failed to send domain renewal email', { error, userId });
  }
}

// ============================================================================
// SEND DOMAIN ALERT SMS
// ============================================================================

/**
 * Send domain expiry alert SMS (Nano only)
 */
async function sendDomainAlertSms(
  userId: string,
  check: Website,
  payload: DomainAlertPayload
): Promise<void> {
  try {
    // Get SMS settings
    const smsDoc = await firestore.collection('smsSettings').doc(userId).get();
    if (!smsDoc.exists) return;

    const smsSettings = smsDoc.data() as SmsSettings;
    const smsRecipients = getSmsRecipients(smsSettings);
    if (!smsSettings.enabled || smsRecipients.length === 0) return;

    // Domain alert filtering: respect checkFilter mode and per-check/per-folder overrides
    const globalAllows = normalizeEventList(smsSettings.events).includes(payload.event);
    const perCheck = smsSettings.perCheck?.[check.id];
    const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
    const perCheckAllows = perCheck?.events ? perCheck.events.includes(payload.event) : undefined;
    const perFolder = !perCheck ? resolvePerFolder(smsSettings, check.folder) : undefined;
    const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
    const perFolderAllows = perFolder?.events ? perFolder.events.includes(payload.event) : undefined;
    const smsCheckFilterMode = smsSettings.checkFilter?.mode;
    const smsDefaultEventsAllow = smsSettings.checkFilter?.defaultEvents
      ? smsSettings.checkFilter.defaultEvents.includes(payload.event) : undefined;
    const shouldSend = perCheckEnabled === false ? false
      : perCheck ? (perCheckAllows ?? globalAllows)
      : perFolderEnabled === false ? false
      : perFolder ? (perFolderAllows ?? globalAllows)
      : smsCheckFilterMode === 'all' ? (smsDefaultEventsAllow ?? globalAllows ?? true)
      : smsCheckFilterMode === 'include' ? false
      : true;
    if (!shouldSend) return;

    const isExpired = payload.event === 'domain_expired';
    const body = isExpired
      ? `DOMAIN EXPIRED: ${payload.domain} - Renew immediately!`
      : `Domain ${payload.domain} expires in ${payload.daysUntilExpiry} days. Renew soon.`;

    // Send to all recipients, continuing even if some fail
    const results: { recipient: string; success: boolean; error?: string }[] = [];
    for (const recipient of smsRecipients) {
      try {
        await sendSmsMessage(recipient, body);
        logger.info(`Domain alert SMS sent to ${recipient}`);
        results.push({ recipient, success: true });
      } catch (recipientError) {
        const errorMsg = recipientError instanceof Error ? recipientError.message : String(recipientError);
        logger.error(`Domain alert SMS failed to ${recipient}: ${errorMsg}`);
        results.push({ recipient, success: false, error: errorMsg });
      }
    }
    // Log summary if any succeeded
    const successCount = results.filter(r => r.success).length;
    if (successCount > 0 && successCount < results.length) {
      const failedRecipients = results.filter(r => !r.success).map(r => r.recipient);
      logger.warn(`Domain alert SMS partially delivered: ${successCount}/${results.length} succeeded. Failed: ${failedRecipients.join(', ')}`);
    }
  } catch (error) {
    logger.warn('Failed to send domain alert SMS', { error, userId });
  }
}
