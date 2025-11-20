import { onRequest, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { firestore, getUserTier } from "./init";
import { CONFIG } from "./config";
import { Website } from "./types";
import { RESEND_API_KEY, RESEND_FROM } from "./env";
import { statusUpdateBuffer, statusFlushInterval, initializeStatusFlush, flushStatusUpdates } from "./status-buffer";
import { checkRestEndpoint, storeCheckHistory } from "./check-utils";
import { triggerAlert, triggerSSLAlert, triggerDomainExpiryAlert } from "./alert";

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
