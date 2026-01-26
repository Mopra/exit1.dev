import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { FieldValue } from "firebase-admin/firestore";
import { firestore, getUserTierLive, getClerkClient } from "./init";
import { SmsSettings } from "./types";
import { CONFIG } from "./config";
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  TWILIO_MESSAGING_SERVICE_SID,
  getTwilioCredentials,
} from "./env";

const normalizePhone = (raw: string): string => {
  const trimmed = raw.trim();
  const normalized = trimmed.replace(/[\s()-]/g, '');
  if (!/^\+\d{8,15}$/.test(normalized)) {
    throw new HttpsError('invalid-argument', 'Phone number must be in E.164 format (e.g., +15551234567)');
  }
  return normalized;
};

const getWindowStart = (nowMs: number, windowMs: number): number => {
  return Math.floor(nowMs / windowMs) * windowMs;
};

// Helper function to check if user is admin (from Firestore cache or Clerk)
async function isAdminUser(uid: string): Promise<boolean> {
  try {
    // First check Firestore cache
    const userRef = firestore.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      const updatedAt = userData?.updatedAt || 0;
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      
      // If we have cached admin status from within the last hour, use it
      if (updatedAt > oneHourAgo && typeof userData?.admin === 'boolean') {
        return userData.admin;
      }
    }

    // If no cache or cache is stale, check Clerk
    const prodClient = getClerkClient('prod');
    const devClient = getClerkClient('dev');
    
    let clerkUser = null;
    
    // Try prod first
    if (prodClient) {
      try {
        clerkUser = await prodClient.users.getUser(uid);
      } catch (prodError: unknown) {
        const err = prodError as { status?: number; errors?: Array<{ code?: string }> };
        if (err?.status !== 404 && err?.errors?.[0]?.code !== 'resource_not_found') {
          logger.warn(`Failed to get user ${uid} from prod Clerk:`, prodError);
        }
      }
    }
    
    // If not found in prod, try dev
    if (!clerkUser && devClient) {
      try {
        clerkUser = await devClient.users.getUser(uid);
      } catch (devError: unknown) {
        logger.warn(`Failed to get user ${uid} from dev Clerk:`, devError);
      }
    }
    
    if (!clerkUser) {
      // If we have cached data, use it even if stale
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') {
          return userData.admin;
        }
      }
      return false;
    }
    
    const adminStatus = clerkUser.publicMetadata?.admin === true;
    
    // Update cache
    await userRef.set({
      admin: adminStatus,
      updatedAt: Date.now()
    }, { merge: true });
    
    return adminStatus;
  } catch (error) {
    logger.error(`Error checking admin status for ${uid}:`, error);
    // Fallback to cache if available
    try {
      const userRef = firestore.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') {
          return userData.admin;
        }
      }
    } catch {
      // Ignore cache errors
    }
    return false;
  }
}

const ensureNanoTierOrAdmin = async (uid: string, clientTier?: unknown) => {
  // Check if user is admin first
  const admin = await isAdminUser(uid);
  if (admin) {
    return;
  }

  // If not admin, check tier
  if (clientTier === 'nano') {
    return;
  }

  const tier = await getUserTierLive(uid);
  if (tier !== 'nano') {
    throw new HttpsError(
      'permission-denied',
      'SMS alerts are only available on the Nano plan or for administrators. Please upgrade to enable SMS notifications.'
    );
  }
};

