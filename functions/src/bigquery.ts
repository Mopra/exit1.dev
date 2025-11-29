import { BigQuery } from '@google-cloud/bigquery';
import * as logger from 'firebase-functions/logger';

const bigquery = new BigQuery({
  projectId: 'exit1-dev',
  keyFilename: undefined, // Use default credentials
});

// Table configuration
const DATASET_ID = 'checks';
const TABLE_ID = 'check_history';

const MAX_BUFFER_SIZE = 2000;
const HIGH_WATERMARK = 500;
const FLUSH_INTERVAL_MS = 30 * 1000;
const DEFAULT_FLUSH_DELAY_MS = 2_000;
const MAX_BATCH_ROWS = 400;
const MAX_BATCH_BYTES = 9 * 1024 * 1024; // 9MB to stay under BigQuery 10MB limit
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_DROP = 10;
const FAILURE_TIMEOUT_MS = 10 * 60 * 1000;

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

interface BigQueryInsertRow {
  id: string;
  website_id: string;
  user_id: string;
  timestamp: Date;
  status: string;
  response_time: number | null | undefined;
  status_code: number | null | undefined;
  error: string | null | undefined;
}

interface BufferedBigQueryEntry {
  row: BigQueryInsertRow;
  approxBytes: number;
  snapshot: BigQueryCheckHistory;
}

interface FailureMeta {
  failures: number;
  nextRetryAt: number;
  firstFailureAt: number;
  lastErrorCode?: number | string;
  lastErrorMessage?: string;
}

interface FlushStats {
  successes: number;
  failures: number;
  dropped: number;
  skipped: number;
}

const bigQueryInsertBuffer = new Map<string, BufferedBigQueryEntry>();
const failureTracker = new Map<string, FailureMeta>();
let flushInterval: NodeJS.Timeout | null = null;
let queuedFlushTimer: NodeJS.Timeout | null = null;
let queuedFlushTime = Infinity;
let isFlushing = false;
let currentFlushPromise: Promise<void> | null = null;
let isShuttingDown = false;
let shutdownHandlersRegistered = false;

export const insertCheckHistory = async (data: BigQueryCheckHistory): Promise<void> => {
  await enqueueCheckHistory(data);
};

export const insertCheckHistoryBatch = async (dataItems: BigQueryCheckHistory[]): Promise<void> => {
  if (dataItems.length === 0) return;
  for (const data of dataItems) {
    await enqueueCheckHistory(data);
  }
};

export const flushBigQueryInserts = async (): Promise<void> => {
  if (bigQueryInsertBuffer.size === 0) return;
  if (isFlushing) {
    return currentFlushPromise ?? Promise.resolve();
  }

  isFlushing = true;
  currentFlushPromise = (async () => {
    const snapshot = Array.from(bigQueryInsertBuffer.entries());
    const readyEntries: Array<[string, BufferedBigQueryEntry]> = [];
    let skipped = 0;
    let dropped = 0;

    for (const [id, entry] of snapshot) {
      const state = evaluateEntryState(id, entry);
      if (state === 'ready') {
        readyEntries.push([id, entry]);
      } else if (state === 'skipped') {
        skipped += 1;
      } else {
        dropped += 1;
      }
    }

    if (readyEntries.length === 0) {
      if (skipped || dropped) {
        logger.info(`No BigQuery rows ready for flush (skipped=${skipped}, dropped=${dropped})`);
      }
      return;
    }

    const stats: FlushStats = {
      successes: 0,
      failures: 0,
      dropped,
      skipped,
    };

    const batches = chunkEntries(readyEntries);
    for (const batch of batches) {
      await processBatch(batch, stats);
    }

    logger.info(
      `BigQuery flush complete: ${stats.successes} inserted, ${stats.failures} deferred, ${stats.dropped} dropped, ${stats.skipped} waiting`
    );
  })()
    .catch(error => {
      logger.error('Error during BigQuery flush:', error);
    })
    .finally(() => {
      isFlushing = false;
      currentFlushPromise = null;

      if (bigQueryInsertBuffer.size >= HIGH_WATERMARK) {
        queueFlushAfter(200);
      }
      scheduleNextBackoffFlush();
    });

  return currentFlushPromise;
};

