import { defineSecret } from 'firebase-functions/params';

export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
export const RESEND_FROM = defineSecret('RESEND_FROM');
export const CLERK_WEBHOOK_SECRET = defineSecret('CLERK_WEBHOOK_SECRET');
// Signing secret for the Resend → resendWebhook endpoint (Svix). Set via
// `firebase functions:secrets:set RESEND_WEBHOOK_SECRET` after creating the
// webhook in the Resend dashboard (Webhooks → endpoint → Signing Secret).
export const RESEND_WEBHOOK_SECRET = defineSecret('RESEND_WEBHOOK_SECRET');
// Day3 (go.day3.app) — the email platform we're migrating to. During the
// dual-write period every contact write goes to both Resend and Day3.
export const DAY3_API_KEY = defineSecret('DAY3_API_KEY');
// Optional. Transactional sends fall back to RESEND_FROM when unset, which is
// what we want once the same sending domain is verified in both providers —
// the From address should not change under the user when the switch flips.
// Set it only to send from a different address while testing Day3.
export const DAY3_FROM = defineSecret('DAY3_FROM');
// Signing secret for the Day3 → day3Webhook endpoint (`whsec_…`). Created with
// the endpoint in the Day3 dashboard (API keys → Webhooks) and set via
// `firebase functions:secrets:set DAY3_WEBHOOK_SECRET`. Day3 shows it once.
export const DAY3_WEBHOOK_SECRET = defineSecret('DAY3_WEBHOOK_SECRET');
export const CLERK_SECRET_KEY_PROD = defineSecret('CLERK_SECRET_KEY_PROD');
export const CLERK_SECRET_KEY_DEV = defineSecret('CLERK_SECRET_KEY_DEV');
export const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
export const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
export const TWILIO_FROM_NUMBER = defineSecret('TWILIO_FROM_NUMBER');
export const TWILIO_MESSAGING_SERVICE_SID = defineSecret('TWILIO_MESSAGING_SERVICE_SID');
export const VPS_MANUAL_CHECK_SECRET = defineSecret('VPS_MANUAL_CHECK_SECRET');
// Shared secret for the probe generator endpoint (probe PLAN.md §6). probe signs
// every request as HMAC-SHA256(secret, timestamp + "." + rawBody), and probe
// calls the function's own URL directly, which is publicly reachable, so the
// signature is the entire gate. Same value as PROBE_HMAC_SECRET in probe's own
// .env; a mismatch makes every call 401. Set with
// `firebase functions:secrets:set PROBE_HMAC_SECRET`, then REDEPLOY the
// function -- a secret only reaches a function on its next deploy.
export const PROBE_HMAC_SECRET = defineSecret('PROBE_HMAC_SECRET');

export const getResendCredentials = () => {
  const sanitize = (value?: string | null) =>
    typeof value === 'string' ? value.trim() : undefined;

  let apiKey: string | undefined;
  try {
    apiKey = sanitize(RESEND_API_KEY.value());
  } catch {
    apiKey = sanitize(process.env.RESEND_API_KEY);
  }

  let fromAddress: string | undefined;
  try {
    fromAddress = sanitize(RESEND_FROM.value());
  } catch {
    fromAddress = sanitize(process.env.RESEND_FROM);
  }

  return {
    apiKey,
    fromAddress: fromAddress || 'Exit1.dev <alerts@updates.exit1.dev>',
  };
};

export const getDay3ApiKey = (): string | undefined => {
  const sanitize = (value?: string | null) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  try {
    return sanitize(DAY3_API_KEY.value());
  } catch {
    return sanitize(process.env.DAY3_API_KEY);
  }
};

/**
 * Credentials for transactional sending via Day3. The From address defaults to
 * whatever Resend sends as, so flipping the provider is invisible to the
 * recipient — provided the same domain is verified on both sides.
 */
export const getDay3EmailCredentials = () => {
  const sanitize = (value?: string | null) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  let fromAddress: string | undefined;
  try {
    fromAddress = sanitize(DAY3_FROM.value());
  } catch {
    fromAddress = sanitize(process.env.DAY3_FROM);
  }

  return {
    apiKey: getDay3ApiKey(),
    fromAddress: fromAddress || getResendCredentials().fromAddress,
  };
};

export const getTwilioCredentials = () => {
  const sanitize = (value?: string | null) =>
    typeof value === 'string' ? value.trim() : undefined;

  let accountSid: string | undefined;
  try {
    accountSid = sanitize(TWILIO_ACCOUNT_SID.value());
  } catch {
    accountSid = sanitize(process.env.TWILIO_ACCOUNT_SID);
  }

  let authToken: string | undefined;
  try {
    authToken = sanitize(TWILIO_AUTH_TOKEN.value());
  } catch {
    authToken = sanitize(process.env.TWILIO_AUTH_TOKEN);
  }

  let fromNumber: string | undefined;
  try {
    fromNumber = sanitize(TWILIO_FROM_NUMBER.value());
  } catch {
    fromNumber = sanitize(process.env.TWILIO_FROM_NUMBER);
  }

  let messagingServiceSid: string | undefined;
  try {
    messagingServiceSid = sanitize(TWILIO_MESSAGING_SERVICE_SID.value());
  } catch {
    messagingServiceSid = sanitize(process.env.TWILIO_MESSAGING_SERVICE_SID);
  }

  return {
    accountSid,
    authToken,
    fromNumber,
    messagingServiceSid,
  };
};

