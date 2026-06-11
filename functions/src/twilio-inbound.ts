import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as crypto from "crypto";
import { Resend } from 'resend';
import {
  RESEND_API_KEY,
  RESEND_FROM,
  TWILIO_AUTH_TOKEN,
  getResendCredentials,
  getTwilioCredentials,
} from "./env";

const FORWARD_TO = 'morten@exit1.dev';

// The URL configured in Twilio ("A message comes in"). Twilio signs requests
// against this exact string, but the cloudfunctions.net proxy strips the
// /twilioInboundSms path before the request reaches the container, so the
// URL can't be reconstructed from the request — it must be pinned here.
// Keep in sync with the Twilio console / `twilio phone-numbers:update --sms-url`.
const CONFIGURED_WEBHOOK_URL = 'https://us-central1-exit1-dev.cloudfunctions.net/twilioInboundSms';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Twilio signs: full request URL + each POST param (name+value) concatenated in
// alphabetical key order, HMAC-SHA1 with the account auth token, base64.
// https://www.twilio.com/docs/usage/security#validating-requests
const isValidTwilioSignature = (
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean => {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Flatten the parsed form body into plain strings (duplicate keys arrive as arrays).
const normalizeParams = (body: unknown): Record<string, string> => {
  const params: Record<string, string> = {};
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === 'string') {
        params[key] = value;
      } else if (Array.isArray(value)) {
        params[key] = value.map(String).join(',');
      } else if (value != null) {
        params[key] = String(value);
      }
    }
  }
  return params;
};

/**
 * Webhook for inbound SMS on the Twilio number. Configure in the Twilio
 * console (number → Messaging Configuration → "A message comes in", or the
 * Messaging Service → Integration → Incoming Messages) as an HTTP POST to
 * this function's URL. Forwards every message to FORWARD_TO via Resend and
 * returns empty TwiML so the sender gets no auto-reply.
 */
export const twilioInboundSms = onRequest({
  secrets: [TWILIO_AUTH_TOKEN, RESEND_API_KEY, RESEND_FROM],
  cors: false,
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const { authToken } = getTwilioCredentials();
  if (!authToken) {
    logger.error('twilioInboundSms: TWILIO_AUTH_TOKEN not configured');
    res.status(500).send('Not configured');
    return;
  }

  const signature = req.headers['x-twilio-signature'];
  if (typeof signature !== 'string' || signature.length === 0) {
    logger.warn('twilioInboundSms: missing X-Twilio-Signature header');
    res.status(403).send('Forbidden');
    return;
  }

  const params = normalizeParams(req.body);
  // Validate against the pinned configured URL first; fall back to the
  // reconstructed URL in case the function is ever called via its direct
  // run.app address instead of the cloudfunctions.net proxy.
  const reconstructedUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid =
    isValidTwilioSignature(authToken, signature, CONFIGURED_WEBHOOK_URL, params) ||
    isValidTwilioSignature(authToken, signature, reconstructedUrl, params);

  if (!valid) {
    logger.warn('twilioInboundSms: invalid signature', { reconstructedUrl, from: params.From });
    res.status(403).send('Forbidden');
    return;
  }

  const from = params.From || 'unknown';
  const to = params.To || 'unknown';
  const body = params.Body || '(empty message)';

  const metaRows: Array<[string, string]> = [
    ['From', from],
    ['To', to],
    ['Sent from', [params.FromCity, params.FromCountry].filter(Boolean).join(', ') || '—'],
    ['Message SID', params.MessageSid || '—'],
  ];
  if (params.OptOutType) {
    metaRows.push(['Opt-out type', params.OptOutType]);
  }
  if (Number(params.NumMedia) > 0) {
    metaRows.push(['Media attachments', params.NumMedia]);
  }

  const metaHtml = metaRows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:12px;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;color:#0f172a;font-size:12px;word-break:break-all">${escapeHtml(v)}</td></tr>`)
    .join('');

  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:24px;background:#f8fafc;color:#0f172a">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
        <h2 style="margin:0 0 4px 0;font-size:18px">Incoming SMS</h2>
        <p style="margin:0 0 16px 0;color:#64748b;font-size:13px">Received on ${escapeHtml(to)}</p>
        <div style="white-space:pre-wrap;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:14px;color:#0f172a">${escapeHtml(body)}</div>
        <table style="margin-top:20px;border-collapse:collapse">${metaHtml}</table>
      </div>
    </div>`;

  const text = [
    'Incoming SMS',
    '',
    body,
    '',
    '---',
    ...metaRows.map(([k, v]) => `${k}: ${v}`),
  ].join('\n');

  try {
    const { apiKey, fromAddress } = getResendCredentials();
    if (!apiKey) {
      logger.error('twilioInboundSms: Resend not configured; SMS not forwarded', { from, body });
      // Still ack — Twilio does not retry inbound webhooks, and a 500 only
      // raises a debugger alert. The message content is preserved in the log
      // line above.
      res.status(200).type('text/xml').send(EMPTY_TWIML);
      return;
    }

    const resend = new Resend(apiKey);
    const response = await resend.emails.send({
      from: fromAddress,
      to: FORWARD_TO,
      subject: `SMS from ${from}`,
      html,
      text,
    });

    if (response.error) {
      logger.error('twilioInboundSms: Resend send failed; SMS not forwarded', {
        from,
        body,
        error: response.error,
      });
    } else {
      logger.info('twilioInboundSms: forwarded', { from, resendId: response.data?.id });
    }
  } catch (error) {
    logger.error('twilioInboundSms: forward failed; SMS not forwarded', { from, body, error });
  }

  res.status(200).type('text/xml').send(EMPTY_TWIML);
});