const enqueueCheckHistory = async (data: BigQueryCheckHistory): Promise<void> => {
  ensureFlushInterval();
  await ensureBufferCapacity();

  const row = convertToRow(data);
  const approxBytes = estimateRowBytes(row);

  bigQueryInsertBuffer.set(data.id, {
    row,
    approxBytes,
    snapshot: data,
  });
  failureTracker.delete(data.id);

  if (bigQueryInsertBuffer.size >= HIGH_WATERMARK) {
    queueFlushAfter(200);
  } else {
    queueFlushAfter(DEFAULT_FLUSH_DELAY_MS);
  }
};

const ensureBufferCapacity = async () => {
  if (bigQueryInsertBuffer.size < MAX_BUFFER_SIZE) return;

  logger.warn(`BigQuery buffer reached ${bigQueryInsertBuffer.size}, forcing flush`);
  await flushBigQueryInserts();

  if (bigQueryInsertBuffer.size <= MAX_BUFFER_SIZE) return;

  const overflow = bigQueryInsertBuffer.size - MAX_BUFFER_SIZE;
  const iterator = bigQueryInsertBuffer.entries();

  for (let i = 0; i < overflow; i++) {
    const next = iterator.next();
    if (next.done) break;
    const [id, entry] = next.value;
    dropBufferedEntry(id, entry, 'Dropping oldest BigQuery row to protect memory');
  }
};

const convertToRow = (data: BigQueryCheckHistory): BigQueryInsertRow => ({
  id: data.id,
  website_id: data.website_id,
  user_id: data.user_id,
  timestamp: new Date(data.timestamp),
  status: data.status,
  response_time: data.response_time ?? null,
  status_code: data.status_code ?? null,
  error: data.error ?? null,
});

const estimateRowBytes = (row: BigQueryInsertRow): number => {
  try {
    return Buffer.byteLength(JSON.stringify(row), 'utf8');
  } catch {
    return 512;
  }
};

const chunkEntries = (
  entries: Array<[string, BufferedBigQueryEntry]>
): Array<Array<[string, BufferedBigQueryEntry]>> => {
  const chunks: Array<Array<[string, BufferedBigQueryEntry]>> = [];
  let current: Array<[string, BufferedBigQueryEntry]> = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const [, value] = entry;
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_ROWS || currentBytes + value.approxBytes > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(entry);
    currentBytes += value.approxBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
};

const processBatch = async (
  batchEntries: Array<[string, BufferedBigQueryEntry]>,
  stats: FlushStats
): Promise<void> => {
  if (batchEntries.length === 0) return;

  const rows = batchEntries.map(([, entry]) => entry.row);
  const table = bigquery.dataset(DATASET_ID).table(TABLE_ID);

  try {
    await table.insert(rows);
    for (const [id, entry] of batchEntries) {
      markEntrySuccess(id, entry);
      stats.successes += 1;
    }
  } catch (error) {
    await handleBatchFailure(batchEntries, error, stats);
  }
};

const handleBatchFailure = async (
  batchEntries: Array<[string, BufferedBigQueryEntry]>,
  error: unknown,
  stats: FlushStats
): Promise<void> => {
  const failedIndices = extractFailedIndices(error, batchEntries);

  if (failedIndices.size === 0) {
    logger.warn(
      `BigQuery batch failed for ${batchEntries.length} entries, scheduling retry`,
      extractErrorMetadata(error)
    );
    for (const [id] of batchEntries) {
      recordFailure(id, error);
      stats.failures += 1;
    }
    return;
  }

  logger.warn(
    `BigQuery batch partially failed (${failedIndices.size}/${batchEntries.length}), scheduling retry`,
    extractErrorMetadata(error)
  );

  batchEntries.forEach(([id, entry], index) => {
    if (failedIndices.has(index)) {
      recordFailure(id, error);
      stats.failures += 1;
    } else {
      markEntrySuccess(id, entry);
      stats.successes += 1;
    }
  });
};

const extractFailedIndices = (
  error: unknown,
  batchEntries: Array<[string, BufferedBigQueryEntry]>
): Set<number> => {
  const failed = new Set<number>();
  const err = error as { errors?: Array<{ index?: number; row?: { id?: string } }>; code?: number | string };
  const entries = Array.isArray(err?.errors) ? err.errors : [];

  entries.forEach(item => {
    if (typeof item.index === 'number') {
      failed.add(item.index);
    } else if (item.row?.id) {
      const idx = batchEntries.findIndex(([, entry]) => entry.row.id === item.row?.id);
      if (idx >= 0) {
        failed.add(idx);
      }
    }
  });

  return failed;
};

