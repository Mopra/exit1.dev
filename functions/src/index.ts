/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { CONFIG } from "./config";
import { Website, WebhookSettings, WebhookPayload } from "./types";
import { triggerAlert } from './alert';
import { handleDiscordOAuthJoin } from './discord';

// Helper function to get user tier (defaults to free)
const getUserTier = async (uid: string): Promise<'free' | 'premium'> => {
  try {
    // TODO: Implement actual user tier logic based on subscription status
    // For now, default all users to free tier
    // This could check a users collection, subscription status, etc.
    return 'free';
  } catch (error) {
    logger.warn(`Error getting user tier for ${uid}, defaulting to free:`, error);
    return 'free';
  }
};

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

initializeApp({ credential: applicationDefault() });
const firestore = getFirestore();

// COST-OPTIMIZED: Single function that checks all websites in batches
// This replaces the expensive distributed system with one efficient function
export const checkAllWebsites = onSchedule(`every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`, async () => {
  try {
    // Get all websites that need checking (older than check interval)
    const checkIntervalAgo = Date.now() - CONFIG.CHECK_INTERVAL_MS;
    const websitesSnapshot = await firestore
      .collection("websites")
      .where("lastChecked", "<", checkIntervalAgo)
      .limit(CONFIG.MAX_WEBSITES_PER_RUN) // Safety limit
      .get();

    if (websitesSnapshot.empty) {
      logger.info("No websites need checking");
      return;
    }

    const websites = websitesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Array<Website>;

    // SMART FILTERING: Only check sites that are due and not disabled
    const now = Date.now();
    const filteredWebsites = websites.filter(website => {
      // Skip disabled websites
      if (website.disabled) return false;
      // Skip if not enough time has passed since last check
      const checkIntervalMs = (website.checkFrequency || CONFIG.FREE_TIER_CHECK_INTERVAL) * 60 * 1000;
      if (now - (website.lastChecked || 0) < checkIntervalMs) return false;
      return true;
    });

    logger.info(`Starting check: ${filteredWebsites.length} websites (filtered from ${websites.length} total)`);

    // PERFORMANCE OPTIMIZATION: Dynamic configuration based on load
    const batchSize = CONFIG.getOptimalBatchSize(filteredWebsites.length);
    const maxConcurrentChecks = CONFIG.getDynamicConcurrency(filteredWebsites.length);
    
    logger.info(`Performance settings: batchSize=${batchSize}, concurrency=${maxConcurrentChecks}`);

    // AGGREGATED LOGGING: Track overall statistics
    let totalChecked = 0;
    let totalUpdated = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalNoChanges = 0;
    let totalAutoDisabled = 0;
    let totalOnline = 0;
    let totalOffline = 0;

    // OPTIMIZED: Process all batches with true parallelism
    const allBatches = [];
    for (let i = 0; i < filteredWebsites.length; i += batchSize) {
      const batch = filteredWebsites.slice(i, i + batchSize);
      allBatches.push(batch);
    }
    
    // Process multiple batches in parallel (but limit total concurrency)
    const maxParallelBatches = Math.ceil(maxConcurrentChecks / 50); // Reasonable batch parallelism
    
    for (let batchGroup = 0; batchGroup < allBatches.length; batchGroup += maxParallelBatches) {
      const parallelBatches = allBatches.slice(batchGroup, batchGroup + maxParallelBatches);
      
      // Process batches in parallel
      const batchResults = await Promise.allSettled(
        parallelBatches.map(async (batch) => {
          const batchPromises = [];
          
          // Process each batch with high concurrency
          for (let j = 0; j < batch.length; j += maxConcurrentChecks) {
            const concurrentBatch = batch.slice(j, j + maxConcurrentChecks);
            const promises = concurrentBatch.map(async (website) => {
              // --- DEAD SITE SKIP & AUTO-DISABLE LOGIC ---
              if (website.disabled) {
                return { id: website.id, skipped: true, reason: 'disabled' };
              }
              
              // Auto-disable if too many consecutive failures
              if (website.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES && !website.disabled) {
                await firestore.collection("websites").doc(website.id).update({
                  disabled: true,
                  disabledAt: Date.now(),
                  disabledReason: "Too many consecutive failures, automatically disabled",
                  updatedAt: Date.now()
                });
                return { id: website.id, skipped: true, reason: 'auto-disabled-failures' };
              }
              
              if (CONFIG.shouldDisableWebsite(website)) {
                await firestore.collection("websites").doc(website.id).update({
                  disabled: true,
                  disabledAt: Date.now(),
                  disabledReason: "Auto-disabled after extended downtime",
                  updatedAt: Date.now()
                });
                return { id: website.id, skipped: true, reason: 'auto-disabled' };
              }
              
              try {
                const startTime = Date.now();
                const controller = new AbortController();
                
                // ADAPTIVE TIMEOUT: Use optimized timeout based on website performance
                const timeoutMs = CONFIG.getAdaptiveTimeout(website);
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                
                const response = await fetch(website.url, {
                  method: 'HEAD',
                  signal: controller.signal,
                  headers: {
                    'User-Agent': CONFIG.USER_AGENT,
                    'Accept': '*/*',
                    'Cache-Control': 'no-cache'
                  }
                });
                
                clearTimeout(timeoutId);
                const responseTime = Date.now() - startTime;
                
                const status = response.ok ? 'online' : 'offline';
                const now = Date.now();
                
                // CHANGE DETECTION: Only update if values have actually changed
                const hasChanges = 
                  website.status !== status ||
                  website.lastStatusCode !== response.status ||
                  Math.abs((website.responseTime || 0) - responseTime) > 100; // Allow small variance
                
                if (!hasChanges) {
                  // Only update lastChecked if no other changes
                  await firestore.collection("websites").doc(website.id).update({
                    lastChecked: now
                  });
                  return { id: website.id, status, responseTime, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                const updateData: Record<string, unknown> = {
                  status,
                  lastChecked: now,
                  updatedAt: now,
                  responseTime: status === 'online' ? responseTime : null,
                  lastStatusCode: response.status,
                  consecutiveFailures: status === 'online' ? 0 : (website.consecutiveFailures || 0) + 1
                };
                
                if (status === 'offline') {
                  updateData.downtimeCount = (Number(website.downtimeCount) || 0) + 1;
                  updateData.lastDowntime = now;
                  updateData.lastFailureTime = now;
                  updateData.lastError = null;
                } else {
                  updateData.lastError = null;
                }
                
                await firestore.collection("websites").doc(website.id).update(updateData);
                const oldStatus = website.status || 'unknown';
                if (oldStatus !== status && oldStatus !== 'unknown') {
                  await triggerAlert(website, oldStatus, status);
                }
                return { id: website.id, status, responseTime };
              } catch (error) {
                // Error handling with change detection
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                const now = Date.now();
                
                // Check if error state has actually changed
                const hasChanges = 
                  website.status !== 'offline' ||
                  website.lastError !== errorMessage;
                
                if (!hasChanges) {
                  // Only update lastChecked if no other changes
                  await firestore.collection("websites").doc(website.id).update({
                    lastChecked: now
                  });
                  return { id: website.id, status: 'offline', error: errorMessage, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                const updateData: Record<string, unknown> = {
                  status: 'offline',
                  lastChecked: now,
                  updatedAt: now,
                  lastError: errorMessage,
                  downtimeCount: (Number(website.downtimeCount) || 0) + 1,
                  lastDowntime: now,
                  lastFailureTime: now,
                  consecutiveFailures: (website.consecutiveFailures || 0) + 1
                };
                
                await firestore.collection("websites").doc(website.id).update(updateData);
                const oldStatus = website.status || 'unknown';
                const newStatus = 'offline';
                if (oldStatus !== newStatus && oldStatus !== 'unknown') {
                  await triggerAlert(website, oldStatus, newStatus);
                }
                return { id: website.id, status: 'offline', error: errorMessage };
              }
            });
            
            // Wait for current concurrent batch to complete
            const results = await Promise.allSettled(promises);
            batchPromises.push(...results);
            
            // MINIMAL DELAY: Only tiny delay if needed
            if (j + maxConcurrentChecks < batch.length && CONFIG.CONCURRENT_BATCH_DELAY_MS > 0) {
              await new Promise(resolve => setTimeout(resolve, CONFIG.CONCURRENT_BATCH_DELAY_MS));
            }
          }
          
          return batchPromises;
        })
      );
      
      // AGGREGATE RESULTS from parallel batches
      batchResults.forEach(batchResult => {
        if (batchResult.status === 'fulfilled') {
          const batchPromises = batchResult.value;
          const results = batchPromises.map(r => r.status === 'fulfilled' ? r.value : null).filter((r): r is NonNullable<typeof r> => r !== null);
          const batchUpdated = results.filter(r => !r.skipped).length;
          const batchFailed = batchPromises.filter(r => r.status === 'rejected').length;
          const batchSkipped = results.filter(r => r.skipped).length;
          const batchNoChanges = results.filter(r => r.skipped && r.reason === 'no-changes').length;
          const batchAutoDisabled = results.filter(r => r.skipped && (r.reason === 'auto-disabled' || r.reason === 'auto-disabled-failures')).length;
          const batchOnline = results.filter(r => !r.skipped && r.status === 'online').length;
          const batchOffline = results.filter(r => !r.skipped && r.status === 'offline').length;
          
          // Update totals
          totalChecked += results.length + batchFailed;
          totalUpdated += batchUpdated;
          totalFailed += batchFailed;
          totalSkipped += batchSkipped;
          totalNoChanges += batchNoChanges;
          totalAutoDisabled += batchAutoDisabled;
          totalOnline += batchOnline;
          totalOffline += batchOffline;
        }
      });
      
      // MINIMAL DELAY between batch groups
      if (batchGroup + maxParallelBatches < allBatches.length && CONFIG.BATCH_DELAY_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY_MS));
      }
    }
    
    // COMPREHENSIVE SUMMARY LOGGING
    const efficiency = totalChecked > 0 ? Math.round((totalNoChanges / totalChecked) * 100) : 0;
    const uptime = totalUpdated > 0 ? Math.round((totalOnline / totalUpdated) * 100) : 0;
    
    logger.info(`Run complete: ${totalChecked} checked, ${totalUpdated} updated, ${totalFailed} failed`);
    logger.info(`Efficiency: ${efficiency}% no-changes, ${totalSkipped} skipped (${totalAutoDisabled} auto-disabled)`);
    logger.info(`Status: ${totalOnline} online (${uptime}%), ${totalOffline} offline`);
    logger.info(`Performance: batchSize=${batchSize}, concurrency=${maxConcurrentChecks}`);
    
    // Log warnings for significant issues
    if (totalFailed > 0) {
      logger.warn(`High failure rate: ${totalFailed} failures out of ${totalChecked} checks`);
    }
    if (totalAutoDisabled > 0) {
      logger.warn(`Auto-disabled ${totalAutoDisabled} dead sites`);
    }
  } catch (error) {
    logger.error("Error in checkAllWebsites:", error);
  }
});



// Simulated uptime/downtime endpoint
export const timeBasedDowntime = onRequest((req, res) => {
  const currentMinute = new Date().getMinutes();
  // 2 minutes offline, then 2 minutes online (4-minute cycle)
  // Minutes 0-1: offline, Minutes 2-3: online, Minutes 4-5: offline, etc.
  if ((currentMinute % 4) < 2) {
    res.status(503).send('Offline');
  } else {
    res.status(200).send('Online');
  }
});

// Callable function to add a website
export const addWebsite = onCall(async (request) => {
  const { url, name } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  // Check user's current website count
  const userWebsites = await firestore.collection("websites").where("userId", "==", uid).get();
  if (userWebsites.size >= 10) {
    throw new Error("You have reached the maximum limit of 10 websites. Please delete some websites before adding new ones.");
  }
  
  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  // Check for duplicates within the same user
  const existing = await firestore.collection("websites").where("userId", "==", uid).where("url", "==", url).get();
  if (!existing.empty) {
    throw new Error("Website already exists in your list");
  }
  // Get user tier and determine check frequency
  const userTier = await getUserTier(uid);
  const checkFrequency = CONFIG.getCheckIntervalForTier(userTier);
  
  // Add website with new cost optimization fields
  const now = Date.now();
  const docRef = await firestore.collection("websites").add({
    url,
    name: name || url,
    userId: uid,
    userTier,
    checkFrequency,
    consecutiveFailures: 0,
    lastFailureTime: null,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    downtimeCount: 0,
    lastDowntime: null,
    status: "unknown",
    lastChecked: 0, // Will be checked on next scheduled run
  });
  return { id: docRef.id };
});

// Callable function to update a website
export const updateWebsite = onCall(async (request) => {
  const { id, url, name } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Website ID required");
  }
  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  // Check if website exists and belongs to user
  const websiteDoc = await firestore.collection("websites").doc(id).get();
  if (!websiteDoc.exists) {
    throw new Error("Website not found");
  }
  const websiteData = websiteDoc.data();
  if (websiteData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }
  // Update website
  await firestore.collection("websites").doc(id).update({
    url,
    name,
    updatedAt: Date.now(),
    lastChecked: 0, // Force re-check on next scheduled run
  });
  return { success: true };
});

// Callable function to delete a website
export const deleteWebsite = onCall(async (request) => {
  const { id } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Website ID required");
  }
  // Check if website exists and belongs to user
  const websiteDoc = await firestore.collection("websites").doc(id).get();
  if (!websiteDoc.exists) {
    throw new Error("Website not found");
  }
  const websiteData = websiteDoc.data();
  if (websiteData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }
  // Delete website
  await firestore.collection("websites").doc(id).delete();
  return { success: true };
});

