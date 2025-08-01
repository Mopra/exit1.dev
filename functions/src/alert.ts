import { getFirestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookPayload, WebhookEvent } from './types';

export async function triggerAlert(website: Website, oldStatus: string, newStatus: string): Promise<void> {
  try {
    // Log the alert
    logger.info(`ALERT: Website ${website.name} (${website.url}) changed from ${oldStatus} to ${newStatus}`);
    
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
      return;
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
  } catch (error) {
    logger.error("Error in triggerAlert:", error);
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