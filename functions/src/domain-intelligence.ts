/**
 * Domain Intelligence (DI) - Domain Expiry Monitoring
 * 
 * Uses RDAP to monitor domain registration expiration dates and alert users
 * before their domains expire. This feature is exclusive to Nano tier users.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { FieldValue } from "firebase-admin/firestore";
import { firestore, getUserTier, getUserTierLive } from "./init";
import { Website, DomainExpiry } from "./types";
import { 
  queryRdap, 
  extractDomain, 
  validateDomainForRdap, 
  calculateNextCheckTime,
  calculateDomainStatus,
  RdapDomainInfo
} from "./rdap-client";
import { triggerDomainAlert, triggerDomainRenewalAlert } from "./alert";
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV } from "./env";

// Configuration
const DI_SCHEDULER_MEMORY = "256MiB" as const;
const DI_SCHEDULER_TIMEOUT_SECONDS = 540;
const DI_MAX_BATCH_SIZE = 400; // Firestore batch limit is 500
const DI_TIME_BUDGET_MS = 500 * 1000; // 8.3 min safety margin
const DI_MANUAL_REFRESH_RATE_LIMIT_COLLECTION = 'domainRefreshRateLimits';
const DI_MANUAL_REFRESH_LIMIT_PER_DAY = 50;

// Default alert thresholds (days before expiry)
const DEFAULT_ALERT_THRESHOLDS = [30, 14, 7, 1];

/**
 * Scheduled function to check domain expiry for all enabled domains
 * Runs every 6 hours, processing only domains that are due for checking
 */
export const checkDomainExpiry = onSchedule({
  schedule: "every 6 hours",
  region: "us-central1",
  timeoutSeconds: DI_SCHEDULER_TIMEOUT_SECONDS,
  memory: DI_SCHEDULER_MEMORY,
  maxInstances: 1,
}, async () => {
  const now = Date.now();
  const startTime = now;
  
  logger.info('Domain Intelligence scheduler starting', { now });
  
  // Query checks with domain expiry enabled and due for checking
  const checksQuery = firestore.collection('checks')
    .where('domainExpiry.enabled', '==', true)
    .where('domainExpiry.nextCheckAt', '<=', now)
    .orderBy('domainExpiry.nextCheckAt')
    .limit(500);
  
  const snapshot = await checksQuery.get();
  
  if (snapshot.empty) {
    logger.info('No domains due for checking');
    return;
  }
  
  logger.info(`Processing ${snapshot.docs.length} domains due for checking`);
  
  // Cache user tiers to minimize Clerk API calls
  const userTierCache = new Map<string, 'free' | 'nano'>();
  
  async function verifyNanoTier(userId: string): Promise<boolean> {
    if (userTierCache.has(userId)) {
      return userTierCache.get(userId) === 'nano';
    }
    const tier = await getUserTier(userId);
    userTierCache.set(userId, tier);
    return tier === 'nano';
  }
  
  // Batch writes for efficiency
  let batch = firestore.batch();
  let batchCount = 0;
  let processedCount = 0;
  let errorCount = 0;
  
  for (const doc of snapshot.docs) {
    // Check time budget
    if (Date.now() - startTime > DI_TIME_BUDGET_MS) {
      logger.warn('Time budget exceeded, stopping', { processed: processedCount });
      break;
    }
    
    const check = doc.data() as Website;
    
    // Verify user is still on Nano tier
    const isNano = await verifyNanoTier(check.userId);
    if (!isNano) {
      // User downgraded - disable domain expiry
      logger.info(`User ${check.userId} no longer on Nano tier, disabling DI for check ${doc.id}`);
      batch.update(doc.ref, { 'domainExpiry.enabled': false });
      batchCount++;
      continue;
    }
    
    const domainExpiry = check.domainExpiry!;
    
    try {
      const rdapData = await queryRdap(domainExpiry.domain);
      const updateData = processRdapResult(domainExpiry, rdapData, now);
      
      // Update nested domainExpiry field
      batch.update(doc.ref, prefixKeys('domainExpiry', updateData));
      batchCount++;
      
      // Check for alerts
      await checkAndSendAlerts(check, domainExpiry, updateData);
      
      processedCount++;
      
    } catch (error) {
      // Handle errors with exponential backoff
      const errorUpdate = handleCheckError(domainExpiry, error as Error, now);
      batch.update(doc.ref, prefixKeys('domainExpiry', errorUpdate));
      batchCount++;
      errorCount++;
      
      logger.warn(`RDAP query failed for ${domainExpiry.domain}`, { 
        error: (error as Error).message,
        checkId: doc.id 
      });
    }
    
    // Commit batch if approaching limit
    if (batchCount >= DI_MAX_BATCH_SIZE) {
      await batch.commit();
      batch = firestore.batch();
      batchCount = 0;
    }
  }
  
  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }
  
  logger.info('Domain Intelligence scheduler completed', {
    processed: processedCount,
    errors: errorCount,
    durationMs: Date.now() - startTime,
  });
});

