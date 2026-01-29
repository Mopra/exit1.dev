import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { Website, ApiKeyDoc } from "./types";
import { BigQueryCheckHistoryRow } from './bigquery';
import { FixedWindowRateLimiter, applyRateLimitHeaders, getClientIp } from "./rate-limit";

const firestore = getFirestore();
const API_KEYS_COLLECTION = 'apiKeys';
const API_KEY_USAGE_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const API_KEY_USAGE_CACHE_MAX = 5000;
const apiKeyUsageCache = new Map<string, { lastWriteAt: number }>();
const CHECKS_TOTAL_CACHE_TTL_MS = 10 * 60 * 1000;
const CHECKS_TOTAL_CACHE_MAX = 5000;
const checksTotalCache = new Map<string, { count: number; expiresAt: number }>();

// API key validation cache - reduces Firestore reads for repeated API calls
const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const API_KEY_CACHE_MAX = 5000;
interface CachedApiKey {
  keyDocId: string;
  userId: string;
  enabled: boolean;
  expiresAt: number;
}
const apiKeyValidationCache = new Map<string, CachedApiKey>();

const getCachedApiKey = (hash: string): CachedApiKey | null => {
  const cached = apiKeyValidationCache.get(hash);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    apiKeyValidationCache.delete(hash);
    return null;
  }
  return cached;
};

const setCachedApiKey = (hash: string, keyDocId: string, userId: string, enabled: boolean): void => {
  apiKeyValidationCache.set(hash, {
    keyDocId,
    userId,
    enabled,
    expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
  });
  if (apiKeyValidationCache.size > API_KEY_CACHE_MAX) {
    // Clear cache when it gets too large to prevent memory issues
    apiKeyValidationCache.clear();
  }
};

const shouldWriteApiKeyUsage = (keyId: string, now: number): boolean => {
  const cached = apiKeyUsageCache.get(keyId);
  if (cached && now - cached.lastWriteAt < API_KEY_USAGE_DEBOUNCE_MS) {
    return false;
  }

  apiKeyUsageCache.set(keyId, { lastWriteAt: now });
  if (apiKeyUsageCache.size > API_KEY_USAGE_CACHE_MAX) {
    apiKeyUsageCache.clear();
  }

  return true;
};

const getCachedChecksTotal = (cacheKey: string): number | null => {
  const cached = checksTotalCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    checksTotalCache.delete(cacheKey);
    return null;
  }
  return cached.count;
};

const setCachedChecksTotal = (cacheKey: string, count: number): void => {
  checksTotalCache.set(cacheKey, { count, expiresAt: Date.now() + CHECKS_TOTAL_CACHE_TTL_MS });
  if (checksTotalCache.size > CHECKS_TOTAL_CACHE_MAX) {
    checksTotalCache.clear();
  }
};

const parseCursor = (cursor: string | undefined): { orderIndex: number; id: string } | null => {
  if (!cursor || typeof cursor !== 'string') {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as { orderIndex?: number; id?: string };
    if (typeof parsed.id !== 'string' || !parsed.id) {
      return null;
    }
    const orderIndex = typeof parsed.orderIndex === 'number' ? parsed.orderIndex : 0;
    return { orderIndex, id: parsed.id };
  } catch {
    return null;
  }
};

const buildCursor = (doc: QueryDocumentSnapshot): string => {
  const data = doc.data() as { orderIndex?: number };
  const orderIndex = typeof data.orderIndex === 'number' ? data.orderIndex : 0;
  return Buffer.from(JSON.stringify({ orderIndex, id: doc.id }), 'utf8').toString('base64');
};

// Public API rate limits (free tier)
// - pre-auth IP guard: slows down API key guessing and abusive traffic
// - post-auth: 5 req/min total per API key, 1 req/min per endpoint
// - daily quotas: 500 req/day per API key, 2000 req/day per user
//
// With these limits:
// - Single API key: max 300 req/hour (5/min) or 500/day (whichever hits first)
// - Single user (multiple keys): max 2000 req/day
// - Max monthly invocations per user: ~60K/month (2000/day * 30 days)
const RATE_LIMITS = {
  ipPerMinute: 20,         // Reduced from 30 to 20
  perKeyTotalPerMinute: 5, // Reduced from 10 to 5
  perEndpointPerMinute: 1, // Reduced from 2 to 1
  perKeyDaily: 500,        // 500 requests per day per API key
  perUserDaily: 2000,      // 2000 requests per day per user (across all their keys)
} as const;
const ipGuardLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 20_000 });
const apiKeyLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 50_000 });
const dailyQuotaLimiter = new FixedWindowRateLimiter({ windowMs: 24 * 60 * 60 * 1000, maxKeys: 50_000 }); // 24 hour window

