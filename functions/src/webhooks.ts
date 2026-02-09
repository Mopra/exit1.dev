import { onCall } from "firebase-functions/v2/https";
import { firestore, getUserTierLive } from "./init";
import { WebhookSettings, WebhookCheckFilter } from "./types";
import { normalizeEventList } from "./webhook-events";
import { CONFIG } from "./config";

// Callable function to save webhook settings
export const saveWebhookSettings = onCall(async (request) => {
  const { url, name, events, secret, headers, webhookType, checkFilter } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  // Validate webhook URL
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid webhook URL");
  }

  if (!name || !events || events.length === 0) {
    throw new Error("Name and events are required");
  }

  const normalizedEvents = normalizeEventList(events);
  if (normalizedEvents.length === 0) {
    throw new Error("At least one valid event is required");
  }

  const normalizedCheckFilter = normalizeCheckFilter(checkFilter);
  const checkFilterIds = normalizedCheckFilter.checkIds ?? [];
  const checkFilterFolders = normalizedCheckFilter.folderPaths ?? [];
  if (normalizedCheckFilter.mode === 'include' && checkFilterIds.length === 0 && checkFilterFolders.length === 0) {
    throw new Error("At least one check or folder is required when targeting specific checks");
  }

  // Get user tier for webhook limit enforcement
  const userTier = await getUserTierLive(uid);
  const maxWebhooks = CONFIG.getMaxWebhooksForTier(userTier);

  // Check user's current webhook count and duplicates in a single query
  // This reduces 2 Firestore reads to 1
  const userWebhooks = await firestore.collection("webhooks").where("userId", "==", uid).get();
  if (userWebhooks.size >= maxWebhooks) {
    throw new Error(`You have reached the maximum of ${maxWebhooks} webhook${maxWebhooks === 1 ? '' : 's'} for your plan. ${userTier === 'free' ? 'Upgrade to Nano for up to ' + CONFIG.MAX_WEBHOOKS_PER_USER_NANO + ' webhooks.' : 'Please delete some webhooks before adding new ones.'}`);
  }
  
  // Check for duplicate URL in the same query results
  const hasDuplicate = userWebhooks.docs.some(doc => doc.data().url === url);
  if (hasDuplicate) {
    throw new Error("Webhook URL already exists in your list");
  }

  const now = Date.now();
  const docRef = await firestore.collection("webhooks").add({
    url,
    name,
    userId: uid,
    enabled: true,
    events: normalizedEvents,
    checkFilter: normalizedCheckFilter.mode === 'include' ? { mode: 'include', checkIds: checkFilterIds, folderPaths: checkFilterFolders } : { mode: 'all' },
    secret: secret || null,
    headers: headers || {},
    webhookType: webhookType || 'generic',
    createdAt: now,
    updatedAt: now,
  });

  return { id: docRef.id };
});

// Callable function to update webhook settings
export const updateWebhookSettings = onCall(async (request) => {
  const { id, url, name, events, enabled, secret, headers, webhookType, checkFilter } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  if (!id) {
    throw new Error("Webhook ID required");
  }

  // Check if webhook exists and belongs to user
  const webhookDoc = await firestore.collection("webhooks").doc(id).get();
  if (!webhookDoc.exists) {
    throw new Error("Webhook not found");
  }
  const webhookData = webhookDoc.data();
  if (webhookData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }

  // Validate URL if provided
  if (url) {
    try {
      new URL(url);
    } catch {
      throw new Error("Invalid webhook URL");
    }
  }

  const updateData: Record<string, unknown> = {
    updatedAt: Date.now(),
  };

  if (url !== undefined) updateData.url = url;
  if (name !== undefined) updateData.name = name;
  if (events !== undefined) {
    const normalizedEvents = normalizeEventList(events);
    // Allow empty events only when webhook is being disabled
    if (normalizedEvents.length === 0 && enabled !== false) {
      throw new Error("At least one valid event is required");
    }
    updateData.events = normalizedEvents;
  }
  if (checkFilter !== undefined) {
    const normalizedCheckFilter = normalizeCheckFilter(checkFilter);
    const checkFilterIds = normalizedCheckFilter.checkIds ?? [];
    const checkFilterFolders = normalizedCheckFilter.folderPaths ?? [];
    if (normalizedCheckFilter.mode === 'include' && checkFilterIds.length === 0 && checkFilterFolders.length === 0) {
      throw new Error("At least one check or folder is required when targeting specific checks");
    }
    updateData.checkFilter = normalizedCheckFilter.mode === 'include'
      ? { mode: 'include', checkIds: checkFilterIds, folderPaths: checkFilterFolders }
      : { mode: 'all' };
  }
  if (enabled !== undefined) updateData.enabled = enabled;
  if (secret !== undefined) updateData.secret = secret || null;
  if (headers !== undefined) updateData.headers = headers || {};
  if (webhookType !== undefined) updateData.webhookType = webhookType;

  await firestore.collection("webhooks").doc(id).update(updateData);
  return { success: true };
});