const extractErrorMetadata = (error: unknown) => {
  if (!error || typeof error !== 'object') return { error };
  const err = error as { code?: number | string; message?: string };
  return {
    code: err.code,
    message: err.message,
  };
};

const markEntrySuccess = (id: string, snapshot: BufferedBigQueryEntry) => {
  const current = bigQueryInsertBuffer.get(id);
  if (current === snapshot) {
    bigQueryInsertBuffer.delete(id);
  }
  failureTracker.delete(id);
};

const dropBufferedEntry = (id: string, snapshot: BufferedBigQueryEntry, reason: string) => {
  const current = bigQueryInsertBuffer.get(id);
  if (current === snapshot) {
    bigQueryInsertBuffer.delete(id);
  }
  failureTracker.delete(id);
  logger.warn(`${reason} (row=${id})`);
};

const recordFailure = (id: string, error: unknown) => {
  const now = Date.now();
  const previous = failureTracker.get(id);
  const failures = (previous?.failures ?? 0) + 1;
  const meta: FailureMeta = {
    failures,
    nextRetryAt: now + calculateBackoffDelay(failures),
    firstFailureAt: previous?.firstFailureAt ?? now,
    lastErrorCode: (error as { code?: number | string })?.code,
    lastErrorMessage: (error as Error)?.message,
  };

  failureTracker.set(id, meta);
  scheduleNextBackoffFlush();

  if (failures === 1 || failures === 3 || failures === 5 || failures >= MAX_FAILURES_BEFORE_DROP) {
    logger.warn(
      `BigQuery insert for ${id} failed ${failures} time(s); next retry in ${meta.nextRetryAt - now}ms`,
      { code: meta.lastErrorCode }
    );
  }
};

const evaluateEntryState = (id: string, snapshot: BufferedBigQueryEntry): 'ready' | 'skipped' | 'dropped' => {
  const meta = failureTracker.get(id);
  if (!meta) return 'ready';

  const now = Date.now();
  const exceededFailures = meta.failures >= MAX_FAILURES_BEFORE_DROP;
  const exceededTimeout = now - meta.firstFailureAt >= FAILURE_TIMEOUT_MS;

  if (exceededFailures || exceededTimeout) {
    dropBufferedEntry(
      id,
      snapshot,
      `Dropping BigQuery row after ${meta.failures} failures${
        meta.lastErrorMessage ? ` (${meta.lastErrorMessage})` : ''
      }`
    );
    return 'dropped';
  }

  if (isShuttingDown) {
    return 'ready';
  }

  if (now < meta.nextRetryAt) {
    return 'skipped';
  }

  return 'ready';
};

const calculateBackoffDelay = (failures: number): number => {
  if (failures <= 0) return BACKOFF_INITIAL_MS;
  const delay = BACKOFF_INITIAL_MS * Math.pow(2, failures - 1);
  return Math.min(delay, BACKOFF_MAX_MS);
};

const scheduleNextBackoffFlush = () => {
  if (isShuttingDown) return;
  const now = Date.now();
  let earliest: number | null = null;

  for (const meta of failureTracker.values()) {
    if (meta.nextRetryAt <= now) {
      queueFlushAfter(0);
      return;
    }
    if (earliest === null || meta.nextRetryAt < earliest) {
      earliest = meta.nextRetryAt;
    }
  }

  if (earliest !== null) {
    queueFlushAt(earliest);
  }
};

const queueFlushAfter = (delayMs: number) => {
  queueFlushAt(Date.now() + Math.max(delayMs, 0));
};

const queueFlushAt = (targetTime: number) => {
  if (isShuttingDown) {
    return;
  }

  const now = Date.now();
  const delay = Math.max(targetTime - now, 0);

  if (queuedFlushTimer) {
    if (targetTime >= queuedFlushTime - 10) {
      return;
    }
    clearTimeout(queuedFlushTimer);
  }

  queuedFlushTime = targetTime;
  queuedFlushTimer = setTimeout(() => {
    queuedFlushTimer = null;
    queuedFlushTime = Infinity;
    flushBigQueryInserts().catch(err => logger.error('Error in queued BigQuery flush', err));
  }, delay);
};