function getRouteName(segments: string[]): string {
  // /v1/public/checks/:id/history
  if (segments.length === 5 && segments[2] === 'checks' && segments[4] === 'history') {
    return 'checks_history';
  }
  // /v1/public/checks/:id/stats
  if (segments.length === 5 && segments[2] === 'checks' && segments[4] === 'stats') {
    return 'checks_stats';
  }
  // /v1/public/checks/:id
  if (segments.length === 4 && segments[2] === 'checks') {
    return 'checks_detail';
  }
  // /v1/public/checks
  if (segments.length === 3 && segments[2] === 'checks') {
    return 'checks_list';
  }
  return 'default';
}

// Helper function to safely parse BigQuery timestamp
function parseBigQueryTimestamp(
  timestamp: unknown,
  entryId: string,
  fallback: number = Date.now()
): number {
  try {
    if (!timestamp) {
      logger.warn(`Missing timestamp for entry ${entryId}, using fallback`);
      return fallback;
    }

    if (typeof timestamp === 'object' && timestamp !== null && 'value' in timestamp) {
      // Expected format: { value: string }
      const value = (timestamp as { value: unknown }).value;
      if (typeof value === 'string' && value) {
        const parsed = new Date(value).getTime();
        if (!isNaN(parsed)) {
          return parsed;
        }
        logger.warn(`Invalid timestamp value for entry ${entryId}: ${value}`);
      }
    } else if (timestamp instanceof Date) {
      // Direct Date object
      return timestamp.getTime();
    } else if (typeof timestamp === 'number') {
      // Already a timestamp number
      if (!isNaN(timestamp) && timestamp > 0) {
        return timestamp;
      }
      logger.warn(`Invalid timestamp number for entry ${entryId}: ${timestamp}`);
    } else if (typeof timestamp === 'string') {
      // String timestamp
      const parsed = new Date(timestamp).getTime();
      if (!isNaN(parsed)) {
        return parsed;
      }
      logger.warn(`Invalid timestamp string for entry ${entryId}: ${timestamp}`);
    } else {
      logger.warn(`Unexpected timestamp format for entry ${entryId}:`, typeof timestamp);
    }
  } catch (e) {
    logger.error(`Error parsing timestamp for entry ${entryId}:`, e);
  }
  return fallback;
}

// Helper functions
async function hashApiKey(key: string): Promise<string> {
  const { createHash } = await import('crypto');
  const pepper = process.env.API_KEY_PEPPER || '';
  return createHash('sha256').update(pepper + key).digest('hex');
}

function parseDateParam(dateStr: string): number {
  // Try parsing as ISO 8601 string first
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.getTime();
  }
  
  // Try parsing as Unix timestamp (milliseconds)
  const timestamp = Number(dateStr);
  if (!isNaN(timestamp) && timestamp > 0) {
    return timestamp;
  }
  
  // Try parsing as Unix timestamp (seconds) and convert to milliseconds
  const secondsTimestamp = Number(dateStr);
  if (!isNaN(secondsTimestamp) && secondsTimestamp > 0 && secondsTimestamp < 1e12) {
    return secondsTimestamp * 1000;
  }
  
  throw new Error(`Invalid date format: ${dateStr}. Use ISO 8601 (2023-12-21T22:30:56Z) or Unix timestamp`);
}