// Function to enable/disable a website manually
export const toggleWebsiteStatus = onCall(async (request) => {
  const { id, disabled, reason } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Website ID required");
  }
  
  // Check if website exists and belongs to user
  const websiteDoc = await firestore.collection("websites").doc(id).get();
  if (!websiteDoc.exists) {
    throw new Error("Website not found");
  }
  const websiteData = websiteDoc.data();
  if (websiteData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }
  
  const now = Date.now();
  const updateData: Record<string, unknown> = {
    disabled: disabled,
    updatedAt: now
  };
  
  if (disabled) {
    updateData.disabledAt = now;
    updateData.disabledReason = reason || "Manually disabled by user";
  } else {
    updateData.disabledAt = null;
    updateData.disabledReason = null;
    // Reset failure tracking when re-enabling to ensure immediate checking
    updateData.consecutiveFailures = 0;
    updateData.lastFailureTime = null;
    updateData.lastChecked = 0; // Force immediate check on next run
    updateData.status = "unknown"; // Reset status to trigger fresh check
  }
  
  await firestore.collection("websites").doc(id).update(updateData);
  
  return { 
    success: true, 
    disabled,
    message: disabled ? "Website disabled" : "Website enabled"
  };
});

// Migration function to add cost optimization fields to existing websites
export const migrateWebsites = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  try {
    // Get all user's websites that don't have the new fields
    const userWebsitesSnapshot = await firestore
      .collection("websites")
      .where("userId", "==", uid)
      .get();
    
    if (userWebsitesSnapshot.empty) {
      return { message: "No websites found to migrate" };
    }
    
    const batch = firestore.batch();
    let migratedCount = 0;
    
    userWebsitesSnapshot.docs.forEach(doc => {
      const data = doc.data();
      
      // Check if website already has the new fields
      if (data.userTier && data.checkFrequency !== undefined) {
        return; // Already migrated
      }
      
      // Add missing fields with defaults
      const userTier = data.userTier || 'free';
      const checkFrequency = data.checkFrequency ?? CONFIG.getCheckIntervalForTier(userTier);
      
      batch.update(doc.ref, {
        userTier,
        checkFrequency,
        consecutiveFailures: data.consecutiveFailures ?? 0,
        lastFailureTime: data.lastFailureTime ?? null,
        disabled: data.disabled ?? false,
        updatedAt: Date.now()
      });
      
      migratedCount++;
    });
    
    if (migratedCount > 0) {
      await batch.commit();
      logger.info(`Migrated ${migratedCount} websites for user ${uid}`);
    }
    
    return { 
      success: true, 
      migratedCount,
      message: migratedCount > 0 ? `Migrated ${migratedCount} websites` : "No websites needed migration"
    };
  } catch (error) {
    logger.error("Error migrating websites:", error);
    throw new Error("Failed to migrate websites");
  }
});

