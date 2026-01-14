import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";
import { BigQueryCheckHistoryRow, purgeOldCheckHistory } from "./bigquery";
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV } from "./env";
import { FixedWindowRateLimiter } from "./rate-limit";

const bigQueryHistoryLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 50_000 });
const BIGQUERY_HISTORY_LIMITS = {
  perUserPerMinute: 60,
  perWebsitePerMinute: 30,
};

function enforceBigQueryHistoryRateLimit(userId: string, websiteId: string): void {
  const now = Date.now();
  const userDecision = bigQueryHistoryLimiter.consume(`bq-history:user:${userId}`, BIGQUERY_HISTORY_LIMITS.perUserPerMinute, now);
  if (!userDecision.allowed) {
    throw new HttpsError(
      "resource-exhausted",
      `Rate limit exceeded. Try again in ${userDecision.retryAfterSeconds ?? userDecision.resetAfterSeconds}s.`,
      { retryAfterSeconds: userDecision.retryAfterSeconds ?? userDecision.resetAfterSeconds }
    );
  }

  const websiteDecision = bigQueryHistoryLimiter.consume(
    `bq-history:user:${userId}:website:${websiteId}`,
    BIGQUERY_HISTORY_LIMITS.perWebsitePerMinute,
    now
  );
  if (!websiteDecision.allowed) {
    throw new HttpsError(
      "resource-exhausted",
      `Rate limit exceeded. Try again in ${websiteDecision.retryAfterSeconds ?? websiteDecision.resetAfterSeconds}s.`,
      { retryAfterSeconds: websiteDecision.retryAfterSeconds ?? websiteDecision.resetAfterSeconds }
    );
  }
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

function parseBigQueryInt(value: unknown, fallback: number = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof value === 'object' && value !== null && 'value' in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === 'number') return inner;
    if (typeof inner === 'string') {
      const parsed = Number(inner);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  }
  return fallback;
}

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
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new Error("Website data not found");
    }
    if (websiteData.userId !== uid) {
      throw new Error("Access denied");
    }

    enforceBigQueryHistoryRateLimit(uid, websiteId);

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

    // Safely handle history data
    const historyArray = Array.isArray(history) ? history : [];
    if (!Array.isArray(history)) {
      logger.warn(`BigQuery returned non-array history for website ${websiteId}, type: ${typeof history}`);
    }

    return {
      success: true,
      history: historyArray.map((entry: BigQueryCheckHistoryRow) => {
        const timestampValue = parseBigQueryTimestamp(entry.timestamp, entry.id || 'unknown');
        return {
          id: entry.id || '',
          websiteId,
          userId: uid,
          timestamp: timestampValue,
          status: entry.status || 'unknown',
          responseTime: entry.response_time ?? undefined,
          statusCode: entry.status_code ?? undefined,
          error: entry.error ?? undefined,

          targetHostname: entry.target_hostname ?? undefined,
          targetIp: entry.target_ip ?? undefined,
          targetIpsJson: entry.target_ips_json ?? undefined,
          targetIpFamily: entry.target_ip_family ?? undefined,
          targetCountry: entry.target_country ?? undefined,
          targetRegion: entry.target_region ?? undefined,
          targetCity: entry.target_city ?? undefined,
          targetLatitude: entry.target_latitude ?? undefined,
          targetLongitude: entry.target_longitude ?? undefined,
          targetAsn: entry.target_asn ?? undefined,
          targetOrg: entry.target_org ?? undefined,
          targetIsp: entry.target_isp ?? undefined,
          cdnProvider: entry.cdn_provider ?? undefined,
          edgePop: entry.edge_pop ?? undefined,
          edgeRayId: entry.edge_ray_id ?? undefined,
          edgeHeadersJson: entry.edge_headers_json ?? undefined,
        };
      }),
      count: historyArray.length
    };
  } catch (error) {
    logger.error(`Failed to get check history for website ${websiteId}:`, error);
    throw new Error(`Failed to get check history: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

function getReportBucketSizeMs(startDate: number, endDate: number): number {
  const spanMs = Math.max(0, endDate - startDate);
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const week = 7 * day;

  if (spanMs <= 36 * hour) return hour;
  if (spanMs <= 14 * day) return day;
  if (spanMs <= 180 * day) return week;
  return 30 * day;
}

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
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new Error("Website data not found");
    }
    if (websiteData.userId !== uid) {
      throw new Error("Access denied");
    }

    enforceBigQueryHistoryRateLimit(uid, websiteId);

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
    const { getCheckHistoryCount } = await import('./bigquery.js');
    const total = await getCheckHistoryCount(
      websiteId,
      uid,
      undefined, // startDate
      undefined, // endDate
      statusFilter === 'all' ? undefined : statusFilter,
      searchTerm
    );
    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    // Safely handle history data
    const historyArray = Array.isArray(history) ? history : [];
    if (!Array.isArray(history)) {
      logger.warn(`BigQuery returned non-array history for website ${websiteId}, type: ${typeof history}`);
    }

    return {
      success: true,
      data: historyArray.map((entry: BigQueryCheckHistoryRow) => {
        const timestampValue = parseBigQueryTimestamp(entry.timestamp, entry.id || 'unknown');
        return {
          id: entry.id || '',
          websiteId,
          userId: uid,
          timestamp: timestampValue,
          status: entry.status || 'unknown',
          responseTime: entry.response_time ?? undefined,
          statusCode: entry.status_code ?? undefined,
          error: entry.error ?? undefined,

          targetHostname: entry.target_hostname ?? undefined,
          targetIp: entry.target_ip ?? undefined,
          targetIpsJson: entry.target_ips_json ?? undefined,
          targetIpFamily: entry.target_ip_family ?? undefined,
          targetCountry: entry.target_country ?? undefined,
          targetRegion: entry.target_region ?? undefined,
          targetCity: entry.target_city ?? undefined,
          targetLatitude: entry.target_latitude ?? undefined,
          targetLongitude: entry.target_longitude ?? undefined,
          targetAsn: entry.target_asn ?? undefined,
          targetOrg: entry.target_org ?? undefined,
          targetIsp: entry.target_isp ?? undefined,
          cdnProvider: entry.cdn_provider ?? undefined,
          edgePop: entry.edge_pop ?? undefined,
          edgeRayId: entry.edge_ray_id ?? undefined,
          edgeHeadersJson: entry.edge_headers_json ?? undefined,
        };
      }),
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
export const getCheckHistoryBigQuery = onCall({
  cors: true,
  maxInstances: 10,
  timeoutSeconds: 540, // 9 minutes max timeout
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
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
    throw new HttpsError("invalid-argument", "Website ID is required");
  }

  // Cap limit to prevent excessive queries
  const cappedLimit = Math.min(limit, 10000);

  logger.info(`BigQuery request: websiteId=${websiteId}, page=${page}, limit=${cappedLimit}, statusFilter=${statusFilter}, searchTerm=${searchTerm}, startDate=${startDate}, endDate=${endDate}`);

  try {
    // Verify the user owns this website
    const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
    if (!websiteDoc.exists) {
      throw new HttpsError("not-found", "Website not found");
    }

    const websiteData = websiteDoc.data() as Website;
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new HttpsError("not-found", "Website data not found");
    }
    if (websiteData.userId !== uid) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    enforceBigQueryHistoryRateLimit(uid, websiteId);

    logger.info(`Website ownership verified for ${websiteId}`);

    // Import BigQuery function
    const { getCheckHistory } = await import('./bigquery.js');

    // Calculate offset for pagination
    const offset = (page - 1) * cappedLimit;

    logger.info(`Calling BigQuery with offset=${offset}, limit=${cappedLimit}`);

    // Get data from BigQuery with server-side filtering
    const history = await getCheckHistory(
      websiteId,
      uid,
      cappedLimit,
      offset,
      startDate,
      endDate,
      statusFilter === 'all' ? undefined : statusFilter,
      searchTerm
    );

    // Get total count with same filters
    const { getCheckHistoryCount } = await import('./bigquery.js');
    const total = await getCheckHistoryCount(
      websiteId,
      uid,
      startDate,
      endDate,
      statusFilter === 'all' ? undefined : statusFilter,
      searchTerm
    );

    const totalPages = Math.ceil(total / cappedLimit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    // Safely handle history data - ensure it's an array
    const historyArray = Array.isArray(history) ? history : [];
    if (!Array.isArray(history)) {
      logger.warn(`BigQuery returned non-array history for website ${websiteId}, type: ${typeof history}`);
    }

    // Safely map history entries with defensive timestamp parsing
    const mappedHistory = historyArray.map((entry: BigQueryCheckHistoryRow) => {
      const timestampValue = parseBigQueryTimestamp(entry.timestamp, entry.id || 'unknown');
      return {
        id: entry.id || '',
        websiteId: entry.website_id || websiteId,
        userId: entry.user_id || uid,
        timestamp: timestampValue,
        status: entry.status || 'unknown',
        responseTime: entry.response_time ?? undefined,
        statusCode: entry.status_code ?? undefined,
        error: entry.error ?? undefined,
        dnsMs: entry.dns_ms ?? undefined,
        connectMs: entry.connect_ms ?? undefined,
        tlsMs: entry.tls_ms ?? undefined,
        ttfbMs: entry.ttfb_ms ?? undefined,
        createdAt: timestampValue,

        targetHostname: entry.target_hostname ?? undefined,
        targetIp: entry.target_ip ?? undefined,
        targetIpsJson: entry.target_ips_json ?? undefined,
        targetIpFamily: entry.target_ip_family ?? undefined,
        targetCountry: entry.target_country ?? undefined,
        targetRegion: entry.target_region ?? undefined,
        targetCity: entry.target_city ?? undefined,
        targetLatitude: entry.target_latitude ?? undefined,
        targetLongitude: entry.target_longitude ?? undefined,
        targetAsn: entry.target_asn ?? undefined,
        targetOrg: entry.target_org ?? undefined,
        targetIsp: entry.target_isp ?? undefined,
        cdnProvider: entry.cdn_provider ?? undefined,
        edgePop: entry.edge_pop ?? undefined,
        edgeRayId: entry.edge_ray_id ?? undefined,
        edgeHeadersJson: entry.edge_headers_json ?? undefined,
      };
    });

    return {
      success: true,
      data: {
        data: mappedHistory,
        pagination: {
          page,
          limit: cappedLimit,
          total,
          totalPages,
          hasNext,
          hasPrev
        }
      }
    };
  } catch (error) {
    logger.error(`Failed to get BigQuery check history for website ${websiteId}:`, error);

    // Preserve HttpsError to maintain CORS headers
    if (error instanceof HttpsError) {
      throw error;
    }

    // Convert other errors to HttpsError for proper CORS handling
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new HttpsError('internal', `Failed to get check history: ${message}`);
  }
});

// New function to get aggregated statistics
export const getCheckStatsBigQuery = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, startDate, endDate } = request.data;
  if (!websiteId) {
    throw new HttpsError("invalid-argument", "Website ID is required");
  }

  try {
    // Verify the user owns this website
    const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
    if (!websiteDoc.exists) {
      throw new HttpsError("not-found", "Website not found");
    }

    const websiteData = websiteDoc.data() as Website;
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new HttpsError("not-found", "Website data not found");
    }
    if (websiteData.userId !== uid) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // SECURITY: Verify user has Nano plan subscription
    // Timeline/Stats view is a Nano-only feature - prevent unauthorized access
    const { getUserTier } = await import('./init.js');
    const userTier = await getUserTier(uid);
    if (userTier !== 'nano') {
      logger.warn(`User ${uid} attempted to access Stats view without Nano subscription (tier: ${userTier})`);
      throw new HttpsError(
        "permission-denied",
        "Statistics view is only available on the Nano plan. Please upgrade to access this feature."
      );
    }

    // Import BigQuery function
    const { getCheckStats } = await import('./bigquery.js');
    const requestedStart = Number.isFinite(startDate) ? Number(startDate) : 0;
    const requestedEnd = Number.isFinite(endDate) ? Number(endDate) : Date.now();
    const createdAt = typeof websiteData.createdAt === "number" ? websiteData.createdAt : 0;
    const effectiveStart = createdAt > 0 ? Math.max(requestedStart, createdAt) : requestedStart;
    const effectiveEnd = requestedEnd > 0 ? requestedEnd : Date.now();
    const stats = await getCheckStats(websiteId, uid, effectiveStart, effectiveEnd);

    return {
      success: true,
      data: stats
    };
  } catch (error) {
    logger.error(`Failed to get BigQuery check stats for website ${websiteId}:`, error);

    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new HttpsError('internal', `Failed to get check stats: ${message}`);
  }
});

// Helper function to get day start timestamp
function getDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Callable function to get daily summary for timeline view (aggregated by day)
export const getCheckHistoryDailySummary = onCall({
  cors: true,
  maxInstances: 10,
  timeoutSeconds: 540,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, startDate, endDate } = request.data;
  if (!websiteId) {
    throw new HttpsError("invalid-argument", "Website ID is required");
  }
  if (!startDate || !endDate) {
    throw new HttpsError("invalid-argument", "Start date and end date are required");
  }

  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);
  logger.info(`[getCheckHistoryDailySummary] Request received: websiteId=${websiteId}, startDate=${startDateObj.toISOString()}, endDate=${endDateObj.toISOString()}, uid=${uid}`);

  try {
    // Verify the user owns this website
    const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
    if (!websiteDoc.exists) {
      logger.warn(`[getCheckHistoryDailySummary] Website not found: ${websiteId}`);
      throw new HttpsError("not-found", "Website not found");
    }

    const websiteData = websiteDoc.data() as Website;
    if (!websiteData) {
      logger.error(`[getCheckHistoryDailySummary] Website document exists but data is null for ${websiteId}`);
      throw new HttpsError("not-found", "Website data not found");
    }
    if (websiteData.userId !== uid) {
      logger.warn(`[getCheckHistoryDailySummary] Access denied: user ${uid} does not own website ${websiteId}`);
      throw new HttpsError("permission-denied", "Access denied");
    }

    // SECURITY: Verify user has Nano plan subscription
    const { getUserTier } = await import('./init.js');
    const userTier = await getUserTier(uid);
    if (userTier !== 'nano') {
      logger.warn(`[getCheckHistoryDailySummary] User ${uid} attempted to access Timeline view without Nano subscription (tier: ${userTier})`);
      throw new HttpsError("permission-denied", "Timeline view is only available on the Nano plan. Please upgrade to access this feature.");
    }

    logger.info(`[getCheckHistoryDailySummary] Calling BigQuery for website ${websiteId}`);

    // Import BigQuery function
    const { getCheckHistoryDailySummary } = await import('./bigquery.js');

    // Get daily summaries
    const summaries = await getCheckHistoryDailySummary(websiteId, uid, startDate, endDate);

    logger.info(`[getCheckHistoryDailySummary] BigQuery returned ${summaries.length} daily summaries`);

    // Convert to format expected by frontend (one CheckHistory-like object per day)
    const history = summaries.map((summary) => {
      const dayStart = summary.day.getTime();
      const totalChecks = Number.isFinite(summary.totalChecks) ? summary.totalChecks : 0;
      const hasData = totalChecks > 0;
      return {
        id: `${websiteId}_${dayStart}`,
        websiteId,
        userId: uid,
        timestamp: dayStart,
        status: hasData ? (summary.hasIssues ? 'offline' : 'online') : 'unknown',
        detailedStatus: hasData ? (summary.hasIssues ? 'DOWN' : 'UP') : undefined,
        responseTime: hasData && summary.avgResponseTime != null ? Math.round(summary.avgResponseTime) : undefined,
        totalChecks,
        issueCount: summary.issueCount,
      };
    });

    // Fill in missing days (days with no data) as green (no issues)
    const allDays: typeof history = [];
    const dayMs = 24 * 60 * 60 * 1000;
    const startDay = getDayStart(startDate);
    const endDay = getDayStart(endDate);

    logger.info(`Daily summary: Found ${summaries.length} days with data, filling range from ${new Date(startDay).toISOString()} to ${new Date(endDay).toISOString()}`);

    const summaryMap = new Map<number, typeof history[0]>();
    history.forEach(h => {
      const day = getDayStart(h.timestamp);
      summaryMap.set(day, h);
    });

    for (let day = startDay; day <= endDay; day += dayMs) {
      const existing = summaryMap.get(day);
      if (existing) {
        allDays.push(existing);
      } else {
        // Day with no data - assume no issues (green)
        allDays.push({
          id: `${websiteId}_${day}`,
          websiteId,
          userId: uid,
          timestamp: day,
          status: 'unknown',
          detailedStatus: undefined,
          responseTime: undefined,
          totalChecks: 0,
          issueCount: 0,
        });
      }
    }

    return {
      success: true,
      data: {
        data: allDays,
        pagination: {
          page: 1,
          limit: allDays.length,
          total: allDays.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }
      }
    };
  } catch (error) {
    logger.error(`Failed to get daily summary for website ${websiteId}:`, error);

    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new HttpsError('internal', `Failed to get daily summary: ${message}`);
  }
});

// Callable function to get aggregated report metrics without full-history download
export const getCheckReportMetrics = onCall({
  cors: true,
  maxInstances: 10,
  timeoutSeconds: 540,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, startDate, endDate } = request.data;
  if (!websiteId) {
    throw new HttpsError("invalid-argument", "Website ID is required");
  }
  if (!Number.isFinite(startDate) || !Number.isFinite(endDate)) {
    throw new HttpsError("invalid-argument", "Start date and end date are required");
  }
  if (endDate <= startDate) {
    throw new HttpsError("invalid-argument", "End date must be after start date");
  }

  try {
    const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
    if (!websiteDoc.exists) {
      throw new HttpsError("not-found", "Website not found");
    }

    const websiteData = websiteDoc.data() as Website;
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new HttpsError("not-found", "Website data not found");
    }
    if (websiteData.userId !== uid) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    const createdAt = typeof websiteData.createdAt === "number" ? websiteData.createdAt : 0;
    const effectiveStart = createdAt > 0 ? Math.max(startDate, createdAt) : startDate;
    const effectiveEnd = endDate;
    const bucketSizeMs = getReportBucketSizeMs(effectiveStart, effectiveEnd);

    const { getCheckStats, getIncidentIntervals, getResponseTimeBuckets } = await import('./bigquery.js');
    const stats = await getCheckStats(websiteId, uid, effectiveStart, effectiveEnd);
    const intervals = await getIncidentIntervals(websiteId, uid, effectiveStart, effectiveEnd);
    const responseTimeBuckets = await getResponseTimeBuckets(websiteId, uid, effectiveStart, effectiveEnd, bucketSizeMs);

    const incidents = intervals.map((row) => ({
      startedAt: parseBigQueryInt(row.started_at_ms),
      endedAt: parseBigQueryInt(row.ended_at_ms),
    }));

    const responseBuckets = responseTimeBuckets.map((row) => ({
      bucketStart: parseBigQueryInt(row.bucket_start_ms),
      avgResponseTime: Number(row.avg_response_time) || 0,
      sampleCount: parseBigQueryInt(row.sample_count),
    }));

    return {
      success: true,
      data: {
        stats,
        incidents,
        responseTimeBuckets: responseBuckets,
        bucketSizeMs,
      }
    };
  } catch (error) {
    logger.error(`Failed to get report metrics for website ${websiteId}:`, error);

    if (error instanceof HttpsError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new HttpsError('internal', `Failed to get report metrics: ${message}`);
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
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new Error("Website data not found");
    }
    if (websiteData.userId !== uid) {
      throw new Error("Access denied");
    }

    // Import BigQuery function
    const { getCheckHistoryForStats } = await import('./bigquery.js');
    const history = await getCheckHistoryForStats(websiteId, uid, startDate, endDate);

    // Safely handle history data
    const historyArray = Array.isArray(history) ? history : [];
    if (!Array.isArray(history)) {
      logger.warn(`BigQuery returned non-array history for stats for website ${websiteId}, type: ${typeof history}`);
    }

    return {
      success: true,
      data: historyArray.map((entry: BigQueryCheckHistoryRow) => {
        const timestampValue = parseBigQueryTimestamp(entry.timestamp, entry.id || 'unknown');
        return {
          id: entry.id || '',
          websiteId: entry.website_id || websiteId,
          userId: entry.user_id || uid,
          timestamp: timestampValue,
          status: entry.status || 'unknown',
          responseTime: entry.response_time ?? undefined,
          statusCode: entry.status_code ?? undefined,
          error: entry.error ?? undefined,
          createdAt: timestampValue
        };
      })
    };
  } catch (error) {
    logger.error(`Failed to get BigQuery check history for stats for website ${websiteId}:`, error);
    throw new Error(`Failed to get check history for stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

export const purgeBigQueryHistory = onSchedule({
  schedule: "every 24 hours",
  timeZone: "UTC",
}, async () => {
  try {
    await purgeOldCheckHistory();
  } catch (error) {
    logger.error("BigQuery retention purge failed:", error);
  }
});

