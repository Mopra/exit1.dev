import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { FieldValue } from "firebase-admin/firestore";
import { firestore, getUserTier } from "./init";
import { EmailSettings } from "./types";
import { RESEND_API_KEY, RESEND_FROM, getResendCredentials } from "./env";
import { Resend } from 'resend';
import { CONFIG } from "./config";

// Callable function to save email settings
export const saveEmailSettings = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { recipient, enabled, events, minConsecutiveEvents } = request.data || {};
  if (!recipient || typeof recipient !== 'string') {
    throw new Error('Recipient email is required');
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('At least one event is required');
  }

  const now = Date.now();
  const data: EmailSettings = {
    userId: uid,
    recipient: recipient.trim(),
    enabled: Boolean(enabled),
    events: events,
    minConsecutiveEvents: Math.max(1, Number(minConsecutiveEvents || 1)),
    createdAt: now,
    updatedAt: now,
  };

  const docRef = firestore.collection('emailSettings').doc(uid);
  const existing = await docRef.get();
  if (existing.exists) {
    await docRef.update({
      recipient: data.recipient,
      // keep 'enabled' for backward compatibility but no longer required in runtime
      enabled: data.enabled,
      events: data.events,
      minConsecutiveEvents: data.minConsecutiveEvents,
      updatedAt: now,
    });
  } else {
    await docRef.set(data);
  }
  return { success: true };
});

// Update per-check overrides
export const updateEmailPerCheck = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  const { checkId, enabled, events } = request.data || {};
  if (!checkId || typeof checkId !== 'string') {
    throw new Error('checkId is required');
  }
  if (events !== undefined && events !== null && !Array.isArray(events)) {
    throw new Error('events must be an array when provided');
  }
  const now = Date.now();
  const docRef = firestore.collection('emailSettings').doc(uid);

  const clearOverride = enabled === null && events === null;
  const updateData: Record<string, unknown> = { updatedAt: now };

  if (clearOverride) {
    updateData[`perCheck.${checkId}`] = FieldValue.delete();
  } else {
    if (enabled !== undefined) {
      updateData[`perCheck.${checkId}.enabled`] =
        enabled === null ? FieldValue.delete() : Boolean(enabled);
    }
    if (events !== undefined) {
      updateData[`perCheck.${checkId}.events`] =
        events === null ? FieldValue.delete() : events;
    }
  }

  try {
    await docRef.update(updateData);
  } catch (error: unknown) {
    const err = error as { code?: unknown; message?: unknown } | null;
    const code = typeof err?.code === 'number' ? err.code : null;
    const message = typeof err?.message === 'string' ? err.message : '';
    const isNotFound = code === 5 || message.includes('No document to update');
    if (!isNotFound) {
      throw error;
    }

    const shouldCreate =
      (enabled !== undefined && enabled !== null) ||
      (events !== undefined && events !== null);
    if (!shouldCreate) {
      return { success: true };
    }

    const perCheckEntry: Record<string, unknown> = {};
    if (enabled !== undefined && enabled !== null) {
      perCheckEntry.enabled = Boolean(enabled);
    }
    if (events !== undefined && events !== null) {
      perCheckEntry.events = events;
    }

    await docRef.set({
      userId: uid,
      recipient: '',
      enabled: false,
      events: ['website_down', 'website_up', 'website_error'],
      perCheck: Object.keys(perCheckEntry).length ? { [checkId]: perCheckEntry } : {},
      createdAt: now,
      updatedAt: now,
    } as EmailSettings);
  }
  return { success: true };
});

// Get email settings
export const getEmailSettings = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  const doc = await firestore.collection('emailSettings').doc(uid).get();
  if (!doc.exists) {
    return { success: true, data: null };
  }
  return { success: true, data: doc.data() as EmailSettings };
});

const getWindowStart = (nowMs: number, windowMs: number): number => {
  return Math.floor(nowMs / windowMs) * windowMs;
};

export const getEmailUsage = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  const resolvedTier = await getUserTier(uid);
  const now = Date.now();
  const hourlyWindowMs = CONFIG.EMAIL_USER_BUDGET_WINDOW_MS;
  const monthlyWindowMs = CONFIG.EMAIL_USER_MONTHLY_BUDGET_WINDOW_MS;
  const hourlyWindowStart = getWindowStart(now, hourlyWindowMs);
  const monthlyWindowStart = getWindowStart(now, monthlyWindowMs);

  const [hourlySnap, monthlySnap] = await Promise.all([
    firestore.collection(CONFIG.EMAIL_USER_BUDGET_COLLECTION).doc(`${uid}__${hourlyWindowStart}`).get(),
    firestore.collection(CONFIG.EMAIL_USER_MONTHLY_BUDGET_COLLECTION).doc(`${uid}__${monthlyWindowStart}`).get(),
  ]);

  const hourlyCount = hourlySnap.exists
    ? Number((hourlySnap.data() as { count?: unknown }).count || 0)
    : 0;
  const monthlyCount = monthlySnap.exists
    ? Number((monthlySnap.data() as { count?: unknown }).count || 0)
    : 0;

  return {
    success: true,
    data: {
      hourly: {
        count: hourlyCount,
        max: CONFIG.getEmailBudgetMaxPerWindowForTier(resolvedTier),
        windowStart: hourlyWindowStart,
        windowEnd: hourlyWindowStart + hourlyWindowMs,
      },
      monthly: {
        count: monthlyCount,
        max: CONFIG.getEmailMonthlyBudgetMaxPerWindowForTier(resolvedTier),
        windowStart: monthlyWindowStart,
        windowEnd: monthlyWindowStart + monthlyWindowMs,
      },
    },
  };
});

// Send a test email to the configured recipient
export const sendTestEmail = onCall({
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const snap = await firestore.collection('emailSettings').doc(uid).get();
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', 'Email settings not found');
    }
    const settings = snap.data() as EmailSettings;

    if (!settings.recipient) {
      throw new HttpsError('failed-precondition', 'Recipient email not set');
    }

    const { apiKey, fromAddress } = getResendCredentials();
    if (!apiKey) {
      throw new HttpsError('failed-precondition', 'Email delivery is not configured');
    }

    logger.info('sendTestEmail: preparing to send', { uid, recipient: settings.recipient, fromAddress });

    const resend = new Resend(apiKey);
    const html = `
      <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
        <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
          <h2 style="margin:0 0 8px 0">Test email from Exit1</h2>
          <p style="margin:0 0 12px 0;color:#94a3b8">If you see this, your email alerts are configured.</p>
        </div>
      </div>`;

    const response = await resend.emails.send({
      from: fromAddress,
      to: settings.recipient,
      subject: 'Test: Exit1 email alerts',
      html,
    });
    if (response.error) {
      logger.error('sendTestEmail: resend error', { uid, error: response.error });
      throw new HttpsError('internal', response.error.message);
    }
    logger.info('sendTestEmail: resend response', { uid, apiResponse: response.data });

    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Failed to send test email';
    logger.error('sendTestEmail failed', error);
    throw new HttpsError('internal', message);
  }
});