// Optional: Manual trigger for immediate checking (for testing)
export const manualCheck = onCall(async (request) => {
  const { websiteId } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  if (websiteId) {
    // Check specific website
    const websiteDoc = await firestore.collection("websites").doc(websiteId).get();
    if (!websiteDoc.exists) {
      throw new Error("Website not found");
    }
    const websiteData = websiteDoc.data();
    if (websiteData?.userId !== uid) {
      throw new Error("Insufficient permissions");
    }
    
    // Perform immediate check
    try {
      const response = await fetch(websiteData.url, { 
        method: 'HEAD',
        headers: { 'User-Agent': CONFIG.USER_AGENT }
      });
      const status = response.ok ? 'online' : 'offline';
      
      await firestore.collection("websites").doc(websiteId).update({
        status,
        lastChecked: Date.now(),
        lastStatusCode: response.status
      });
      
      const oldStatus = websiteData.status || 'unknown';
      if (oldStatus !== status && oldStatus !== 'unknown') {
        await triggerAlert(websiteData as Website, oldStatus, status);
      }
      return { status, lastChecked: Date.now() };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await firestore.collection("websites").doc(websiteId).update({
        status: 'offline',
        lastChecked: Date.now(),
        lastError: errorMessage
      });
      const oldStatus = websiteData.status || 'unknown';
      const newStatus = 'offline';
      if (oldStatus !== newStatus && oldStatus !== 'unknown') {
        await triggerAlert(websiteData as Website, oldStatus, newStatus);
      }
      return { status: 'offline', error: errorMessage };
    }
  }
  
  throw new Error("Website ID required");
});