const ensureFlushInterval = () => {
  if (isShuttingDown) return;
  if (!flushInterval) {
    flushInterval = setInterval(() => {
      flushBigQueryInserts().catch(error => logger.error('Error flushing BigQuery buffer', error));
    }, FLUSH_INTERVAL_MS);
    registerShutdownHandlers();
  }
};

const registerShutdownHandlers = () => {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const handle = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, flushing BigQuery buffer before shutdown...`);

    if (flushInterval) {
      clearInterval(flushInterval);
      flushInterval = null;
    }
    if (queuedFlushTimer) {
      clearTimeout(queuedFlushTimer);
      queuedFlushTimer = null;
    }

    while (bigQueryInsertBuffer.size > 0) {
      logger.info(`Shutdown flush: ${bigQueryInsertBuffer.size} BigQuery rows remaining...`);
      await flushBigQueryInserts();
    }
  };

  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
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

export const getCheckHistoryCount = async (
  websiteId: string,
  userId: string,
  startDate?: number,
  endDate?: number,
  statusFilter?: string,
  searchTerm?: string
): Promise<number> => {
  try {
    let query = `
      SELECT COUNT(*) as count
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
    
    const options = {
      query,
      params,
    };

    const [rows] = await bigquery.query(options);
    return Number(rows[0]?.count || 0);
  } catch (error) {
    console.error('Error querying check history count from BigQuery:', error);
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

export const getDatabaseUsage = async (): Promise<{
  totalRows: number;
  totalBytes: number;
  activeBytes: number;
  longTermBytes: number;
}> => {
  try {
    const query = `
      SELECT 
        sum(row_count) as total_rows,
        sum(size_bytes) as total_bytes,
        sum(active_logical_bytes) as active_bytes,
        sum(long_term_logical_bytes) as long_term_bytes
      FROM \`exit1-dev.checks.__TABLES__\`
    `;
    
    const [rows] = await bigquery.query({ query });
    const row = rows[0];
    
    return {
      totalRows: Number(row?.total_rows) || 0,
      totalBytes: Number(row?.total_bytes) || 0,
      activeBytes: Number(row?.active_bytes) || 0,
      longTermBytes: Number(row?.long_term_bytes) || 0
    };
  } catch (error) {
    console.error('Error querying database usage:', error);
    // Return zeros instead of throwing to allow partial stats
    return { totalRows: 0, totalBytes: 0, activeBytes: 0, longTermBytes: 0 };
  }
};

export const getQueryUsage = async (): Promise<{
  totalBytesBilled: number;
  totalBytesProcessed: number;
}> => {
  // Try common regions
  // Add more specific regions if needed
  const regions = ['region-us', 'region-eu', 'region-us-central1', 'region-us-east1', 'region-us-west1'];
  
  let bestResult = { totalBytesBilled: 0, totalBytesProcessed: 0 };
  
  for (const region of regions) {
    try {
      const query = `
        SELECT 
          SUM(total_bytes_billed) as total_bytes_billed,
          SUM(total_bytes_processed) as total_bytes_processed
        FROM \`${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
        WHERE creation_time >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), MONTH)
      `;
      
      const [rows] = await bigquery.query({ query });
      const row = rows[0];
      
      if (row) {
        const billed = Number(row.total_bytes_billed) || 0;
        const processed = Number(row.total_bytes_processed) || 0;
        
        console.log(`Region ${region}: ${billed} billed, ${processed} processed`);
        
        // If we found usage, assume this is the active region and return
        if (billed > 0 || processed > 0) {
          return {
            totalBytesBilled: billed,
            totalBytesProcessed: processed
          };
        }
        
        // Keep partial result (e.g. 0) if we don't find anything better
        if (bestResult.totalBytesBilled === 0 && bestResult.totalBytesProcessed === 0) {
           bestResult = { totalBytesBilled: billed, totalBytesProcessed: processed };
        }
      }
    } catch (error) {
      // Log warning but continue to next region
      const msg = error instanceof Error ? error.message : String(error);
      // Don't spam logs with "Not found" errors which are expected for unused regions
      if (!msg.includes('Not found') && !msg.includes('404')) {
        console.warn(`Error querying usage in ${region}:`, msg);
      }
    }
  }
  
  return bestResult;
};