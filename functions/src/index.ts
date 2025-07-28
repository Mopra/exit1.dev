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
import { Website, WebhookSettings, WebhookPayload, CheckHistory, CheckAggregation } from "./types";
import { triggerAlert } from './alert';
import { handleDiscordOAuthJoin } from './discord';
import * as tls from 'tls';
import { URL } from 'url';

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

// Helper function to update hourly aggregation for long-term storage
const updateHourlyAggregation = async (website: Website, checkResult: {
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
}, timestamp: number) => {
  try {
    // Round down to the start of the hour
    const hourTimestamp = Math.floor(timestamp / (60 * 60 * 1000)) * (60 * 60 * 1000);
    const aggregationId = `${website.id}_${hourTimestamp}`;
    const aggregationRef = firestore.collection("checkAggregations").doc(aggregationId);
    await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(aggregationRef);
      if (doc.exists) {
        // Update existing aggregation
        const data = doc.data() as CheckAggregation;
        const newTotalChecks = data.totalChecks + 1;
        const newOnlineChecks = data.onlineChecks + (checkResult.status === 'online' ? 1 : 0);
        const newOfflineChecks = data.offlineChecks + (checkResult.status === 'offline' ? 1 : 0);
        let newAvgResponseTime = data.averageResponseTime;
        let newMinResponseTime = data.minResponseTime;
        let newMaxResponseTime = data.maxResponseTime;
        if (checkResult.status === 'online' && typeof checkResult.responseTime === 'number') {
          const totalResponseTime = data.averageResponseTime * data.onlineChecks + checkResult.responseTime;
          newAvgResponseTime = totalResponseTime / newOnlineChecks;
          newMinResponseTime = Math.min(data.minResponseTime, checkResult.responseTime);
          newMaxResponseTime = Math.max(data.maxResponseTime, checkResult.responseTime);
        }
        const updateData = {
          totalChecks: newTotalChecks,
          onlineChecks: newOnlineChecks,
          offlineChecks: newOfflineChecks,
          averageResponseTime: newAvgResponseTime,
          minResponseTime: newMinResponseTime,
          maxResponseTime: newMaxResponseTime,
          uptimePercentage: (newOnlineChecks / newTotalChecks) * 100,
          lastStatus: checkResult.status,
          lastStatusCode: checkResult.statusCode,
          updatedAt: timestamp
        } as const;
        
        // Only add lastError if it's defined and not empty
        const newLastError = checkResult.error || data.lastError;
        if (newLastError && typeof newLastError === 'string' && newLastError.trim() !== '') {
          (updateData as Record<string, unknown>).lastError = newLastError;
        }
        
        transaction.update(aggregationRef, updateData);
      } else {
        // Create new aggregation
        const initialData: Omit<CheckAggregation, 'id'> = {
          websiteId: website.id,
          userId: website.userId,
          hourTimestamp,
          totalChecks: 1,
          onlineChecks: checkResult.status === 'online' ? 1 : 0,
          offlineChecks: checkResult.status === 'offline' ? 1 : 0,
          averageResponseTime: checkResult.status === 'online' && typeof checkResult.responseTime === 'number' ? checkResult.responseTime : 0,
          minResponseTime: checkResult.status === 'online' && typeof checkResult.responseTime === 'number' ? checkResult.responseTime : 0,
          maxResponseTime: checkResult.status === 'online' && typeof checkResult.responseTime === 'number' ? checkResult.responseTime : 0,
          uptimePercentage: checkResult.status === 'online' ? 100 : 0,
          lastStatus: checkResult.status,
          lastStatusCode: checkResult.statusCode,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        
        // Only add lastError if it's defined and not empty
        if (checkResult.error && typeof checkResult.error === 'string' && checkResult.error.trim() !== '') {
          (initialData as Record<string, unknown>).lastError = checkResult.error;
        }
        transaction.set(aggregationRef, initialData);
      }
    });
    // Clean up old aggregations (older than 30 days)
    const thirtyDaysAgo = timestamp - (30 * 24 * 60 * 60 * 1000);
    const oldAggregationsQuery = await firestore
      .collection("checkAggregations")
      .where("websiteId", "==", website.id)
      .where("hourTimestamp", "<", thirtyDaysAgo)
      .get();
    if (!oldAggregationsQuery.empty) {
      const batch = firestore.batch();
      oldAggregationsQuery.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }
  } catch (error) {
    logger.warn(`Error updating aggregation for website ${website.id}:`, error);
  }
};

