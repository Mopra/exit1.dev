/**
 * Badge API endpoints - separate from main public-api to keep things organized
 * No authentication required - designed for public embedding
 */

import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { getCheckStats } from './bigquery';
import { Website } from './types';

// In-memory cache for badge data to minimize BigQuery costs
export interface CachedBadgeData {
  data: BadgeData;
  timestamp: number;
}

export interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  uptimePercentage: number;
  lastChecked: number;
  status: string;
  createdAt?: number;
}

const badgeCache = new Map<string, CachedBadgeData>();
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BADGE_CACHE_SIZE = 1000;
const CACHE_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

// Rate limiting: Track requests per IP
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60; // 60 requests per minute per IP
const MAX_RATE_LIMIT_RECORDS = 5000;

const MAX_IN_FLIGHT_FETCHES = 20;
const RETRY_ATTEMPTS = 3;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15_000;

const inFlightFetches = new Map<string, Promise<BadgeData | null>>();
let maintenanceInitialized = false;
let cleanupInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;
let shutdownHandlersRegistered = false;

/**
 * Check if an IP address has exceeded rate limits
 */
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    // Create new record or reset expired one
    rateLimitMap.set(ip, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS
    });
    enforceRateLimitMapLimit();
    return false;
  }

  record.count++;
  
  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  return false;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function getCachedBadgeData(checkId: string): BadgeData | null {
  const cached = badgeCache.get(checkId);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.timestamp >= CACHE_DURATION_MS) {
    badgeCache.delete(checkId);
    return null;
  }

  return cached.data;
}

function enforceBadgeCacheLimit(): void {
  while (badgeCache.size > MAX_BADGE_CACHE_SIZE) {
    const iterator = badgeCache.keys().next();
    if (iterator.done) {
      break;
    }
    badgeCache.delete(iterator.value);
  }
}

function enforceRateLimitMapLimit(): void {
  while (rateLimitMap.size > MAX_RATE_LIMIT_RECORDS) {
    const iterator = rateLimitMap.keys().next();
    if (iterator.done) {
      break;
    }
    rateLimitMap.delete(iterator.value);
  }
}

async function throttleInFlightFetches(): Promise<void> {
  while (inFlightFetches.size >= MAX_IN_FLIGHT_FETCHES) {
    const pending = Array.from(inFlightFetches.values()).map(fetch =>
      fetch.catch(() => null)
    );

    if (pending.length === 0) {
      break;
    }

    await Promise.race(pending);
  }
}

async function waitForInFlightFetches(): Promise<void> {
  if (!inFlightFetches.size) {
    return;
  }
  await Promise.allSettled(inFlightFetches.values());
}

async function getOrCreateFetchPromise(
  checkId: string,
  fetcher: () => Promise<BadgeData | null>
): Promise<BadgeData | null> {
  const existing = inFlightFetches.get(checkId);
  if (existing) {
    return existing;
  }

  await throttleInFlightFetches();

  const nextExisting = inFlightFetches.get(checkId);
  if (nextExisting) {
    return nextExisting;
  }

  const fetchPromise = (async () => {
    try {
      return await fetcher();
    } finally {
      inFlightFetches.delete(checkId);
    }
  })();

  inFlightFetches.set(checkId, fetchPromise);
  return fetchPromise;
}

async function retryWithBackoff<T>(
  operationName: string,
  fn: () => Promise<T>
): Promise<T> {
  let attempt = 0;
  let delay = RETRY_INITIAL_DELAY_MS;
  let lastError: unknown;

  while (attempt < RETRY_ATTEMPTS) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      attempt += 1;

      if (attempt >= RETRY_ATTEMPTS) {
        throw error;
      }

      logger.warn(
        `Badge API ${operationName} failed (attempt ${attempt} of ${RETRY_ATTEMPTS}), retrying in ${delay}ms`,
        error
      );
      await sleep(delay);
      delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
    }
  }

  // Should be unreachable, but keep TypeScript satisfied.
  throw lastError ?? new Error(`Badge API ${operationName} failed`);
}

const ensureMaintenanceInitialized = () => {
  if (maintenanceInitialized) {
    return;
  }

  maintenanceInitialized = true;
  cleanupBadgeCache();
  cleanupInterval = setInterval(() => {
    try {
      cleanupBadgeCache();
    } catch (error) {
      logger.error('Error running badge cache cleanup:', error);
    }
  }, CACHE_SWEEP_INTERVAL_MS);
};