/**
 * Process RDAP result and compute update data
 */
function processRdapResult(
  current: DomainExpiry,
  rdapData: RdapDomainInfo,
  now: number
): Partial<DomainExpiry> {
  const daysUntilExpiry = rdapData.daysUntilExpiry;
  const status = calculateDomainStatus(daysUntilExpiry);
  
  return {
    registrar: rdapData.registrar,
    registrarUrl: rdapData.registrarUrl,
    createdDate: rdapData.createdDate,
    updatedDate: rdapData.updatedDate,
    expiryDate: rdapData.expiryDate,
    nameservers: rdapData.nameservers,
    registryStatus: rdapData.registryStatus,
    status,
    daysUntilExpiry,
    lastCheckedAt: now,
    nextCheckAt: calculateNextCheckTime(daysUntilExpiry, now),
    consecutiveErrors: 0,
    lastError: undefined, // Clear any previous error
  };
}

/**
 * Handle check errors with exponential backoff
 */
function handleCheckError(
  domain: DomainExpiry, 
  error: Error, 
  now: number
): Partial<DomainExpiry> {
  const consecutiveErrors = (domain.consecutiveErrors || 0) + 1;
  
  // Exponential backoff: 1h, 4h, 12h, 24h, 48h max
  const backoffHours = Math.min(Math.pow(2, consecutiveErrors - 1), 48);
  const nextCheckAt = now + backoffHours * 60 * 60 * 1000;
  
  return {
    lastCheckedAt: now,
    nextCheckAt,
    consecutiveErrors,
    lastError: error.message.slice(0, 500), // Truncate for storage
    status: consecutiveErrors >= 5 ? 'error' : domain.status,
  };
}

/**
 * Check and send alerts for domain expiry thresholds
 */
async function checkAndSendAlerts(
  check: Website,
  currentDomainExpiry: DomainExpiry,
  updateData: Partial<DomainExpiry>
): Promise<void> {
  const daysUntilExpiry = updateData.daysUntilExpiry;
  if (daysUntilExpiry === undefined) return;
  
  const alertsSent = currentDomainExpiry.alertsSent || [];
  const thresholds = currentDomainExpiry.alertThresholds || DEFAULT_ALERT_THRESHOLDS;
  
  // Check each threshold
  for (const threshold of thresholds) {
    // Skip if already sent
    if (alertsSent.includes(threshold)) continue;
    
    // Trigger if we've crossed this threshold
    if (daysUntilExpiry <= threshold) {
      await triggerDomainAlert(check, threshold, daysUntilExpiry);
      
      // Mark as sent (will be included in batch update)
      updateData.alertsSent = [...alertsSent, threshold];
      break; // Only one alert per check
    }
  }
  
  // Check for domain renewed (expiry moved forward significantly)
  if (currentDomainExpiry.expiryDate && updateData.expiryDate) {
    const oldExpiry = currentDomainExpiry.expiryDate;
    const newExpiry = updateData.expiryDate;
    
    // If expiry extended by more than 30 days, it's a renewal
    if (newExpiry > oldExpiry + 30 * 24 * 60 * 60 * 1000) {
      await triggerDomainRenewalAlert(check, newExpiry);
      updateData.alertsSent = []; // Reset alerts for new cycle
    }
  }
}

