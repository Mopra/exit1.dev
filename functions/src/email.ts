import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { EmailSettings } from "./types";
import { RESEND_API_KEY, RESEND_FROM, CLERK_SECRET_KEY_PROD, getResendCredentials } from "./env";
import { Resend } from 'resend';
import { createClerkClient } from '@clerk/backend';

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
  const snap = await docRef.get();
  if (!snap.exists) {
    // initialize base settings disabled with placeholder recipient to allow overrides only after base saved
    await docRef.set({
      userId: uid,
      recipient: '',
      enabled: false,
      events: ['website_down','website_up','website_error'],
      perCheck: { [checkId]: { enabled, events } },
      createdAt: now,
      updatedAt: now,
    } as EmailSettings);
  } else {
    const current = snap.data() as EmailSettings;
    const perCheck = current.perCheck || {};
    const updatedCheck: Record<string, unknown> = { ...perCheck[checkId] };
    
    // Handle enabled tri-state: true/false/null (null clears override)
    if (enabled === null) {
      delete updatedCheck.enabled;
    } else if (enabled !== undefined) {
      updatedCheck.enabled = Boolean(enabled);
    }
    // Handle events override: array/null (null clears override)
    if (events === null) {
      delete updatedCheck.events;
    } else if (Array.isArray(events)) {
      updatedCheck.events = events;
    }
    
    perCheck[checkId] = updatedCheck;
    await docRef.update({ perCheck, updatedAt: now });
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

// Helper function to wrap HTML content in email template
function createEmailHTML(htmlContent: string, recipientEmail?: string): string {
  // Base URL for the application - defaults to exit1.dev, can be overridden via environment
  const baseUrl = process.env.FRONTEND_URL || 'https://exit1.dev';
  const profileUrl = `${baseUrl}/profile`;
  const optOutUrl = recipientEmail 
    ? `${baseUrl}/opt-out?email=${encodeURIComponent(recipientEmail)}`
    : profileUrl;
  
  // Wrap HTML content in email template with glassmorphism styling
  return `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        ${htmlContent}
        <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(148,163,184,0.15);text-align:center;font-size:12px;color:rgba(226,232,240,0.6)">
          <p style="margin:0 0 8px 0;">Don't want to receive product updates?</p>
          <p style="margin:0;">
            <a href="${profileUrl}" style="color:rgba(148,163,184,0.8);text-decoration:underline;">Manage your email preferences</a> or <a href="${optOutUrl}" style="color:rgba(148,163,184,0.8);text-decoration:underline;">opt out</a>
          </p>
        </div>
      </div>
    </div>
  `;
}

// Send email to a single user
export const sendSingleEmail = onCall({
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const { subject, htmlBody, recipientEmail, recipientId } = request.data || {};
    
    if (!subject || typeof subject !== 'string') {
      throw new HttpsError('invalid-argument', 'Subject is required');
    }
    
    if (!htmlBody || typeof htmlBody !== 'string') {
      throw new HttpsError('invalid-argument', 'Email body is required');
    }
    
    if (!recipientEmail && !recipientId) {
      throw new HttpsError('invalid-argument', 'Recipient email or ID is required');
    }

    const { apiKey } = getResendCredentials();
    if (!apiKey) {
      throw new HttpsError('failed-precondition', 'Email delivery is not configured');
    }

    // If recipientId is provided, fetch email from Clerk
    let email = recipientEmail;
    if (!email && recipientId) {
      const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
      if (!prodSecretKey) {
        throw new HttpsError('failed-precondition', 'Clerk configuration not found');
      }
      const clerkClient = createClerkClient({ secretKey: prodSecretKey });
      const clerkUser = await clerkClient.users.getUser(recipientId);
      email = clerkUser.emailAddresses[0]?.emailAddress;
      if (!email) {
        throw new HttpsError('not-found', 'User email not found');
      }
    }

    if (!email) {
      throw new HttpsError('invalid-argument', 'Valid recipient email is required');
    }

    logger.info('sendSingleEmail: preparing to send', { uid, recipientEmail: email, subject });

    const resend = new Resend(apiKey);
    const html = createEmailHTML(htmlBody, email);
    const manualFromAddress = 'Exit1.dev <morten@updates.exit1.dev>';

    const response = await resend.emails.send({
      from: manualFromAddress,
      to: email,
      subject: subject.trim(),
      html,
    });
    
    if (response.error) {
      logger.error('sendSingleEmail: resend error', { uid, error: response.error });
      throw new HttpsError('internal', response.error.message);
    }
    
    logger.info('sendSingleEmail: resend response', { uid, apiResponse: response.data });

    return { 
      success: true, 
      messageId: response.data?.id 
    };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Failed to send email';
    logger.error('sendSingleEmail failed', error);
    throw new HttpsError('internal', message);
  }
});