function sanitizeCheck(doc: { id: string; [key: string]: unknown }) {
  return {
    id: doc.id,
    name: doc.name || doc.url,
    url: doc.url,
    status: doc.status,
    lastChecked: doc.lastChecked,
    responseTime: doc.responseTime ?? null,
    lastStatusCode: doc.lastStatusCode ?? null,
    disabled: !!doc.disabled,
    sslCertificate: doc.sslCertificate || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Public REST API (X-Api-Key)
export const publicApi = onRequest(async (req, res) => {
  // CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.set('Access-Control-Expose-Headers', 'RateLimit, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    // Pre-auth IP guard (best-effort)
    const clientIp = getClientIp(req);
    const ipDecision = ipGuardLimiter.consume(`ip:${clientIp}`, RATE_LIMITS.ipPerMinute);
    applyRateLimitHeaders(res, ipDecision);
    if (!ipDecision.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    const apiKey = (req.header('x-api-key') || req.header('X-Api-Key') || '').trim();
    if (!apiKey) {
      res.status(401).json({ error: 'Missing X-Api-Key' });
      return;
    }

    const hash = await hashApiKey(apiKey);

    // Check cache first to avoid Firestore read
    let keyDocId: string;
    let userId: string;
    let keyEnabled: boolean;

    const cachedKey = getCachedApiKey(hash);
    if (cachedKey) {
      keyDocId = cachedKey.keyDocId;
      userId = cachedKey.userId;
      keyEnabled = cachedKey.enabled;
    } else {
      // Cache miss - query Firestore
      const keySnap = await firestore
        .collection(API_KEYS_COLLECTION)
        .where('hash', '==', hash)
        .limit(1)
        .get();

      if (keySnap.empty) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      const keyDoc = keySnap.docs[0];
      const key = keyDoc.data() as ApiKeyDoc;
      keyDocId = keyDoc.id;
      userId = key.userId;
      keyEnabled = key.enabled;

      // Cache the result
      setCachedApiKey(hash, keyDocId, userId, keyEnabled);
    }

    if (!keyEnabled) {
      res.status(401).json({ error: 'API key disabled' });
      return;
    }

    // Daily quota checks (protects against excessive usage)
    const dailyKeyQuota = dailyQuotaLimiter.consume(`daily:key:${keyDocId}`, RATE_LIMITS.perKeyDaily);
    if (!dailyKeyQuota.allowed) {
      applyRateLimitHeaders(res, dailyKeyQuota);
      res.status(429).json({
        error: 'Daily API key quota exceeded. Limit: 500 requests/day. Resets at midnight UTC.',
        quotaLimit: RATE_LIMITS.perKeyDaily,
        quotaReset: dailyKeyQuota.resetAtMs
      });
      logger.warn(`API key ${keyDocId} exceeded daily quota (${RATE_LIMITS.perKeyDaily} req/day)`);
      return;
    }

    const dailyUserQuota = dailyQuotaLimiter.consume(`daily:user:${userId}`, RATE_LIMITS.perUserDaily);
    if (!dailyUserQuota.allowed) {
      applyRateLimitHeaders(res, dailyUserQuota);
      res.status(429).json({
        error: 'Daily user quota exceeded. Limit: 2000 requests/day across all API keys. Resets at midnight UTC.',
        quotaLimit: RATE_LIMITS.perUserDaily,
        quotaReset: dailyUserQuota.resetAtMs
      });
      logger.warn(`User ${userId} exceeded daily quota (${RATE_LIMITS.perUserDaily} req/day)`);
      return;
    }

    const path = (req.path || req.url || '').replace(/\/+$/, '');
    const segments = path.split('?')[0].split('/').filter(Boolean); // e.g., ['v1','public','checks',':id',...]

    // Post-auth rate limits: global per-key + per-endpoint
    const globalKeyDecision = apiKeyLimiter.consume(`key:${keyDocId}:total`, RATE_LIMITS.perKeyTotalPerMinute);
    if (!globalKeyDecision.allowed) {
      applyRateLimitHeaders(res, globalKeyDecision);
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    const routeName = getRouteName(segments);
    const endpointDecision = apiKeyLimiter.consume(`key:${keyDocId}:route:${routeName}`, RATE_LIMITS.perEndpointPerMinute);
    applyRateLimitHeaders(res, endpointDecision);
    if (!endpointDecision.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    // Track usage (best-effort)
    const usageNow = Date.now();
    if (shouldWriteApiKeyUsage(keyDocId, usageNow)) {
      firestore.collection(API_KEYS_COLLECTION).doc(keyDocId).update({ lastUsedAt: usageNow, lastUsedPath: path }).catch(() => {});
    }

    // Routing
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // /v1/public/checks
    if (segments.length === 3 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      const limit = Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 100);
      const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
      const statusFilter = String(req.query.status || 'all');
      const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const cursor = parseCursor(cursorParam);
      const includeTotal = String(req.query.includeTotal || 'true') !== 'false';

      let countQuery = firestore.collection('checks')
        .where('userId', '==', userId);
      let baseQuery = firestore.collection('checks')
        .where('userId', '==', userId)
        .orderBy('orderIndex', 'asc')
        .orderBy(FieldPath.documentId(), 'asc');

      if (statusFilter !== 'all') {
        countQuery = countQuery.where('status', '==', statusFilter);
        baseQuery = baseQuery.where('status', '==', statusFilter);
      }

      let total: number | null = null;
      if (includeTotal) {
        const totalCacheKey = `${userId}::${statusFilter}`;
        const cachedTotal = getCachedChecksTotal(totalCacheKey);
        if (cachedTotal !== null) {
          total = cachedTotal;
        } else {
          const totalSnap = await countQuery.count().get();
          total = totalSnap.data().count;
          setCachedChecksTotal(totalCacheKey, total);
        }
      }

      let dataQuery = baseQuery;
      if (cursor) {
        dataQuery = dataQuery.startAfter(cursor.orderIndex, cursor.id);
      } else if (page > 1) {
        dataQuery = dataQuery.offset((page - 1) * limit);
      }

      const snap = await dataQuery.limit(limit).get();
      const data = snap.docs.map(d => sanitizeCheck({ id: d.id, ...d.data() }));
      const lastDoc = snap.docs[snap.docs.length - 1];
      const nextCursor = lastDoc ? buildCursor(lastDoc) : null;

      const totalPages = total !== null ? Math.ceil(total / limit) : null;
      const hasNext = cursor
        ? snap.docs.length === limit
        : total !== null
          ? page < (totalPages || 0)
          : snap.docs.length === limit;

      res.json({
        data,
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNext,
          hasPrev: cursor ? true : page > 1,
          nextCursor,
        }
      });
      return;
    }

    // /v1/public/checks/:id
    if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      const checkId = segments[3];
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.json({ data: sanitizeCheck({ ...data, id: doc.id }) });
      return;
    }

    // /v1/public/checks/:id/history
    if (segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'history') {
      const checkId = segments[3];
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const limit = Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 200);
      const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
      const startDate = req.query.from ? parseDateParam(String(req.query.from)) : undefined;
      const endDate = req.query.to ? parseDateParam(String(req.query.to)) : undefined;
      const statusFilter = String(req.query.status || 'all');
      const searchTerm = String(req.query.q || '');

      const { getCheckHistory } = await import('./bigquery.js');

      // Fetch limit + 1 to detect if there's a next page (avoids expensive count query)
      const history = await getCheckHistory(
        checkId,
        userId,
        limit + 1,
        (page - 1) * limit,
        startDate,
        endDate,
        statusFilter,
        searchTerm
      );

      // Safely handle history data
      const historyArray = Array.isArray(history) ? history : [];
      if (!Array.isArray(history)) {
        logger.warn(`BigQuery returned non-array history for check ${checkId}, type: ${typeof history}`);
      }

      // Determine hasNext and trim to limit
      const hasNext = historyArray.length > limit;
      const trimmedHistory = hasNext ? historyArray.slice(0, limit) : historyArray;

      res.json({
        data: trimmedHistory.map((entry: BigQueryCheckHistoryRow) => {
          const timestampValue = parseBigQueryTimestamp(entry.timestamp, entry.id || 'unknown');
          return {
            id: entry.id || '',
            websiteId: entry.website_id || checkId,
            userId: entry.user_id || userId,
            timestamp: timestampValue,
            status: entry.status || 'unknown',
            responseTime: entry.response_time ?? undefined,
            statusCode: entry.status_code ?? undefined,
            error: entry.error ?? undefined,
            createdAt: timestampValue
          };
        }),
        meta: {
          page,
          limit,
          // Total is expensive to compute - return null to indicate unknown
          // Clients should use hasNext for pagination
          total: null,
          totalPages: null,
          hasNext,
          hasPrev: page > 1
        }
      });
      return;
    }

    // /v1/public/checks/:id/stats
    if (segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'stats') {
      const checkId = segments[3];
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const startDate = req.query.from ? parseDateParam(String(req.query.from)) : undefined;
      const endDate = req.query.to ? parseDateParam(String(req.query.to)) : undefined;

      const { getCheckStats } = await import('./bigquery.js');
      const stats = await getCheckStats(checkId, userId, startDate, endDate);

      res.json({ data: stats });
      return;
    }

    res.status(404).json({ error: 'Not found' });
  } catch (e: unknown) {
    logger.error('publicApi error', e);
    res.status(500).json({ error: 'Internal error' });
  }
});
