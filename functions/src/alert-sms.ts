import * as logger from "firebase-functions/logger";
import { Website, WebhookEvent } from './types';
import { CONFIG } from './config';
import { getTwilioCredentials } from './env';
import {
  DeliveryFailureMeta,
  AlertContext,
  SmsSendFn,
  formatStatusCode,
  emitAlertMetric,
  evaluateDeliveryState,
  markDeliverySuccess,
  recordDeliveryFailure,
  getSmsTrackerKey,
} from './alert-helpers';
import {
  acquireSmsThrottleSlot,
  acquireUserSmsBudget,
  acquireUserSmsMonthlyBudget,
} from './alert-throttle';
import { sendLimitReachedEmail } from './alert-email';

// ============================================================================
// FAILURE TRACKER
// ============================================================================

export const smsFailureTracker = new Map<string, DeliveryFailureMeta>();

// ============================================================================
// SMS SEND WITH GUARDS
// ============================================================================

export const sendSmsWithGuards = async (
  trackerKey: string,
  eventType: WebhookEvent,
  sendFn: SmsSendFn
): Promise<'sent' | 'skipped' | 'failed'> => {
  const state = evaluateDeliveryState(smsFailureTracker, trackerKey);

  if (state === 'skipped') {
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

// ============================================================================
// DELIVER SMS ALERT (with throttle + budget guards)
// ============================================================================

export const deliverSmsAlert = async ({
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
  smsTier: 'free' | 'nano' | 'pro' | 'agency';
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

  const monthlySmsMax = CONFIG.getSmsMonthlyBudgetMaxPerWindowForTier(smsTier);
  const monthlyAllowed = await acquireUserSmsMonthlyBudget(
    website.userId,
    CONFIG.SMS_USER_MONTHLY_BUDGET_WINDOW_MS,
    monthlySmsMax,
    context?.smsMonthlyBudgetCache
  );
  if (!monthlyAllowed) {
    emitAlertMetric('sms_monthly_budget_blocked', { userId: website.userId, eventType });
    // Fire-and-forget: notify user they hit their monthly SMS limit
    sendLimitReachedEmail(
      website.userId,
      smsTier,
      'sms',
      monthlySmsMax
    ).catch(() => {});
    return 'throttled';
  }

  const trackerKey = getSmsTrackerKey(website.userId, website.id, eventType);
  const deliveryState = await sendSmsWithGuards(trackerKey, eventType, send);

  if (deliveryState === 'sent') {
    return 'sent';
  }

  return 'error';
};

// ============================================================================
// SMS BODY BUILDERS
// ============================================================================

export const normalizeSmsBody = (value: string, maxLength: number = 320) => {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return compact.slice(0, maxLength).trimEnd();
};

export const buildStatusSmsBody = (website: Website, eventType: WebhookEvent, previousStatus?: string) => {
  const statusLabel =
    eventType === 'website_down'
      ? 'DOWN'
      : eventType === 'website_up'
        ? 'UP'
        : 'ALERT';

  let message = `Exit1 ${statusLabel}: ${website.name}`;
  const isProtocolCheck = website.type === 'ping' || website.type === 'websocket';
  // For ping/websocket checks, show the error reason instead of the meaningless status code
  if (isProtocolCheck) {
    if (website.lastError && eventType === 'website_down') {
      // Extract the concise reason from errors like "Ping failed: ..." or "WebSocket upgrade failed: ..."
      const reason = website.lastError
        .replace(/^Ping failed:\s*/i, '')
        .replace(/^WebSocket upgrade failed:\s*/i, '')
        .replace(/^WebSocket handshake timed out\s*/i, 'Handshake timeout')
        .slice(0, 60);
      message += ` [${reason}]`;
    }
  } else {
    const smsStatusCode = formatStatusCode(website.lastStatusCode);
    if (smsStatusCode) {
      message += ` [${smsStatusCode}]`;
    }
  }
  if (eventType === 'website_up' && previousStatus) {
    message += ` (was ${previousStatus})`;
  }
  // Include response time on recovery for protocol checks
  if (isProtocolCheck && eventType === 'website_up' && website.responseTime) {
    message += ` ${website.responseTime}ms`;
  }
  message += ` ${website.url}`;

  return normalizeSmsBody(message);
};

export const buildSslSmsBody = (
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

// ============================================================================
// SEND SMS MESSAGE (Twilio)
// ============================================================================

export const sendSmsMessage = async (toPhone: string, body: string): Promise<void> => {
  const optOut = '\nReply STOP to opt out.';
  const fullBody = body + optOut;
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
    Body: fullBody,
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
    let errorCode: number | undefined;
    try {
      const data = (await response.json()) as { message?: string; code?: number };
      if (data?.message) {
        message = data.message;
      }
      if (typeof data?.code === 'number') {
        errorCode = data.code;
      }
    } catch {
      // Ignore JSON parse errors.
    }
    const codeStr = errorCode !== undefined ? ` (code ${errorCode})` : '';
    // Log additional context for common Twilio errors
    if (errorCode === 21408) {
      logger.error(`Twilio geographic permission denied for ${toPhone}. Enable SMS permissions for this region in Twilio console.`);
    } else if (errorCode === 21211) {
      logger.error(`Invalid phone number format: ${toPhone}`);
    } else if (errorCode === 21614) {
      logger.error(`Phone number ${toPhone} is not a valid mobile number or cannot receive SMS`);
    }
    throw new Error(`${message}${codeStr}`);
  }
};

// ============================================================================
// SEND STATUS SMS NOTIFICATION
// ============================================================================

export const sendSmsNotification = async (
  toPhone: string,
  website: Website,
  eventType: WebhookEvent,
  previousStatus: string
): Promise<void> => {
  const body = buildStatusSmsBody(website, eventType, previousStatus);
  await sendSmsMessage(toPhone, body);
};

// ============================================================================
// SEND SSL SMS NOTIFICATION
// ============================================================================

export const sendSslSmsNotification = async (
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
