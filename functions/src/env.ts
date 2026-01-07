import { defineSecret } from 'firebase-functions/params';

export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
export const RESEND_FROM = defineSecret('RESEND_FROM');
export const CLERK_SECRET_KEY_PROD = defineSecret('CLERK_SECRET_KEY_PROD');
export const CLERK_SECRET_KEY_DEV = defineSecret('CLERK_SECRET_KEY_DEV');
export const CLERK_SECRET_KEY = defineSecret('CLERK_SECRET_KEY');
export const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
export const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
export const TWILIO_FROM_NUMBER = defineSecret('TWILIO_FROM_NUMBER');
export const TWILIO_MESSAGING_SERVICE_SID = defineSecret('TWILIO_MESSAGING_SERVICE_SID');

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

