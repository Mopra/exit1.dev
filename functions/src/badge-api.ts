/**
 * Badge API endpoints - separate from main public-api to keep things organized
 * No authentication required - designed for public embedding
 */

import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { getCheckStats } from './bigquery';
import { Website } from './types';

// In-memory cache for badge data to minimize BigQuery costs
interface CachedBadgeData {
  data: BadgeData;
  timestamp: number;
}

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  uptimePercentage: number;
  lastChecked: number;
  status: string;
}

const badgeCache = new Map<string, CachedBadgeData>();
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Rate limiting: Track requests per IP
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60; // 60 requests per minute per IP

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
    return false;
  }

  record.count++;
  
  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  return false;
}

/**
 * Get badge data for a specific check
 * Public endpoint - no authentication required
 * Implements caching to minimize BigQuery costs
 */
export async function getBadgeData(checkId: string, clientIp?: string): Promise<BadgeData | null> {
  try {
    // Rate limiting
    if (clientIp && isRateLimited(clientIp)) {
      logger.warn(`Rate limit exceeded for IP: ${clientIp}`);
      throw new Error('Rate limit exceeded. Please try again later.');
    }

    // Check cache first
    const cached = badgeCache.get(checkId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION_MS) {
      logger.info(`Badge data cache hit for check: ${checkId}`);
      return cached.data;
    }

    // Fetch check data from Firestore
    const firestore = getFirestore();
    const checkDoc = await firestore.collection('checks').doc(checkId).get();
    
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
      const stats = await getCheckStats(checkId, check.userId);
      uptimePercentage = stats.uptimePercentage;
    } catch (error) {
      logger.error(`Error fetching BigQuery stats for check ${checkId}:`, error);
      // Continue with 0% if BigQuery fails - better than failing completely
      uptimePercentage = 0;
    }

    const badgeData: BadgeData = {
      checkId: checkId,
      name: check.name,
      url: check.url,
      uptimePercentage: Math.round(uptimePercentage * 100) / 100, // Round to 2 decimals
      lastChecked: check.lastChecked || 0,
      status: check.status || 'unknown'
    };

    // Cache the result
    badgeCache.set(checkId, {
      data: badgeData,
      timestamp: Date.now()
    });

    logger.info(`Badge data fetched and cached for check: ${checkId}`);
    return badgeData;

  } catch (error) {
    logger.error(`Error in getBadgeData for check ${checkId}:`, error);
    throw error;
  }
}

/**
 * Clear cache for a specific check (can be called after check updates)
 */
export function clearBadgeCache(checkId: string): void {
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
  
  // Clean up rate limit records
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
  
  logger.info('Badge cache cleanup completed');
}