// Callable function to delete webhook
export const deleteWebhook = onCall(async (request) => {
  const { id } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Webhook ID required");
  }

  // Check if webhook exists and belongs to user
  const webhookDoc = await firestore.collection("webhooks").doc(id).get();
  if (!webhookDoc.exists) {
    throw new Error("Webhook not found");
  }
  const webhookData = webhookDoc.data();
  if (webhookData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }

  await firestore.collection("webhooks").doc(id).delete();
  return { success: true };
});

// Callable function to test webhook
export const testWebhook = onCall(async (request) => {
  const { id } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Webhook ID required");
  }

  // Check if webhook exists and belongs to user
  const webhookDoc = await firestore.collection("webhooks").doc(id).get();
  if (!webhookDoc.exists) {
    throw new Error("Webhook not found");
  }
  const webhookData = webhookDoc.data() as WebhookSettings;
  if (webhookData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }

  // Create test payload - detect Slack, Discord, and Teams webhooks and send appropriate format
  const isSlackWebhook = webhookData.webhookType === 'slack' || webhookData.url.includes('hooks.slack.com');
  const isDiscordWebhook = webhookData.webhookType === 'discord' || webhookData.url.includes('discord.com') || webhookData.url.includes('discordapp.com');
  const isTeamsWebhook = webhookData.webhookType === 'teams' || webhookData.url.includes('.webhook.office.com') || webhookData.url.includes('.logic.azure.com');

  let testPayload: object;
  if (isSlackWebhook) {
    // Send Slack-compatible payload
    testPayload = {
      text: "🔔 Exit1 Test Webhook - Your webhook is working correctly!"
    };
  } else if (isDiscordWebhook) {
    // Send Discord-compatible payload
    testPayload = {
      content: "🔔 **Exit1 Test Webhook** - Your webhook is working correctly!"
    };
  } else if (isTeamsWebhook) {
    // Send Microsoft Teams Adaptive Card payload
    testPayload = {
      type: "message",
      summary: "Exit1 Test Webhook",
      attachments: [{
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: [
            {
              type: "Container",
              style: "good",
              items: [
                {
                  type: "TextBlock",
                  text: "✅ Exit1 Test Webhook",
                  weight: "Bolder",
                  size: "Medium",
                  wrap: true,
                },
              ],
            },
            {
              type: "TextBlock",
              text: "Your webhook is working correctly!",
              wrap: true,
            },
          ],
        },
      }],
    };
  } else {
    // Send standard Exit1 webhook payload
    testPayload = {
      event: 'website_down',
      timestamp: Date.now(),
      website: {
        id: 'test-website-id',
        name: 'Test Website',
        url: 'https://example.com',
        status: 'offline',
        responseTime: 1500,
        lastError: 'Connection timeout',
      },
      previousStatus: 'online',
      userId: uid,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Exit1-Website-Monitor/1.0 (Test)',
    ...webhookData.headers,
  };

  // Add signature if secret is provided
  if (webhookData.secret) {
    const crypto = await import('crypto');
    const signature = crypto
      .createHmac('sha256', webhookData.secret)
      .update(JSON.stringify(testPayload))
      .digest('hex');
    headers['X-Exit1-Signature'] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(webhookData.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(testPayload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      message: response.ok ? 'Test webhook sent successfully!' : `HTTP ${response.status}: ${response.statusText}`
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      error: errorMessage,
      message: `Failed to send test webhook: ${errorMessage}`
    };
  }
});