// Callable function to reorder websites
export const reorderWebsites = onCall(async (request) => {
  const { fromIndex, toIndex } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
    throw new Error("Invalid indices provided");
  }
  
  if (fromIndex === toIndex) {
    return { success: true }; // No reordering needed
  }
  
  try {
    // Get all user's websites ordered by creation time
    const userWebsitesSnapshot = await firestore
      .collection("websites")
      .where("userId", "==", uid)
      .orderBy("createdAt", "asc")
      .get();
    
    if (userWebsitesSnapshot.empty) {
      throw new Error("No websites found");
    }
    
    const websites = userWebsitesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    if (fromIndex >= websites.length || toIndex >= websites.length) {
      throw new Error("Invalid index provided");
    }
    
    // Reorder the array
    const [movedWebsite] = websites.splice(fromIndex, 1);
    websites.splice(toIndex, 0, movedWebsite);
    
    // Update the order by modifying creation timestamps
    // This ensures the order is maintained in future queries
    const batch = firestore.batch();
    const now = Date.now();
    
    websites.forEach((website, index) => {
      const docRef = firestore.collection("websites").doc(website.id);
      // Use a small increment to maintain order without affecting the original creation time too much
      const newCreatedAt = now + index;
      batch.update(docRef, { 
        createdAt: newCreatedAt,
        updatedAt: now
      });
    });
    
    await batch.commit();
    
    return { success: true };
  } catch (error) {
    logger.error("Error reordering websites:", error);
    throw new Error("Failed to reorder websites");
  }
});

