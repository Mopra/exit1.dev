import { getFirestore, QueryDocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookPayload, WebhookEvent, EmailSettings } from './types';
import { Resend } from 'resend';
import { CONFIG } from './config';

export async function triggerAlert(
  website: Website,
  oldStatus: string,
  newStatus: string,
  counters?: { consecutiveFailures?: number; consecutiveSuccesses?: number }
): Promise<{ delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' }> {
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
            // Flap suppression: require N consecutive results before emailing
            const minN = Math.max(1, Number(emailSettings.minConsecutiveEvents) || 1);
            let consecutiveCount = 1;
            if (newStatus === 'offline') {
              consecutiveCount = (counters?.consecutiveFailures ?? (website as Website & { consecutiveSuccesses?: number }).consecutiveFailures ?? 0) as number;
            } else if (newStatus === 'online') {
              consecutiveCount = (counters?.consecutiveSuccesses ?? (website as Website & { consecutiveSuccesses?: number }).consecutiveSuccesses ?? 0) as number;
            }

            if (consecutiveCount < minN) {
              logger.info(`Email suppressed by flap suppression for ${website.name} (${eventType}) - ${consecutiveCount}/${minN}`);
              return { delivered: false, reason: 'flap' };
            }

            const acquired = await acquireEmailThrottleSlot(website.userId, website.id, eventType);
            if (!acquired) {
              logger.info(`Email suppressed by throttle for ${website.name} (${eventType})`);
              return { delivered: false, reason: 'throttle' };
            }

            try {
              await sendEmailNotification(emailSettings.recipient, website, eventType, oldStatus);
              logger.info(`Email sent successfully to ${emailSettings.recipient} for website ${website.name}`);
              return { delivered: true };
            } catch (emailError) {
              logger.error(`Failed to send email to ${emailSettings.recipient}:`, emailError);
              return { delivered: false, reason: 'none' };
            }
          } else {
            logger.info(`Email suppressed by settings for ${website.name} (${eventType})`);
            return { delivered: false, reason: 'settings' };
          }
        } else {
          logger.info(`No email recipient configured for user ${website.userId}`);
          return { delivered: false, reason: 'missingRecipient' };
        }
      } else {
        logger.info(`No email settings found for user ${website.userId}`);
        // Debug: List all email settings documents
        const allEmailSettings = await firestore.collection('emailSettings').get();
        logger.info(`Total email settings documents: ${allEmailSettings.size}`);
        allEmailSettings.docs.forEach(doc => {
          logger.info(`Email settings doc ID: ${doc.id}, data: ${JSON.stringify(doc.data())}`);
        });
        return { delivered: false, reason: 'settings' };
      }
    } catch (emailError) {
      logger.error('Error processing email notifications:', emailError);
      logger.error('Email error details:', JSON.stringify(emailError));
      return { delivered: false, reason: 'none' };
    }
    logger.info(`ALERT: Email notification processing completed`);
  } catch (error) {
    logger.error("Error in triggerAlert:", error);
    return { delivered: false, reason: 'none' };
  }
  return { delivered: false, reason: 'none' };
}

