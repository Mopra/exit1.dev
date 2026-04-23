import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createClerkClient } from '@clerk/backend';
import { Resend } from 'resend';
import { RESEND_API_KEY, RESEND_FROM, CLERK_SECRET_KEY_PROD, getResendCredentials } from "./env";

const FEEDBACK_TO = 'connect@exit1.dev';
const MAX_MESSAGE_LENGTH = 4000;
const MAX_PAGE_LENGTH = 500;

const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const submitFeedback = onCall({
  secrets: [RESEND_API_KEY, RESEND_FROM, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  const { message, page } = request.data || {};

  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'Message is required');
  }
  const trimmed = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  const pageUrl = typeof page === 'string' ? page.trim().slice(0, MAX_PAGE_LENGTH) : '';

  const { apiKey, fromAddress } = getResendCredentials();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'Email delivery is not configured');
  }

  let userEmail: string | undefined;
  let userName: string | undefined;
  try {
    const clerkSecretKey = CLERK_SECRET_KEY_PROD.value();
    if (clerkSecretKey) {
      const clerkClient = createClerkClient({ secretKey: clerkSecretKey });
      const user = await clerkClient.users.getUser(uid);
      userEmail = user.primaryEmailAddress?.emailAddress || user.emailAddresses[0]?.emailAddress;
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
      userName = fullName || user.username || undefined;
    }
  } catch (error) {
    logger.warn('submitFeedback: failed to fetch Clerk user', { uid, error });
  }

  const resend = new Resend(apiKey);
  const subject = `Feedback from ${userName || userEmail || uid}`;

  const metaRows: Array<[string, string]> = [
    ['User', userName ? `${userName}` : uid],
    ['Email', userEmail || '—'],
    ['User ID', uid],
    ['Page', pageUrl || '—'],
  ];
  const metaHtml = metaRows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-size:12px;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;color:#0f172a;font-size:12px;word-break:break-all">${escapeHtml(v)}</td></tr>`)
    .join('');

  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:24px;background:#f8fafc;color:#0f172a">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
        <h2 style="margin:0 0 4px 0;font-size:18px">New in-app feedback</h2>
        <p style="margin:0 0 16px 0;color:#64748b;font-size:13px">Submitted from app.exit1.dev</p>
        <div style="white-space:pre-wrap;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:14px;color:#0f172a">${escapeHtml(trimmed)}</div>
        <table style="margin-top:20px;border-collapse:collapse">${metaHtml}</table>
      </div>
    </div>`;

  const text = [
    'New in-app feedback',
    '',
    trimmed,
    '',
    '---',
    ...metaRows.map(([k, v]) => `${k}: ${v}`),
  ].join('\n');

  try {
    const response = await resend.emails.send({
      from: fromAddress,
      to: FEEDBACK_TO,
      replyTo: userEmail,
      subject,
      html,
      text,
    });
    if (response.error) {
      logger.error('submitFeedback: resend error', { uid, error: response.error });
      throw new HttpsError('internal', response.error.message);
    }
    logger.info('submitFeedback: sent', { uid, resendId: response.data?.id });
    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    const msg = error instanceof Error ? error.message : 'Failed to send feedback';
    logger.error('submitFeedback failed', error);
    throw new HttpsError('internal', msg);
  }
});