// Callable function to bulk delete webhooks (reduces N function calls to 1)
export const bulkDeleteWebhooks = onCall(async (request) => {
  const { ids } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Webhook IDs array required");
  }

  // Limit batch size to prevent abuse
  const MAX_BATCH_SIZE = 10;
  const limitedIds = ids.slice(0, MAX_BATCH_SIZE);

  // Verify all webhooks exist and belong to user in a single query
  const FIRESTORE_IN_LIMIT = 10;
  const validIds: string[] = [];
  
  for (let i = 0; i < limitedIds.length; i += FIRESTORE_IN_LIMIT) {
    const chunk = limitedIds.slice(i, i + FIRESTORE_IN_LIMIT);
    const batchQuery = firestore.collection("webhooks")
      .where("userId", "==", uid)
      .where("__name__", "in", chunk);
    
    const snapshot = await batchQuery.get();
    snapshot.docs.forEach(doc => {
      validIds.push(doc.id);
    });
  }

  if (validIds.length === 0) {
    throw new Error("No valid webhooks found to delete");
  }

  // Batch delete all valid webhooks
  const batch = firestore.batch();
  validIds.forEach(id => {
    batch.delete(firestore.collection("webhooks").doc(id));
  });
  await batch.commit();

  return { success: true, deletedCount: validIds.length };
});

// Callable function to bulk update webhook status (reduces N function calls to 1)
export const bulkUpdateWebhookStatus = onCall(async (request) => {
  const { ids, enabled } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Webhook IDs array required");
  }
  if (typeof enabled !== 'boolean') {
    throw new Error("Enabled status (boolean) required");
  }

  // Limit batch size to prevent abuse
  const MAX_BATCH_SIZE = 10;
  const limitedIds = ids.slice(0, MAX_BATCH_SIZE);

  // Verify all webhooks exist and belong to user in a single query
  const FIRESTORE_IN_LIMIT = 10;
  const validIds: string[] = [];
  
  for (let i = 0; i < limitedIds.length; i += FIRESTORE_IN_LIMIT) {
    const chunk = limitedIds.slice(i, i + FIRESTORE_IN_LIMIT);
    const batchQuery = firestore.collection("webhooks")
      .where("userId", "==", uid)
      .where("__name__", "in", chunk);
    
    const snapshot = await batchQuery.get();
    snapshot.docs.forEach(doc => {
      validIds.push(doc.id);
    });
  }

  if (validIds.length === 0) {
    throw new Error("No valid webhooks found to update");
  }

  // Batch update all valid webhooks
  const batch = firestore.batch();
  const now = Date.now();
  validIds.forEach(id => {
    batch.update(firestore.collection("webhooks").doc(id), {
      enabled,
      updatedAt: now
    });
  });
  await batch.commit();

  return { success: true, updatedCount: validIds.length };
});

function normalizeCheckFilter(value: unknown): WebhookCheckFilter {
  if (!value || typeof value !== 'object') {
    return { mode: 'all' };
  }

  const raw = value as { mode?: unknown; checkIds?: unknown; folderPaths?: unknown };
  const mode = raw.mode === 'include' ? 'include' : 'all';
  const rawIds = Array.isArray(raw.checkIds) ? raw.checkIds : [];
  const checkIds = Array.from(
    new Set(
      rawIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    )
  );

  const rawFolders = Array.isArray(raw.folderPaths) ? raw.folderPaths : [];
  const folderPaths = Array.from(
    new Set(
      rawFolders
        .filter((fp): fp is string => typeof fp === 'string')
        .map((fp) => fp.trim())
        .filter((fp) => fp.length > 0)
    )
  );

  return { mode, checkIds, folderPaths };
}

