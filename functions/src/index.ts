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
import { Website, WebhookSettings, WebhookPayload, CheckHistory } from "./types";
import { triggerAlert } from './alert';
import { insertCheckHistory, BigQueryCheckHistoryRow } from './bigquery';

import * as tls from 'tls';
import { URL } from 'url';

// Initialize Firebase Admin
initializeApp({
  credential: applicationDefault(),
});

// Initialize Firestore
const firestore = getFirestore();

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





// Status update buffer for batching updates
const statusUpdateBuffer = new Map<string, {
  status?: string;
  lastChecked: number;
  responseTime?: number | null;
  statusCode?: number;
  lastError?: string | null;
  downtimeCount?: number;
  lastDowntime?: number;
  lastFailureTime?: number;
  consecutiveFailures?: number;
  detailedStatus?: string;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  disabled?: boolean;
  disabledAt?: number;
  disabledReason?: string;
  updatedAt: number;
}>();

// Flush status updates every 30 seconds
let statusFlushInterval: NodeJS.Timeout | null = null;

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, flushing status updates before shutdown...');
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
    statusFlushInterval = null;
  }
  await flushStatusUpdates();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, flushing status updates before shutdown...');
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
    statusFlushInterval = null;
  }
  await flushStatusUpdates();
  process.exit(0);
});

const initializeStatusFlush = () => {
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
  }
  
  statusFlushInterval = setInterval(async () => {
    try {
      await flushStatusUpdates();
      
      // Memory management: Log buffer size for monitoring
      if (statusUpdateBuffer.size > 1000) {
        logger.warn(`Status update buffer is large: ${statusUpdateBuffer.size} entries`);
      }
    } catch (error) {
      logger.error('Error flushing status updates:', error);
    }
  }, 30 * 1000); // Flush every 30 seconds
};

const flushStatusUpdates = async () => {
  if (statusUpdateBuffer.size === 0) return;
  
  logger.info(`Flushing status update buffer with ${statusUpdateBuffer.size} entries`);
  
  try {
    // Split large batches to avoid Firestore limits (500 operations per batch)
    const batchSize = 400; // Conservative limit
    const entries = Array.from(statusUpdateBuffer.entries());
    
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = firestore.batch();
      const batchEntries = entries.slice(i, i + batchSize);
      
      for (const [checkId, data] of batchEntries) {
        const docRef = firestore.collection("checks").doc(checkId);
        batch.update(docRef, data);
      }
      
      await batch.commit();
      logger.info(`Committed batch ${Math.floor(i / batchSize) + 1} with ${batchEntries.length} updates`);
    }
    
    logger.info(`Successfully updated ${statusUpdateBuffer.size} checks in total`);
  } catch (error) {
    logger.error('Error committing status update batch:', error);
    // Don't clear the buffer on error - let it retry on next flush
    return;
  }
  
  statusUpdateBuffer.clear();
};