const handleShutdownSignal = async (signal: NodeJS.Signals) => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info(`Badge API received ${signal}, draining caches before shutdown...`);

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  await waitForInFlightFetches();
  cleanupBadgeCache();
};

const registerShutdownHandlers = () => {
  if (shutdownHandlersRegistered) {
    return;
  }

  shutdownHandlersRegistered = true;

  process.on('SIGTERM', () => {
    void handleShutdownSignal('SIGTERM');
  });
  process.on('SIGINT', () => {
    void handleShutdownSignal('SIGINT');
  });
};

registerShutdownHandlers();

function resetBadgeApiForTests(): void {
  badgeCache.clear();
  rateLimitMap.clear();
  inFlightFetches.clear();
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  maintenanceInitialized = false;
  isShuttingDown = false;
}


/**
 * Get badge data for a specific check
 * Public endpoint - no authentication required
 * Implements caching to minimize BigQuery costs
 */
export async function getBadgeData(checkId: string, clientIp?: string): Promise<BadgeData | null> {
  ensureMaintenanceInitialized();

  try {
    // Rate limiting
    if (clientIp && isRateLimited(clientIp)) {
      logger.warn(`Rate limit exceeded for IP: ${clientIp}`);
      throw new Error('Rate limit exceeded. Please try again later.');
    }

    const cached = getCachedBadgeData(checkId);
    if (cached) {
      logger.info(`Badge data cache hit for check: ${checkId}`);
      return cached;
    }

    const fetched = await getOrCreateFetchPromise(checkId, async () => {
      const firestore = getFirestore();
      const checkDoc = await retryWithBackoff('firestore:checks.doc.get', () =>
        firestore.collection('checks').doc(checkId).get()
      );

      if (!checkDoc.exists) {
        logger.warn(`Check not found: ${checkId}`);
        return null;
      }

      const check = checkDoc.data() as Website;

      // Don't show disabled checks
      if (check.disabled) {
        logger.info(`Check is disabled: ${checkId}`);
        return null;
      }

      // Get all-time uptime stats from BigQuery
      let uptimePercentage = 0;
      try {
        const stats = await retryWithBackoff('bigquery:getCheckStats', () =>
          getCheckStats(checkId, check.userId)
        );
        uptimePercentage = stats.uptimePercentage;
      } catch (error) {
        logger.error(`Error fetching BigQuery stats for check ${checkId} after retries:`, error);
        // Continue with 0% if BigQuery fails - better than failing completely
        uptimePercentage = 0;
      }

      const badgeData: BadgeData = {
        checkId,
        name: check.name,
        url: check.url,
        uptimePercentage: Math.round(uptimePercentage * 100) / 100, // Round to 2 decimals
        lastChecked: check.lastChecked || 0,
        status: check.status || 'unknown',
        createdAt: check.createdAt
      };

      // Cache the result
      badgeCache.set(checkId, {
        data: badgeData,
        timestamp: Date.now()
      });
      enforceBadgeCacheLimit();

      logger.info(`Badge data fetched and cached for check: ${checkId}`);
      return badgeData;
    });

    return fetched;

  } catch (error) {
    logger.error(`Error in getBadgeData for check ${checkId}:`, error);
    throw error;
  }
}

/**
 * Clear cache for a specific check (can be called after check updates)
 */
export function clearBadgeCache(checkId: string): void {
  ensureMaintenanceInitialized();
  badgeCache.delete(checkId);
  logger.info(`Badge cache cleared for check: ${checkId}`);
}

/**
 * Clean up expired cache entries and rate limit records periodically
 */
export function cleanupBadgeCache(): void {
  const now = Date.now();
  
  // Clean up badge cache
  for (const [checkId, cached] of badgeCache.entries()) {
    if (now - cached.timestamp >= CACHE_DURATION_MS) {
      badgeCache.delete(checkId);
    }
  }
  enforceBadgeCacheLimit();
  
  // Clean up rate limit records
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
  enforceRateLimitMapLimit();
  
  logger.info('Badge cache cleanup completed', {
    badgeEntries: badgeCache.size,
    rateLimitEntries: rateLimitMap.size
  });
}

export const __badgeApiTestHooks = {
  badgeCache,
  rateLimitMap,
  inFlightFetches,
  getCachedBadgeData,
  getOrCreateFetchPromise,
  cleanupBadgeCache,
  resetState: resetBadgeApiForTests,
  constants: {
    CACHE_DURATION_MS,
    MAX_BADGE_CACHE_SIZE,
    MAX_RATE_LIMIT_RECORDS,
    MAX_IN_FLIGHT_FETCHES
  }
};

