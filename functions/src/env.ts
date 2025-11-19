import { defineSecret } from 'firebase-functions/params';

export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
export const RESEND_FROM = defineSecret('RESEND_FROM');
export const CLERK_SECRET_KEY_PROD = defineSecret('CLERK_SECRET_KEY_PROD');
export const CLERK_SECRET_KEY_DEV = defineSecret('CLERK_SECRET_KEY_DEV');
export const CLERK_SECRET_KEY = defineSecret('CLERK_SECRET_KEY');

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