// Update storeCheckHistory to call updateHourlyAggregation
const storeCheckHistory = async (website: Website, checkResult: {
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
}) => {
  try {
    const now = Date.now();
    const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
    // Create history entry with only defined values
    const historyEntry: Record<string, unknown> = {
      websiteId: website.id,
      userId: website.userId,
      timestamp: now,
      status: checkResult.status,
      statusCode: checkResult.statusCode || 0,
      createdAt: now
    };
    if (checkResult.status === 'online' && typeof checkResult.responseTime === 'number' && !isNaN(checkResult.responseTime)) {
      historyEntry.responseTime = checkResult.responseTime;
    }
    if (checkResult.error && typeof checkResult.error === 'string' && checkResult.error.trim() !== '') {
      historyEntry.error = checkResult.error;
    }
    await firestore.collection("checkHistory").add(historyEntry);
    // Update hourly aggregation
    await updateHourlyAggregation(website, checkResult, now);
    // Clean up old history entries (older than 24 hours)
    const oldHistoryQuery = await firestore
      .collection("checkHistory")
      .where("websiteId", "==", website.id)
      .where("timestamp", "<", twentyFourHoursAgo)
      .get();
    if (!oldHistoryQuery.empty) {
      const batch = firestore.batch();
      oldHistoryQuery.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }
  } catch (error) {
    logger.warn(`Error storing check history for website ${website.id}:`, error);
    // Don't throw - history storage failure shouldn't break the main check
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

// COST-OPTIMIZED: Single function that checks all checks in batches
// This replaces the expensive distributed system with one efficient function
export const checkAllChecks = onSchedule(`every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`, async () => {
  try {
    // Get all checks that need checking (older than check interval)
    const checkIntervalAgo = Date.now() - CONFIG.CHECK_INTERVAL_MS;
    const checksSnapshot = await firestore
      .collection("checks")
      .where("lastChecked", "<", checkIntervalAgo)
      .limit(CONFIG.MAX_WEBSITES_PER_RUN) // Safety limit
      .get();

    if (checksSnapshot.empty) {
      logger.info("No checks need checking");
      return;
    }

    const checks = checksSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Array<Website>;

    // SMART FILTERING: Only check sites that are due and not disabled
    const now = Date.now();
    const filteredChecks = checks.filter(check => {
      // Skip disabled checks
      if (check.disabled) return false;
      // Skip if not enough time has passed since last check
      const checkIntervalMs = (check.checkFrequency || CONFIG.FREE_TIER_CHECK_INTERVAL) * 60 * 1000;
      if (now - (check.lastChecked || 0) < checkIntervalMs) return false;
      return true;
    });

    logger.info(`Starting check: ${filteredChecks.length} checks (filtered from ${checks.length} total)`);

    // PERFORMANCE OPTIMIZATION: Dynamic configuration based on load
    const batchSize = CONFIG.getOptimalBatchSize(filteredChecks.length);
    const maxConcurrentChecks = CONFIG.getDynamicConcurrency(filteredChecks.length);
    
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
    for (let i = 0; i < filteredChecks.length; i += batchSize) {
      const batch = filteredChecks.slice(i, i + batchSize);
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
            const promises = concurrentBatch.map(async (check) => {
              // --- DEAD SITE SKIP & AUTO-DISABLE LOGIC ---
              if (check.disabled) {
                return { id: check.id, skipped: true, reason: 'disabled' };
              }
              
              // Auto-disable if too many consecutive failures
              if (check.consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES && !check.disabled) {
                await firestore.collection("checks").doc(check.id).update({
                  disabled: true,
                  disabledAt: Date.now(),
                  disabledReason: "Too many consecutive failures, automatically disabled",
                  updatedAt: Date.now()
                });
                return { id: check.id, skipped: true, reason: 'auto-disabled-failures' };
              }
              
              if (CONFIG.shouldDisableWebsite(check)) {
                await firestore.collection("checks").doc(check.id).update({
                  disabled: true,
                  disabledAt: Date.now(),
                  disabledReason: "Auto-disabled after extended downtime",
                  updatedAt: Date.now()
                });
                return { id: check.id, skipped: true, reason: 'auto-disabled' };
              }
              
              try {

                const now = Date.now();
                
                // Choose checking method based on website type
                const checkResult = await checkRestEndpoint(check);
                
                const status = checkResult.status;
                const responseTime = checkResult.responseTime;
                
                // Store check history (always store, regardless of changes)
                await storeCheckHistory(check, checkResult);
                
                // CHANGE DETECTION: Only update if values have actually changed
                const hasChanges = 
                  check.status !== status ||
                  check.lastStatusCode !== checkResult.statusCode ||
                  Math.abs((check.responseTime || 0) - responseTime) > 100; // Allow small variance
                
                if (!hasChanges) {
                  // Only update lastChecked if no other changes
                  await firestore.collection("checks").doc(check.id).update({
                    lastChecked: now
                  });
                  return { id: check.id, status, responseTime, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                const updateData: Record<string, unknown> = {
                  status,
                  lastChecked: now,
                  updatedAt: now,
                  responseTime: status === 'online' ? responseTime : null,
                  lastStatusCode: checkResult.statusCode,
                  consecutiveFailures: status === 'online' ? 0 : (check.consecutiveFailures || 0) + 1
                };
                

                
                // Add SSL certificate information if available
                if (checkResult.sslCertificate) {
                  // Clean SSL certificate data to remove undefined values
                  const cleanSslData: {
                    valid: boolean;
                    lastChecked: number;
                    issuer?: string;
                    subject?: string;
                    validFrom?: number;
                    validTo?: number;
                    daysUntilExpiry?: number;
                    error?: string;
                  } = {
                    valid: checkResult.sslCertificate.valid,
                    lastChecked: now
                  };
                  
                  if (checkResult.sslCertificate.issuer) cleanSslData.issuer = checkResult.sslCertificate.issuer;
                  if (checkResult.sslCertificate.subject) cleanSslData.subject = checkResult.sslCertificate.subject;
                  if (checkResult.sslCertificate.validFrom) cleanSslData.validFrom = checkResult.sslCertificate.validFrom;
                  if (checkResult.sslCertificate.validTo) cleanSslData.validTo = checkResult.sslCertificate.validTo;
                  if (checkResult.sslCertificate.daysUntilExpiry !== undefined) cleanSslData.daysUntilExpiry = checkResult.sslCertificate.daysUntilExpiry;
                  if (checkResult.sslCertificate.error) cleanSslData.error = checkResult.sslCertificate.error;
                  
                  updateData.sslCertificate = cleanSslData;
                }
                
                if (status === 'offline') {
                  updateData.downtimeCount = (Number(check.downtimeCount) || 0) + 1;
                  updateData.lastDowntime = now;
                  updateData.lastFailureTime = now;
                  updateData.lastError = null;
                } else {
                  updateData.lastError = null;
                }
                
                await firestore.collection("checks").doc(check.id).update(updateData);
                const oldStatus = check.status || 'unknown';
                if (oldStatus !== status && oldStatus !== 'unknown') {
                  await triggerAlert(check, oldStatus, status);
                }
                return { id: check.id, status, responseTime };
              } catch (error) {
                // Error handling with change detection
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                const now = Date.now();
                
                // Store check history for error case
                await storeCheckHistory(check, {
                  status: 'offline',
                  responseTime: 0,
                  statusCode: 0,
                  error: errorMessage
                });
                
                // Check if error state has actually changed
                const hasChanges = 
                  check.status !== 'offline' ||
                  check.lastError !== errorMessage;
                
                if (!hasChanges) {
                  // Only update lastChecked if no other changes
                  await firestore.collection("checks").doc(check.id).update({
                    lastChecked: now
                  });
                  return { id: check.id, status: 'offline', error: errorMessage, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                const updateData: Record<string, unknown> = {
                  status: 'offline',
                  lastChecked: now,
                  updatedAt: now,
                  lastError: errorMessage,
                  downtimeCount: (Number(check.downtimeCount) || 0) + 1,
                  lastDowntime: now,
                  lastFailureTime: now,
                  consecutiveFailures: (check.consecutiveFailures || 0) + 1
                };
                
                await firestore.collection("checks").doc(check.id).update(updateData);
                const oldStatus = check.status || 'unknown';
                const newStatus = 'offline';
                if (oldStatus !== newStatus && oldStatus !== 'unknown') {
                  await triggerAlert(check, oldStatus, newStatus);
                }
                return { id: check.id, status: 'offline', error: errorMessage };
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

// Callable function to add a check or REST endpoint
export const addCheck = onCall(async (request) => {
  const { 
    url, 
    name, 
    type = 'website',
    httpMethod = 'GET',
    expectedStatusCodes = [200, 201, 202],
    requestHeaders = {},
    requestBody = '',
    responseValidation = {}
  } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  // SPAM PROTECTION: Check user's current check count
  const userChecks = await firestore.collection("checks").where("userId", "==", uid).get();
  
  // Enforce maximum checks per user
  if (userChecks.size >= CONFIG.MAX_CHECKS_PER_USER) {
    throw new Error(`You have reached the maximum limit of ${CONFIG.MAX_CHECKS_PER_USER} checks. Please delete some checks before adding new ones.`);
  }
  
  // RATE LIMITING: Check recent additions
  const now = Date.now();
  const oneMinuteAgo = now - (60 * 1000);
  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  
  const recentChecks = userChecks.docs.filter(doc => {
    const createdAt = doc.data().createdAt;
    return createdAt >= oneMinuteAgo || createdAt >= oneHourAgo || createdAt >= oneDayAgo;
  });
  
  const checksLastMinute = recentChecks.filter(doc => doc.data().createdAt >= oneMinuteAgo).length;
  const checksLastHour = recentChecks.filter(doc => doc.data().createdAt >= oneHourAgo).length;
  const checksLastDay = recentChecks.filter(doc => doc.data().createdAt >= oneDayAgo).length;
  
  if (checksLastMinute >= CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE) {
    throw new Error(`Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE} checks per minute. Please wait before adding more.`);
  }
  
  if (checksLastHour >= CONFIG.RATE_LIMIT_CHECKS_PER_HOUR) {
    throw new Error(`Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_HOUR} checks per hour. Please wait before adding more.`);
  }
  
  if (checksLastDay >= CONFIG.RATE_LIMIT_CHECKS_PER_DAY) {
    throw new Error(`Rate limit exceeded: Maximum ${CONFIG.RATE_LIMIT_CHECKS_PER_DAY} checks per day. Please wait before adding more.`);
  }
  
  // URL VALIDATION: Enhanced validation with spam protection
  const urlValidation = CONFIG.validateUrl(url);
  if (!urlValidation.valid) {
    throw new Error(`URL validation failed: ${urlValidation.reason}`);
  }
  
  // Validate REST endpoint parameters
  if (type === 'rest_endpoint') {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(httpMethod)) {
      throw new Error("Invalid HTTP method. Must be one of: GET, POST, PUT, PATCH, DELETE, HEAD");
    }
    
    if (['POST', 'PUT', 'PATCH'].includes(httpMethod) && requestBody) {
      try {
        JSON.parse(requestBody);
      } catch {
        throw new Error("Request body must be valid JSON");
      }
    }
    
    if (!Array.isArray(expectedStatusCodes) || expectedStatusCodes.length === 0) {
      throw new Error("Expected status codes must be a non-empty array");
    }
  }
  
  // SUSPICIOUS PATTERN DETECTION: Check for spam patterns
  const existingChecks = userChecks.docs.map(doc => {
    const data = doc.data();
    return {
      url: data.url,
      name: data.name || data.url
    };
  });
  
  const patternCheck = CONFIG.detectSuspiciousPatterns(existingChecks, url, name);
  if (patternCheck.suspicious) {
    throw new Error(`Suspicious pattern detected: ${patternCheck.reason}. Please contact support if this is a legitimate use case.`);
  }
  
  // Check for duplicates within the same user and type
  const existing = await firestore.collection("checks").where("userId", "==", uid).where("url", "==", url).where("type", "==", type).get();
  if (!existing.empty) {
    const typeLabel = type === 'rest_endpoint' ? 'API' : 'website';
    throw new Error(`Check URL already exists in your ${typeLabel} list`);
  }
  
  // Get user tier and determine check frequency
  const userTier = await getUserTier(uid);
  const checkFrequency = CONFIG.getCheckIntervalForTier(userTier);
  
  // Add check with new cost optimization fields
  const docRef = await firestore.collection("checks").add({
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
    type,
    httpMethod,
    expectedStatusCodes,
    requestHeaders,
    requestBody,
    responseValidation
  });
  
  logger.info(`Check added successfully: ${url} by user ${uid} (${userChecks.size + 1}/${CONFIG.MAX_CHECKS_PER_USER} total checks)`);
  
  return { id: docRef.id };
});

// Callable function to update a check or REST endpoint
export const updateCheck = onCall(async (request) => {
  const { 
    id, 
    url, 
    name,
    type,
    httpMethod,
    expectedStatusCodes,
    requestHeaders,
    requestBody,
    responseValidation
  } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Check ID required");
  }
  
  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  
  // Validate REST endpoint parameters if provided
  if (type === 'rest_endpoint') {
    if (httpMethod && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(httpMethod)) {
      throw new Error("Invalid HTTP method. Must be one of: GET, POST, PUT, PATCH, DELETE, HEAD");
    }
    
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(httpMethod || 'GET')) {
      try {
        JSON.parse(requestBody);
      } catch {
        throw new Error("Request body must be valid JSON");
      }
    }
    
    if (expectedStatusCodes && (!Array.isArray(expectedStatusCodes) || expectedStatusCodes.length === 0)) {
      throw new Error("Expected status codes must be a non-empty array");
    }
  }
  
  // Check if check exists and belongs to user
  const checkDoc = await firestore.collection("checks").doc(id).get();
  if (!checkDoc.exists) {
    throw new Error("Check not found");
  }
  const checkData = checkDoc.data();
  if (checkData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }
  
  // Check for duplicates within the same user and type (excluding current check)
  const existing = await firestore.collection("checks")
    .where("userId", "==", uid)
    .where("url", "==", url)
    .where("type", "==", checkData.type)
    .get();
  
  const duplicateExists = existing.docs.some(doc => doc.id !== id);
  if (duplicateExists) {
    const typeLabel = checkData.type === 'rest_endpoint' ? 'API' : 'website';
    throw new Error(`Check URL already exists in your ${typeLabel} list`);
  }
  
  // Prepare update data
  const updateData: Record<string, unknown> = {
    url,
    name,
    updatedAt: Date.now(),
    lastChecked: 0, // Force re-check on next scheduled run
  };
  
  // Add REST endpoint fields if provided
  if (type !== undefined) updateData.type = type;
  if (httpMethod !== undefined) updateData.httpMethod = httpMethod;
  if (expectedStatusCodes !== undefined) updateData.expectedStatusCodes = expectedStatusCodes;
  if (requestHeaders !== undefined) updateData.requestHeaders = requestHeaders;
  if (requestBody !== undefined) updateData.requestBody = requestBody;
  if (responseValidation !== undefined) updateData.responseValidation = responseValidation;
  
  // Update check
  await firestore.collection("checks").doc(id).update(updateData);
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
  const websiteDoc = await firestore.collection("checks").doc(id).get();
  if (!websiteDoc.exists) {
    throw new Error("Website not found");
  }
  const websiteData = websiteDoc.data();
  if (websiteData?.userId !== uid) {
    throw new Error("Insufficient permissions");
  }
  // Delete website
  await firestore.collection("checks").doc(id).delete();
  return { success: true };
});

// Function to enable/disable a check manually
export const toggleCheckStatus = onCall(async (request) => {
  const { id, disabled, reason } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  if (!id) {
    throw new Error("Check ID required");
  }
  
  // Check if check exists and belongs to user
  const checkDoc = await firestore.collection("checks").doc(id).get();
  if (!checkDoc.exists) {
    throw new Error("Check not found");
  }
  const checkData = checkDoc.data();
  if (checkData?.userId !== uid) {
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
  
  await firestore.collection("checks").doc(id).update(updateData);
  
  return { 
    success: true, 
    disabled,
    message: disabled ? "Check disabled" : "Check enabled"
  };
});

// Migration function to add cost optimization fields to existing checks
export const migrateChecks = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  try {
    // Get all user's checks that don't have the new fields
    const userChecksSnapshot = await firestore
      .collection("checks")
      .where("userId", "==", uid)
      .get();
    
    if (userChecksSnapshot.empty) {
      return { message: "No checks found to migrate" };
    }
    
    const batch = firestore.batch();
    let migratedCount = 0;
    
    userChecksSnapshot.docs.forEach(doc => {
      const data = doc.data();
      
      // Check if check already has the new fields
      if (data.userTier && data.checkFrequency !== undefined && data.type !== undefined) {
        return; // Already migrated
      }
      
      // Add missing fields with defaults
      const userTier = data.userTier || 'free';
      const checkFrequency = data.checkFrequency ?? CONFIG.getCheckIntervalForTier(userTier);
      const type = data.type || 'website'; // Default to website type for existing checks
      
      batch.update(doc.ref, {
        userTier,
        checkFrequency,
        type,
        consecutiveFailures: data.consecutiveFailures ?? 0,
        lastFailureTime: data.lastFailureTime ?? null,
        disabled: data.disabled ?? false,
        updatedAt: Date.now()
      });
      
      migratedCount++;
    });
    
    if (migratedCount > 0) {
      await batch.commit();
      logger.info(`Migrated ${migratedCount} checks for user ${uid}`);
    }
    
    return { 
      success: true, 
      migratedCount,
      message: migratedCount > 0 ? `Migrated ${migratedCount} checks` : "No checks needed migration"
    };
  } catch (error) {
    logger.error("Error migrating checks:", error);
    throw new Error("Failed to migrate checks");
  }
});

// Optional: Manual trigger for immediate checking (for testing)
export const manualCheck = onCall(async (request) => {
  const { checkId } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  if (checkId) {
    // Check specific check
    const checkDoc = await firestore.collection("checks").doc(checkId).get();
    if (!checkDoc.exists) {
      throw new Error("Check not found");
    }
    const checkData = checkDoc.data();
    if (checkData?.userId !== uid) {
      throw new Error("Insufficient permissions");
    }
    
    // Perform immediate check using the same logic as scheduled checks
    try {
      const checkResult = await checkRestEndpoint(checkData as Website);
      const status = checkResult.status;
      const responseTime = checkResult.responseTime;
      
      // Store check history (always store, regardless of changes)
      await storeCheckHistory(checkData as Website, checkResult);
      
      const updateData: Record<string, unknown> = {
        status,
        lastChecked: Date.now(),
        updatedAt: Date.now(),
        responseTime: status === 'online' ? responseTime : null,
        lastStatusCode: checkResult.statusCode,
        consecutiveFailures: status === 'online' ? 0 : (checkData.consecutiveFailures || 0) + 1
      };
      
      // Add SSL certificate information if available
      if (checkResult.sslCertificate) {
        // Clean SSL certificate data to remove undefined values
        const cleanSslData: {
          valid: boolean;
          lastChecked: number;
          issuer?: string;
          subject?: string;
          validFrom?: number;
          validTo?: number;
          daysUntilExpiry?: number;
          error?: string;
        } = {
          valid: checkResult.sslCertificate.valid,
          lastChecked: Date.now()
        };
        
        if (checkResult.sslCertificate.issuer) cleanSslData.issuer = checkResult.sslCertificate.issuer;
        if (checkResult.sslCertificate.subject) cleanSslData.subject = checkResult.sslCertificate.subject;
        if (checkResult.sslCertificate.validFrom) cleanSslData.validFrom = checkResult.sslCertificate.validFrom;
        if (checkResult.sslCertificate.validTo) cleanSslData.validTo = checkResult.sslCertificate.validTo;
        if (checkResult.sslCertificate.daysUntilExpiry !== undefined) cleanSslData.daysUntilExpiry = checkResult.sslCertificate.daysUntilExpiry;
        if (checkResult.sslCertificate.error) cleanSslData.error = checkResult.sslCertificate.error;
        
        updateData.sslCertificate = cleanSslData;
      }
      
      if (status === 'offline') {
        updateData.downtimeCount = (Number(checkData.downtimeCount) || 0) + 1;
        updateData.lastDowntime = Date.now();
        updateData.lastFailureTime = Date.now();
        updateData.lastError = checkResult.error || null;
      } else {
        updateData.lastError = null;
      }
      
      await firestore.collection("checks").doc(checkId).update(updateData);
      
      const oldStatus = checkData.status || 'unknown';
      if (oldStatus !== status && oldStatus !== 'unknown') {
        await triggerAlert(checkData as Website, oldStatus, status);
      }
      return { status, lastChecked: Date.now() };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const now = Date.now();
      
      // Store check history for error case
      await storeCheckHistory(checkData as Website, {
        status: 'offline',
        responseTime: 0,
        statusCode: 0,
        error: errorMessage
      });
      
      const updateData: Record<string, unknown> = {
        status: 'offline',
        lastChecked: now,
        updatedAt: now,
        lastError: errorMessage,
        downtimeCount: (Number(checkData.downtimeCount) || 0) + 1,
        lastDowntime: now,
        lastFailureTime: now,
        consecutiveFailures: (checkData.consecutiveFailures || 0) + 1
      };
      
      await firestore.collection("checks").doc(checkId).update(updateData);
      
      const oldStatus = checkData.status || 'unknown';
      const newStatus = 'offline';
      if (oldStatus !== newStatus && oldStatus !== 'unknown') {
        await triggerAlert(checkData as Website, oldStatus, newStatus);
      }
      return { status: 'offline', error: errorMessage };
    }
  }
  
  throw new Error("Check ID required");
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
      .collection("checks")
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
      const docRef = firestore.collection("checks").doc(website.id);
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
      .collection("checks")
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

// Callable function to delete user account and all associated data
export const deleteUserAccount = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    logger.info(`Starting account deletion for user ${uid}`);

    // Delete all user's checks/websites
    const checksSnapshot = await firestore.collection("checks").where("userId", "==", uid).get();
    const checksBatch = firestore.batch();
    checksSnapshot.docs.forEach(doc => {
      checksBatch.delete(doc.ref);
    });

    // Delete all user's webhooks
    const webhooksSnapshot = await firestore.collection("webhooks").where("userId", "==", uid).get();
    const webhooksBatch = firestore.batch();
    webhooksSnapshot.docs.forEach(doc => {
      webhooksBatch.delete(doc.ref);
    });

    // Delete Discord connection if exists
    const discordConnectionRef = firestore.collection("user_discord_connections").doc(uid);
    const discordConnectionDoc = await discordConnectionRef.get();
    const discordBatch = firestore.batch();
    if (discordConnectionDoc.exists) {
      discordBatch.delete(discordConnectionRef);
    }

    // Execute all deletion batches
    await Promise.all([
      checksBatch.commit(),
      webhooksBatch.commit(),
      discordBatch.commit()
    ]);

    logger.info(`Deleted ${checksSnapshot.size} checks, ${webhooksSnapshot.size} webhooks, and Discord connection for user ${uid}`);

    // Note: Clerk user deletion should be handled on the frontend
    // as it requires the user's session and cannot be done from Firebase Functions

    return {
      success: true,
      deletedCounts: {
        checks: checksSnapshot.size,
        webhooks: webhooksSnapshot.size,
        discordConnection: discordConnectionDoc.exists ? 1 : 0
      },
      message: 'All user data has been deleted from the database. Please complete the account deletion in your account settings.'
    };
  } catch (error) {
    logger.error(`Failed to delete user account for ${uid}:`, error);
    throw new Error(`Failed to delete user account: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Callable function to get check history for a website
export const getCheckHistory = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { websiteId } = request.data;
  if (!websiteId) {
    throw new Error("Website ID is required");
  }

  try {
    // Verify the user owns this website
    const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
    if (!websiteDoc.exists) {
      throw new Error("Website not found");
    }
    
    const websiteData = websiteDoc.data() as Website;
    if (websiteData.userId !== uid) {
      throw new Error("Access denied");
    }

    // Get history for the last 24 hours
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    const historySnapshot = await firestore
      .collection("checkHistory")
      .where("websiteId", "==", websiteId)
      .where("timestamp", ">=", twentyFourHoursAgo)
      .orderBy("timestamp", "asc")
      .get();

    const history = historySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as CheckHistory[];

    return {
      success: true,
      history,
      count: history.length
    };
  } catch (error) {
    logger.error(`Failed to get check history for website ${websiteId}:`, error);
    throw new Error(`Failed to get check history: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Callable function to get check aggregations for a website
export const getCheckAggregations = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { websiteId, days = 7 } = request.data;
  if (!websiteId) {
    throw new Error("Website ID is required");
  }

  try {
    // Verify the user owns this website
    const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
    if (!websiteDoc.exists) {
      throw new Error("Website not found");
    }
    const websiteData = websiteDoc.data() as Website;
    if (websiteData.userId !== uid) {
      throw new Error("Access denied");
    }
    // Get aggregations for the specified number of days
    const startTimestamp = Date.now() - (days * 24 * 60 * 60 * 1000);
    const aggregationsSnapshot = await firestore
      .collection("checkAggregations")
      .where("websiteId", "==", websiteId)
      .where("hourTimestamp", ">=", startTimestamp)
      .orderBy("hourTimestamp", "asc")
      .get();
    const aggregations = aggregationsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as CheckAggregation[];
    return {
      success: true,
      aggregations,
      count: aggregations.length
    };
  } catch (error) {
    logger.error(`Failed to get check aggregations for website ${websiteId}:`, error);
    throw new Error(`Failed to get check aggregations: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Unified function to check both websites and REST endpoints with advanced validation
async function checkRestEndpoint(website: Website): Promise<{
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  responseBody?: string;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
}> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutMs = CONFIG.getAdaptiveTimeout(website);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {

    
    // Check SSL certificate first (for HTTPS URLs)
    let sslCertificate;
    if (website.url.startsWith('https://')) {
      sslCertificate = await checkSSLCertificate(website.url);
    }
    
    // Determine default values based on website type
    // Default to 'website' type if not specified (for backward compatibility)
    const websiteType = website.type || 'website';
    const defaultMethod = websiteType === 'website' ? 'HEAD' : 'GET';
    const defaultStatusCodes = websiteType === 'website' ? [200, 201, 202, 204, 301, 302, 404] : [200, 201, 202];
    
    // Prepare request options
    const requestOptions: RequestInit = {
      method: website.httpMethod || defaultMethod,
      signal: controller.signal,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': '*/*',
        'Cache-Control': 'no-cache',
        ...website.requestHeaders
      }
    };
    
    // Add request body for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(website.httpMethod || 'GET') && website.requestBody) {
      requestOptions.body = website.requestBody;
      requestOptions.headers = {
        ...requestOptions.headers,
        'Content-Type': 'application/json'
      };
    }
    
    const response = await fetch(website.url, requestOptions);
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    

    

    
    // Get response body for validation (only for small responses to avoid memory issues)
    let responseBody: string | undefined;
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) < 10000) { // Only read if < 10KB
      responseBody = await response.text();
    }
    
    // Check if status code is in expected range
    const expectedCodes = website.expectedStatusCodes || defaultStatusCodes;
    const statusCodeValid = expectedCodes.includes(response.status);
    
    // Validate response body if specified
    let bodyValidationPassed = true;
    if (responseBody && website.responseValidation) {
      const validation = website.responseValidation;
      
      // Check for required text in response
      if (validation.containsText && validation.containsText.length > 0) {
        bodyValidationPassed = validation.containsText.every(text => 
          responseBody!.toLowerCase().includes(text.toLowerCase())
        );
      }
      
      // JSONPath validation (if implemented)
      if (validation.jsonPath && validation.expectedValue !== undefined) {
        try {
          JSON.parse(responseBody); // Validate JSON format
          // TODO: Implement JSONPath validation
          // For now, we'll skip this validation
        } catch {
          bodyValidationPassed = false;
        }
      }
    }
    
    const isOnline = statusCodeValid && bodyValidationPassed;
    

    
    return {
      status: isOnline ? 'online' : 'offline',
      responseTime,
      statusCode: response.status,
      responseBody,
      sslCertificate
    };
    
  } catch (error) {
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    

    
    // Try to get SSL certificate even if HTTP request fails
    let sslCertificate;
    if (website.url.startsWith('https://')) {
      sslCertificate = await checkSSLCertificate(website.url);
    }
    
    return {
      status: 'offline',
      responseTime,
      statusCode: 0,
      error: errorMessage,
      sslCertificate
    };
  }
}

// Function to check SSL certificate validity
async function checkSSLCertificate(url: string): Promise<{
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  error?: string;
}> {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const port = urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80);
    
    // Only check SSL for HTTPS URLs
    if (urlObj.protocol !== 'https:') {
      return {
        valid: true // HTTP URLs don't need SSL
      };
    }

    return new Promise((resolve) => {
      const socket = tls.connect({
        host: hostname,
        port: parseInt(port.toString()),
        servername: hostname, // SNI support
        rejectUnauthorized: false, // Don't reject on certificate errors, we'll check manually
        timeout: 10000 // 10 second timeout
      });

      socket.on('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        
        if (!cert || Object.keys(cert).length === 0) {
          socket.destroy();
          resolve({
            valid: false,
            error: 'No certificate received'
          });
          return;
        }

        const now = Date.now();
        const validFrom = new Date(cert.valid_from).getTime();
        const validTo = new Date(cert.valid_to).getTime();
        const daysUntilExpiry = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));
        
        const isValid = now >= validFrom && now <= validTo;
        
        socket.destroy();
        
        const sslData: {
          valid: boolean;
          issuer: string;
          subject: string;
          validFrom: number;
          validTo: number;
          daysUntilExpiry: number;
          error?: string;
        } = {
          valid: isValid,
          issuer: cert.issuer?.CN || cert.issuer?.O || 'Unknown',
          subject: cert.subject?.CN || cert.subject?.O || hostname,
          validFrom,
          validTo,
          daysUntilExpiry
        };
        
        // Only add error field if there's an actual error
        if (!isValid) {
          sslData.error = `Certificate expired ${Math.abs(daysUntilExpiry)} days ago`;
        }
        
        resolve(sslData);
      });

      socket.on('error', (error) => {
        socket.destroy();
        resolve({
          valid: false,
          error: `SSL connection failed: ${error.message}`
        });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          valid: false,
          error: 'SSL connection timeout'
        });
      });
    });
  } catch (error) {
    return {
      valid: false,
      error: `SSL check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}