/**
 * Helper to update nested fields with dot notation
 */
function prefixKeys(prefix: string, obj: Record<string, unknown>): FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> {
  const result: Record<string, FieldValue | unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      result[`${prefix}.${key}`] = FieldValue.delete();
    } else {
      result[`${prefix}.${key}`] = value;
    }
  }
  return result;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Enable domain expiry monitoring for a check (Nano only)
 */
export const enableDomainExpiry = onCall(
  { secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  // Verify Nano tier (live check)
  const tier = await getUserTierLive(uid);
  if (tier !== 'nano') {
    throw new HttpsError(
      'permission-denied',
      'Domain Intelligence is only available for Nano subscribers'
    );
  }
  
  const { checkId, alertThresholds } = request.data as {
    checkId: string;
    alertThresholds?: number[];
  };
  
  if (!checkId) {
    throw new HttpsError('invalid-argument', 'checkId is required');
  }
  
  // Get the existing check
  const checkRef = firestore.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  const check = checkDoc.data() as Website;
  
  // Check if already enabled
  if (check.domainExpiry?.enabled) {
    return { success: true, data: { checkId, domainExpiry: check.domainExpiry } };
  }
  
  // Extract domain from check URL
  const domain = extractDomain(check.url);
  if (!domain) {
    throw new HttpsError('invalid-argument', 'Could not extract domain from URL');
  }
  
  // Validate domain supports RDAP
  const validation = validateDomainForRdap(domain);
  if (!validation.valid) {
    throw new HttpsError('invalid-argument', validation.error || 'Domain not supported');
  }

  // Check for duplicate domain monitoring (deduplication per user)
  const existingMonitor = await firestore.collection('checks')
    .where('userId', '==', uid)
    .where('domainExpiry.enabled', '==', true)
    .where('domainExpiry.domain', '==', domain)
    .limit(1)
    .get();

  if (!existingMonitor.empty) {
    const existingCheck = existingMonitor.docs[0].data() as Website;
    throw new HttpsError(
      'already-exists',
      `Domain "${domain}" is already monitored on check "${existingCheck.name}"`
    );
  }

  // Enable DI immediately without RDAP query
  // The scheduled job will fetch RDAP data shortly
  const now = Date.now();
  const domainExpiry: DomainExpiry = {
    enabled: true,
    domain,
    status: 'unknown',
    lastCheckedAt: 0,
    nextCheckAt: now, // Check immediately on next scheduler run
    consecutiveErrors: 0,
    alertThresholds: alertThresholds || DEFAULT_ALERT_THRESHOLDS,
    alertsSent: [],
  };
  
  await checkRef.update({ domainExpiry });

  logger.info(`Domain Intelligence enabled for check ${checkId}`, { domain });
  
  return { success: true, data: { checkId, domainExpiry } };
});

/**
 * Disable domain expiry monitoring for a check
 */
export const disableDomainExpiry = onCall(
  { secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  const { checkId } = request.data as { checkId: string };
  
  if (!checkId) {
    throw new HttpsError('invalid-argument', 'checkId is required');
  }
  
  const checkRef = firestore.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  await checkRef.update({ 'domainExpiry.enabled': false });
  
  logger.info(`Domain Intelligence disabled for check ${checkId}`);
  
  return { success: true };
});

/**
 * Update domain expiry settings for a check
 */
export const updateDomainExpiry = onCall(
  { secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  const { checkId, alertThresholds } = request.data as {
    checkId: string;
    alertThresholds?: number[];
  };
  
  if (!checkId) {
    throw new HttpsError('invalid-argument', 'checkId is required');
  }
  
  const checkRef = firestore.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  const check = checkDoc.data() as Website;
  if (!check.domainExpiry?.enabled) {
    throw new HttpsError('failed-precondition', 'Domain expiry monitoring not enabled');
  }
  
  const updates: Record<string, unknown> = {};
  
  if (alertThresholds) {
    // Validate thresholds (1-365 days)
    const validThresholds = alertThresholds.filter(t => 
      Number.isInteger(t) && t >= 1 && t <= 365
    ).sort((a, b) => b - a); // Sort descending
    
    updates['domainExpiry.alertThresholds'] = validThresholds;
  }
  
  if (Object.keys(updates).length > 0) {
    await checkRef.update(updates);
    logger.info(`Domain expiry settings updated for check ${checkId}`, updates);
  }
  
  return { success: true };
});

