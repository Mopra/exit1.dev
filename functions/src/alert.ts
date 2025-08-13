import { getFirestore, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookPayload, WebhookEvent, EmailSettings } from './types';
import { Resend } from 'resend';
import { CONFIG } from './config';

export async function triggerAlert(website: Website, oldStatus: string, newStatus: string): Promise<void> {
  try {
    // Log the alert
    logger.info(`ALERT: Website ${website.name} (${website.url}) changed from ${oldStatus} to ${newStatus}`);
    logger.info(`ALERT: User ID: ${website.userId}`);
    
    // Determine webhook event type
    let eventType: WebhookEvent;
    if (newStatus === 'offline') {
      eventType = 'website_down';
    } else if (newStatus === 'online' && oldStatus === 'offline') {
      eventType = 'website_up';
    } else {
      eventType = 'website_error';
    }

    // Get user's webhook settings
    const firestore = getFirestore();
    const webhooksSnapshot = await firestore
      .collection("webhooks")
      .where("userId", "==", website.userId)
      .where("enabled", "==", true)
      .get();

    if (webhooksSnapshot.empty) {
      logger.info(`No active webhooks found for user ${website.userId}`);
    }

    // Send webhook notifications
    const webhookPromises = webhooksSnapshot.docs.map(async (doc: QueryDocumentSnapshot) => {
      const webhook = doc.data() as WebhookSettings;
      
      // Check if this webhook should handle this event
      if (!webhook.events.includes(eventType)) {
        return;
      }

      try {
        await sendWebhook(webhook, website, eventType, oldStatus);
        logger.info(`Webhook sent successfully to ${webhook.url} for website ${website.name}`);
      } catch (error) {
        logger.error(`Failed to send webhook to ${webhook.url}:`, error);
      }
    });

    await Promise.allSettled(webhookPromises);

    logger.info(`ALERT: Webhook processing completed`);
    logger.info(`ALERT: Starting email notification process for user ${website.userId}`);
    // Send email notifications via Resend
    logger.info(`ALERT: About to enter email notification try block`);
    try {
      // Load email settings for the user
      logger.info(`Looking for email settings for user: ${website.userId}`);
      const emailDoc = await firestore.collection('emailSettings').doc(website.userId).get();
      logger.info(`Email settings exists: ${emailDoc.exists}`);
      if (emailDoc.exists) {
        const emailSettings = emailDoc.data() as EmailSettings;
        if (emailSettings.recipient) {
          // Check global event filters
          const globalAllows = (emailSettings.events || []).includes(eventType);

          // Check per-check override
          const perCheck = emailSettings.perCheck?.[website.id];
          const perCheckEnabled = perCheck?.enabled;
          const perCheckAllows = perCheck?.events ? perCheck.events.includes(eventType) : undefined;

          const shouldSend = perCheckEnabled === true
            ? (perCheckAllows ?? globalAllows)
            : perCheckEnabled === false
              ? false
              : globalAllows; // fallback to global

          if (shouldSend) {
            const acquired = await acquireEmailThrottleSlot(website.userId, website.id, eventType);
            if (!acquired) {
              logger.info(`Email suppressed by throttle for ${website.name} (${eventType})`);
            } else {
              await sendEmailNotification(emailSettings.recipient, website, eventType, oldStatus);
              logger.info(`Email notification queued to ${emailSettings.recipient} for ${website.name}`);
            }
          } else {
            logger.info(`Email suppressed by settings for website ${website.name}`);
          }
        } else {
          logger.info(`Email recipient missing for user ${website.userId}`);
        }
      } else {
        logger.info(`No email settings found for user ${website.userId}`);
        // Debug: List all email settings documents
        const allEmailSettings = await firestore.collection('emailSettings').get();
        logger.info(`Total email settings documents: ${allEmailSettings.size}`);
        allEmailSettings.docs.forEach(doc => {
          logger.info(`Email settings doc ID: ${doc.id}, data: ${JSON.stringify(doc.data())}`);
        });
      }
    } catch (emailError) {
      logger.error('Error processing email notifications:', emailError);
      logger.error('Email error details:', JSON.stringify(emailError));
    }
    logger.info(`ALERT: Email notification processing completed`);
  } catch (error) {
    logger.error("Error in triggerAlert:", error);
  }
}

function getThrottleWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

async function acquireEmailThrottleSlot(userId: string, checkId: string, eventType: WebhookEvent): Promise<boolean> {
  try {
    const firestore = getFirestore();
    const windowMs = CONFIG.EMAIL_THROTTLE_WINDOW_MS;
    const now = Date.now();
    const windowStart = getThrottleWindowStart(now, windowMs);
    const docId = `${userId}__${checkId}__${eventType}__${windowStart}`;
    const docRef = firestore.collection(CONFIG.EMAIL_THROTTLE_COLLECTION).doc(docId);
    await docRef.create({
      userId,
      checkId,
      eventType,
      windowStart,
      windowEnd: windowStart + windowMs,
      createdAt: now,
      expireAt: Timestamp.fromMillis(windowStart + windowMs + (10 * 60 * 1000)), // keep small buffer past window
    });
    return true;
  } catch (error) {
    // Only suppress on already-exists; otherwise, log and allow send to avoid dropping alerts
    const code = (error as { code?: string; status?: string })?.code || (error as { code?: string; status?: string })?.status;
    if (code === 'ALREADY_EXISTS' || code === '6') {
      logger.info(`Throttle slot unavailable for ${userId}/${checkId}/${eventType}: already exists`);
      return false;
    }
    logger.warn(`Throttle check failed (allowing email) for ${userId}/${checkId}/${eventType}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

async function sendWebhook(
  webhook: WebhookSettings, 
  website: Website, 
  eventType: WebhookEvent, 
  previousStatus: string
): Promise<void> {
  const payload: WebhookPayload = {
    event: eventType,
    timestamp: Date.now(),
    website: {
      id: website.id,
      name: website.name,
      url: website.url,
      status: website.status,
      responseTime: website.responseTime,
      lastError: website.lastError,
      detailedStatus: website.detailedStatus,
    },
    previousStatus,
    userId: website.userId,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Exit1-Website-Monitor/1.0',
    ...webhook.headers,
  };

  // Add signature if secret is provided
  if (webhook.secret) {
    const crypto = await import('crypto');
    const signature = crypto
      .createHmac('sha256', webhook.secret)
      .update(JSON.stringify(payload))
      .digest('hex');
    headers['X-Exit1-Signature'] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    logger.info(`Webhook delivered successfully: ${webhook.url} (${response.status})`);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
} 

async function sendEmailNotification(
  toEmail: string,
  website: Website,
  eventType: WebhookEvent,
  previousStatus: string
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(resendApiKey);
  const fromAddress = process.env.RESEND_FROM || 'alerts@updates.exit1.dev';

  const subject =
    eventType === 'website_down'
      ? `ALERT: ${website.name} is DOWN`
      : eventType === 'website_up'
        ? `RESOLVED: ${website.name} is UP`
        : `NOTICE: ${website.name} error`;

  const statusLabel = website.detailedStatus || website.status;
  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${subject}</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${new Date().toLocaleString()}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
          <div><strong>Site:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          <div><strong>Current:</strong> ${statusLabel}</div>
          ${website.responseTime ? `<div><strong>Response:</strong> ${website.responseTime}ms</div>` : ''}
          ${website.lastError ? `<div><strong>Last error:</strong> ${website.lastError}</div>` : ''}
          <div><strong>Previous:</strong> ${previousStatus}</div>
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8">Manage email alerts in your Exit1 settings.</p>
      </div>
    </div>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: toEmail,
    subject,
    html,
  });
}