const sendTwilioMessage = async (to: string, body: string) => {
  const { accountSid, authToken, fromNumber, messagingServiceSid } = getTwilioCredentials();

  if (!accountSid || !authToken) {
    throw new HttpsError('failed-precondition', 'SMS delivery is not configured');
  }

  if (!messagingServiceSid && !fromNumber) {
    throw new HttpsError('failed-precondition', 'Twilio sender configuration is missing');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({
    To: to,
    Body: body,
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

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const apiMessage =
      typeof data?.message === 'string'
        ? data.message
        : `Twilio request failed (${response.status})`;
    const errorCode = typeof data?.code === 'number' ? ` (code ${data.code})` : '';
    if (response.status === 401 || response.status === 403) {
      throw new HttpsError(
        'internal',
        `Twilio authentication failed${errorCode}. Verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN for the deployed functions.`
      );
    }
    throw new HttpsError('internal', `${apiMessage}${errorCode}`);
  }

  return data;
};

// Callable function to save SMS settings
export const saveSmsSettings = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  await ensureNanoTierOrAdmin(uid, request.data?.clientTier);

  const { recipients, recipient, enabled, events, minConsecutiveEvents } = request.data || {};
  
  // Support both old 'recipient' field and new 'recipients' array for backwards compatibility
  let phoneRecipients: string[] = [];
  if (Array.isArray(recipients) && recipients.length > 0) {
    phoneRecipients = recipients.map((r: string) => normalizePhone(r)).filter((r: string) => r.length > 0);
  } else if (recipient && typeof recipient === 'string') {
    phoneRecipients = [normalizePhone(recipient)];
  }
  
  if (phoneRecipients.length === 0) {
    throw new HttpsError('invalid-argument', 'At least one recipient phone number is required');
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw new HttpsError('invalid-argument', 'At least one event is required');
  }

  const now = Date.now();
  const docRef = firestore.collection('smsSettings').doc(uid);
  
  // Use merge: true to avoid read-then-write pattern
  // This reduces 1 read + 1 write to just 1 write
  await docRef.set({
    userId: uid,
    recipients: phoneRecipients,
    enabled: Boolean(enabled),
    events: events,
    minConsecutiveEvents: Math.max(1, Number(minConsecutiveEvents || 1)),
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
  
  return { success: true };
});

// Update per-check overrides
export const updateSmsPerCheck = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  await ensureNanoTierOrAdmin(uid, request.data?.clientTier);

  const { checkId, enabled, events } = request.data || {};
  if (!checkId || typeof checkId !== 'string') {
    throw new HttpsError('invalid-argument', 'checkId is required');
  }
  if (events !== undefined && events !== null && !Array.isArray(events)) {
    throw new HttpsError('invalid-argument', 'events must be an array when provided');
  }

  const now = Date.now();
  const docRef = firestore.collection('smsSettings').doc(uid);
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
    } as SmsSettings);
  }
  return { success: true };
});

// Bulk update per-check overrides (reduces N function calls to 1)
export const bulkUpdateSmsPerCheck = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  await ensureNanoTierOrAdmin(uid, request.data?.clientTier);

  const { updates } = request.data || {};
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new HttpsError('invalid-argument', 'updates array is required');
  }

  // Limit batch size to prevent abuse
  const MAX_BATCH_SIZE = 50;
  const limitedUpdates = updates.slice(0, MAX_BATCH_SIZE);

  const now = Date.now();
  const docRef = firestore.collection('smsSettings').doc(uid);

  // Build update object for all checks at once
  const updateData: Record<string, unknown> = { updatedAt: now };

  for (const update of limitedUpdates) {
    const { checkId, enabled, events } = update;
    if (!checkId || typeof checkId !== 'string') continue;

    const clearOverride = enabled === null && events === null;

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

    // Document doesn't exist - create it with the updates
    const perCheck: Record<string, { enabled?: boolean; events?: string[] }> = {};
    for (const update of limitedUpdates) {
      const { checkId, enabled, events } = update;
      if (!checkId || typeof checkId !== 'string') continue;
      if (enabled === null && events === null) continue;

      const entry: { enabled?: boolean; events?: string[] } = {};
      if (enabled !== undefined && enabled !== null) {
        entry.enabled = Boolean(enabled);
      }
      if (events !== undefined && events !== null) {
        entry.events = events;
      }
      if (Object.keys(entry).length > 0) {
        perCheck[checkId] = entry;
      }
    }

    await docRef.set({
      userId: uid,
      recipient: '',
      enabled: false,
      events: ['website_down', 'website_up', 'website_error'],
      perCheck,
      createdAt: now,
      updatedAt: now,
    } as SmsSettings);
  }

  return { success: true, updatedCount: limitedUpdates.length };
});

