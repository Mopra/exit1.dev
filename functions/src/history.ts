import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";
import { BigQueryCheckHistoryRow } from "./bigquery";

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

