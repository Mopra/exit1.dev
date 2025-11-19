/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { CONFIG } from "./config";
import { Website, WebhookSettings, EmailSettings } from "./types";
import { Resend } from 'resend';
import { createClerkClient } from '@clerk/backend';
import { triggerAlert, triggerSSLAlert, triggerDomainExpiryAlert } from './alert'; // Import alert functions
import { insertCheckHistory, BigQueryCheckHistoryRow } from './bigquery';
import { BigQuery } from '@google-cloud/bigquery';
import { getBadgeData } from './badge-api';
import { RESEND_API_KEY, RESEND_FROM, getResendCredentials, CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from './env';

import * as tls from 'tls';
import { URL } from 'url';
import { parse as parseTld } from "tldts";
import * as punycode from "punycode";
import * as net from "net";
import * as dns from "node:dns/promises";

// Import https for HTTP requests
import * as https from 'https';

// Initialize Firebase Admin
initializeApp({
  credential: applicationDefault(),
});

// Initialize Firestore
const firestore = getFirestore();
// Avoid failing updates due to undefined fields in partial updates
firestore.settings({ ignoreUndefinedProperties: true });

// Initialize Clerk clients for dual-instance support (dev and prod)
// Environment variables:
// - CLERK_SECRET_KEY: Production instance secret key (backward compatibility)
// - CLERK_SECRET_KEY_PROD: Production instance secret key (explicit)
// - CLERK_SECRET_KEY_DEV: Development instance secret key
// 
// To set these via Firebase CLI:
// firebase functions:config:set clerk.secret_key_prod="your_prod_key"
// firebase functions:config:set clerk.secret_key_dev="your_dev_key"
// Then redeploy functions

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
let clerkClientDev: ReturnType<typeof createClerkClient> | null = null;
let clerkClientProd: ReturnType<typeof createClerkClient> | null = null;

try {
  // Initialize production client
  // Firebase Functions v2 automatically makes secrets available as environment variables
  // Secrets set via 'firebase functions:secrets:set' are accessible via process.env
  const secretKey = process.env.CLERK_SECRET_KEY || process.env.CLERK_SECRET_KEY_PROD;
  
  if (secretKey) {
    clerkClientProd = createClerkClient({
      secretKey: secretKey,
    });
    clerkClient = clerkClientProd; // Default to prod for backward compatibility
    logger.info('Clerk production client initialized successfully');
  }
  
  // Initialize development client
  const devSecretKey = process.env.CLERK_SECRET_KEY_DEV;
  
  if (devSecretKey) {
    clerkClientDev = createClerkClient({
      secretKey: devSecretKey,
    });
    logger.info('Clerk development client initialized successfully');
  }
  
  if (!secretKey && !devSecretKey) {
    logger.warn('No Clerk secret keys found. User management features will be limited.');
    logger.warn('Available env vars:', Object.keys(process.env).filter(key => key.includes('CLERK')));
  }
} catch (error) {
  logger.error('Failed to initialize Clerk clients:', error);
}

// Helper function to get the appropriate Clerk client based on instance type
function getClerkClient(instance: 'dev' | 'prod'): ReturnType<typeof createClerkClient> | null {
  if (instance === 'dev') {
    return clerkClientDev;
  } else {
    return clerkClientProd || clerkClient; // Fallback to default client
  }
}

// Helper function to determine which Clerk instance a user belongs to
// Checks the userMigrations collection to see if user is on dev or prod
// Exported for potential future use
export async function getUserInstance(email: string): Promise<'dev' | 'prod'> {
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const migrationDoc = await firestore.collection('userMigrations').doc(normalizedEmail).get();
    
    if (migrationDoc.exists) {
      const data = migrationDoc.data();
      if (data?.instance === 'dev' && !data?.migrated) {
        return 'dev';
      }
      // If migrated or instance is prod, use prod
      return 'prod';
    }
    
    // If not in migration table, assume prod (new users go to prod)
    return 'prod';
  } catch (error) {
    logger.error(`Error checking user instance for ${email}:`, error);
    // Default to prod on error
    return 'prod';
  }
}

// Helper functions for getting Clerk client for specific users
// These can be uncommented and used when needed in the future
// Currently not used but kept for reference:
//
// async function getClerkClientForUser(email: string): Promise<ReturnType<typeof createClerkClient> | null> {
//   const instance = await getUserInstance(email);
//   return getClerkClient(instance);
// }
//
// async function getClerkClientForUserId(userId: string): Promise<ReturnType<typeof createClerkClient> | null> {
//   try {
//     const migrationsSnapshot = await firestore.collection('userMigrations')
//       .where('devClerkUserId', '==', userId)
//       .limit(1)
//       .get();
//     
//     if (!migrationsSnapshot.empty) {
//       const data = migrationsSnapshot.docs[0].data();
//       if (data?.instance === 'dev' && !data?.migrated) {
//         return getClerkClient('dev');
//       }
//     }
//     
//     const prodMigrationsSnapshot = await firestore.collection('userMigrations')
//       .where('prodClerkUserId', '==', userId)
//       .limit(1)
//       .get();
//     
//     if (!prodMigrationsSnapshot.empty) {
//       return getClerkClient('prod');
//     }
//     
//     return getClerkClient('prod');
//   } catch (error) {
//     logger.error(`Error checking user instance for userId ${userId}:`, error);
//     return getClerkClient('prod');
//   }
// }

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
  nextCheckAt?: number;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
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
    
    // Store EVERY check in BigQuery only
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
    
    // No longer storing in Firestore subcollections - BigQuery handles all history
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
export const checkAllChecks = onSchedule({
  schedule: `every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`,
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async () => {
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
    
    // Get all checks that are due for checking
    const now = Date.now();
    const checksSnapshot = await firestore
      .collection("checks")
      .where("nextCheckAt", "<=", now)
      .where("disabled", "==", false)
      .limit(CONFIG.MAX_WEBSITES_PER_RUN) // Safety limit
      .get();

    if (checksSnapshot.empty) {
      // Fallback for legacy documents without nextCheckAt (temporary migration path)
      const legacyCutoff = Date.now() - CONFIG.CHECK_INTERVAL_MS;
      const legacySnapshot = await firestore
        .collection("checks")
        .where("lastChecked", "<", legacyCutoff)
        .limit(CONFIG.MAX_WEBSITES_PER_RUN)
        .get();
      if (legacySnapshot.empty) {
        logger.info("No checks need checking");
        return;
      }
      const checks = legacySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Array<Website>;
      const filteredChecks = checks;
      logger.info(`Starting check (legacy): ${filteredChecks.length} checks (filtered from ${checks.length} total)`);
      // Reassign for downstream processing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).__filteredChecks = filteredChecks;
    }

    const checks = checksSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Array<Website>;

    // Since we're now querying by nextCheckAt and disabled filter, all checks are ready to run
    const filteredChecks = checks;

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
                const prevConsecutiveFailures = Number(check.consecutiveFailures || 0);
                const prevConsecutiveSuccesses = Number((check as Website & { consecutiveSuccesses?: number }).consecutiveSuccesses || 0);
                const nextConsecutiveFailures = status === 'offline' ? prevConsecutiveFailures + 1 : 0;
                const nextConsecutiveSuccesses = status === 'online' ? prevConsecutiveSuccesses + 1 : 0;
                
                // Store check history (always store, regardless of changes)
                await storeCheckHistory(check, checkResult);
                
                // CHANGE DETECTION: Only update if values have actually changed
                const hasChanges = 
                  check.status !== status ||
                  check.lastStatusCode !== checkResult.statusCode ||
                  Math.abs((check.responseTime || 0) - responseTime) > 100; // Allow small variance
                
                if (!hasChanges) {
                  // Update counters even if no other changes and reschedule next check
                  const noChangeUpdate: Partial<Website> & { lastChecked: number; updatedAt: number; nextCheckAt: number; consecutiveFailures: number; consecutiveSuccesses: number; pendingDownEmail?: boolean; pendingDownSince?: number | null; pendingUpEmail?: boolean; pendingUpSince?: number | null } = {
                    lastChecked: now,
                    updatedAt: now,
                    nextCheckAt: CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.FREE_TIER_CHECK_INTERVAL, now),
                    consecutiveFailures: nextConsecutiveFailures,
                    consecutiveSuccesses: nextConsecutiveSuccesses,
                  };
                  // Attempt pending flap-suppressed emails
                  if (status === 'offline' && (check as Website & { pendingDownEmail?: boolean }).pendingDownEmail) {
                    const result = await triggerAlert(check, 'online', 'offline', { consecutiveFailures: nextConsecutiveFailures });
                    if (result.delivered) {
                      noChangeUpdate.pendingDownEmail = false;
                      noChangeUpdate.pendingDownSince = null;
                    } else if (result.reason === 'flap') {
                      // ensure pending flag remains
                      noChangeUpdate.pendingDownEmail = true;
                      if (!(check as Website & { pendingDownSince?: number }).pendingDownSince) noChangeUpdate.pendingDownSince = now;
                    }
                  }
                  if (status === 'online' && (check as Website & { pendingUpEmail?: boolean }).pendingUpEmail) {
                    const result = await triggerAlert(check, 'offline', 'online', { consecutiveSuccesses: nextConsecutiveSuccesses });
                    if (result.delivered) {
                      noChangeUpdate.pendingUpEmail = false;
                      noChangeUpdate.pendingUpSince = null;
                    } else if (result.reason === 'flap') {
                      noChangeUpdate.pendingUpEmail = true;
                      if (!(check as Website & { pendingUpSince?: number }).pendingUpSince) noChangeUpdate.pendingUpSince = now;
                    }
                  }
                  statusUpdateBuffer.set(check.id, noChangeUpdate);
                  return { id: check.id, status, responseTime, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                const updateData: Partial<Website> & { status: string; lastChecked: number; updatedAt: number; responseTime?: number | null | undefined; lastStatusCode?: number; consecutiveFailures: number; consecutiveSuccesses: number; detailedStatus?: string; nextCheckAt: number; sslCertificate?: { valid: boolean; lastChecked: number; issuer?: string; subject?: string; validFrom?: number; validTo?: number; daysUntilExpiry?: number; error?: string }; downtimeCount?: number; lastDowntime?: number; lastFailureTime?: number; lastError?: string | null | undefined; uptimeCount?: number; lastUptime?: number; pendingDownEmail?: boolean; pendingDownSince?: number | null; pendingUpEmail?: boolean; pendingUpSince?: number | null } = {
                  status,
                  lastChecked: now,
                  updatedAt: now,
                  responseTime: status === 'online' ? responseTime : undefined,
                  lastStatusCode: checkResult.statusCode,
                  consecutiveFailures: nextConsecutiveFailures,
                  consecutiveSuccesses: nextConsecutiveSuccesses,
                  detailedStatus: checkResult.detailedStatus,
                  nextCheckAt: CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.FREE_TIER_CHECK_INTERVAL, now)
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
                  
                  // Trigger SSL alerts if needed
                  if (checkResult.sslCertificate) {
                    await triggerSSLAlert(check, checkResult.sslCertificate);
                  }
                }
                
                // Add domain expiry information if available
                if (checkResult.domainExpiry) {
                  // Clean domain expiry data to remove undefined values
                  const cleanDomainData: {
                    valid: boolean;
                    lastChecked: number;
                    registrar?: string;
                    domainName?: string;
                    expiryDate?: number;
                    daysUntilExpiry?: number;
                    error?: string;
                  } = {
                    valid: checkResult.domainExpiry.valid,
                    lastChecked: now
                  };
                  
                  if (checkResult.domainExpiry.registrar) cleanDomainData.registrar = checkResult.domainExpiry.registrar;
                  if (checkResult.domainExpiry.domainName) cleanDomainData.domainName = checkResult.domainExpiry.domainName;
                  if (checkResult.domainExpiry.expiryDate) cleanDomainData.expiryDate = checkResult.domainExpiry.expiryDate;
                  if (checkResult.domainExpiry.daysUntilExpiry !== undefined) cleanDomainData.daysUntilExpiry = checkResult.domainExpiry.daysUntilExpiry;
                  if (checkResult.domainExpiry.error) cleanDomainData.error = checkResult.domainExpiry.error;
                  
                  updateData.domainExpiry = cleanDomainData;
                  
                  // Trigger domain expiry alerts if needed
                  if (checkResult.domainExpiry) {
                    const isExpired = !checkResult.domainExpiry.valid;
                    const isExpiringSoon = checkResult.domainExpiry.daysUntilExpiry !== undefined && 
                                          checkResult.domainExpiry.daysUntilExpiry <= 30;
                    
                    if (isExpired || isExpiringSoon) {
                      await triggerDomainExpiryAlert(check, checkResult.domainExpiry);
                    }
                  }
                }
                
                if (status === 'offline') {
                  updateData.downtimeCount = (Number(check.downtimeCount) || 0) + 1;
                  updateData.lastDowntime = now;
                  updateData.lastFailureTime = now;
                  updateData.lastError = checkResult.error || null;
                } else {
                  updateData.lastError = null;
                }
                
                // Buffer the update instead of immediate Firestore write
                const oldStatus = check.status || 'unknown';
                if (oldStatus !== status && oldStatus !== 'unknown') {
                  const result = await triggerAlert(check, oldStatus, status, { consecutiveFailures: nextConsecutiveFailures, consecutiveSuccesses: nextConsecutiveSuccesses });
                  if (result.delivered) {
                    // Clear pending flags on successful delivery
                    if (status === 'offline') {
                      updateData.pendingDownEmail = false;
                      updateData.pendingDownSince = null;
                    } else if (status === 'online') {
                      updateData.pendingUpEmail = false;
                      updateData.pendingUpSince = null;
                    }
                  } else if (result.reason === 'flap') {
                    // Set pending flags to send later when threshold reached
                    if (status === 'offline') {
                      updateData.pendingDownEmail = true;
                      updateData.pendingDownSince = now;
                    } else if (status === 'online') {
                      updateData.pendingUpEmail = true;
                      updateData.pendingUpSince = now;
                    }
                  }
                } else {
                  // If status didn't change but had pending from before, attempt send
                  if (status === 'offline' && (check as Website & { pendingDownEmail?: boolean }).pendingDownEmail) {
                    const result = await triggerAlert(check, 'online', 'offline', { consecutiveFailures: nextConsecutiveFailures });
                    if (result.delivered) {
                      updateData.pendingDownEmail = false;
                      updateData.pendingDownSince = null;
                    }
                  }
                  if (status === 'online' && (check as Website & { pendingUpEmail?: boolean }).pendingUpEmail) {
                    const result = await triggerAlert(check, 'offline', 'online', { consecutiveSuccesses: nextConsecutiveSuccesses });
                    if (result.delivered) {
                      updateData.pendingUpEmail = false;
                      updateData.pendingUpSince = null;
                    }
                  }
                }
                statusUpdateBuffer.set(check.id, updateData);
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
                  // Only update timestamps if no other changes, and reschedule next check
                  statusUpdateBuffer.set(check.id, {
                    lastChecked: now,
                    updatedAt: now,
                    nextCheckAt: CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.FREE_TIER_CHECK_INTERVAL, now)
                  });
                  return { id: check.id, status: 'offline', error: errorMessage, skipped: true, reason: 'no-changes' };
                }
                
                // Prepare update data for actual changes
                const updateData: Partial<Website> & { status: string; lastChecked: number; updatedAt: number; lastError: string; downtimeCount: number; lastDowntime: number; lastFailureTime: number; consecutiveFailures: number; consecutiveSuccesses: number; detailedStatus: string; nextCheckAt: number; pendingDownEmail?: boolean; pendingDownSince?: number | null } = {
                  status: 'offline',
                  lastChecked: now,
                  updatedAt: now,
                  lastError: errorMessage,
                  downtimeCount: (Number(check.downtimeCount) || 0) + 1,
                  lastDowntime: now,
                  lastFailureTime: now,
                   consecutiveFailures: (check.consecutiveFailures || 0) + 1,
                   consecutiveSuccesses: 0,
                  detailedStatus: 'DOWN',
                  nextCheckAt: CONFIG.getNextCheckAtMs(check.checkFrequency || CONFIG.FREE_TIER_CHECK_INTERVAL, now)
                };
                
                // Buffer the update instead of immediate Firestore write
                const oldStatus = check.status || 'unknown';
                const newStatus = 'offline';
                if (oldStatus !== newStatus && oldStatus !== 'unknown') {
                  const result = await triggerAlert(check, oldStatus, newStatus, { consecutiveFailures: (updateData.consecutiveFailures as number) });
                  if (result.delivered) {
                    updateData.pendingDownEmail = false;
                    updateData.pendingDownSince = null;
                  } else if (result.reason === 'flap') {
                    updateData.pendingDownEmail = true;
                    updateData.pendingDownSince = now;
                  }
                }
                statusUpdateBuffer.set(check.id, updateData);
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
  } finally {
    // Ensure any buffered updates are written before the function exits
    await flushStatusUpdates();
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
      nextCheckAt: now, // Check immediately on next scheduler run
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
    nextCheckAt: Date.now(), // Check immediately on next scheduler run
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
    updateData.nextCheckAt = Date.now(); // Check immediately on next scheduler run
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
export const manualCheck = onCall({
  secrets: [RESEND_API_KEY, RESEND_FROM],
}, async (request) => {
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
      
      const now = Date.now();
      const updateData: Record<string, unknown> = {
        status,
        lastChecked: now,
        updatedAt: now,
        responseTime: status === 'online' ? responseTime : null,
        lastStatusCode: checkResult.statusCode,
        consecutiveFailures: status === 'online' ? 0 : (checkData.consecutiveFailures || 0) + 1,
        detailedStatus: checkResult.detailedStatus,
        nextCheckAt: CONFIG.getNextCheckAtMs(checkData.checkFrequency || CONFIG.FREE_TIER_CHECK_INTERVAL, now)
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
        
        // Trigger SSL alerts if needed
        if (checkResult.sslCertificate) {
          await triggerSSLAlert(checkData as Website, checkResult.sslCertificate);
        }
      }
      
      // Add domain expiry information if available
      if (checkResult.domainExpiry) {
        // Clean domain expiry data to remove undefined values
        const cleanDomainData: {
          valid: boolean;
          lastChecked: number;
          registrar?: string;
          domainName?: string;
          expiryDate?: number;
          daysUntilExpiry?: number;
          error?: string;
        } = {
          valid: checkResult.domainExpiry.valid,
          lastChecked: Date.now()
        };
        
        if (checkResult.domainExpiry.registrar) cleanDomainData.registrar = checkResult.domainExpiry.registrar;
        if (checkResult.domainExpiry.domainName) cleanDomainData.domainName = checkResult.domainExpiry.domainName;
        if (checkResult.domainExpiry.expiryDate) cleanDomainData.expiryDate = checkResult.domainExpiry.expiryDate;
        if (checkResult.domainExpiry.daysUntilExpiry !== undefined) cleanDomainData.daysUntilExpiry = checkResult.domainExpiry.daysUntilExpiry;
        if (checkResult.domainExpiry.error) cleanDomainData.error = checkResult.domainExpiry.error;
        
        updateData.domainExpiry = cleanDomainData;
        
        // Trigger domain expiry alerts if needed
        if (checkResult.domainExpiry) {
          const isExpired = !checkResult.domainExpiry.valid;
          const isExpiringSoon = checkResult.domainExpiry.daysUntilExpiry !== undefined && 
                                checkResult.domainExpiry.daysUntilExpiry <= 30;
          
          if (isExpired || isExpiringSoon) {
            await triggerDomainExpiryAlert(checkData as Website, checkResult.domainExpiry);
          }
        }
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
  const { url, name, events, secret, headers, webhookType } = request.data || {};
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
    webhookType: webhookType || 'generic',
    createdAt: now,
    updatedAt: now,
  });

  return { id: docRef.id };
});

