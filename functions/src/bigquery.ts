import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({
  projectId: 'exit1-dev',
  keyFilename: undefined, // Use default credentials
});

// Table configuration
const DATASET_ID = 'checks';
const TABLE_ID = 'check_history';

export interface BigQueryCheckHistory {
  id: string;
  website_id: string;
  user_id: string;
  timestamp: number;
  status: string;
  response_time?: number;
  status_code?: number;
  error?: string;
}

export const insertCheckHistory = async (data: BigQueryCheckHistory) => {
  try {
    const row = {
      id: data.id,
      website_id: data.website_id,
      user_id: data.user_id,
      timestamp: new Date(data.timestamp),
      status: data.status,
      response_time: data.response_time || null,
      status_code: data.status_code || null,
      error: data.error || null,
    };

    // Use the insert method with the full table path
    await bigquery.dataset(DATASET_ID).table(TABLE_ID).insert([row]);
    console.log(`Inserted check history for website ${data.website_id}`);
  } catch (error) {
    console.error('Error inserting check history to BigQuery:', error);
    // Don't throw - BigQuery failure shouldn't break the main check
  }
};

export interface BigQueryCheckHistoryRow {
  id: string;
  website_id: string;
  user_id: string;
  timestamp: { value: string };
  status: string;
  response_time?: number;
  status_code?: number;
  error?: string;
}

export const getCheckHistory = async (
  websiteId: string,
  userId: string,
  limit: number = 100,
  offset: number = 0,
  startDate?: number,
  endDate?: number,
  statusFilter?: string,
  searchTerm?: string
): Promise<BigQueryCheckHistoryRow[]> => {
  try {
    let query = `
      SELECT 
        id,
        website_id,
        user_id,
        timestamp,
        status,
        response_time,
        status_code,
        error
      FROM \`exit1-dev.checks.check_history\`
      WHERE website_id = @websiteId 
        AND user_id = @userId
    `;
    
    const params: Record<string, unknown> = {
      websiteId,
      userId,
      limit,
      offset
    };
    
    // Add date range filtering
    if (startDate && startDate > 0) {
      query += ` AND timestamp >= @startDate`;
      params.startDate = new Date(startDate);
    }
    
    if (endDate && endDate > 0) {
      query += ` AND timestamp <= @endDate`;
      params.endDate = new Date(endDate);
    }
    
    // Add status filtering
    if (statusFilter && statusFilter !== 'all') {
      query += ` AND status = @statusFilter`;
      params.statusFilter = statusFilter;
    }
    
    // Add search term filtering (search in error messages)
    if (searchTerm && searchTerm.trim()) {
      query += ` AND (error LIKE @searchTerm OR status LIKE @searchTerm)`;
      params.searchTerm = `%${searchTerm.trim()}%`;
    }
    
    query += `
      ORDER BY timestamp DESC
      LIMIT @limit
      OFFSET @offset
    `;

    const options = {
      query,
      params,
    };

    const [rows] = await bigquery.query(options);
    console.log('BigQuery query result:', rows);
    console.log('BigQuery rows length:', rows.length);
    return rows;
  } catch (error) {
    console.error('Error querying check history from BigQuery:', error);
    throw error;
  }
};

// New function to get aggregated statistics
export const getCheckStats = async (
  websiteId: string,
  userId: string,
  startDate?: number,
  endDate?: number
): Promise<{
  totalChecks: number;
  onlineChecks: number;
  offlineChecks: number;
  uptimePercentage: number;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
}> => {
  try {
    let query = `
      SELECT 
        COUNT(*) as totalChecks,
        COUNTIF(status IN ('online', 'UP', 'REDIRECT')) as onlineChecks,
        COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) as offlineChecks,
        AVG(response_time) as avgResponseTime,
        MIN(response_time) as minResponseTime,
        MAX(response_time) as maxResponseTime
      FROM \`exit1-dev.checks.check_history\`
      WHERE website_id = @websiteId 
        AND user_id = @userId
    `;
    
    const params: Record<string, unknown> = {
      websiteId,
      userId
    };
    
    // Add date range filtering
    if (startDate && startDate > 0) {
      query += ` AND timestamp >= @startDate`;
      params.startDate = new Date(startDate);
    }
    
    if (endDate && endDate > 0) {
      query += ` AND timestamp <= @endDate`;
      params.endDate = new Date(endDate);
    }

    const options = {
      query,
      params,
    };

    const [rows] = await bigquery.query(options);
    const row = rows[0];
    
    const totalChecks = Number(row.totalChecks) || 0;
    const onlineChecks = Number(row.onlineChecks) || 0;
    const offlineChecks = Number(row.offlineChecks) || 0;
    const uptimePercentage = totalChecks > 0 ? (onlineChecks / totalChecks) * 100 : 0;
    
    return {
      totalChecks,
      onlineChecks,
      offlineChecks,
      uptimePercentage,
      avgResponseTime: Number(row.avgResponseTime) || 0,
      minResponseTime: Number(row.minResponseTime) || 0,
      maxResponseTime: Number(row.maxResponseTime) || 0
    };
  } catch (error) {
    console.error('Error querying check stats from BigQuery:', error);
    throw error;
  }
};

// Function to get check history for statistics (with time range)
export const getCheckHistoryForStats = async (
  websiteId: string,
  userId: string,
  startDate: number,
  endDate: number
): Promise<BigQueryCheckHistoryRow[]> => {
  try {
    const query = `
      SELECT 
        id,
        website_id,
        user_id,
        timestamp,
        status,
        response_time,
        status_code,
        error
      FROM \`exit1-dev.checks.check_history\`
      WHERE website_id = @websiteId 
        AND user_id = @userId
        AND timestamp >= @startDate
        AND timestamp <= @endDate
      ORDER BY timestamp DESC
    `;
    
    const params: Record<string, unknown> = {
      websiteId,
      userId,
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    };

    const options = {
      query,
      params,
    };

    const [rows] = await bigquery.query(options);
    return rows;
  } catch (error) {
    console.error('Error querying check history for stats from BigQuery:', error);
    throw error;
  }
};

// Function to get incidents for a specific hour
export const getIncidentsForHour = async (
  websiteId: string,
  userId: string,
  hourStart: number,
  hourEnd: number
): Promise<BigQueryCheckHistoryRow[]> => {
  try {
    const query = `
      SELECT 
        id,
        website_id,
        user_id,
        timestamp,
        status,
        response_time,
        status_code,
        error
      FROM \`exit1-dev.checks.check_history\`
      WHERE website_id = @websiteId 
        AND user_id = @userId
        AND timestamp >= @hourStart
        AND timestamp < @hourEnd
      ORDER BY timestamp DESC
    `;
    
    const params: Record<string, unknown> = {
      websiteId,
      userId,
      hourStart: new Date(hourStart),
      hourEnd: new Date(hourEnd)
    };

    const options = {
      query,
      params,
    };

    const [rows] = await bigquery.query(options);
    return rows;
  } catch (error) {
    console.error('Error querying incidents from BigQuery:', error);
    throw error;
  }
}; 