/**
 * Manual refresh of domain expiry data
 */
export const refreshDomainExpiry = onCall(
  { secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  const { checkId } = request.data as { checkId: string };
  
  if (!checkId) {
    throw new HttpsError('invalid-argument', 'checkId is required');
  }
  
  const checkRef = firestore.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  const check = checkDoc.data() as Website;
  if (!check.domainExpiry?.enabled) {
    throw new HttpsError('failed-precondition', 'Domain expiry monitoring not enabled');
  }
  
  // Rate limit manual refreshes (10/day per domain)
  await enforceRefreshRateLimit(uid, checkId);
  
  // Query RDAP
  let rdapData: RdapDomainInfo;
  try {
    rdapData = await queryRdap(check.domainExpiry.domain);
  } catch (error) {
    throw new HttpsError('unavailable', `RDAP query failed: ${(error as Error).message}`);
  }
  
  const now = Date.now();
  const daysUntilExpiry = rdapData.daysUntilExpiry;
  
  const updates: Record<string, unknown> = {
    'domainExpiry.registrar': rdapData.registrar,
    'domainExpiry.registrarUrl': rdapData.registrarUrl,
    'domainExpiry.createdDate': rdapData.createdDate,
    'domainExpiry.updatedDate': rdapData.updatedDate,
    'domainExpiry.expiryDate': rdapData.expiryDate,
    'domainExpiry.nameservers': rdapData.nameservers,
    'domainExpiry.registryStatus': rdapData.registryStatus,
    'domainExpiry.status': calculateDomainStatus(daysUntilExpiry),
    'domainExpiry.daysUntilExpiry': daysUntilExpiry,
    'domainExpiry.lastCheckedAt': now,
    'domainExpiry.nextCheckAt': calculateNextCheckTime(daysUntilExpiry, now),
    'domainExpiry.consecutiveErrors': 0,
    'domainExpiry.lastError': FieldValue.delete(),
  };
  
  await checkRef.update(updates);
  
  logger.info(`Domain expiry manually refreshed for check ${checkId}`, { 
    domain: check.domainExpiry.domain,
    daysUntilExpiry 
  });
  
  return { 
    success: true, 
    data: { 
      checkId, 
      ...rdapData 
    } 
  };
});

/**
 * Bulk enable domain expiry for multiple checks (Nano only)
 */