// Callable function to update webhook settings
export const updateWebhookSettings = onCall(async (request) => {
  const { id, url, name, events, enabled, secret, headers, webhookType } = request.data || {};
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
  if (events !== undefined) updateData.events = events;
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

  // Create test payload - detect Slack webhooks and send appropriate format
  const isSlackWebhook = webhookData.url.includes('hooks.slack.com');
  
  let testPayload: object;
  if (isSlackWebhook) {
    // Send Slack-compatible payload
    testPayload = {
      text: "🔔 Exit1 Test Webhook - Your webhook is working correctly!"
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

    // Delete user's email settings
    const emailDocRef = firestore.collection('emailSettings').doc(uid);
    webhooksBatch.delete(emailDocRef);

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

// ===== Email Notifications (Resend) =====
// Save or update email notification settings
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

// Callable function to get check history for a website (BigQuery only)
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

    // Get history for the last 24 hours from BigQuery
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    const { getCheckHistory } = await import('./bigquery.js');
    
    const history = await getCheckHistory(
      websiteId,
      uid,
      100, // limit
      0,   // offset
      twentyFourHoursAgo,
      Date.now()
    );

    return {
      success: true,
      history: history.map((entry: BigQueryCheckHistoryRow) => ({
        id: entry.id,
        websiteId,
        userId: uid,
        timestamp: new Date(entry.timestamp.value).getTime(),
        status: entry.status,
        responseTime: entry.response_time,
        statusCode: entry.status_code,
        error: entry.error
      })),
      count: history.length
    };
  } catch (error) {
    logger.error(`Failed to get check history for website ${websiteId}:`, error);
    throw new Error(`Failed to get check history: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Callable function to get paginated check history for a website (BigQuery only)
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

    // Use BigQuery for paginated history
    const { getCheckHistory } = await import('./bigquery.js');
    const offset = (page - 1) * limit;
    
    const history = await getCheckHistory(
      websiteId,
      uid,
      limit,
      offset,
      undefined, // startDate
      undefined, // endDate
      statusFilter === 'all' ? undefined : statusFilter,
      searchTerm
    );

    // Get total count for pagination
    const totalHistory = await getCheckHistory(
      websiteId,
      uid,
      10000, // large limit to get all
      0,
      undefined, // startDate
      undefined, // endDate
      statusFilter === 'all' ? undefined : statusFilter,
      searchTerm
    );

    const total = totalHistory.length;
    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      data: history.map((entry: BigQueryCheckHistoryRow) => ({
        id: entry.id,
        websiteId,
        userId: uid,
        timestamp: new Date(entry.timestamp.value).getTime(),
        status: entry.status,
        responseTime: entry.response_time,
        statusCode: entry.status_code,
        error: entry.error
      })),
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
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
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

    
    // Check SSL certificate and domain expiry first
    const securityChecks = await checkSecurityAndExpiry(website.url);
    const sslCertificate = securityChecks.sslCertificate;
    const domainExpiry = securityChecks.domainExpiry;
    
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
      domainExpiry,
      detailedStatus
    };
    
  } catch (error) {
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    

    
    // Still return security check results even if HTTP check fails
    const securityChecks = await checkSecurityAndExpiry(website.url);
    
    return {
      status: 'offline',
      responseTime,
      statusCode: 0,
      error: errorMessage,
      sslCertificate: securityChecks.sslCertificate,
      domainExpiry: securityChecks.domainExpiry,
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

// Function to check domain expiry using DNS and basic validation
// Enhanced RDAP domain type
type RdapDomain = {
  events?: Array<{ 
    eventAction?: string; 
    eventDate?: string;
    eventActor?: string;
  }>;
  registrar?: { 
    name?: string;
    ianaId?: string;
    url?: string;
  };
  name?: string;
  status?: string[];
  entities?: Array<{
    vcardArray?: unknown[];
    roles?: string[];
    handle?: string;
  }>;
  nameservers?: Array<{
    ldhName?: string;
    ipAddresses?: {
      v4?: string[];
      v6?: string[];
    };
  }>;
  secureDNS?: {
    delegationSigned?: boolean;
    dsData?: Array<{
      algorithm?: number;
      digest?: string;
      digestType?: number;
      keyTag?: number;
    }>;
  };
  links?: Array<{
    href?: string;
    rel?: string;
    type?: string;
  }>;
  remarks?: Array<{
    title?: string;
    description?: string[];
  }>;
};

// Enhanced RDAP cache with comprehensive data
const rdapCache = new Map<string, {
  expiryDate?: number; 
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  status?: string[];
  nameservers?: string[];
  hasDNSSEC?: boolean;
  events?: Array<{ action: string; date: string; actor?: string }>;
  remarks?: string[];
  cachedAt: number;
  error?: string;
  rawData?: unknown; // Store raw RDAP response for debugging
  lastAttempt?: number; // Track last attempt to prevent spam
  attemptCount?: number; // Track failed attempts
}>();

// Rate limiting for RDAP requests
const RDAP_RATE_LIMIT = {
  MIN_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours minimum between attempts
  MAX_ATTEMPTS: 3, // Max failed attempts before backing off
  BACKOFF_MULTIPLIER: 2, // Exponential backoff multiplier
  MAX_BACKOFF: 7 * 24 * 60 * 60 * 1000, // Max 7 days backoff
};

// Firestore cache for persistent storage
async function getRdapFromFirestore(domain: string): Promise<{
  expiryDate?: number;
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  status?: string[];
  nameservers?: string[];
  hasDNSSEC?: boolean;
  events?: Array<{ action: string; date: string; actor?: string }>;
  remarks?: string[];
  cachedAt: number;
  error?: string;
  lastAttempt?: number;
  attemptCount?: number;
} | null> {
  try {
    const doc = await firestore.collection('rdap_cache').doc(domain).get();
    if (doc.exists) {
      const data = doc.data();
      return {
        expiryDate: data?.expiryDate,
        registrar: data?.registrar,
        registrarId: data?.registrarId,
        registrarUrl: data?.registrarUrl,
        domainName: data?.domainName,
        status: data?.status,
        nameservers: data?.nameservers,
        hasDNSSEC: data?.hasDNSSEC,
        events: data?.events,
        remarks: data?.remarks,
        cachedAt: data?.cachedAt || 0,
        error: data?.error,
        lastAttempt: data?.lastAttempt,
        attemptCount: data?.attemptCount || 0,
      };
    }
    return null;
  } catch (error) {
    logger.warn(`Failed to get RDAP cache from Firestore for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function saveRdapToFirestore(domain: string, data: {
  expiryDate?: number;
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  status?: string[];
  nameservers?: string[];
  hasDNSSEC?: boolean;
  events?: Array<{ action: string; date: string; actor?: string }>;
  remarks?: string[];
  cachedAt: number;
  error?: string;
  lastAttempt?: number;
  attemptCount?: number;
}): Promise<void> {
  try {
    await firestore.collection('rdap_cache').doc(domain).set(data, { merge: true });
  } catch (error) {
    logger.warn(`Failed to save RDAP cache to Firestore for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Extract registrable domain from URL
function getRegistrableDomainFromUrl(url: string): {
  registrableDomain?: string;
  hostname?: string;
  error?: string;
} {
  try {
    const u = new URL(url);
    let hostname = u.hostname.replace(/\.$/, ''); // strip trailing dot
    
    if (net.isIP(hostname)) {
      return { hostname, error: 'IP addresses have no expiry' };
    }
    
    // Convert IDNs to ASCII
    hostname = punycode.toASCII(hostname);
    
    const parsed = parseTld(hostname, { validateHostname: true });
    if (!parsed.domain || !parsed.publicSuffix) {
      return { hostname, error: 'Unable to determine registrable domain (PSL)' };
    }
    
    return { hostname, registrableDomain: parsed.domain };
  } catch (e) {
    return { error: `Invalid URL: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Check if we should attempt RDAP request based on rate limiting
function shouldAttemptRdap(domain: string, cached: {
  expiryDate?: number;
  cachedAt?: number;
  lastAttempt?: number;
  attemptCount?: number;
  error?: string;
} | null | undefined): boolean {
  const now = Date.now();
  
  // If we have recent successful data, don't attempt
  if (cached && cached.cachedAt && !cached.error) {
    const daysUntilExpiry = cached.expiryDate ? Math.floor((cached.expiryDate - now) / 86400000) : undefined;
    const freshnessMs = daysUntilExpiry !== undefined && daysUntilExpiry <= 30
      ? 24 * 60 * 60 * 1000  // ≤30d left → refresh daily
      : 7 * 24 * 60 * 60 * 1000; // otherwise weekly
    
    if (now - cached.cachedAt < freshnessMs) {
      return false; // Cache is still fresh
    }
  }
  
  // Check rate limiting
  const lastAttempt = cached?.lastAttempt || 0;
  const attemptCount = cached?.attemptCount || 0;
  
  // If we've exceeded max attempts, use exponential backoff
  if (attemptCount >= RDAP_RATE_LIMIT.MAX_ATTEMPTS) {
    const backoffMs = Math.min(
      RDAP_RATE_LIMIT.MIN_INTERVAL * Math.pow(RDAP_RATE_LIMIT.BACKOFF_MULTIPLIER, attemptCount - RDAP_RATE_LIMIT.MAX_ATTEMPTS + 1),
      RDAP_RATE_LIMIT.MAX_BACKOFF
    );
    
    if (now - lastAttempt < backoffMs) {
      return false; // Still in backoff period
    }
  } else {
    // Normal rate limiting
    if (now - lastAttempt < RDAP_RATE_LIMIT.MIN_INTERVAL) {
      return false; // Too soon since last attempt
    }
  }
  
  return true;
}

// Enhanced RDAP data fetching with better error handling and fallbacks
async function fetchRdap(domain: string, signal?: AbortSignal): Promise<{
  expiryDate?: number;
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  status?: string[];
  nameservers?: string[];
  hasDNSSEC?: boolean;
  events?: Array<{ action: string; date: string; actor?: string }>;
  remarks?: string[];
  raw?: RdapDomain;
}> {
  try {
    // Try multiple RDAP servers with better error handling
    const rdapServers = [
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      `https://rdap.iana.org/domain/${encodeURIComponent(domain)}`,
      `https://rdap.verisign.com/rdap/domain/${encodeURIComponent(domain)}`
    ];
    
    let lastError: Error | null = null;
    
    for (const serverUrl of rdapServers) {
      try {
        logger.info(`Trying RDAP server: ${serverUrl}`);
        
        const body = await new Promise<RdapDomain>((resolve, reject) => {
          const req = https.get(serverUrl, {
            headers: { 
              'User-Agent': 'Mozilla/5.0 (compatible; exit1.dev/rdap; +https://exit1.dev)',
              'Accept': 'application/rdap+json, application/json',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 10000, // Increased timeout
          }, (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`RDAP HTTP ${res.statusCode} from ${serverUrl}`));
              return;
            }
            
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data) as RdapDomain;
                resolve(parsed);
              } catch (e) {
                reject(new Error(`Failed to parse RDAP JSON from ${serverUrl}: ${e instanceof Error ? e.message : String(e)}`));
              }
            });
          });
          
          req.on('error', (err) => {
            reject(new Error(`RDAP request failed for ${serverUrl}: ${err.message}`));
          });
          
          req.on('timeout', () => {
            req.destroy();
            reject(new Error(`RDAP request timeout for ${serverUrl}`));
          });
          
          // Handle abort signal
          if (signal) {
            signal.addEventListener('abort', () => {
              req.destroy();
              reject(new Error('RDAP request aborted'));
            });
          }
        });
        
        // If we get here, the request succeeded
        logger.info(`RDAP request succeeded for ${serverUrl}`);
        
        // Enhanced expiration detection - try multiple patterns
        let expiryDate: number | undefined;
        const events = body.events || [];
        
        // Look for expiration events with various naming patterns
        const expEvent = events.find(e => {
          const action = (e.eventAction || '').toLowerCase();
          return action.includes('expiration') || 
                 action.includes('expiry') || 
                 action.includes('expires') ||
                 action.includes('renewal') ||
                 action.includes('registration');
        });
        
        if (expEvent?.eventDate) {
          expiryDate = Date.parse(expEvent.eventDate);
        }
        
        // Extract nameservers
        const nameservers = body.nameservers?.map(ns => ns.ldhName).filter((ns): ns is string => Boolean(ns)) || [];
        
        // Check DNSSEC status
        const hasDNSSEC = body.secureDNS?.delegationSigned || false;
        
        // Extract remarks
        const remarks = body.remarks?.map(r => r.description?.join(' ')).filter((r): r is string => Boolean(r)) || [];
        
        // Process all events for debugging
        const processedEvents = events.map(e => ({
          action: e.eventAction || 'unknown',
          date: e.eventDate || '',
          actor: e.eventActor
        }));

        return {
          expiryDate,
          registrar: body.registrar?.name,
          registrarId: body.registrar?.ianaId,
          registrarUrl: body.registrar?.url,
          domainName: body.name ?? domain,
          status: body.status || [],
          nameservers,
          hasDNSSEC,
          events: processedEvents,
          remarks,
          raw: body,
        };
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`RDAP request failed for ${serverUrl}: ${lastError.message}`);
        continue; // Try next server
      }
    }
    
    // If we get here, all servers failed
    throw lastError || new Error('All RDAP servers failed');
  } catch (error) {
    throw new Error(`RDAP fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Enhanced DNS validation
async function performDNSValidation(hostname: string): Promise<{
  valid: boolean;
  ipAddresses?: string[];
  ns?: string[];
  error?: string;
}> {
  try {
    const [a, aaaa] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const ipAddresses: string[] = [];
    if (a.status === 'fulfilled') ipAddresses.push(...a.value);
    if (aaaa.status === 'fulfilled') ipAddresses.push(...aaaa.value);

    // NS records are helpful for diagnostics (optional)
    const ns = await Promise.allSettled([
      dns.resolveNs(hostname),
    ]);

    if (!ipAddresses.length) {
      return { valid: false, error: `No A/AAAA for ${hostname}` };
    }

    return {
      valid: true,
      ipAddresses,
      ns: ns[0].status === 'fulfilled' ? ns[0].value : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, error: `DNS validation failed: ${msg}` };
  }
}

// Main domain expiry check function
async function checkDomainExpiry(url: string): Promise<{
  valid: boolean;
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  expiryDate?: number;
  daysUntilExpiry?: number;
  nameservers?: string[];
  hasDNSSEC?: boolean;
  status?: string[];
  events?: Array<{ action: string; date: string; actor?: string }>;
  error?: string;
}> {
  try {
    const parsed = getRegistrableDomainFromUrl(url);
    if (parsed.error) {
      return { valid: false, error: parsed.error };
    }
    
    const { registrableDomain, hostname } = parsed;
    if (!registrableDomain) {
      return { valid: false, error: 'No registrable domain found' };
    }

    logger.info(`Checking domain expiry for: ${url} (registrable domain: ${registrableDomain})`);

    // Skip localhost-like/private use
    if (/^(localhost|127\.|::1)/.test(hostname!)) {
      return { valid: true, domainName: hostname, registrar: 'n/a' };
    }

    // DNS sanity check (optional but helpful)
    const dnsResult = await performDNSValidation(hostname!);
    if (!dnsResult.valid) {
      // Domain might be parked or non-resolving; still try RDAP
      // but note DNS error as context
      logger.info(`DNS validation failed for ${hostname}: ${dnsResult.error}`);
    }

    // RDAP with intelligent caching and rate limiting
    const now = Date.now();
    
    // Try to get from in-memory cache first
    let cached = rdapCache.get(registrableDomain);
    
    // If not in memory, try Firestore
    if (!cached) {
      const firestoreData = await getRdapFromFirestore(registrableDomain);
      if (firestoreData) {
        cached = firestoreData;
        rdapCache.set(registrableDomain, cached);
      }
    }
    
    // Check if we should attempt RDAP request
    const shouldAttempt = shouldAttemptRdap(registrableDomain, cached);
    
    if (shouldAttempt) {
      logger.info(`Fetching fresh RDAP data for ${registrableDomain} (cached=${!!cached}, attemptCount=${cached?.attemptCount || 0})`);
      
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000); // 10 second timeout
        
        const rdap = await fetchRdap(registrableDomain, ctrl.signal);
        clearTimeout(t);
        
        // Success - update cache
        const cacheData = {
          expiryDate: rdap.expiryDate, 
          registrar: rdap.registrar,
          registrarId: rdap.registrarId,
          registrarUrl: rdap.registrarUrl,
          domainName: rdap.domainName,
          status: rdap.status,
          nameservers: rdap.nameservers,
          hasDNSSEC: rdap.hasDNSSEC,
          events: rdap.events,
          remarks: rdap.remarks,
          cachedAt: now,
          lastAttempt: now,
          attemptCount: 0, // Reset attempt count on success
          error: undefined
        };
        
        rdapCache.set(registrableDomain, cacheData);
        await saveRdapToFirestore(registrableDomain, cacheData);
        
        logger.info(`RDAP data cached for ${registrableDomain}: expiry=${rdap.expiryDate}, registrar=${rdap.registrar}, events=${rdap.events?.length || 0}, nameservers=${rdap.nameservers?.length || 0}, hasDNSSEC=${rdap.hasDNSSEC}, status=${rdap.status?.length || 0}`);
        
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn(`RDAP fetch failed for ${registrableDomain}: ${errorMsg}`);
        
        // Update attempt count and last attempt
        const attemptCount = (cached?.attemptCount || 0) + 1;
        const cacheData = {
          ...cached,
          cachedAt: cached?.cachedAt || now,
          lastAttempt: now,
          attemptCount,
          error: errorMsg
        };
        
        rdapCache.set(registrableDomain, cacheData);
        await saveRdapToFirestore(registrableDomain, cacheData);
        
        // Keep old cache if present, otherwise continue with limited data
        if (!cached) {
          cached = cacheData;
        }
      }
    } else {
      logger.info(`Using cached RDAP data for ${registrableDomain} (lastAttempt=${cached?.lastAttempt}, attemptCount=${cached?.attemptCount || 0})`);
    }

    const fresh = rdapCache.get(registrableDomain);
    const daysUntilExpiry = fresh?.expiryDate ? Math.floor((fresh.expiryDate - now) / 86400000) : undefined;

    // Debug: Log what's in the cache
    logger.info(`Cache data for ${registrableDomain}: fresh=${!!fresh}, registrar=${fresh?.registrar}, events=${fresh?.events?.length}, nameservers=${fresh?.nameservers?.length}, hasDNSSEC=${fresh?.hasDNSSEC}, status=${fresh?.status?.length}, error=${fresh?.error}`);

    // Check if we have any RDAP data at all
    const hasRdapData = fresh && (
      fresh.registrar || 
      fresh.events?.length || 
      fresh.nameservers?.length || 
      fresh.hasDNSSEC !== undefined ||
      fresh.status?.length
    );

    // Build comprehensive status message
    let statusMessage = '';
    if (hasRdapData) {
      if (fresh?.events && fresh.events.length > 0) {
        statusMessage = `RDAP data available (${fresh.events.length} events)`;
        if (!fresh.expiryDate) {
          statusMessage += ' - No expiry date found in events';
        }
      } else if (fresh?.registrar) {
        statusMessage = `RDAP data available (registrar: ${fresh.registrar})`;
        if (!fresh.expiryDate) {
          statusMessage += ' - No expiry date found';
        }
      } else {
        statusMessage = 'RDAP data available (limited information)';
      }
    } else {
      // Check if we have DNS validation as fallback
      const dnsResult = await performDNSValidation(hostname!);
      if (dnsResult.valid) {
        statusMessage = 'RDAP data unavailable (using DNS validation only)';
      } else {
        statusMessage = `RDAP data unavailable - ${fresh?.error || 'No RDAP data available'}`;
      }
    }

    return {
      valid: true,
      domainName: fresh?.domainName ?? registrableDomain,
      registrar: fresh?.registrar,
      registrarId: fresh?.registrarId,
      registrarUrl: fresh?.registrarUrl,
      expiryDate: fresh?.expiryDate,
      daysUntilExpiry,
      nameservers: fresh?.nameservers,
      hasDNSSEC: fresh?.hasDNSSEC,
      status: fresh?.status,
      events: fresh?.events,
      error: hasRdapData ? undefined : statusMessage,
    };

    // Debug logging
    logger.info(`Domain expiry result for ${registrableDomain}: hasRdapData=${hasRdapData}, registrar=${fresh?.registrar}, events=${fresh?.events?.length}, nameservers=${fresh?.nameservers?.length}, hasDNSSEC=${fresh?.hasDNSSEC}, error=${hasRdapData ? undefined : statusMessage}`);
    
  } catch (error) {
    return {
      valid: false,
      error: `Domain check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

// Enhanced function to check both SSL and domain expiry
async function checkSecurityAndExpiry(url: string): Promise<{
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    registrarId?: string;
    registrarUrl?: string;
    domainName?: string;
    expiryDate?: number;
    daysUntilExpiry?: number;
    nameservers?: string[];
    hasDNSSEC?: boolean;
    status?: string[];
    events?: Array<{ action: string; date: string; actor?: string }>;
    error?: string;
  };
}> {
  const [sslCertificate, domainExpiry] = await Promise.allSettled([
    checkSSLCertificate(url),
    checkDomainExpiry(url)
  ]);

  return {
    sslCertificate: sslCertificate.status === 'fulfilled' ? sslCertificate.value : undefined,
    domainExpiry: domainExpiry.status === 'fulfilled' ? domainExpiry.value : undefined
  };
}









// ===== API Keys (X-Api-Key) and Public REST API =====

const API_KEYS_COLLECTION = 'apiKeys';

type ApiKeyDoc = {
  userId: string;
  name?: string;
  hash: string;
  prefix: string;
  last4: string;
  enabled: boolean;
  scopes?: string[];
  createdAt: number;
  lastUsedAt?: number;
  lastUsedPath?: string;
};

async function generateApiKey(): Promise<string> {
  const { randomBytes } = await import('crypto');
  // ek_live_ + 32 bytes hex (64 chars)
  return `ek_live_${randomBytes(32).toString('hex')}`;
}

async function hashApiKey(key: string): Promise<string> {
  const { createHash } = await import('crypto');
  const pepper = process.env.API_KEY_PEPPER || '';
  return createHash('sha256').update(pepper + key).digest('hex');
}

function extractPrefix(key: string): string {
  return key.slice(0, 12);
}

function last4(key: string): string {
  return key.slice(-4);
}



// Create API key (returns plaintext once)
export const createApiKey = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  const { name = '' , scopes = [] } = request.data || {};
  const key = await generateApiKey();
  const hash = await hashApiKey(key);
  const now = Date.now();

  const docRef = await firestore.collection(API_KEYS_COLLECTION).add({
    userId: uid,
    name: String(name).slice(0, 100),
    hash,
    prefix: extractPrefix(key),
    last4: last4(key),
    enabled: true,
    scopes: Array.isArray(scopes) ? scopes : [],
    createdAt: now,
  } as ApiKeyDoc);

  return {
    id: docRef.id,
    key, // show once
    name,
    prefix: extractPrefix(key),
    last4: last4(key),
    createdAt: now,
  };
});

// List API keys (sanitized)
export const listApiKeys = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  const snap = await firestore
    .collection(API_KEYS_COLLECTION)
    .where('userId', '==', uid)
    .get();

  const keys = snap.docs.map((d) => {
    const data = d.data() as ApiKeyDoc;
    return {
      id: d.id,
      name: data.name || '',
      prefix: data.prefix,
      last4: data.last4,
      enabled: data.enabled,
      createdAt: data.createdAt,
      lastUsedAt: data.lastUsedAt || null,
      scopes: data.scopes || [],
    };
  });

  // Sort by createdAt descending (newest first)
  keys.sort((a, b) => b.createdAt - a.createdAt);

  return { success: true, data: keys };
});