// Store every check in BigQuery - no restrictions
const storeCheckHistory = async (website: Website, checkResult: {
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
}) => {
  try {
    const now = Date.now();
    
    // Store EVERY check in BigQuery
    await insertCheckHistory({
      id: `${website.id}_${now}_${Math.random().toString(36).substr(2, 9)}`,
      website_id: website.id,
      user_id: website.userId,
      timestamp: now,
      status: checkResult.status,
      response_time: checkResult.responseTime,
      status_code: checkResult.statusCode,
      error: checkResult.error,
    });
    
    // Also store in Firestore for real-time access (keep recent data)
    const historyEntry: Record<string, unknown> = {
      timestamp: now,
      status: checkResult.status,
      statusCode: checkResult.statusCode || 0,
      createdAt: now,
      detailedStatus: checkResult.detailedStatus
    };
    
    if (checkResult.status === 'online' && typeof checkResult.responseTime === 'number' && !isNaN(checkResult.responseTime)) {
      historyEntry.responseTime = checkResult.responseTime;
    }
    
    if (checkResult.error && typeof checkResult.error === 'string' && checkResult.error.trim() !== '') {
      historyEntry.error = checkResult.error;
    }
    
    // Use subcollection for better performance
    const historyRef = firestore
      .collection("checks")
      .doc(website.id)
      .collection("history")
      .doc();
      
    await historyRef.set(historyEntry);
    
    // No cleanup - keep all data in BigQuery for historical analysis
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

// COST-OPTIMIZED: Single function that checks all checks in batches
// This replaces the expensive distributed system with one efficient function
export const checkAllChecks = onSchedule(`every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`, async () => {
  try {
    // Initialize status flush interval if not already running
    if (!statusFlushInterval) {
      initializeStatusFlush();
    }
    
    // Circuit breaker: Check if we're in a failure state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failureCount = (global as any).__failureCount || 0;
    if (failureCount > 5) {
      logger.error(`Circuit breaker open: ${failureCount} consecutive failures. Skipping this run.`);
      return;
    }
    
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
                statusUpdateBuffer.set(check.id, {
                  disabled: true,
                  disabledAt: Date.now(),
                  disabledReason: "Too many consecutive failures, automatically disabled",
                  updatedAt: Date.now(),
                  lastChecked: Date.now()
                });
                return { id: check.id, skipped: true, reason: 'auto-disabled-failures' };
              }
              
              if (CONFIG.shouldDisableWebsite(check)) {
                statusUpdateBuffer.set(check.id, {
                  disabled: true,
                  disabledAt: Date.now(),
                  disabledReason: "Auto-disabled after extended downtime",
                  updatedAt: Date.now(),
                  lastChecked: Date.now()
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
                  statusUpdateBuffer.set(check.id, {
                    lastChecked: now,
                    updatedAt: now
                  });
                  return { id: check.id, status, responseTime, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const updateData: any = {
                  status,
                  lastChecked: now,
                  updatedAt: now,
                  responseTime: status === 'online' ? responseTime : null,
                  lastStatusCode: checkResult.statusCode,
                  consecutiveFailures: status === 'online' ? 0 : (check.consecutiveFailures || 0) + 1,
                  detailedStatus: checkResult.detailedStatus
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
                
                // Buffer the update instead of immediate Firestore write
                statusUpdateBuffer.set(check.id, updateData);
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
                  statusUpdateBuffer.set(check.id, {
                    lastChecked: now,
                    updatedAt: now
                  });
                  return { id: check.id, status: 'offline', error: errorMessage, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const updateData: any = {
                  status: 'offline',
                  lastChecked: now,
                  updatedAt: now,
                  lastError: errorMessage,
                  downtimeCount: (Number(check.downtimeCount) || 0) + 1,
                  lastDowntime: now,
                  lastFailureTime: now,
                  consecutiveFailures: (check.consecutiveFailures || 0) + 1,
                  detailedStatus: 'DOWN'
                };
                
                // Buffer the update instead of immediate Firestore write
                statusUpdateBuffer.set(check.id, updateData);
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
    
    // Circuit breaker: Increment failure count
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).__failureCount = ((global as any).__failureCount || 0) + 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger.error(`Circuit breaker failure count: ${(global as any).__failureCount}`);
  }
  
  // Circuit breaker: Reset on successful completion
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__failureCount = 0;
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
export const addCheck = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  try {
    logger.info('addCheck function called with data:', JSON.stringify(request.data));
    
    const { 
      url, 
      name, 
      checkFrequency,
      type = 'website',
      httpMethod = 'GET',
      expectedStatusCodes = [200, 201, 202],
      requestHeaders = {},
      requestBody = '',
      responseValidation = {}
    } = request.data || {};
    
    logger.info('Parsed data:', { url, name, checkFrequency, type });
    
    const uid = request.auth?.uid;
    if (!uid) {
      throw new Error("Authentication required");
    }
    
    logger.info('User authenticated:', uid);
    
    // SPAM PROTECTION: Check user's current check count
    const userChecks = await firestore.collection("checks").where("userId", "==", uid).get();
    
    logger.info('User checks count:', userChecks.size);
    
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
    
    logger.info('URL validation passed');
    
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
    
    logger.info('Duplicate check validation passed');
    
    // Get user tier and determine check frequency (use provided frequency or fall back to tier-based)
    const userTier = await getUserTier(uid);
    logger.info('User tier:', userTier);
    
    const finalCheckFrequency = checkFrequency || CONFIG.getCheckIntervalForTier(userTier);
    logger.info('Final check frequency:', finalCheckFrequency);
    
    // Get the highest orderIndex to add new check at the top
    const maxOrderIndex = userChecks.docs.length > 0 
      ? Math.max(...userChecks.docs.map(doc => doc.data().orderIndex || 0))
      : -1;
    
    logger.info('Max order index:', maxOrderIndex);
    
    // Add check with new cost optimization fields
    const docRef = await firestore.collection("checks").add({
      url,
      name: name || url,
      userId: uid,
      userTier,
      checkFrequency: finalCheckFrequency,
      consecutiveFailures: 0,
      lastFailureTime: null,
      disabled: false,
      createdAt: now,
      updatedAt: now,
      downtimeCount: 0,
      lastDowntime: null,
      status: "unknown",
      lastChecked: 0, // Will be checked on next scheduled run
      orderIndex: maxOrderIndex + 1, // Add to top of list
      type,
      httpMethod,
      expectedStatusCodes,
      requestHeaders,
      requestBody,
      responseValidation
    });
    
    logger.info(`Check added successfully: ${url} by user ${uid} (${userChecks.size + 1}/${CONFIG.MAX_CHECKS_PER_USER} total checks)`);
    
    return { id: docRef.id };
  } catch (error) {
    logger.error('Error in addCheck function:', error);
    throw error; // Re-throw to maintain the original error response
  }
});

// Callable function to get all checks for a user
export const getChecks = onCall({
  cors: true, // Enable CORS for this function
  maxInstances: 10, // Limit concurrent instances
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    const checksSnapshot = await firestore
      .collection("checks")
      .where("userId", "==", uid)
      .orderBy("orderIndex", "asc")
      .get();

    const checks = checksSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Website[];

    // Sort checks: those with orderIndex first, then by createdAt
    const sortedChecks = checks.sort((a, b) => {
      if (a.orderIndex !== undefined && b.orderIndex !== undefined) {
        return a.orderIndex - b.orderIndex;
      }
      if (a.orderIndex !== undefined) return -1;
      if (b.orderIndex !== undefined) return 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    return {
      success: true,
      data: sortedChecks,
      count: sortedChecks.length
    };
  } catch (error) {
    logger.error(`Failed to get checks for user ${uid}:`, error);
    throw new Error(`Failed to get checks: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Migration function to add orderIndex to existing checks
export const migrateOrderIndex = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }
  
  try {
    // Get all checks for the user that don't have orderIndex
    const checksWithoutOrderIndex = await firestore.collection("checks")
      .where("userId", "==", uid)
      .get();
    
    const checksToUpdate = checksWithoutOrderIndex.docs.filter(doc => 
      doc.data().orderIndex === undefined
    );
    
    if (checksToUpdate.length === 0) {
      return { message: "No checks need migration", updated: 0 };
    }
    
    // Update checks with orderIndex based on createdAt timestamp
    const batch = firestore.batch();
    const sortedChecks = checksToUpdate.sort((a, b) => 
      (a.data().createdAt || 0) - (b.data().createdAt || 0)
    );
    
    sortedChecks.forEach((doc, index) => {
      const docRef = firestore.collection("checks").doc(doc.id);
      batch.update(docRef, { orderIndex: index });
    });
    
    await batch.commit();
    
    logger.info(`Migrated orderIndex for ${sortedChecks.length} checks for user ${uid}`);
    return { 
      message: `Successfully migrated ${sortedChecks.length} checks`, 
      updated: sortedChecks.length 
    };
    
  } catch (error) {
    logger.error('Error migrating orderIndex:', error);
    throw new Error('Migration failed: ' + (error as Error).message);
  }
});

// Callable function to update a check or REST endpoint
export const updateCheck = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const { 
    id, 
    url, 
    name,
    checkFrequency,
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
  
  // Add checkFrequency if provided
  if (checkFrequency !== undefined) updateData.checkFrequency = checkFrequency;
  
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
export const deleteWebsite = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
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
export const toggleCheckStatus = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
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
      
      // Store check history using optimized approach
      await storeCheckHistory(checkData as Website, checkResult);
      
      const updateData: Record<string, unknown> = {
        status,
        lastChecked: Date.now(),
        updatedAt: Date.now(),
        responseTime: status === 'online' ? responseTime : null,
        lastStatusCode: checkResult.statusCode,
        consecutiveFailures: status === 'online' ? 0 : (checkData.consecutiveFailures || 0) + 1,
        detailedStatus: checkResult.detailedStatus
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
      
              // Store check history for error case using optimized approach
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
        consecutiveFailures: (checkData.consecutiveFailures || 0) + 1,
        detailedStatus: 'DOWN'
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

    // Execute all deletion batches
    await Promise.all([
      checksBatch.commit(),
      webhooksBatch.commit()
    ]);

    logger.info(`Deleted ${checksSnapshot.size} checks and ${webhooksSnapshot.size} webhooks for user ${uid}`);

    // Note: Clerk user deletion should be handled on the frontend
    // as it requires the user's session and cannot be done from Firebase Functions

    return {
      success: true,
      deletedCounts: {
        checks: checksSnapshot.size,
        webhooks: webhooksSnapshot.size
      },
      message: 'All user data has been deleted from the database. Please complete the account deletion in your account settings.'
    };
  } catch (error) {
    logger.error(`Failed to delete user account for ${uid}:`, error);
    throw new Error(`Failed to delete user account: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Callable function to get check history for a website
export const getCheckHistory = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
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
      .collection("checks")
      .doc(websiteId)
      .collection("history")
      .where("timestamp", ">=", twentyFourHoursAgo)
      .orderBy("timestamp", "asc")
      .get();

    const history = historySnapshot.docs.map(doc => ({
      id: doc.id,
      websiteId, // Add back for compatibility
      userId: uid, // Add back for compatibility
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

// Callable function to get paginated check history for a website
export const getCheckHistoryPaginated = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { websiteId, page = 1, limit = 10, searchTerm = '', statusFilter = 'all' } = request.data;
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

    // Build query with filters
    let query = firestore
      .collection("checks")
      .doc(websiteId)
      .collection("history")
      .orderBy("timestamp", "desc");

    // Apply status filter if specified
    if (statusFilter && statusFilter !== 'all') {
      query = query.where("status", "==", statusFilter);
    }

    // Get total count with filters applied
    const totalSnapshot = await query.count().get();
    const total = totalSnapshot.data().count;

    // Apply pagination
    const offset = (page - 1) * limit;
    const historySnapshot = await query
      .limit(limit)
      .offset(offset)
      .get();

    let history = historySnapshot.docs.map(doc => ({
      id: doc.id,
      websiteId, // Add back for compatibility
      userId: uid, // Add back for compatibility
      ...doc.data()
    })) as CheckHistory[];

    // Apply search filter on the client side if specified
    if (searchTerm && searchTerm.trim()) {
      const searchLower = searchTerm.toLowerCase();
      history = history.filter(entry => {
        // Search in error message
        if (entry.error && entry.error.toLowerCase().includes(searchLower)) {
          return true;
        }
        // Search in status code
        if (entry.statusCode && entry.statusCode.toString().includes(searchTerm)) {
          return true;
        }
        // Search in response time
        if (entry.responseTime && entry.responseTime.toString().includes(searchTerm)) {
          return true;
        }
        // Search in timestamp
        if (entry.timestamp && new Date(entry.timestamp).toISOString().includes(searchTerm)) {
          return true;
        }
        return false;
      });
    }

    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      data: history,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext,
        hasPrev
      }
    };
  } catch (error) {
    logger.error(`Failed to get paginated check history for website ${websiteId}:`, error);
    throw new Error(`Failed to get check history: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Callable function to get check history from BigQuery
export const getCheckHistoryBigQuery = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { 
    websiteId, 
    page = 1, 
    limit = 25, 
    searchTerm = '', 
    statusFilter = 'all',
    startDate,
    endDate
  } = request.data;
  if (!websiteId) {
    throw new Error("Website ID is required");
  }

  logger.info(`BigQuery request: websiteId=${websiteId}, page=${page}, limit=${limit}, statusFilter=${statusFilter}, searchTerm=${searchTerm}, startDate=${startDate}, endDate=${endDate}`);

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

    logger.info(`Website ownership verified for ${websiteId}`);

    // Import BigQuery function
    const { getCheckHistory } = await import('./bigquery.js');
    
    // Calculate offset for pagination
    const offset = (page - 1) * limit;
    
    logger.info(`Calling BigQuery with offset=${offset}`);
    
    // Get data from BigQuery with server-side filtering
    const history = await getCheckHistory(
      websiteId, 
      uid, 
      limit, 
      offset,
      startDate,
      endDate,
      statusFilter,
      searchTerm
    );

    // Get total count with same filters
    const totalHistory = await getCheckHistory(
      websiteId, 
      uid, 
      10000, 
      0,
      startDate,
      endDate,
      statusFilter,
      searchTerm
    );
    const total = totalHistory.length;
    
    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      data: {
        data: history.map((entry: BigQueryCheckHistoryRow) => ({
          id: entry.id,
          websiteId: entry.website_id,
          userId: entry.user_id,
          timestamp: new Date(entry.timestamp.value).getTime(),
          status: entry.status,
          responseTime: entry.response_time,
          statusCode: entry.status_code,
          error: entry.error,
          createdAt: new Date(entry.timestamp.value).getTime()
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext,
          hasPrev
        }
      }
    };
  } catch (error) {
    logger.error(`Failed to get BigQuery check history for website ${websiteId}:`, error);
    throw new Error(`Failed to get check history: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// New function to get aggregated statistics
export const getCheckStatsBigQuery = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { websiteId, startDate, endDate } = request.data;
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

    // Import BigQuery function
    const { getCheckStats } = await import('./bigquery.js');
    const stats = await getCheckStats(websiteId, uid, startDate, endDate);
    
    return {
      success: true,
      data: stats
    };
  } catch (error) {
    logger.error(`Failed to get BigQuery check stats for website ${websiteId}:`, error);
    throw new Error(`Failed to get check stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Callable function to get check history for statistics
export const getCheckHistoryForStats = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { websiteId, startDate, endDate } = request.data;
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

    // Import BigQuery function
    const { getCheckHistoryForStats } = await import('./bigquery.js');
    const history = await getCheckHistoryForStats(websiteId, uid, startDate, endDate);
    
    return {
      success: true,
      data: history.map((entry: BigQueryCheckHistoryRow) => ({
        id: entry.id,
        websiteId: entry.website_id,
        userId: entry.user_id,
        timestamp: new Date(entry.timestamp.value).getTime(),
        status: entry.status,
        responseTime: entry.response_time,
        statusCode: entry.status_code,
        error: entry.error,
        createdAt: new Date(entry.timestamp.value).getTime()
      }))
    };
  } catch (error) {
    logger.error(`Failed to get BigQuery check history for stats for website ${websiteId}:`, error);
    throw new Error(`Failed to get check history for stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Callable function to get incidents for a specific hour
export const getIncidentsForHour = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const { websiteId, hourStart, hourEnd } = request.data;
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

    // Import BigQuery function
    const { getIncidentsForHour } = await import('./bigquery.js');
    const incidents = await getIncidentsForHour(websiteId, uid, hourStart, hourEnd);
    
    return {
      success: true,
      data: incidents.map((entry: BigQueryCheckHistoryRow) => ({
        id: entry.id,
        websiteId: entry.website_id,
        userId: entry.user_id,
        timestamp: new Date(entry.timestamp.value).getTime(),
        status: entry.status,
        responseTime: entry.response_time,
        statusCode: entry.status_code,
        error: entry.error,
        createdAt: new Date(entry.timestamp.value).getTime()
      }))
    };
  } catch (error) {
    logger.error(`Failed to get BigQuery incidents for website ${websiteId}:`, error);
    throw new Error(`Failed to get incidents: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});



// Function to categorize status codes
function categorizeStatusCode(statusCode: number): 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' {
  if ([200, 201, 202, 204].includes(statusCode)) {
    return 'UP';
  } else if ([301, 302, 303, 307, 308].includes(statusCode)) {
    return 'REDIRECT';
  } else if ([400, 403, 404, 429].includes(statusCode)) {
    return 'REACHABLE_WITH_ERROR';
  } else {
    return 'DOWN';
  }
}

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
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
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
    const defaultStatusCodes = websiteType === 'website' ? [200, 201, 202, 204, 301, 302, 303, 307, 308, 404, 403, 429] : [200, 201, 202];
    
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
    
    // Check if status code is in expected range (for logging purposes)
    const expectedCodes = website.expectedStatusCodes || defaultStatusCodes;
    const statusCodeValid = expectedCodes.includes(response.status);
    
    // Validate response body if specified (for logging purposes)
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
    
    // Log validation results for debugging
    if (!statusCodeValid || !bodyValidationPassed) {
      logger.info(`Validation failed for ${website.url}: statusCodeValid=${statusCodeValid}, bodyValidationPassed=${bodyValidationPassed}`);
    }
    
    // Determine status based on status code categorization
    const detailedStatus = categorizeStatusCode(response.status);
    
    // For backward compatibility, map to online/offline
    // UP and REDIRECT are considered online, REACHABLE_WITH_ERROR and DOWN are considered offline
    const isOnline = detailedStatus === 'UP' || detailedStatus === 'REDIRECT';
    
    return {
      status: isOnline ? 'online' : 'offline',
      responseTime,
      statusCode: response.status,
      responseBody,
      sslCertificate,
      detailedStatus
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
      sslCertificate,
      detailedStatus: 'DOWN'
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
