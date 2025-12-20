import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";
import { BigQueryCheckHistoryRow } from "./bigquery";

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
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new Error("Website data not found");
    }
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
    const { getCheckHistoryCount } = await import('./bigquery.js');
    const total = await getCheckHistoryCount(
      websiteId, 
      uid, 
      startDate,
      endDate,
      statusFilter,
      searchTerm
    );
    
    const totalPages = Math.ceil(total / limit);
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
    if (!websiteData) {
      logger.error(`Website document exists but data is null for ${websiteId}`);
      throw new Error("Website data not found");
    }
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