// Send bulk emails to multiple users (all or selected)
export const sendBulkEmail = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [RESEND_API_KEY, RESEND_FROM, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
  // The frontend already ensures only admin users can access this function

  try {
    const { subject, htmlBody, recipientIds } = request.data || {};
    
    if (!subject || typeof subject !== 'string') {
      throw new HttpsError('invalid-argument', 'Subject is required');
    }
    
    if (!htmlBody || typeof htmlBody !== 'string') {
      throw new HttpsError('invalid-argument', 'Email body is required');
    }

    const { apiKey } = getResendCredentials();
    if (!apiKey) {
      throw new HttpsError('failed-precondition', 'Email delivery is not configured');
    }

    logger.info('sendBulkEmail: preparing to send', { uid, subject, recipientCount: recipientIds?.length || 'all' });

    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    if (!prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Clerk configuration not found');
    }
    
    const clerkClient = createClerkClient({ secretKey: prodSecretKey });
    const resend = new Resend(apiKey);
    const trimmedSubject = subject.trim();
    const manualFromAddress = 'Exit1.dev <morten@updates.exit1.dev>';

    // Fetch all users from Clerk
    const allUsers: Array<{ id: string; emailAddresses?: Array<{ emailAddress?: string }> }> = [];
    let offset = 0;
    const limit = 500;
    let hasMore = true;
    
    while (hasMore) {
      const response = await clerkClient.users.getUserList({
        limit,
        offset,
      });
      
      if (response.data.length === 0) {
        hasMore = false;
        break;
      }
      
      allUsers.push(...response.data);
      offset += response.data.length;
      
      if (response.data.length < limit) {
        hasMore = false;
      }
    }

    logger.info(`sendBulkEmail: fetched ${allUsers.length} users from Clerk`);

    // Get email opt-out preferences for all users
    const userIds = allUsers.map(user => user.id);
    const userIdChunks: string[][] = [];
    for (let i = 0; i < userIds.length; i += 30) {
      userIdChunks.push(userIds.slice(i, i + 30));
    }

    const optedOutUserIds = new Set<string>();
    for (const chunk of userIdChunks) {
      const prefPromises = chunk.map(userId => 
        firestore.collection('userPreferences').doc(userId).get()
      );
      const prefDocs = await Promise.all(prefPromises);
      prefDocs.forEach((doc, index) => {
        if (doc.exists && doc.data()?.emailOptedOut === true) {
          optedOutUserIds.add(chunk[index]);
        }
      });
    }

    logger.info(`sendBulkEmail: found ${optedOutUserIds.size} opted-out users`);

    // Filter users if recipientIds is provided
    let usersToEmail = allUsers;
    if (recipientIds && Array.isArray(recipientIds) && recipientIds.length > 0) {
      const recipientIdSet = new Set(recipientIds);
      usersToEmail = allUsers.filter(user => recipientIdSet.has(user.id));
      logger.info(`sendBulkEmail: filtered to ${usersToEmail.length} recipients`);
    }

    // Filter out opted-out users
    usersToEmail = usersToEmail.filter(user => !optedOutUserIds.has(user.id));
    logger.info(`sendBulkEmail: filtered out opted-out users, ${usersToEmail.length} remaining`);

    // Extract valid email addresses
    const emailAddresses = usersToEmail
      .map(user => user.emailAddresses?.[0]?.emailAddress)
      .filter((email): email is string => typeof email === 'string' && email.length > 0);

    if (emailAddresses.length === 0) {
      throw new HttpsError('failed-precondition', 'No valid email addresses found');
    }

    logger.info(`sendBulkEmail: sending to ${emailAddresses.length} recipients`);

    // Send emails in batches of 50 to avoid timeout and rate limits
    const batchSize = 50;
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < emailAddresses.length; i += batchSize) {
      const batch = emailAddresses.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (email) => {
        try {
          // Personalize HTML for each recipient with their email in the opt-out link
          const personalizedHtml = createEmailHTML(htmlBody, email);
          const response = await resend.emails.send({
            from: manualFromAddress,
            to: email,
            subject: trimmedSubject,
            html: personalizedHtml,
          });
          
          if (response.error) {
            failed++;
            errors.push(`${email}: ${response.error.message}`);
            logger.error('sendBulkEmail: failed to send', { email, error: response.error });
          } else {
            sent++;
          }
        } catch (error) {
          failed++;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`${email}: ${errorMessage}`);
          logger.error('sendBulkEmail: exception sending email', { email, error });
        }
      });

      await Promise.all(batchPromises);
      
      logger.info(`sendBulkEmail: batch progress ${Math.min(i + batchSize, emailAddresses.length)}/${emailAddresses.length}`);
    }

    logger.info('sendBulkEmail: completed', { sent, failed, total: emailAddresses.length });

    return {
      success: true,
      sent,
      failed,
      total: emailAddresses.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Failed to send bulk email';
    logger.error('sendBulkEmail failed', error);
    throw new HttpsError('internal', message);
  }
});