// New function to handle SSL certificate alerts
export async function triggerSSLAlert(
  website: Website,
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  }
): Promise<{ delivered: boolean; reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' }> {
  try {
    // Determine SSL alert type
    let eventType: WebhookEvent;
    let alertMessage: string;
    
    if (!sslCertificate.valid) {
      eventType = 'ssl_error';
      alertMessage = `SSL certificate is invalid: ${sslCertificate.error || 'Unknown error'}`;
    } else if (sslCertificate.daysUntilExpiry !== undefined && sslCertificate.daysUntilExpiry <= 30) {
      eventType = 'ssl_warning';
      alertMessage = `SSL certificate expires in ${sslCertificate.daysUntilExpiry} days`;
    } else {
      // No alert needed
      return { delivered: false, reason: 'none' };
    }

    logger.info(`SSL ALERT: Website ${website.name} (${website.url}) - ${alertMessage}`);
    logger.info(`SSL ALERT: User ID: ${website.userId}`);

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
        await sendSSLWebhook(webhook, website, eventType, sslCertificate);
        logger.info(`SSL webhook sent successfully to ${webhook.url} for website ${website.name}`);
      } catch (error) {
        logger.error(`Failed to send SSL webhook to ${webhook.url}:`, error);
      }
    });

    await Promise.allSettled(webhookPromises);

    logger.info(`SSL ALERT: Webhook processing completed`);
    logger.info(`SSL ALERT: Starting email notification process for user ${website.userId}`);

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
            // For SSL alerts, we don't use flap suppression since they're not status changes
            const acquired = await acquireEmailThrottleSlot(website.userId, website.id, eventType);
            if (!acquired) {
              logger.info(`SSL email suppressed by throttle for ${website.name} (${eventType})`);
              return { delivered: false, reason: 'throttle' };
            }

            try {
              await sendSSLEmailNotification(emailSettings.recipient, website, eventType, sslCertificate);
              logger.info(`SSL email sent successfully to ${emailSettings.recipient} for website ${website.name}`);
              return { delivered: true };
            } catch (emailError) {
              logger.error(`Failed to send SSL email to ${emailSettings.recipient}:`, emailError);
              return { delivered: false, reason: 'none' };
            }
          } else {
            logger.info(`SSL email suppressed by settings for ${website.name} (${eventType})`);
            return { delivered: false, reason: 'settings' };
          }
        } else {
          logger.info(`No email recipient configured for user ${website.userId}`);
          return { delivered: false, reason: 'missingRecipient' };
        }
      } else {
        logger.info(`No email settings found for user ${website.userId}`);
        return { delivered: false, reason: 'settings' };
      }
    } catch (emailError) {
      logger.error('Error processing SSL email notifications:', emailError);
      logger.error('SSL email error details:', JSON.stringify(emailError));
      return { delivered: false, reason: 'none' };
    }
    logger.info(`SSL ALERT: Email notification processing completed`);
  } catch (error) {
    logger.error("Error in triggerSSLAlert:", error);
    return { delivered: false, reason: 'none' };
  }
  return { delivered: false, reason: 'none' };
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
    const err = error as unknown as { code?: number | string; status?: string; message?: string };
    const codeString = typeof err.code === 'number' ? String(err.code) : (err.code || err.status || '');
    const message = (err.message || '').toUpperCase();
    const alreadyExists = codeString === '6' || codeString === 'ALREADY_EXISTS' || message.includes('ALREADY_EXISTS') || message.includes('ALREADY EXISTS');
    if (alreadyExists) {
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
      status: website.status || 'unknown',
      responseTime: website.responseTime,
      lastError: undefined,
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

// SSL-specific webhook function
async function sendSSLWebhook(
  webhook: WebhookSettings, 
  website: Website, 
  eventType: WebhookEvent, 
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  }
): Promise<void> {
  const payload: WebhookPayload = {
    event: eventType,
    timestamp: Date.now(),
    website: {
      id: website.id,
      name: website.name,
      url: website.url,
      status: website.status || 'unknown',
      responseTime: website.responseTime,
      lastError: undefined,
      detailedStatus: website.detailedStatus,
      sslCertificate: {
        valid: sslCertificate.valid,
        issuer: sslCertificate.issuer,
        subject: sslCertificate.subject,
        validFrom: sslCertificate.validFrom,
        validTo: sslCertificate.validTo,
        daysUntilExpiry: sslCertificate.daysUntilExpiry,
        error: sslCertificate.error,
      },
    },
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

    logger.info(`SSL webhook delivered successfully: ${webhook.url} (${response.status})`);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// SSL-specific email notification function
async function sendSSLEmailNotification(
  toEmail: string,
  website: Website,
  eventType: WebhookEvent,
  sslCertificate: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  }
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(resendApiKey);
  const fromAddress = process.env.RESEND_FROM || 'alerts@updates.exit1.dev';

  const subject =
    eventType === 'ssl_error'
      ? `SSL ERROR: ${website.name} certificate is invalid`
      : `SSL WARNING: ${website.name} certificate expires soon`;

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleDateString();
  };

  const sslDetails = `
    <div style="margin:8px 0;padding:8px;border-radius:6px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2)">
      <div><strong>Certificate Status:</strong> ${sslCertificate.valid ? 'Valid' : 'Invalid'}</div>
      ${sslCertificate.issuer ? `<div><strong>Issuer:</strong> ${sslCertificate.issuer}</div>` : ''}
      ${sslCertificate.subject ? `<div><strong>Subject:</strong> ${sslCertificate.subject}</div>` : ''}
      ${sslCertificate.validFrom ? `<div><strong>Valid From:</strong> ${formatDate(sslCertificate.validFrom)}</div>` : ''}
      ${sslCertificate.validTo ? `<div><strong>Valid Until:</strong> ${formatDate(sslCertificate.validTo)}</div>` : ''}
      ${sslCertificate.daysUntilExpiry !== undefined ? `<div><strong>Days Until Expiry:</strong> ${sslCertificate.daysUntilExpiry}</div>` : ''}
      ${sslCertificate.error ? `<div><strong>Error:</strong> ${sslCertificate.error}</div>` : ''}
    </div>
  `;

  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${subject}</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">${new Date().toLocaleString()}</p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2)">
          <div><strong>Site:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          ${sslDetails}
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8">Manage SSL alerts in your Exit1 settings.</p>
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