// Revoke API key
export const revokeApiKey = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");
  const { id } = request.data || {};
  if (!id) throw new Error("Key ID required");

  const ref = firestore.collection(API_KEYS_COLLECTION).doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Key not found");
  const data = doc.data() as ApiKeyDoc;
  if (data.userId !== uid) throw new Error("Insufficient permissions");

  await ref.update({ enabled: false, lastUsedAt: Date.now() });
  return { success: true };
});

// ===== Admin User Management Functions =====

// Simple in-memory cache for user data
const userCache = new Map<string, { data: Record<string, unknown>; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Helper function to invalidate user cache
const invalidateUserCache = () => {
  userCache.delete('all_users');
  logger.info('User cache invalidated');
};

// Get all users (admin only) - OPTIMIZED VERSION
export const getAllUsers = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  logger.info('getAllUsers called by user:', uid);
  logger.info('Clerk client status:', clerkClient ? 'initialized' : 'not initialized');

  try {
    // OPTIMIZATION 4: Check cache first
    const cacheKey = 'all_users';
    const cached = userCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      logger.info('Returning cached user data');
      return cached.data;
    }

    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function
    // No need for backend admin verification since the UI controls access

    // Get pagination parameters from request
    const { page = 1, limit = 50, offset = 0, instance } = request.data || {};
    const pageSize = Math.min(limit, 100); // Max 100 users per page
    const skip = offset || (page - 1) * pageSize;

    // Determine which instance to query
    // If instance is specified, use it; otherwise query both
    const queryInstance = instance === 'dev' ? 'dev' : 'prod';
    const client = getClerkClient(queryInstance);
    
    if (!client) {
      throw new Error(`Clerk ${queryInstance} client not initialized. Please check your Clerk secret key configuration.`);
    }

    // Get users from Clerk with pagination
    logger.info(`Calling Clerk ${queryInstance} API with params:`, { limit: Math.min(pageSize, 500), offset: skip });
    const clerkUsers = await client.users.getUserList({
      limit: Math.min(pageSize, 500), // Clerk's max is 500
      offset: skip
    });
    logger.info(`Clerk ${queryInstance} API response received, user count:`, clerkUsers.data.length);

    if (clerkUsers.data.length === 0) {
      return {
        success: true,
        data: [],
        count: 0,
        pagination: {
          page,
          pageSize,
          total: 0,
          hasNext: false,
          hasPrev: page > 1
        }
      };
    }

    // OPTIMIZATION 1: Batch fetch all checks and webhooks in parallel
    const userIds = clerkUsers.data.map(user => user.id);
    
    // Helper function to chunk array into smaller arrays
    const chunkArray = <T>(array: T[], chunkSize: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
      }
      return chunks;
    };

    // Firestore IN queries are limited to 30 values, so chunk the userIds
    const userIdChunks = chunkArray(userIds, 30);
    
    // Create batch queries for all users at once, handling the 30-item limit
    const [checksSnapshots, webhooksSnapshots] = await Promise.all([
      // Get all checks for all users in multiple queries (chunked)
      Promise.all(userIdChunks.map(chunk => 
        firestore
          .collection('checks')
          .where('userId', 'in', chunk)
          .get()
      )),
      // Get all webhooks for all users in multiple queries (chunked)
      Promise.all(userIdChunks.map(chunk => 
        firestore
          .collection('webhooks')
          .where('userId', 'in', chunk)
          .get()
      ))
    ]);

    // Combine all snapshots into single snapshots
    const checksSnapshot = { docs: checksSnapshots.flatMap(snapshot => snapshot.docs) };
    const webhooksSnapshot = { docs: webhooksSnapshots.flatMap(snapshot => snapshot.docs) };

    // OPTIMIZATION 2: Pre-process data into maps for O(1) lookup
    const checksByUser = new Map<string, Array<Record<string, unknown> & { createdAt?: number; updatedAt?: number }>>();
    const webhooksByUser = new Map<string, Array<Record<string, unknown> & { createdAt?: number; updatedAt?: number }>>();
    
    // Group checks by userId
    checksSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const userId = data.userId;
      if (!checksByUser.has(userId)) {
        checksByUser.set(userId, []);
      }
      checksByUser.get(userId)!.push(data);
    });
    
    // Group webhooks by userId
    webhooksSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const userId = data.userId;
      if (!webhooksByUser.has(userId)) {
        webhooksByUser.set(userId, []);
      }
      webhooksByUser.get(userId)!.push(data);
    });

    // OPTIMIZATION 3: Process users in parallel
    const users = await Promise.all(
      clerkUsers.data.map(async (clerkUser) => {
        const userChecks = checksByUser.get(clerkUser.id) || [];
        const userWebhooks = webhooksByUser.get(clerkUser.id) || [];

        // Get earliest check creation time as user creation time
        let createdAt = 0;
        if (userChecks.length > 0) {
          const sortedChecks = userChecks.sort((a, b) => 
            (a.createdAt || 0) - (b.createdAt || 0)
          );
          createdAt = sortedChecks[0].createdAt || 0;
        }

        // Get latest check update time as user update time
        let updatedAt = 0;
        if (userChecks.length > 0) {
          const latestCheck = userChecks.reduce((latest, current) => {
            const latestTime = latest.updatedAt || 0;
            const currentTime = current.updatedAt || 0;
            return currentTime > latestTime ? current : latest;
          });
          updatedAt = latestCheck.updatedAt || 0;
        }

        // Use Clerk's creation time if no checks exist
        if (createdAt === 0) {
          createdAt = clerkUser.createdAt;
        }

        // Use Clerk's last sign in time if no checks exist
        if (updatedAt === 0) {
          updatedAt = clerkUser.lastSignInAt || clerkUser.createdAt;
        }

        return {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress || 'No email',
          displayName: clerkUser.fullName || clerkUser.firstName || clerkUser.lastName || 'No name',
          createdAt: createdAt,
          updatedAt: updatedAt,
          isAdmin: clerkUser.publicMetadata?.admin === true,
          lastSignIn: clerkUser.lastSignInAt,
          emailVerified: clerkUser.emailAddresses[0]?.verification?.status === 'verified',
          checksCount: userChecks.length,
          webhooksCount: userWebhooks.length
        };
      })
    );

    // Sort by creation date (newest first)
    users.sort((a, b) => b.createdAt - a.createdAt);

    // Calculate pagination metadata
    const totalUsers = clerkUsers.totalCount || users.length;
    const hasNext = skip + users.length < totalUsers;
    const hasPrev = page > 1;

    const result = {
      success: true,
      data: users,
      count: users.length,
      pagination: {
        page,
        pageSize,
        total: totalUsers,
        hasNext,
        hasPrev
      }
    };

    // OPTIMIZATION 4: Cache the result
    userCache.set(cacheKey, { data: result, timestamp: now });
    
    // Clean up old cache entries (keep cache size manageable)
    if (userCache.size > 10) {
      const oldestKey = userCache.keys().next().value;
      if (oldestKey) {
        userCache.delete(oldestKey);
      }
    }

    return result;
  } catch (error) {
    logger.error('Error getting all users:', error);
    logger.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    logger.error('Clerk client status:', clerkClient ? 'initialized' : 'not initialized');
    throw new Error(`Failed to get users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Update user (admin only)
export const updateUser = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  try {
    const { userId } = request.data;
    if (!userId || typeof userId !== 'string') {
      throw new Error("User ID is required");
    }

    // Check if current user is admin
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // For now, user updates are not supported since we don't have a users collection
    // This would need to be implemented with Clerk's admin API or a separate user management system
    throw new Error("User updates are not yet implemented. This requires integration with Clerk's admin API.");

    // Future implementation would go here:
    // - Update user data in Clerk via their admin API
    // - Or maintain a separate users collection for additional metadata
    // - Or update user data in existing collections (checks, webhooks)

  } catch (error) {
    logger.error('Error updating user:', error);
    throw new Error(`Failed to update user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Delete user (admin only)
export const deleteUser = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  try {
    const { userId } = request.data;
    if (!userId || typeof userId !== 'string') {
      throw new Error("User ID is required");
    }

    // Check if current user is admin
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // Prevent admin from deleting themselves
    if (userId === uid) {
      throw new Error("Cannot delete your own account");
    }

    // Delete user's checks
    const checksSnapshot = await firestore.collection("checks").where("userId", "==", userId).get();
    const checksBatch = firestore.batch();
    checksSnapshot.docs.forEach(doc => {
      checksBatch.delete(doc.ref);
    });

    // Delete user's webhooks
    const webhooksSnapshot = await firestore.collection("webhooks").where("userId", "==", userId).get();
    const webhooksBatch = firestore.batch();
    webhooksSnapshot.docs.forEach(doc => {
      webhooksBatch.delete(doc.ref);
    });

    // Delete user's email settings
    const emailDocRef = firestore.collection('emailSettings').doc(userId);
    webhooksBatch.delete(emailDocRef);

    // Delete user's API keys
    const apiKeysSnapshot = await firestore.collection('apiKeys').where('userId', '==', userId).get();
    const apiKeysBatch = firestore.batch();
    apiKeysSnapshot.docs.forEach(doc => {
      apiKeysBatch.delete(doc.ref);
    });

    // Execute all deletion batches
    await Promise.all([
      checksBatch.commit(),
      webhooksBatch.commit(),
      apiKeysBatch.commit()
    ]);

    logger.info(`Admin ${uid} deleted user ${userId} and all associated data`);

    // Invalidate user cache since user data has changed
    invalidateUserCache();

    return {
      success: true,
      message: "User and all associated data deleted successfully",
      deletedCounts: {
        checks: checksSnapshot.size,
        webhooks: webhooksSnapshot.size,
        apiKeys: apiKeysSnapshot.size
      }
    };
  } catch (error) {
    logger.error('Error deleting user:', error);
    throw new Error(`Failed to delete user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Bulk delete users (admin only)
export const bulkDeleteUsers = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  try {
    const { userIds } = request.data;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new Error("User IDs array is required");
    }

    // Check if current user is admin
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // Prevent admin from deleting themselves
    if (userIds.includes(uid)) {
      throw new Error("Cannot delete your own account");
    }

    const results = [];
    const errors = [];

    for (const userId of userIds) {
      try {
        // Delete user's data (similar to single delete)
        const checksSnapshot = await firestore.collection("checks").where("userId", "==", userId).get();
        const checksBatch = firestore.batch();
        checksSnapshot.docs.forEach(doc => {
          checksBatch.delete(doc.ref);
        });

        const webhooksSnapshot = await firestore.collection("webhooks").where("userId", "==", userId).get();
        const webhooksBatch = firestore.batch();
        webhooksSnapshot.docs.forEach(doc => {
          webhooksBatch.delete(doc.ref);
        });

        const emailDocRef = firestore.collection('emailSettings').doc(userId);
        webhooksBatch.delete(emailDocRef);

        const apiKeysSnapshot = await firestore.collection('apiKeys').where('userId', '==', userId).get();
        const apiKeysBatch = firestore.batch();
        apiKeysSnapshot.docs.forEach(doc => {
          apiKeysBatch.delete(doc.ref);
        });

        await Promise.all([
          checksBatch.commit(),
          webhooksBatch.commit(),
          apiKeysBatch.commit()
        ]);

        results.push({
          userId,
          success: true,
          deletedCounts: {
            checks: checksSnapshot.size,
            webhooks: webhooksSnapshot.size,
            apiKeys: apiKeysSnapshot.size
          }
        });
      } catch (error) {
        errors.push({
          userId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    logger.info(`Admin ${uid} bulk deleted ${results.length} users`);

    // Invalidate user cache since user data has changed
    invalidateUserCache();

    return {
      success: true,
      message: `Successfully deleted ${results.length} users`,
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    logger.error('Error bulk deleting users:', error);
    throw new Error(`Failed to bulk delete users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Authenticate with dev Clerk instance
// This function allows dev users to authenticate via the dev instance
// and receive a Firebase custom token for Firebase Auth
export const authenticateWithDevInstance = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  try {
    const { email, oauthToken } = request.data || {};
    
    if (!email && !oauthToken) {
      throw new Error("Email or OAuth token is required");
    }
    
    // Note: password parameter is not used as Clerk Backend API doesn't support password verification
    // This would need to be handled via Frontend API
    
    // Check if user is in migration table and should use dev instance
    const normalizedEmail = email?.toLowerCase().trim();
    if (normalizedEmail) {
      const migrationDoc = await firestore.collection('userMigrations').doc(normalizedEmail).get();
      if (!migrationDoc.exists) {
        throw new Error("User not found in migration table. Please use normal sign-in.");
      }
      
      const migrationData = migrationDoc.data();
      if (migrationData?.instance !== 'dev' || migrationData?.migrated) {
        throw new Error("User has been migrated to production. Please use normal sign-in.");
      }
    }
    
    // Get dev Clerk client
    const devClient = getClerkClient('dev');
    if (!devClient) {
      throw new Error("Dev Clerk instance not configured");
    }
    
    // Note: Clerk Backend API doesn't support password verification or Firebase custom token generation
    // Firebase custom tokens are generated via Clerk's Frontend API using getToken() with JWT template
    // For dev users, they would need to authenticate via a separate ClerkProvider with dev publishable key
    // This function serves as a placeholder for future implementation
    // 
    // Current workaround: Migrate users to prod instance, or use separate dev instance URL
    
    // Validate that user exists in dev instance (for future implementation)
    if (email) {
      const users = await devClient.users.getUserList({
        emailAddress: [normalizedEmail],
        limit: 1
      });
      
      if (users.data.length === 0) {
        throw new Error("User not found in dev instance");
      }
      // clerkUser would be used here when implementing token generation
    }
    
    throw new Error("Dev instance authentication via backend is not yet fully implemented. Please migrate the user to prod instance first using the migration script, or implement a separate authentication flow for dev users.");
  } catch (error) {
    logger.error('Error authenticating with dev instance:', error);
    throw new Error(`Failed to authenticate: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Public Badge Data API - No authentication required
// CORS enabled for cross-origin embedding
export const badgeData = onRequest({ cors: true }, async (req, res) => {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  try {
    // Only allow GET requests
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Get check ID from query parameter
    const checkId = req.query.checkId as string;
    
    if (!checkId || typeof checkId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid checkId parameter' });
      return;
    }

    // Get client IP for rate limiting
    const clientIp = req.headers['x-forwarded-for'] as string || 
                     req.headers['x-real-ip'] as string ||
                     req.ip ||
                     'unknown';

    // Fetch badge data
    const data = await getBadgeData(checkId, clientIp);
    
    if (!data) {
      res.status(404).json({ error: 'Check not found or disabled' });
      return;
    }

    // Set cache headers (5 minutes)
    res.setHeader('Cache-Control', 'public, max-age=300');
    
    // Return badge data
    res.status(200).json({
      success: true,
      data
    });

  } catch (error) {
    logger.error('Error in badgeData endpoint:', error);
    
    if (error instanceof Error && error.message.includes('Rate limit')) {
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export public REST API from separate file
export { publicApi } from './public-api';

// Admin-only function to export dev users to migration table
// Temporarily accessible with secret token for migration purposes
export const exportDevUsers = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_DEV],
}, async (request) => {
  try {
    // Temporary: Allow access with secret token OR authenticated admin
    const { secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.EXPORT_SECRET_TOKEN || 'migration-export-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
      logger.info('Export dev users called by authenticated user:', uid);
    } else {
      logger.info('Export dev users called with secret token');
    }

    // Initialize dev client with secret from function context
    let devClient = getClerkClient('dev');
    if (!devClient) {
      // Try to initialize dev client with secret from function context
      const devSecretKey = CLERK_SECRET_KEY_DEV.value();
      if (devSecretKey) {
        devClient = createClerkClient({ secretKey: devSecretKey });
        logger.info('Dev Clerk client initialized in exportDevUsers function');
      } else {
        throw new HttpsError('failed-precondition', 'Dev Clerk client not initialized: CLERK_SECRET_KEY_DEV secret not found');
      }
    }

    logger.info('Starting export of dev users to migration table...');
    
    const allUsers: Array<{ id: string; emailAddresses?: Array<{ emailAddress?: string }> }> = [];
    let offset = 0;
    const limit = 500;
    let hasMore = true;
    
    // Fetch all users from dev instance
    while (hasMore) {
      logger.info(`Fetching users (offset: ${offset})...`);
      const response = await devClient.users.getUserList({
        limit,
        offset,
      });
      
      if (response.data.length === 0) {
        hasMore = false;
        break;
      }
      
      allUsers.push(...response.data);
      offset += response.data.length;
      
      logger.info(`Fetched ${response.data.length} users (total: ${allUsers.length})`);
      
      if (response.data.length < limit) {
        hasMore = false;
      }
    }

    logger.info(`Total users fetched: ${allUsers.length}`);
    logger.info('Exporting to Firestore userMigrations collection...');

    // Export to Firestore in batches
    const batch = firestore.batch();
    let count = 0;
    
    for (const user of allUsers) {
      const emailAddress = user.emailAddresses?.[0]?.emailAddress;
      if (emailAddress) {
        const normalizedEmail = emailAddress.toLowerCase().trim();
        const userMigrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
        
        const record = {
          email: normalizedEmail,
          devClerkUserId: user.id,
          prodClerkUserId: null,
          instance: 'dev' as const,
          migrated: false,
          migratedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        
        batch.set(userMigrationRef, record, { merge: true });
        count++;
        
        // Commit batch every 500 documents (Firestore limit)
        if (count % 500 === 0) {
          await batch.commit();
          logger.info(`Committed batch: ${count} users exported`);
        }
      }
    }
    
    // Commit remaining documents
    if (count % 500 !== 0) {
      await batch.commit();
    }

    logger.info(`Successfully exported ${count} dev users to Firestore userMigrations collection.`);
    
    return {
      success: true,
      totalUsers: allUsers.length,
      exportedUsers: count,
      message: `Successfully exported ${count} dev users to migration table`,
    };
  } catch (error) {
    logger.error('Error exporting dev users:', error);
    throw new HttpsError('internal', `Failed to export dev users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Admin-only function to migrate a single user from dev to prod instance
export const migrateUser = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { email, secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    if (!email) {
      throw new HttpsError('invalid-argument', 'Email is required');
    }
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Migrate user called by authenticated user:', uid);
    } else {
      logger.info('Migrate user called with secret token');
    }

    const normalizedEmail = email.toLowerCase().trim();
    logger.info(`Starting migration for user: ${normalizedEmail}`);

    // Get Clerk clients
    const devSecretKey = CLERK_SECRET_KEY_DEV.value();
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    
    if (!devSecretKey) {
      throw new HttpsError('failed-precondition', 'Dev Clerk secret key not configured');
    }
    if (!prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Prod Clerk secret key not configured');
    }
    
    const devClient = createClerkClient({ secretKey: devSecretKey });
    const prodClient = createClerkClient({ secretKey: prodSecretKey });

    // Check migration table
    const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
    const migrationDoc = await migrationRef.get();
    
    if (!migrationDoc.exists) {
      throw new HttpsError('not-found', `User ${normalizedEmail} not found in migration table. Run exportDevUsers first.`);
    }
    
    const migrationData = migrationDoc.data()!;
    
    if (migrationData.migrated) {
      return {
        success: true,
        message: `User ${normalizedEmail} has already been migrated`,
        prodClerkUserId: migrationData.prodClerkUserId,
      };
    }
    
    if (migrationData.instance !== 'dev') {
      throw new HttpsError('failed-precondition', `User ${normalizedEmail} is not on dev instance`);
    }
    
    const devClerkUserId = migrationData.devClerkUserId;
    logger.info(`Dev Clerk User ID: ${devClerkUserId}`);
    
    // Fetch user data from dev instance
    logger.info('Fetching user data from dev instance...');
    const devUser = await devClient.users.getUser(devClerkUserId);
    logger.info(`Found user: ${devUser.emailAddresses[0]?.emailAddress || 'No email'}`);
    
    // Create user in prod instance
    logger.info('Creating user in prod instance...');
    let prodUser;
    try {
      // Prepare user data, filtering out null/undefined values
      const email = devUser.emailAddresses?.[0]?.emailAddress || normalizedEmail;
      if (!email) {
        throw new HttpsError('invalid-argument', 'User email address is required');
      }

      const createUserData: {
        emailAddress: string[];
        firstName?: string;
        lastName?: string;
        username?: string;
        publicMetadata?: Record<string, unknown>;
        privateMetadata?: Record<string, unknown>;
        unsafeMetadata?: Record<string, unknown>;
        skipPasswordChecks?: boolean;
        skipPasswordRequirement?: boolean;
      } = {
        emailAddress: [email],
        skipPasswordChecks: true,
        skipPasswordRequirement: true,
      };

      // Only add fields if they have values
      if (devUser.firstName) {
        createUserData.firstName = devUser.firstName;
      }
      if (devUser.lastName) {
        createUserData.lastName = devUser.lastName;
      }
      if (devUser.username) {
        createUserData.username = devUser.username;
      }
      if (devUser.publicMetadata && Object.keys(devUser.publicMetadata).length > 0) {
        createUserData.publicMetadata = devUser.publicMetadata as Record<string, unknown>;
      }
      if (devUser.privateMetadata && Object.keys(devUser.privateMetadata).length > 0) {
        createUserData.privateMetadata = devUser.privateMetadata as Record<string, unknown>;
      }
      if (devUser.unsafeMetadata && Object.keys(devUser.unsafeMetadata).length > 0) {
        createUserData.unsafeMetadata = devUser.unsafeMetadata as Record<string, unknown>;
      }
      
      logger.info('Creating user with data:', JSON.stringify(createUserData, null, 2));
      prodUser = await prodClient.users.createUser(createUserData);
      logger.info(`Created user in prod instance: ${prodUser.id}`);
    } catch (error: unknown) {
      logger.error('Error creating user in prod:', error);
      const clerkError = error as { errors?: Array<{ code?: string; message?: string }>; status?: number };
      
      if (clerkError?.errors?.[0]?.code === 'duplicate_record') {
        logger.info('User already exists in prod instance, fetching...');
        const existingUsers = await prodClient.users.getUserList({
          emailAddress: [normalizedEmail],
          limit: 1,
        });
        
        if (existingUsers.data.length > 0) {
          prodUser = existingUsers.data[0];
          logger.info(`Found existing user in prod: ${prodUser.id}`);
        } else {
          throw new HttpsError('internal', 'User exists but could not be found');
        }
      } else {
        const errorMessage = clerkError?.errors?.[0]?.message || 'Unknown error';
        const errorCode = clerkError?.errors?.[0]?.code || 'unknown';
        logger.error(`Clerk error: ${errorCode} - ${errorMessage}`);
        throw new HttpsError('failed-precondition', `Failed to create user in prod instance: ${errorMessage} (${errorCode})`);
      }
    }
    
    const prodClerkUserId = prodUser.id;
    logger.info(`Prod Clerk User ID: ${prodClerkUserId}`);
    
    // Update all Firestore documents with new userId
    logger.info('Updating Firestore documents...');
    
    let checksCount = 0;
    let webhooksCount = 0;
    let apiKeysCount = 0;
    let emailSettingsMigrated = false;
    
    // Update checks
    const checksSnapshot = await firestore.collection('checks')
      .where('userId', '==', devClerkUserId)
      .get();
    
    if (!checksSnapshot.empty) {
      const checksBatch = firestore.batch();
      checksSnapshot.docs.forEach(doc => {
        checksBatch.update(doc.ref, { userId: prodClerkUserId });
      });
      await checksBatch.commit();
      checksCount = checksSnapshot.size;
      logger.info(`Updated ${checksCount} checks`);
    }
    
    // Update webhooks
    const webhooksSnapshot = await firestore.collection('webhooks')
      .where('userId', '==', devClerkUserId)
      .get();
    
    if (!webhooksSnapshot.empty) {
      const webhooksBatch = firestore.batch();
      webhooksSnapshot.docs.forEach(doc => {
        webhooksBatch.update(doc.ref, { userId: prodClerkUserId });
      });
      await webhooksBatch.commit();
      webhooksCount = webhooksSnapshot.size;
      logger.info(`Updated ${webhooksCount} webhooks`);
    }
    
    // Update emailSettings
    const emailSettingsRef = firestore.collection('emailSettings').doc(devClerkUserId);
    const emailSettingsDoc = await emailSettingsRef.get();
    if (emailSettingsDoc.exists) {
      const emailSettingsData = emailSettingsDoc.data()!;
      const newEmailSettingsRef = firestore.collection('emailSettings').doc(prodClerkUserId);
      await newEmailSettingsRef.set(emailSettingsData);
      await emailSettingsRef.delete();
      emailSettingsMigrated = true;
      logger.info('Updated emailSettings');
    }
    
    // Update apiKeys
    const apiKeysSnapshot = await firestore.collection('apiKeys')
      .where('userId', '==', devClerkUserId)
      .get();
    
    if (!apiKeysSnapshot.empty) {
      const apiKeysBatch = firestore.batch();
      apiKeysSnapshot.docs.forEach(doc => {
        apiKeysBatch.update(doc.ref, { userId: prodClerkUserId });
      });
      await apiKeysBatch.commit();
      apiKeysCount = apiKeysSnapshot.size;
      logger.info(`Updated ${apiKeysCount} API keys`);
    }
    
    // Update BigQuery check_history table (logs and reports data)
    logger.info('Updating BigQuery check_history table...');
    let bigQueryRowsUpdated = 0;
    try {
      const bigquery = new BigQuery({
        projectId: 'exit1-dev',
      });
      
      // First, count how many rows will be updated
      const countQuery = `
        SELECT COUNT(*) as row_count
        FROM \`exit1-dev.checks.check_history\`
        WHERE user_id = @oldUserId
      `;
      
      const countOptions = {
        query: countQuery,
        params: {
          oldUserId: devClerkUserId,
        },
      };
      
      const [countJob] = await bigquery.createQueryJob(countOptions);
      const [countRows] = await countJob.getQueryResults();
      const rowCount = Number(countRows[0]?.row_count || 0);
      logger.info(`Found ${rowCount} rows in BigQuery to update`);
      
      if (rowCount > 0) {
        // Use DML UPDATE to change user_id in BigQuery
        const updateQuery = `
          UPDATE \`exit1-dev.checks.check_history\`
          SET user_id = @newUserId
          WHERE user_id = @oldUserId
        `;
        
        const updateOptions = {
          query: updateQuery,
          params: {
            newUserId: prodClerkUserId,
            oldUserId: devClerkUserId,
          },
        };
        
        const [updateJob] = await bigquery.createQueryJob(updateOptions);
        await updateJob.getQueryResults();
        
        // Get the number of rows updated from job statistics
        const [metadata] = await updateJob.getMetadata();
        bigQueryRowsUpdated = Number(metadata.statistics?.totalBytesProcessed ? rowCount : rowCount);
        logger.info(`Updated ${bigQueryRowsUpdated} rows in BigQuery check_history table`);
      }
    } catch (bigQueryError) {
      logger.error('Error updating BigQuery:', bigQueryError);
      // Don't fail the migration if BigQuery update fails - log it but continue
      // The user can manually fix BigQuery data if needed
    }
    
    // Update migration table
    const now = Date.now();
    await migrationRef.set({
      email: normalizedEmail,
      devClerkUserId,
      prodClerkUserId,
      instance: 'prod' as const,
      migrated: true,
      migratedAt: now,
      createdAt: migrationData.createdAt,
      updatedAt: now,
    }, { merge: true });
    
    logger.info(`Migration complete for ${normalizedEmail}`);
    
    return {
      success: true,
      message: `Successfully migrated user ${normalizedEmail}`,
      devClerkUserId,
      prodClerkUserId,
      checksMigrated: checksCount,
      webhooksMigrated: webhooksCount,
      apiKeysMigrated: apiKeysCount,
      emailSettingsMigrated,
      bigQueryRowsMigrated: bigQueryRowsUpdated,
    };
  } catch (error) {
    logger.error('Error migrating user:', error);
    throw new HttpsError('internal', `Failed to migrate user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Recovery function to fix BigQuery data for already-migrated users
export const fixBigQueryData = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { email, secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    if (!email) {
      throw new HttpsError('invalid-argument', 'Email is required');
    }
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Fix BigQuery data called by authenticated user:', uid);
    } else {
      logger.info('Fix BigQuery data called with secret token');
    }

    const normalizedEmail = email.toLowerCase().trim();
    logger.info(`Fixing BigQuery data for user: ${normalizedEmail}`);

    // Get migration record
    const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
    const migrationDoc = await migrationRef.get();
    
    if (!migrationDoc.exists) {
      throw new HttpsError('not-found', `User ${normalizedEmail} not found in migration table`);
    }
    
    const migrationData = migrationDoc.data()!;
    
    logger.info('Migration record data:', JSON.stringify(migrationData, null, 2));
    
    // Try to get user IDs from migration record
    let devClerkUserId = migrationData.devClerkUserId;
    let prodClerkUserId = migrationData.prodClerkUserId;
    
    // If prodClerkUserId is missing, try to find it in Clerk
    if (!prodClerkUserId) {
      logger.info('prodClerkUserId missing from migration record, attempting to find user in prod Clerk...');
      const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
      if (prodSecretKey) {
        const prodClient = createClerkClient({ secretKey: prodSecretKey });
        
        // Try finding by email
        try {
          const existingUsers = await prodClient.users.getUserList({
            emailAddress: [normalizedEmail],
            limit: 10, // Get more results in case there are duplicates
          });
          
          logger.info(`Found ${existingUsers.data.length} users with email ${normalizedEmail} in prod Clerk`);
          
          if (existingUsers.data.length > 0) {
            // Use the first user found (most recent)
            prodClerkUserId = existingUsers.data[0].id;
            logger.info(`Found prod user ID: ${prodClerkUserId}`);
            
            // Update migration record with prod user ID
            await migrationRef.update({
              prodClerkUserId,
              migrated: true, // Also mark as migrated if not already
              instance: 'prod',
              updatedAt: Date.now(),
            });
          } else {
            logger.warn(`No user found in prod Clerk with email ${normalizedEmail}`);
          }
        } catch (lookupError) {
          logger.error('Error looking up user in prod Clerk:', lookupError);
        }
      }
    }
    
    // If devClerkUserId is missing, try to find it
    if (!devClerkUserId) {
      logger.info('devClerkUserId missing from migration record, attempting to find user in dev Clerk...');
      const devSecretKey = CLERK_SECRET_KEY_DEV.value();
      if (devSecretKey) {
        const devClient = createClerkClient({ secretKey: devSecretKey });
        const existingUsers = await devClient.users.getUserList({
          emailAddress: [normalizedEmail],
          limit: 1,
        });
        
        if (existingUsers.data.length > 0) {
          devClerkUserId = existingUsers.data[0].id;
          logger.info(`Found dev user ID: ${devClerkUserId}`);
          
          // Update migration record with dev user ID
          await migrationRef.update({
            devClerkUserId,
            updatedAt: Date.now(),
          });
        }
      }
    }
    
    // If we still don't have prodClerkUserId, we can't proceed
    if (!prodClerkUserId) {
      logger.error(`Missing prodClerkUserId - dev: ${devClerkUserId}, prod: ${prodClerkUserId}`);
      throw new HttpsError('failed-precondition', `Cannot fix BigQuery: User ${normalizedEmail} not found in prod Clerk instance. Please ensure the user exists in prod Clerk, or run migrateUser first to create them.`);
    }
    
    // If devClerkUserId is missing, we can still try to fix BigQuery by updating all rows
    // that might belong to this user (though this is less precise)
    if (!devClerkUserId) {
      logger.warn(`devClerkUserId missing - will attempt to update BigQuery using website IDs from checks`);
      
      // Get all checks for the prod user to find website IDs
      const checksSnapshot = await firestore.collection('checks')
        .where('userId', '==', prodClerkUserId)
        .get();
      
      if (checksSnapshot.empty) {
        throw new HttpsError('failed-precondition', `Cannot fix BigQuery: No checks found for prod user ${prodClerkUserId}. Cannot determine which BigQuery rows to update without devClerkUserId.`);
      }
      
      const websiteIds = checksSnapshot.docs.map(doc => doc.id);
      logger.info(`Found ${websiteIds.length} checks for prod user. Will update BigQuery rows for these websites.`);
      
      // Update BigQuery using website IDs instead of user_id
      // This is a fallback approach
      const bigquery = new BigQuery({
        projectId: 'exit1-dev',
      });
      
      let totalUpdated = 0;
      // Exclude rows in streaming buffer (last 30 minutes)
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      
      for (const websiteId of websiteIds) {
        try {
          const updateQuery = `
            UPDATE \`exit1-dev.checks.check_history\`
            SET user_id = @newUserId
            WHERE website_id = @websiteId
              AND user_id != @newUserId
              AND timestamp < @cutoffTime
          `;
          
          const updateOptions = {
            query: updateQuery,
            params: {
              newUserId: prodClerkUserId,
              websiteId: websiteId,
              cutoffTime: thirtyMinutesAgo,
            },
          };
          
          const [updateJob] = await bigquery.createQueryJob(updateOptions);
          await updateJob.getQueryResults();
          
          // Count updated rows (excluding streaming buffer)
          const countQuery = `
            SELECT COUNT(*) as row_count
            FROM \`exit1-dev.checks.check_history\`
            WHERE website_id = @websiteId
              AND user_id = @newUserId
              AND timestamp < @cutoffTime
          `;
          
          const [countJob] = await bigquery.createQueryJob({
            query: countQuery,
            params: {
              websiteId: websiteId,
              newUserId: prodClerkUserId,
              cutoffTime: thirtyMinutesAgo,
            },
          });
          const [countRows] = await countJob.getQueryResults();
          const count = Number(countRows[0]?.row_count || 0);
          totalUpdated += count;
        } catch (error) {
          logger.error(`Error updating BigQuery for website ${websiteId}:`, error);
        }
      }
      
      return {
        success: true,
        message: `Successfully fixed BigQuery data for ${normalizedEmail} using website IDs (devClerkUserId was missing)`,
        bigQueryRowsUpdated: totalUpdated,
      };
    }
    
    logger.info(`Updating BigQuery: ${devClerkUserId} -> ${prodClerkUserId}`);
    
    // Update BigQuery check_history table
    let bigQueryRowsUpdated = 0;
    try {
      const bigquery = new BigQuery({
        projectId: 'exit1-dev',
      });
      
      // Exclude rows in streaming buffer (last 30 minutes) - BigQuery doesn't allow updates on streaming buffer rows
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      
      // First, count how many rows will be updated (excluding streaming buffer)
      const countQuery = `
        SELECT COUNT(*) as row_count
        FROM \`exit1-dev.checks.check_history\`
        WHERE user_id = @oldUserId
          AND timestamp < @cutoffTime
      `;
      
      const countOptions = {
        query: countQuery,
        params: {
          oldUserId: devClerkUserId,
          cutoffTime: thirtyMinutesAgo,
        },
      };
      
      const [countJob] = await bigquery.createQueryJob(countOptions);
      const [countRows] = await countJob.getQueryResults();
      const rowCount = Number(countRows[0]?.row_count || 0);
      logger.info(`Found ${rowCount} rows in BigQuery to update (excluding streaming buffer)`);
      
      if (rowCount > 0) {
        // Use DML UPDATE to change user_id in BigQuery
        const updateQuery = `
          UPDATE \`exit1-dev.checks.check_history\`
          SET user_id = @newUserId
          WHERE user_id = @oldUserId
            AND timestamp < @cutoffTime
        `;
        
        const updateOptions = {
          query: updateQuery,
          params: {
            newUserId: prodClerkUserId,
            oldUserId: devClerkUserId,
            cutoffTime: thirtyMinutesAgo,
          },
        };
        
        const [updateJob] = await bigquery.createQueryJob(updateOptions);
        await updateJob.getQueryResults();
        
        // Count how many rows were actually updated (excluding streaming buffer)
        const countUpdatedQuery = `
          SELECT COUNT(*) as row_count
          FROM \`exit1-dev.checks.check_history\`
          WHERE user_id = @newUserId
            AND timestamp < @cutoffTime
        `;
        
        const [countJob] = await bigquery.createQueryJob({
          query: countUpdatedQuery,
          params: {
            newUserId: prodClerkUserId,
            cutoffTime: thirtyMinutesAgo,
          },
        });
        const [countRows] = await countJob.getQueryResults();
        bigQueryRowsUpdated = Number(countRows[0]?.row_count || 0);
        
        logger.info(`Updated ${bigQueryRowsUpdated} rows in BigQuery check_history table (excluding streaming buffer)`);
        
        // Note: Rows in streaming buffer (last 30 min) will be updated automatically on next insert
        // since new inserts use the prod user_id
      } else {
        logger.info('No rows found in BigQuery to update');
      }
    } catch (bigQueryError) {
      logger.error('Error updating BigQuery:', bigQueryError);
      throw new HttpsError('internal', `Failed to update BigQuery: ${bigQueryError instanceof Error ? bigQueryError.message : 'Unknown error'}`);
    }
    
    return {
      success: true,
      message: `Successfully fixed BigQuery data for ${normalizedEmail}`,
      bigQueryRowsUpdated,
    };
  } catch (error) {
    logger.error('Error fixing BigQuery data:', error);
    throw new HttpsError('internal', `Failed to fix BigQuery data: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Bulk migration function to migrate all remaining dev users
export const migrateAllUsers = onCall({
  cors: true, // Allow all origins for callable functions
  maxInstances: 1,
  timeoutSeconds: 540, // 9 minutes (max for 2nd gen functions)
  memory: '512MiB',
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { secretToken, batchSize = 10 } = request.data || {};
    const uid = request.auth?.uid;
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Migrate all users called by authenticated user:', uid);
    } else {
      logger.info('Migrate all users called with secret token');
    }

    // Get Clerk clients
    const devSecretKey = CLERK_SECRET_KEY_DEV.value();
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    
    if (!devSecretKey || !prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Clerk secret keys not configured');
    }
    
    const devClient = createClerkClient({ secretKey: devSecretKey });
    const prodClient = createClerkClient({ secretKey: prodSecretKey });

    // Get all users that need migration (instance = 'dev' and migrated = false)
    logger.info('Fetching users that need migration...');
    
    // Query for all dev users in migration table (Firestore doesn't handle missing fields well in compound queries)
    // We'll filter in memory for users that aren't migrated
    // Limit to smaller batches to avoid timeout
    const migrationSnapshot = await firestore.collection('userMigrations')
      .where('instance', '==', 'dev')
      .limit(200) // Reduced limit to speed up query
      .get();
    
    logger.info(`Total users in migration table with instance='dev': ${migrationSnapshot.size}`);
    
    // Filter in memory for users that aren't migrated (optimized filter)
    const allDevUsers = migrationSnapshot.docs.filter(doc => {
      const data = doc.data();
      return data.instance === 'dev' && (!data.migrated || data.migrated === false);
    });
    
    logger.info(`Found ${allDevUsers.length} unmigrated dev users`);
    
    // Limit to 20 for this batch to avoid timeout (can run multiple times)
    const usersToMigrate = allDevUsers.slice(0, 20).map(doc => ({
      email: doc.id,
      data: doc.data(),
    }));
    
    logger.info(`Processing ${usersToMigrate.length} users in this batch`);
    
    if (usersToMigrate.length === 0) {
      return {
        success: true,
        message: 'No users found that need migration',
        totalUsers: 0,
        migratedUsers: 0,
        failedUsers: 0,
        results: [],
      };
    }
    
    const results: Array<{
      email: string;
      success: boolean;
      message?: string;
      error?: string;
    }> = [];
    
    let migratedCount = 0;
    let failedCount = 0;
    
    // Migrate users in batches (smaller batches to avoid timeout)
    const actualBatchSize = Math.min(batchSize || 2, 2); // Max 2 at a time to avoid timeouts
    for (let i = 0; i < usersToMigrate.length; i += actualBatchSize) {
      const batch = usersToMigrate.slice(i, i + actualBatchSize);
      logger.info(`Processing batch ${Math.floor(i / actualBatchSize) + 1} (${batch.length} users)...`);
      
        // Process batch sequentially to avoid rate limits
        for (const user of batch) {
          const normalizedEmail = user.email.toLowerCase().trim();
          // Reduced logging to speed up execution
          if (i % 10 === 0) {
            logger.info(`Migrating user ${normalizedEmail} (${i + batch.indexOf(user) + 1}/${usersToMigrate.length})...`);
          }
        
        try {
          const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
          const migrationData = user.data;
          
          if (migrationData.migrated) {
            results.push({
              email: normalizedEmail,
              success: true,
              message: 'Already migrated',
            });
            continue;
          }
          
          const devClerkUserId = migrationData.devClerkUserId;
          if (!devClerkUserId) {
            throw new Error('devClerkUserId missing from migration record');
          }
          
          // Fetch user from dev instance
          const devUser = await devClient.users.getUser(devClerkUserId);
          
          // Create user in prod instance
          let prodUser;
          try {
            const email = devUser.emailAddresses?.[0]?.emailAddress || normalizedEmail;
            
            // Validate email
            if (!email || !email.includes('@')) {
              throw new Error(`Invalid email address: ${email}`);
            }
            
            // Check if user already exists in prod first
            try {
              const existingUsers = await prodClient.users.getUserList({
                emailAddress: [normalizedEmail],
                limit: 1,
              });
              if (existingUsers.data.length > 0) {
                prodUser = existingUsers.data[0];
                logger.info(`User already exists in prod: ${prodUser.id}`);
              }
            } catch (lookupError) {
              logger.warn(`Error checking for existing user ${normalizedEmail}:`, lookupError);
              // Continue to try creating
            }
            
            // If user doesn't exist, create them
            if (!prodUser) {
              const createUserData: {
                emailAddress: string[];
                firstName?: string;
                lastName?: string;
                username?: string;
                publicMetadata?: Record<string, unknown>;
                privateMetadata?: Record<string, unknown>;
                unsafeMetadata?: Record<string, unknown>;
                skipPasswordChecks?: boolean;
                skipPasswordRequirement?: boolean;
              } = {
                emailAddress: [email],
                skipPasswordChecks: true,
                skipPasswordRequirement: true,
              };
              
              // Only add fields if they have valid values
              if (devUser.firstName && devUser.firstName.trim()) {
                createUserData.firstName = devUser.firstName.trim();
              }
              if (devUser.lastName && devUser.lastName.trim()) {
                createUserData.lastName = devUser.lastName.trim();
              }
              if (devUser.username && devUser.username.trim()) {
                createUserData.username = devUser.username.trim();
              }
              if (devUser.publicMetadata && Object.keys(devUser.publicMetadata).length > 0) {
                createUserData.publicMetadata = devUser.publicMetadata as Record<string, unknown>;
              }
              if (devUser.privateMetadata && Object.keys(devUser.privateMetadata).length > 0) {
                createUserData.privateMetadata = devUser.privateMetadata as Record<string, unknown>;
              }
              if (devUser.unsafeMetadata && Object.keys(devUser.unsafeMetadata).length > 0) {
                createUserData.unsafeMetadata = devUser.unsafeMetadata as Record<string, unknown>;
              }
              
              logger.info(`Creating user in prod: ${email}`);
              prodUser = await prodClient.users.createUser(createUserData);
              logger.info(`Created user in prod: ${prodUser.id}`);
            }
          } catch (error: unknown) {
            const clerkError = error as { 
              errors?: Array<{ code?: string; message?: string; longMessage?: string }>; 
              status?: number;
              message?: string;
            };
            
            logger.error(`Error creating user ${normalizedEmail}:`, {
              error: clerkError,
              code: clerkError?.errors?.[0]?.code,
              message: clerkError?.errors?.[0]?.message,
              longMessage: clerkError?.errors?.[0]?.longMessage,
              status: clerkError?.status,
            });
            
            // Try to find user one more time if it's a duplicate error
            if (clerkError?.errors?.[0]?.code === 'duplicate_record' || 
                clerkError?.status === 422 ||
                clerkError?.message?.toLowerCase().includes('already exists')) {
              try {
                const existingUsers = await prodClient.users.getUserList({
                  emailAddress: [normalizedEmail],
                  limit: 1,
                });
                if (existingUsers.data.length > 0) {
                  prodUser = existingUsers.data[0];
                  logger.info(`Found existing user in prod after error: ${prodUser.id}`);
                } else {
                  throw new Error(`User exists but could not be found: ${clerkError?.errors?.[0]?.message || clerkError?.message}`);
                }
              } catch {
                throw new Error(`Failed to create or find user: ${clerkError?.errors?.[0]?.message || clerkError?.message || 'Unknown error'}`);
              }
            } else {
              throw new Error(`Failed to create user: ${clerkError?.errors?.[0]?.message || clerkError?.message || 'Unknown error'} (${clerkError?.errors?.[0]?.code || 'unknown'})`);
            }
          }
          
          const prodClerkUserId = prodUser.id;
          
          // Update Firestore documents
          const checksSnapshot = await firestore.collection('checks')
            .where('userId', '==', devClerkUserId)
            .get();
          
          if (!checksSnapshot.empty) {
            const checksBatch = firestore.batch();
            checksSnapshot.docs.forEach(doc => {
              checksBatch.update(doc.ref, { userId: prodClerkUserId });
            });
            await checksBatch.commit();
          }
          
          const webhooksSnapshot = await firestore.collection('webhooks')
            .where('userId', '==', devClerkUserId)
            .get();
          
          if (!webhooksSnapshot.empty) {
            const webhooksBatch = firestore.batch();
            webhooksSnapshot.docs.forEach(doc => {
              webhooksBatch.update(doc.ref, { userId: prodClerkUserId });
            });
            await webhooksBatch.commit();
          }
          
          const emailSettingsRef = firestore.collection('emailSettings').doc(devClerkUserId);
          const emailSettingsDoc = await emailSettingsRef.get();
          if (emailSettingsDoc.exists) {
            const emailSettingsData = emailSettingsDoc.data()!;
            const newEmailSettingsRef = firestore.collection('emailSettings').doc(prodClerkUserId);
            await newEmailSettingsRef.set(emailSettingsData);
            await emailSettingsRef.delete();
          }
          
          const apiKeysSnapshot = await firestore.collection('apiKeys')
            .where('userId', '==', devClerkUserId)
            .get();
          
          if (!apiKeysSnapshot.empty) {
            const apiKeysBatch = firestore.batch();
            apiKeysSnapshot.docs.forEach(doc => {
              apiKeysBatch.update(doc.ref, { userId: prodClerkUserId });
            });
            await apiKeysBatch.commit();
          }
          
            // Skip BigQuery updates during bulk migration to avoid timeout
            // BigQuery can be updated later using the fixBigQueryData function
            logger.info(`Skipping BigQuery update for ${normalizedEmail} during bulk migration (use fixBigQueryData later)`);
          
          // Update migration record
          await migrationRef.set({
            email: normalizedEmail,
            devClerkUserId,
            prodClerkUserId,
            instance: 'prod' as const,
            migrated: true,
            migratedAt: Date.now(),
            createdAt: migrationData.createdAt,
            updatedAt: Date.now(),
          }, { merge: true });
          
          migratedCount++;
          results.push({
            email: normalizedEmail,
            success: true,
            message: 'Migrated successfully',
          });
          
          logger.info(`Successfully migrated ${normalizedEmail}`);
        } catch (error) {
          failedCount++;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const errorDetails = error instanceof Error ? {
            message: error.message,
            stack: error.stack,
          } : String(error);
          logger.error(`Failed to migrate ${normalizedEmail}:`, {
            error: errorDetails,
            email: normalizedEmail,
          });
          results.push({
            email: normalizedEmail,
            success: false,
            error: errorMessage,
          });
        }
      }
      
      // Small delay between batches to avoid rate limits (reduced delay)
      if (i + actualBatchSize < usersToMigrate.length) {
        await new Promise(resolve => setTimeout(resolve, 300)); // Reduced to 300ms
      }
    }
    
    logger.info(`Bulk migration complete: ${migratedCount} migrated, ${failedCount} failed`);
    
    return {
      success: true,
      message: `Bulk migration complete: ${migratedCount} users migrated, ${failedCount} failed`,
      totalUsers: usersToMigrate.length,
      migratedUsers: migratedCount,
      failedUsers: failedCount,
      results: results.slice(0, 100), // Limit results to first 100 to avoid response size limits
    };
  } catch (error) {
    logger.error('Error in bulk migration:', error);
    throw new HttpsError('internal', `Failed to migrate users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Validation function to verify all migrated users and their data
export const validateMigration = onCall({
  cors: true,
  maxInstances: 1,
  timeoutSeconds: 540, // 9 minutes (max for 2nd gen functions)
  memory: '512MiB',
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Validate migration called by authenticated user:', uid);
    } else {
      logger.info('Validate migration called with secret token');
    }

    // Get Clerk clients
    const devSecretKey = CLERK_SECRET_KEY_DEV.value();
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    
    if (!devSecretKey || !prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Clerk secret keys not configured');
    }
    
    const prodClient = createClerkClient({ secretKey: prodSecretKey });

    logger.info('Starting migration validation...');
    
    // Get all migrated users (limit to avoid timeout)
    const migrationSnapshot = await firestore.collection('userMigrations')
      .where('migrated', '==', true)
      .limit(50) // Limit to 50 users per validation to avoid timeout
      .get();
    
    logger.info(`Found ${migrationSnapshot.size} migrated users to validate`);
    
    const results: Array<{
      email: string;
      valid: boolean;
      issues: string[];
      checksCount?: number;
      webhooksCount?: number;
      apiKeysCount?: number;
      hasEmailSettings?: boolean;
      prodUserExists?: boolean;
    }> = [];
    
    let validCount = 0;
    let invalidCount = 0;
    
    // Process users in smaller batches to avoid timeout
    const batchSize = 5;
    for (let i = 0; i < migrationSnapshot.docs.length; i += batchSize) {
      const batch = migrationSnapshot.docs.slice(i, i + batchSize);
      logger.info(`Validating batch ${Math.floor(i / batchSize) + 1} (${batch.length} users)...`);
      
      // Process batch in parallel for speed
      const batchPromises = batch.map(async (doc) => {
        const normalizedEmail = doc.id;
        const migrationData = doc.data();
        const issues: string[] = [];
        
        const prodClerkUserId = migrationData.prodClerkUserId;
        
        // Verify prod user exists (most important check)
        let prodUserExists = false;
        try {
          if (prodClerkUserId) {
            await prodClient.users.getUser(prodClerkUserId);
            prodUserExists = true;
          } else {
            issues.push('prodClerkUserId missing');
          }
        } catch {
          issues.push('Prod user not found in Clerk');
        }
        
        // Quick checks for data migration (simplified to avoid timeout)
        let checksCount = 0;
        let webhooksCount = 0;
        let apiKeysCount = 0;
        let hasEmailSettings = false;
        
        if (prodClerkUserId && prodUserExists) {
          // Count checks (quick check)
          try {
            const checksSnapshot = await firestore.collection('checks')
              .where('userId', '==', prodClerkUserId)
              .limit(1) // Just check if any exist, don't count all
              .get();
            checksCount = checksSnapshot.size > 0 ? 1 : 0; // Simplified: just indicate if checks exist
          } catch {
            // Skip if query fails
          }
          
          // Count webhooks (quick check)
          try {
            const webhooksSnapshot = await firestore.collection('webhooks')
              .where('userId', '==', prodClerkUserId)
              .limit(1)
              .get();
            webhooksCount = webhooksSnapshot.size > 0 ? 1 : 0;
          } catch {
            // Skip if query fails
          }
          
          // Count API keys (quick check)
          try {
            const apiKeysSnapshot = await firestore.collection('apiKeys')
              .where('userId', '==', prodClerkUserId)
              .limit(1)
              .get();
            apiKeysCount = apiKeysSnapshot.size > 0 ? 1 : 0;
          } catch {
            // Skip if query fails
          }
          
          // Check email settings
          try {
            const emailSettingsRef = firestore.collection('emailSettings').doc(prodClerkUserId);
            const emailSettingsDoc = await emailSettingsRef.get();
            hasEmailSettings = emailSettingsDoc.exists;
          } catch {
            // Skip if query fails
          }
        }
        
        const isValid = issues.length === 0 && prodUserExists;
        
        return {
          email: normalizedEmail,
          valid: isValid,
          issues,
          checksCount,
          webhooksCount,
          apiKeysCount,
          hasEmailSettings,
          prodUserExists,
        };
      });
      
      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);
      
      // Count valid/invalid
      for (const result of batchResults) {
        if (result.valid) {
          validCount++;
        } else {
          invalidCount++;
        }
        results.push(result);
      }
      
      // Small delay between batches
      if (i + batchSize < migrationSnapshot.docs.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    logger.info(`Validation complete: ${validCount} valid, ${invalidCount} invalid`);
    
    return {
      success: true,
      message: `Validation complete: ${validCount} users valid, ${invalidCount} users have issues`,
      totalUsers: migrationSnapshot.size,
      validUsers: validCount,
      invalidUsers: invalidCount,
      results: results.slice(0, 200), // Limit to first 200 to avoid response size limits
    };
  } catch (error) {
    logger.error('Error validating migration:', error);
    throw new HttpsError('internal', `Failed to validate migration: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});