export const bulkEnableDomainExpiry = onCall(
  {
    secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
    timeoutSeconds: 60, // 1 minute is plenty since we don't query RDAP
  },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  // Verify Nano tier (live check)
  const tier = await getUserTierLive(uid);
  if (tier !== 'nano') {
    throw new HttpsError(
      'permission-denied',
      'Domain Intelligence is only available for Nano subscribers'
    );
  }
  
  const { checkIds } = request.data as { checkIds: string[] };
  
  if (!checkIds || !Array.isArray(checkIds) || checkIds.length === 0) {
    throw new HttpsError('invalid-argument', 'checkIds array is required');
  }
  
  // Limit bulk operations
  if (checkIds.length > 50) {
    throw new HttpsError('invalid-argument', 'Maximum 50 checks per bulk operation');
  }
  
  const results: Array<{ checkId: string; success: boolean; error?: string; domain?: string }> = [];

  for (let i = 0; i < checkIds.length; i++) {
    const checkId = checkIds[i];

    try {
      const checkRef = firestore.collection('checks').doc(checkId);
      const checkDoc = await checkRef.get();

      if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
        results.push({ checkId, success: false, error: 'Check not found' });
        continue;
      }

      const check = checkDoc.data() as Website;

      // Skip if already enabled
      if (check.domainExpiry?.enabled) {
        results.push({
          checkId,
          success: true,
          domain: check.domainExpiry.domain
        });
        continue;
      }

      // Extract domain
      const domain = extractDomain(check.url);
      if (!domain) {
        results.push({ checkId, success: false, error: 'Could not extract domain' });
        continue;
      }

      // Validate domain
      const validation = validateDomainForRdap(domain);
      if (!validation.valid) {
        results.push({ checkId, success: false, error: validation.error });
        continue;
      }

      // Check for duplicate domain monitoring (deduplication per user)
      const existingMonitor = await firestore.collection('checks')
        .where('userId', '==', uid)
        .where('domainExpiry.enabled', '==', true)
        .where('domainExpiry.domain', '==', domain)
        .limit(1)
        .get();

      if (!existingMonitor.empty) {
        const existingCheck = existingMonitor.docs[0].data() as Website;
        results.push({
          checkId,
          success: false,
          error: `Domain "${domain}" is already monitored on check "${existingCheck.name}"`
        });
        continue;
      }

      // Enable DI immediately without RDAP query
      // The scheduled job will fetch RDAP data shortly
      const now = Date.now();
      const domainExpiry: DomainExpiry = {
        enabled: true,
        domain,
        status: 'unknown',
        lastCheckedAt: 0,
        nextCheckAt: now, // Check immediately on next scheduler run
        consecutiveErrors: 0,
        alertThresholds: DEFAULT_ALERT_THRESHOLDS,
        alertsSent: [],
      };

      await checkRef.update({ domainExpiry });
      results.push({ checkId, success: true, domain });

      logger.info(`Bulk enable: Successfully enabled DI for ${domain} (${i + 1}/${checkIds.length})`);

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.warn(`Bulk enable: Failed for check ${checkId}`, { error: errorMessage });

      results.push({
        checkId,
        success: false,
        error: errorMessage
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  logger.info(`Bulk domain expiry enable completed`, { 
    requested: checkIds.length, 
    succeeded: successCount 
  });
  
  return { success: true, data: { results } };
});

/**
 * Get all domain intelligence data for user's checks
 */
export const getDomainIntelligence = onCall(
  { secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  // Query all checks with domain expiry enabled for this user
  const checksQuery = firestore.collection('checks')
    .where('userId', '==', uid)
    .where('domainExpiry.enabled', '==', true);
  
  const snapshot = await checksQuery.get();
  
  const domains = snapshot.docs.map(doc => {
    const check = doc.data() as Website;
    return {
      checkId: doc.id,
      checkName: check.name,
      checkUrl: check.url,
      folder: check.folder,
      ...check.domainExpiry,
    };
  });
  
  // Sort by days until expiry (soonest first)
  domains.sort((a, b) => {
    const aDays = a.daysUntilExpiry ?? Infinity;
    const bDays = b.daysUntilExpiry ?? Infinity;
    return aDays - bDays;
  });
  
  return { 
    success: true, 
    data: { 
      domains,
      count: domains.length,
    } 
  };
});

/**
 * Rate limit manual refreshes
 */
async function enforceRefreshRateLimit(userId: string, checkId: string): Promise<void> {
  const now = Date.now();
  const dayStart = now - (now % (24 * 60 * 60 * 1000));
  const docId = `${userId}__${checkId}__${dayStart}`;
  
  const docRef = firestore.collection(DI_MANUAL_REFRESH_RATE_LIMIT_COLLECTION).doc(docId);
  
  try {
    await firestore.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      
      if (doc.exists) {
        const count = doc.data()!.count || 0;
        if (count >= DI_MANUAL_REFRESH_LIMIT_PER_DAY) {
          throw new HttpsError('resource-exhausted', 'Daily refresh limit reached (50/day)');
        }
        tx.update(docRef, { count: count + 1 });
      } else {
        tx.set(docRef, {
          userId,
          checkId,
          count: 1,
          dayStart,
          createdAt: now,
        });
      }
    });
  } catch (error) {
    if ((error as HttpsError).code === 'resource-exhausted') {
      throw error;
    }
    // Log but don't block on rate limit failures
    logger.warn('Rate limit check failed', { error });
  }
}