// Get SMS settings
export const getSmsSettings = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  await ensureNanoTierOrAdmin(uid, request.data?.clientTier);

  const doc = await firestore.collection('smsSettings').doc(uid).get();
  if (!doc.exists) {
    return { success: true, data: null };
  }
  return { success: true, data: doc.data() as SmsSettings };
});

export const getSmsUsage = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  const admin = await isAdminUser(uid);
  let resolvedTier: 'nano' | 'free' = 'free';

  if (admin || request.data?.clientTier === 'nano') {
    resolvedTier = 'nano';
  } else {
    const liveTier = await getUserTierLive(uid);
    resolvedTier = liveTier === 'nano' || (liveTier as unknown) === 'premium' ? 'nano' : 'free';
  }

  if (resolvedTier !== 'nano') {
    throw new HttpsError(
      'permission-denied',
      'SMS alerts are only available on the Nano plan or for administrators. Please upgrade to enable SMS notifications.'
    );
  }

  const now = Date.now();
  const hourlyWindowMs = CONFIG.SMS_USER_BUDGET_WINDOW_MS;
  const monthlyWindowMs = CONFIG.SMS_USER_MONTHLY_BUDGET_WINDOW_MS;
  const hourlyWindowStart = getWindowStart(now, hourlyWindowMs);
  const monthlyWindowStart = getWindowStart(now, monthlyWindowMs);

  const [hourlySnap, monthlySnap] = await Promise.all([
    firestore.collection(CONFIG.SMS_USER_BUDGET_COLLECTION).doc(`${uid}__${hourlyWindowStart}`).get(),
    firestore.collection(CONFIG.SMS_USER_MONTHLY_BUDGET_COLLECTION).doc(`${uid}__${monthlyWindowStart}`).get(),
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
        max: CONFIG.getSmsBudgetMaxPerWindowForTier(resolvedTier),
        windowStart: hourlyWindowStart,
        windowEnd: hourlyWindowStart + hourlyWindowMs,
      },
      monthly: {
        count: monthlyCount,
        max: CONFIG.SMS_USER_MONTHLY_BUDGET_MAX_PER_WINDOW,
        windowStart: monthlyWindowStart,
        windowEnd: monthlyWindowStart + monthlyWindowMs,
      },
    },
  };
});

// Helper to get recipients array from settings (supports both old and new format)
function getSmsRecipients(settings: SmsSettings): string[] {
  if (settings.recipients && settings.recipients.length > 0) {
    return settings.recipients;
  }
  if (settings.recipient) {
    return [settings.recipient];
  }
  return [];
}

// Send a test SMS to the configured recipients
export const sendTestSms = onCall({
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_MESSAGING_SERVICE_SID],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  await ensureNanoTierOrAdmin(uid, request.data?.clientTier);

  try {
    const snap = await firestore.collection('smsSettings').doc(uid).get();
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', 'SMS settings not found');
    }
    const settings = snap.data() as SmsSettings;
    const recipients = getSmsRecipients(settings);

    if (recipients.length === 0) {
      throw new HttpsError('failed-precondition', 'No recipient phone numbers configured');
    }

    const body = 'Exit1 SMS test: your alerts are ready.';
    
    // Send to all recipients
    for (const recipient of recipients) {
      await sendTwilioMessage(recipient, body);
      logger.info('sendTestSms: sent', { uid, recipient });
    }

    return { success: true };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Failed to send test SMS';
    logger.error('sendTestSms failed', error);
    throw new HttpsError('internal', message);
  }
});