// Status function for the status page
export const getSystemStatus = onCall(async () => {
  try {
    logger.info("Getting system status", { structuredData: true });

    // Single query to get recent errors
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const errorsSnapshot = await firestore
      .collection("websites")
      .where("lastError", "!=", null)
      .where("lastChecked", ">", oneDayAgo)
      .orderBy("lastChecked", "desc")
      .limit(10)
      .get();

    const recentErrors = errorsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        website: data.url || 'Unknown',
        error: data.lastError,
        timestamp: data.lastChecked,
        status: data.status
      };
    });

    // Get system uptime and performance metrics
    const systemInfo = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: Date.now(),
      version: process.version,
      platform: process.platform
    };

    return {
      success: true,
      data: {
        recentErrors,
        systemInfo,
        services: {
          firestore: true, // If we got here, Firestore is working
          functions: true, // If we got here, Functions is working
        }
      }
    };
  } catch (error) {
    logger.error("Error getting system status:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      data: {
        recentErrors: [],
        systemInfo: null,
        services: {
          firestore: false,
          functions: false,
        }
      }
    };
  }
});

// Callable function to save webhook settings
export const saveWebhookSettings = onCall(async (request) => {
  const { url, name, events, secret, headers } = request.data || {};
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

  // Check user's current webhook count (limit to 5 webhooks per user)
  const userWebhooks = await firestore.collection("webhooks").where("userId", "==", uid).get();
  if (userWebhooks.size >= 5) {
    throw new Error("You have reached the maximum limit of 5 webhooks. Please delete some webhooks before adding new ones.");
  }

  // Check for duplicates within the same user
  const existing = await firestore.collection("webhooks").where("userId", "==", uid).where("url", "==", url).get();
  if (!existing.empty) {
    throw new Error("Webhook URL already exists in your list");
  }

  const now = Date.now();
  const docRef = await firestore.collection("webhooks").add({
    url,
    name,
    userId: uid,
    enabled: true,
    events,
    secret: secret || null,
    headers: headers || {},
    createdAt: now,
    updatedAt: now,
  });

  return { id: docRef.id };
});

