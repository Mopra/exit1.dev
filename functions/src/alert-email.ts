import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookEvent } from './types';
import { CONFIG } from './config';
import { CLERK_SECRET_KEY_PROD } from './env';
import { createClerkClient } from '@clerk/backend';
import {
  DeliveryFailureMeta,
  AlertContext,
  EmailSendFn,
  formatDateForCheck,
  formatDateOnlyForCheck,
  formatStatusCode,
  emitAlertMetric,
  getResendClient,
  evaluateDeliveryState,
  markDeliverySuccess,
  recordDeliveryFailure,
  getEmailTrackerKey,
  getThrottleWindowStart,
} from './alert-helpers';
import {
  acquireEmailThrottleSlot,
  acquireUserEmailBudget,
  acquireUserEmailMonthlyBudget,
} from './alert-throttle';

// ============================================================================
// FAILURE TRACKER
// ============================================================================

export const emailFailureTracker = new Map<string, DeliveryFailureMeta>();

// ============================================================================
// EMAIL SEND WITH GUARDS
// ============================================================================

export const sendEmailWithGuards = async (
  trackerKey: string,
  eventType: WebhookEvent,
  sendFn: EmailSendFn
): Promise<'sent' | 'skipped' | 'failed'> => {
  const state = evaluateDeliveryState(emailFailureTracker, trackerKey);

  if (state === 'skipped') {
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

// ============================================================================
// DELIVER EMAIL ALERT (with throttle + budget guards)
// ============================================================================

export const deliverEmailAlert = async ({
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
    // Fire-and-forget: notify user they hit their monthly email limit
    sendLimitReachedEmail(
      website.userId,
      emailTier,
      'email',
      CONFIG.getEmailMonthlyBudgetMaxPerWindowForTier(emailTier)
    ).catch(() => {});
    return 'throttled';
  }

  const trackerKey = getEmailTrackerKey(website.userId, website.id, eventType);
  const deliveryState = await sendEmailWithGuards(trackerKey, eventType, send);

  if (deliveryState === 'sent') {
    return 'sent';
  }

  return 'error';
};

// ============================================================================
// SEND STATUS EMAIL NOTIFICATION
// ============================================================================

export async function sendEmailNotification(
  toEmail: string,
  website: Website,
  eventType: WebhookEvent,
  previousStatus: string,
  emailFormat: 'html' | 'text' = 'html'
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

  // Build status code info (skip for ping/websocket checks — status code is meaningless for these protocols)
  let statusCodeHtml = '';
  const skipStatusCode = website.type === 'ping' || website.type === 'websocket';
  const statusCodeLabel = skipStatusCode ? null : formatStatusCode(website.lastStatusCode);
  if (statusCodeLabel) {
    statusCodeHtml = `<div><strong>Status Code:</strong> <span style="color:#38bdf8">${statusCodeLabel}</span></div>`;
  }

  // Build error reason (especially useful for ping checks: "Host Unreachable" vs "Timeout")
  let errorHtml = '';
  if (website.lastError && eventType === 'website_down') {
    const safeError = website.lastError.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    errorHtml = `<div><strong>Error:</strong> <span style="color:#f87171">${safeError}</span></div>`;
  }

  // Build target IP info (helps identify which resolved IP failed for multi-IP hosts)
  let targetIpHtml = '';
  if (website.targetIp) {
    targetIpHtml = `<div><strong>Target IP:</strong> <span style="color:#38bdf8">${website.targetIp}</span></div>`;
  }

  // Build latency breakdown + bottleneck highlight
  const timings = {
    dns: website.dnsMs,
    connect: website.connectMs,
    tls: website.tlsMs,
    ttfb: website.ttfbMs,
  };
  const hasTimings = Object.values(timings).some(v => typeof v === 'number');

  // Determine the bottleneck (highest value) if any timing is notably high
  let bottleneckHtml = '';
  let timingsHtml = '';
  if (hasTimings) {
    const timingEntries: { label: string; key: string; value: number }[] = [
      { label: 'DNS', key: 'dns', value: timings.dns ?? 0 },
      { label: 'Connect', key: 'connect', value: timings.connect ?? 0 },
      { label: 'TLS', key: 'tls', value: timings.tls ?? 0 },
      { label: 'TTFB', key: 'ttfb', value: timings.ttfb ?? 0 },
    ];

    // Find the bottleneck: the phase contributing most to total latency
    const totalTimings = timingEntries.reduce((s, t) => s + t.value, 0);
    const bottleneck = timingEntries.reduce((max, t) => t.value > max.value ? t : max, timingEntries[0]);

    // Show bottleneck if it accounts for > 50% of total and is > 200ms
    if (bottleneck.value > 200 && totalTimings > 0 && bottleneck.value / totalTimings > 0.5) {
      bottleneckHtml = `<div><strong>Latency Bottleneck:</strong> <span style="color:#f59e0b;font-weight:600">${bottleneck.label} ${Math.round(bottleneck.value)}ms</span></div>`;
    }

    // Build the timing breakdown row
    const timingParts = timingEntries
      .filter(t => typeof (timings as Record<string, number | undefined>)[t.key] === 'number')
      .map(t => {
        const isBottleneck = t === bottleneck && bottleneckHtml !== '';
        const color = isBottleneck ? '#f59e0b' : '#38bdf8';
        return `<span style="color:${color}">${t.label} ${Math.round(t.value)}ms</span>`;
      });

    timingsHtml = `<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(148,163,184,0.06);border:1px solid rgba(148,163,184,0.1);font-size:13px">
      <strong style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Latency Breakdown</strong>
      <div style="margin-top:4px">${timingParts.join(' &nbsp;·&nbsp; ')}</div>
    </div>`;
  }

  const baseUrl = process.env.FRONTEND_URL || 'https://app.exit1.dev';
  const incidentUrl = `${baseUrl}/logs?check=${encodeURIComponent(website.id)}`;
  const billingUrl = `${baseUrl}/billing`;

  // Show SMS upsell only for free tier users
  const isFreeTier = !website.userTier || website.userTier === 'free';

  if (emailFormat === 'text') {
    // Plain text version for ticket systems and users who prefer plain text
    const lines: string[] = [
      subject,
      '='.repeat(subject.length),
      '',
      formatDateForCheck(new Date(), website.timezone),
      '',
      `Site: ${website.name}`,
      `URL: ${website.url}`,
      `Current Status: ${statusLabel}`,
    ];
    if (website.responseTime) lines.push(`Response Time: ${website.responseTime}ms`);
    if (statusCodeLabel) lines.push(`Status Code: ${statusCodeLabel}`);
    if (website.lastError && eventType === 'website_down') lines.push(`Error: ${website.lastError}`);
    if (website.targetIp) lines.push(`Target IP: ${website.targetIp}`);
    lines.push(`Previous Status: ${previousStatus}`);

    // Latency breakdown
    if (hasTimings) {
      const timingEntries = [
        { label: 'DNS', value: timings.dns },
        { label: 'Connect', value: timings.connect },
        { label: 'TLS', value: timings.tls },
        { label: 'TTFB', value: timings.ttfb },
      ];
      const totalTimings = timingEntries.reduce((s, t) => s + (t.value ?? 0), 0);
      const bottleneck = timingEntries.reduce((max, t) => (t.value ?? 0) > (max.value ?? 0) ? t : max, timingEntries[0]);
      if ((bottleneck.value ?? 0) > 200 && totalTimings > 0 && (bottleneck.value ?? 0) / totalTimings > 0.5) {
        lines.push(`Latency Bottleneck: ${bottleneck.label} ${Math.round(bottleneck.value ?? 0)}ms`);
      }
      lines.push('');
      lines.push('Latency Breakdown:');
      timingEntries
        .filter(t => typeof t.value === 'number')
        .forEach(t => lines.push(`  ${t.label}: ${Math.round(t.value!)}ms`));
    }

    lines.push('', `View incident: ${incidentUrl}`);
    lines.push('', 'Manage email alerts in your Exit1 settings.');

    const text = lines.join('\n');
    await resend.emails.send({ from: fromAddress, to: toEmail, subject, text });
  } else {
    const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${subject}</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${formatDateForCheck(new Date(), website.timezone)}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
          <div><strong>Site:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          <div><strong>Current Status:</strong> ${statusLabel}</div>
          ${responseTimeHtml}
          ${statusCodeHtml}
          ${errorHtml}
          ${targetIpHtml}
          ${bottleneckHtml}
          <div><strong>Previous Status:</strong> ${previousStatus}</div>
        </div>
        ${timingsHtml}
        <div style="margin:16px 0 0 0;text-align:center">
          <table role="presentation" style="width:100%;border-collapse:collapse">
            <tr>
              <td style="width:50%;padding:0 4px 0 0">
                <a href="${incidentUrl}" style="display:block;padding:10px 12px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:12px;font-weight:500;text-align:center">Go to Incident</a>
              </td>
              ${isFreeTier ? `<td style="width:50%;padding:0 0 0 4px">
                <a href="${billingUrl}" style="display:block;padding:10px 12px;background:rgba(148,163,184,0.1);color:#38bdf8;text-decoration:none;border-radius:12px;font-weight:500;text-align:center;border:1px solid rgba(148,163,184,0.2)">Get SMS on next incident</a>
              </td>` : ''}
            </tr>
          </table>
        </div>
        <div style="margin:16px 0 0 0;padding:12px;border-radius:8px;background:rgba(148,163,184,0.06);border:1px solid rgba(148,163,184,0.1)">
          <p style="margin:0;color:#94a3b8;font-size:14px"><strong style="color:#e2e8f0">Tip:</strong> You can add a comment to this incident to track what happened or note the resolution. <a href="${incidentUrl}" style="color:#38bdf8;text-decoration:none">Add a comment on the logs page</a>.</p>
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8;font-size:14px">Manage email alerts in your Exit1 settings.</p>
      </div>
    </div>
  `;

    await resend.emails.send({ from: fromAddress, to: toEmail, subject, html });
  }
}

// ============================================================================
// SEND SSL EMAIL NOTIFICATION
// ============================================================================

export async function sendSSLEmailNotification(
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
  },
  emailFormat: 'html' | 'text' = 'html'
): Promise<void> {
  const { resend, fromAddress } = getResendClient();

  const subject =
    eventType === 'ssl_error'
      ? `SSL ERROR: ${website.name} certificate is invalid`
      : `SSL WARNING: ${website.name} certificate expires soon`;

  const formatDate = (timestamp?: number) => formatDateOnlyForCheck(timestamp, website.timezone);

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

  if (emailFormat === 'text') {
    const lines: string[] = [
      subject,
      '='.repeat(subject.length),
      '',
      formatDateForCheck(new Date(), website.timezone),
      '',
      `Site: ${website.name}`,
      `URL: ${website.url}`,
      '',
      `Certificate Status: ${sslCertificate.valid ? 'Valid' : 'Invalid'}`,
    ];
    if (sslCertificate.issuer) lines.push(`Issuer: ${sslCertificate.issuer}`);
    if (sslCertificate.subject) lines.push(`Subject: ${sslCertificate.subject}`);
    if (sslCertificate.validFrom) lines.push(`Valid From: ${formatDate(sslCertificate.validFrom)}`);
    if (sslCertificate.validTo) lines.push(`Valid Until: ${formatDate(sslCertificate.validTo)}`);
    if (sslCertificate.daysUntilExpiry !== undefined) lines.push(`Days Until Expiry: ${sslCertificate.daysUntilExpiry}`);
    if (sslCertificate.error) lines.push(`Error: ${sslCertificate.error}`);
    lines.push('', 'Manage SSL alerts in your Exit1 settings.');

    const text = lines.join('\n');
    await resend.emails.send({ from: fromAddress, to: toEmail, subject, text });
  } else {
    const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${subject}</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${formatDateForCheck(new Date(), website.timezone)}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
          <div><strong>Site:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          ${sslDetails}
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8">Manage SSL alerts in your Exit1 settings.</p>
      </div>
    </div>
  `;

    await resend.emails.send({ from: fromAddress, to: toEmail, subject, html });
  }
}

// ============================================================================
// LIMIT-REACHED NOTIFICATION EMAILS
// ============================================================================

// Sent once per budget window when a user's monthly email or SMS budget
// is exhausted.  Uses an in-memory Set (keyed by userId + channel +
// windowStart) so we never spam the same user within a single process
// lifetime, plus a Firestore collection with TTL for cross-instance
// dedup.

const limitNotifiedThisWindow = new Set<string>();

/**
 * Send a one-time "you've hit your notification limit" email.
 * - Free users get a CTA to upgrade to Nano.
 * - Nano users get a heads-up without the upgrade nudge.
 * Silently no-ops if we've already notified this user for this channel+window.
 */
export const sendLimitReachedEmail = async (
  userId: string,
  tier: 'free' | 'nano' | 'scale',
  channel: 'email' | 'sms',
  monthlyLimit: number
): Promise<void> => {
  const now = Date.now();
  const windowStart = getThrottleWindowStart(now, CONFIG.EMAIL_USER_MONTHLY_BUDGET_WINDOW_MS);
  const dedupKey = `${userId}__${channel}__${windowStart}`;

  // Fast in-memory dedup
  if (limitNotifiedThisWindow.has(dedupKey)) return;

  try {
    // Cross-instance dedup via Firestore
    const db = getFirestore();
    const docRef = db.collection('limitNotifications').doc(dedupKey);
    const snap = await docRef.get();
    if (snap.exists) {
      limitNotifiedThisWindow.add(dedupKey);
      return;
    }

    // Look up user email from Clerk
    const clerkSecretKey = CLERK_SECRET_KEY_PROD.value();
    if (!clerkSecretKey) {
      logger.warn('Cannot send limit-reached email: Clerk secret key not found');
      return;
    }
    const clerkClient = createClerkClient({ secretKey: clerkSecretKey });
    let user;
    try {
      user = await clerkClient.users.getUser(userId);
    } catch (clerkError: unknown) {
      const err = clerkError as { status?: number; errors?: Array<{ code?: string }> };
      if (err?.status === 404 || err?.errors?.[0]?.code === 'resource_not_found') {
        logger.warn(`Cannot send limit-reached email: user ${userId} not found in Clerk (likely deleted)`);
        return;
      }
      throw clerkError;
    }
    const userEmail = user.primaryEmailAddress?.emailAddress || user.emailAddresses[0]?.emailAddress;
    if (!userEmail) {
      logger.warn(`Cannot send limit-reached email for user ${userId}: no email address found`);
      return;
    }

    const { resend, fromAddress } = getResendClient();
    const baseUrl = process.env.FRONTEND_URL || 'https://app.exit1.dev';
    const billingUrl = `${baseUrl}/billing`;
    const isFreeTier = tier === 'free';
    const channelLabel = channel === 'email' ? 'email' : 'SMS';

    const subject = `Your monthly ${channelLabel} notification limit has been reached`;

    const upgradeCta = isFreeTier
      ? `<div style="margin:16px 0;padding:16px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
            <p style="margin:0 0 8px 0;color:#e2e8f0;font-weight:500">Need more notifications?</p>
            <p style="margin:0 0 12px 0;color:#94a3b8">Upgrade to the <strong style="color:#e2e8f0">Nano plan</strong> and get up to <strong style="color:#e2e8f0">${channel === 'email' ? '1,000 emails' : '20 SMS'}</strong> per month, plus faster check intervals, more checks, and webhooks.</p>
            <div style="text-align:center">
              <a href="${billingUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:12px;font-weight:500">Upgrade to Nano</a>
            </div>
          </div>`
      : '';

    const html = `
      <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
        <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
          <h2 style="margin:0 0 8px 0">${channelLabel} Notification Limit Reached</h2>
          <p style="margin:0 0 12px 0;color:#94a3b8">${formatDateForCheck(new Date())}</p>

          <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2)">
            <p style="margin:0;color:#e2e8f0">You've used all <strong>${monthlyLimit.toLocaleString()} ${channelLabel.toLowerCase()} notifications</strong> included in your plan this month.</p>
          </div>

          <div style="margin:16px 0;padding:12px;border-radius:8px;background:rgba(148,163,184,0.06);border:1px solid rgba(148,163,184,0.1)">
            <p style="margin:0 0 8px 0;color:#e2e8f0;font-weight:500">What this means:</p>
            <ul style="margin:0;padding-left:20px;color:#94a3b8">
              <li>Your monitors are still running and tracking uptime as normal</li>
              <li>New ${channelLabel.toLowerCase()} notifications will be paused until your limit resets next month</li>
              ${channel === 'email' && tier === 'free' ? '<li>Webhook notifications (Slack, Discord, etc.) are not affected by this limit</li>' : ''}
              ${channel === 'sms' ? '<li>Email notifications are not affected by this limit</li>' : ''}
            </ul>
          </div>

          ${upgradeCta}

          <p style="margin:16px 0 0 0;color:#94a3b8;font-size:14px">Your ${channelLabel.toLowerCase()} limit will automatically reset at the start of your next billing cycle. You don't need to take any action to resume notifications.</p>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: fromAddress,
      to: userEmail,
      subject,
      html,
    });

    // Mark as notified in Firestore with TTL so it auto-cleans
    const windowEnd = windowStart + CONFIG.EMAIL_USER_MONTHLY_BUDGET_WINDOW_MS;
    await docRef.set({
      userId,
      channel,
      sentAt: now,
      expireAt: Timestamp.fromMillis(windowEnd + 24 * 60 * 60 * 1000),
    });

    limitNotifiedThisWindow.add(dedupKey);
    logger.info(`Sent ${channel} limit-reached email to ${userEmail} for user ${userId} (tier=${tier}, limit=${monthlyLimit})`);
  } catch (error) {
    logger.error(`Failed to send ${channel} limit-reached email for user ${userId}:`, error);
  }
};

