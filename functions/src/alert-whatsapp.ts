import * as logger from "firebase-functions/logger";
import { Website, WebhookEvent } from './types';
import { getWhatsAppCredentials } from './env';
import { formatStatusCode } from './alert-helpers';

// WhatsApp alerts go through Meta's WhatsApp Cloud API. Alerts are business
// initiated, so each one is an approved "utility" template; free text is only
// allowed inside a 24h window the user opens, which alerts never have. Throttle,
// budget and retry are the SMS channel's (deliverSmsAlert in alert-sms.ts): a
// WhatsApp number is another recipient of the same text alert.
//
// The template texts (submit in WhatsApp Manager, category Utility, language
// English "en") are in WHATSAPP_ALERTS.md. Names and parameter order
// here must match them exactly.

const GRAPH_API_VERSION = 'v23.0';
const TEMPLATE_LANGUAGE = 'en';

export const WHATSAPP_TEMPLATES = {
  down: 'exit1_check_down',
  up: 'exit1_check_up',
  ssl: 'exit1_ssl_alert',
  test: 'exit1_test',
} as const;

type SslCertificateLike = {
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  error?: string;
};

// Meta rejects template parameters that are empty or contain newlines, tabs or
// more than four spaces in a row.
export const normalizeTemplateParam = (value: string | undefined, maxLength: number = 200): string => {
  const compact = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '-';
  return compact.length <= maxLength ? compact : compact.slice(0, maxLength).trimEnd();
};

/** Template name and body parameters ({{1}} name, {{2}} status, {{3}} URL). */
export const buildStatusWhatsAppTemplate = (
  website: Website,
  eventType: WebhookEvent,
  previousStatus?: string
): { name: string; params: string[] } => {
  const isProtocolCheck = website.type === 'ping' || website.type === 'websocket';
  let status: string;
  if (eventType === 'website_down') {
    status = isProtocolCheck
      ? (website.lastError
        ? website.lastError
          .replace(/^Ping failed:\s*/i, '')
          .replace(/^WebSocket upgrade failed:\s*/i, '')
          .replace(/^WebSocket handshake timed out\s*/i, 'Handshake timeout')
          .slice(0, 80)
        : 'no response')
      : (formatStatusCode(website.lastStatusCode) || website.lastError || 'no response');
  } else {
    const parts: string[] = [];
    const code = isProtocolCheck ? undefined : formatStatusCode(website.lastStatusCode);
    parts.push(code || 'online');
    if (previousStatus) parts.push(`was ${previousStatus}`);
    if (website.responseTime) parts.push(`${website.responseTime}ms`);
    status = parts.join(', ');
  }

  return {
    name: eventType === 'website_down' ? WHATSAPP_TEMPLATES.down : WHATSAPP_TEMPLATES.up,
    params: [
      normalizeTemplateParam(website.name, 100),
      normalizeTemplateParam(status, 120),
      normalizeTemplateParam(website.url, 200),
    ],
  };
};

/** Template name and body parameters ({{1}} name, {{2}} problem, {{3}} URL). */
export const buildSslWhatsAppTemplate = (
  website: Website,
  eventType: WebhookEvent,
  sslCertificate: SslCertificateLike
): { name: string; params: string[] } => {
  const parts: string[] = [];
  if (sslCertificate.error) parts.push(sslCertificate.error);
  if (sslCertificate.daysUntilExpiry !== undefined) {
    parts.push(`expires in ${sslCertificate.daysUntilExpiry} days`);
  }
  if (parts.length === 0) {
    parts.push(eventType === 'ssl_error' ? 'certificate is invalid' : 'certificate expires soon');
  }

  return {
    name: WHATSAPP_TEMPLATES.ssl,
    params: [
      normalizeTemplateParam(website.name, 100),
      normalizeTemplateParam(parts.join(', '), 160),
      normalizeTemplateParam(website.url, 200),
    ],
  };
};

// ============================================================================
// SEND WHATSAPP TEMPLATE (Meta Cloud API)
// ============================================================================

export const sendWhatsAppTemplate = async (
  toPhone: string,
  templateName: string,
  params: string[]
): Promise<void> => {
  const { accessToken, phoneNumberId } = getWhatsAppCredentials();
  if (!accessToken || !phoneNumberId) {
    throw new Error('WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
  }

  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: TEMPLATE_LANGUAGE },
  };
  if (params.length > 0) {
    template.components = [{
      type: 'body',
      parameters: params.map((text) => ({ type: 'text', text })),
    }];
  }

  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone.replace(/^\+/, ''),
      type: 'template',
      template,
    }),
  });

  if (!response.ok) {
    let message = `WhatsApp request failed (${response.status})`;
    let errorCode: number | undefined;
    try {
      const data = (await response.json()) as { error?: { message?: string; code?: number } };
      if (data?.error?.message) message = data.error.message;
      if (typeof data?.error?.code === 'number') errorCode = data.error.code;
    } catch {
      // Ignore JSON parse errors.
    }
    if (errorCode === 132001) {
      logger.error(`WhatsApp template ${templateName} (${TEMPLATE_LANGUAGE}) does not exist or is not approved.`);
    } else if (errorCode === 190 || response.status === 401) {
      logger.error('WhatsApp access token is invalid or expired. Use a permanent System User token.');
    } else if (errorCode === 131030) {
      logger.error(`WhatsApp test number restriction: ${toPhone} is not in the allowed recipient list.`);
    }
    const codeStr = errorCode !== undefined ? ` (code ${errorCode})` : '';
    throw new Error(`${message}${codeStr}`);
  }
};

export const sendWhatsAppNotification = async (
  toPhone: string,
  website: Website,
  eventType: WebhookEvent,
  previousStatus: string
): Promise<void> => {
  const { name, params } = buildStatusWhatsAppTemplate(website, eventType, previousStatus);
  await sendWhatsAppTemplate(toPhone, name, params);
};

export const sendSslWhatsAppNotification = async (
  toPhone: string,
  website: Website,
  eventType: WebhookEvent,
  sslCertificate: SslCertificateLike
): Promise<void> => {
  const { name, params } = buildSslWhatsAppTemplate(website, eventType, sslCertificate);
  await sendWhatsAppTemplate(toPhone, name, params);
};