// Callable function to update webhook settings
export const updateWebhookSettings = onCall(async (request) => {
  const { id, url, name, events, enabled, secret, headers } = request.data || {};
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

  const updateData: Partial<WebhookSettings> = {
    updatedAt: Date.now(),
  };

  if (url !== undefined) updateData.url = url;
  if (name !== undefined) updateData.name = name;
  if (events !== undefined) updateData.events = events;
  if (enabled !== undefined) updateData.enabled = enabled;
  if (secret !== undefined) updateData.secret = secret || null;
  if (headers !== undefined) updateData.headers = headers || {};

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

  // Create test payload
  const testPayload: WebhookPayload = {
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

// Callable function to handle Discord OAuth completion and auto-invite
export const handleDiscordAuth = onCall(async (request) => {
  const { discordUserId, userEmail, username } = request.data || {};
  const uid = request.auth?.uid;
  
  if (!uid) {
    throw new Error("Authentication required");
  }

  if (!discordUserId) {
    throw new Error("Discord user ID required");
  }

  try {
    logger.info(`Processing Discord OAuth for user ${userEmail} (UID: ${uid}, Discord: ${discordUserId})`);

    // Handle Discord OAuth join - create invite or welcome existing member
    const result = await handleDiscordOAuthJoin(
      uid,
      discordUserId,
      userEmail || 'Unknown Email',
      username || 'Unknown User'
    );

    // Store Discord association in Firestore
    const now = Date.now();
    await firestore.collection("user_discord_connections").doc(uid).set({
      clerkUserId: uid,
      discordUserId,
      userEmail,
      username,
      connectedAt: now,
      lastUpdated: now,
      inviteCreated: !!result.inviteUrl,
      alreadyMember: !!result.alreadyMember
    }, { merge: true });

    logger.info(`Discord OAuth processing completed for ${userEmail}`);

    return {
      success: true,
      inviteUrl: result.inviteUrl,
      alreadyMember: result.alreadyMember,
      message: result.alreadyMember 
        ? 'Welcome back! You\'re already a member of our Discord server.' 
        : 'Discord invite created! Click the invite link to join our server.'
    };
  } catch (error) {
    logger.error(`Failed to handle Discord OAuth for user ${userEmail}:`, error);
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Failed to process Discord connection. Please try again or contact support.'
    };
  }
});
