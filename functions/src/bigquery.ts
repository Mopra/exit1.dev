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
const DEFAULT_FLUSH_DELAY_MS = 2_000;
const IDLE_STOP_AFTER_MS = 25_000;
const LOG_SAMPLE_RATE = 0.05;
const MAX_BATCH_ROWS = 400;
const MAX_BATCH_BYTES = 9 * 1024 * 1024; // 9MB to stay under BigQuery 10MB limit
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_DROP = 10;
const FAILURE_TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_RETENTION_DAYS = 90;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface BigQueryCheckHistory {
  id: string;
  website_id: string;
  user_id: string;
  timestamp: number;
  status: string;
  response_time?: number;
  status_code?: number;
  error?: string;
  dns_ms?: number;
  connect_ms?: number;
  tls_ms?: number;
  ttfb_ms?: number;
  // Target metadata (best-effort)
  target_hostname?: string;
  target_ip?: string;
  target_ips_json?: string;
  target_ip_family?: number;
  target_country?: string;
  target_region?: string;
  target_city?: string;
  target_latitude?: number;
  target_longitude?: number;
  target_asn?: string;
  target_org?: string;
  target_isp?: string;
  // Edge hints (best-effort)
  cdn_provider?: string;
  edge_pop?: string;
  edge_ray_id?: string;
  edge_headers_json?: string;
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
  dns_ms?: number | null | undefined;
  connect_ms?: number | null | undefined;
  tls_ms?: number | null | undefined;
  ttfb_ms?: number | null | undefined;
  target_hostname?: string | null | undefined;
  target_ip?: string | null | undefined;
  target_ips_json?: string | null | undefined;
  target_ip_family?: number | null | undefined;
  target_country?: string | null | undefined;
  target_region?: string | null | undefined;
  target_city?: string | null | undefined;
  target_latitude?: number | null | undefined;
  target_longitude?: number | null | undefined;
  target_asn?: string | null | undefined;
  target_org?: string | null | undefined;
  target_isp?: string | null | undefined;
  cdn_provider?: string | null | undefined;
  edge_pop?: string | null | undefined;
  edge_ray_id?: string | null | undefined;
  edge_headers_json?: string | null | undefined;
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
const logSampledDebug = (message: string, meta?: Record<string, unknown>) => {
  if (Math.random() < LOG_SAMPLE_RATE) {
    if (meta) {
      logger.debug(message, meta);
    } else {
      logger.debug(message);
    }
  }
};
let queuedFlushTimer: NodeJS.Timeout | null = null;
let queuedFlushTime = Infinity;
let isFlushing = false;
let currentFlushPromise: Promise<void> | null = null;
let isShuttingDown = false;
let shutdownHandlersRegistered = false;
let idleStopTimer: NodeJS.Timeout | null = null;

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
        logSampledDebug(`No BigQuery rows ready for flush (skipped=${skipped}, dropped=${dropped})`);
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

    const totalTouched = stats.successes + stats.failures + stats.dropped + stats.skipped;
    if (totalTouched >= 10) {
      logger.info(
        `BigQuery flush: ${stats.successes} inserted, ${stats.failures} deferred, ${stats.dropped} dropped, ${stats.skipped} waiting`
      );
    } else {
      logSampledDebug(
        `BigQuery flush small batch: ${stats.successes} inserted, ${stats.failures} deferred, ${stats.dropped} dropped, ${stats.skipped} waiting`
      );
    }
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
      if (!isShuttingDown) {
        touchIdleTimer();
      }
    });

  return currentFlushPromise;
};

const enqueueCheckHistory = async (data: BigQueryCheckHistory): Promise<void> => {
  ensureOnDemandScheduler();
  await ensureBufferCapacity();

  const row = convertToRow(data);
  const approxBytes = estimateRowBytes(row);

  bigQueryInsertBuffer.set(data.id, {
    row,
    approxBytes,
    snapshot: data,
  });
  failureTracker.delete(data.id);
  touchIdleTimer();

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
  dns_ms: data.dns_ms ?? null,
  connect_ms: data.connect_ms ?? null,
  tls_ms: data.tls_ms ?? null,
  ttfb_ms: data.ttfb_ms ?? null,
  target_hostname: data.target_hostname ?? null,
  target_ip: data.target_ip ?? null,
  target_ips_json: data.target_ips_json ?? null,
  target_ip_family: data.target_ip_family ?? null,
  target_country: data.target_country ?? null,
  target_region: data.target_region ?? null,
  target_city: data.target_city ?? null,
  target_latitude: data.target_latitude ?? null,
  target_longitude: data.target_longitude ?? null,
  target_asn: data.target_asn ?? null,
  target_org: data.target_org ?? null,
  target_isp: data.target_isp ?? null,
  cdn_provider: data.cdn_provider ?? null,
  edge_pop: data.edge_pop ?? null,
  edge_ray_id: data.edge_ray_id ?? null,
  edge_headers_json: data.edge_headers_json ?? null,
});

type SchemaField = { name: string; type: string; mode?: "NULLABLE" | "REQUIRED" | "REPEATED" };

const DESIRED_SCHEMA: SchemaField[] = [
  { name: "id", type: "STRING", mode: "REQUIRED" },
  { name: "website_id", type: "STRING", mode: "REQUIRED" },
  { name: "user_id", type: "STRING", mode: "REQUIRED" },
  { name: "timestamp", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "status", type: "STRING", mode: "REQUIRED" },
  { name: "response_time", type: "FLOAT", mode: "NULLABLE" },
  { name: "status_code", type: "INTEGER", mode: "NULLABLE" },
  { name: "error", type: "STRING", mode: "NULLABLE" },
  { name: "dns_ms", type: "FLOAT", mode: "NULLABLE" },
  { name: "connect_ms", type: "FLOAT", mode: "NULLABLE" },
  { name: "tls_ms", type: "FLOAT", mode: "NULLABLE" },
  { name: "ttfb_ms", type: "FLOAT", mode: "NULLABLE" },
  // Target metadata (best-effort)
  { name: "target_hostname", type: "STRING", mode: "NULLABLE" },
  { name: "target_ip", type: "STRING", mode: "NULLABLE" },
  { name: "target_ips_json", type: "STRING", mode: "NULLABLE" },
  { name: "target_ip_family", type: "INTEGER", mode: "NULLABLE" },
  { name: "target_country", type: "STRING", mode: "NULLABLE" },
  { name: "target_region", type: "STRING", mode: "NULLABLE" },
  { name: "target_city", type: "STRING", mode: "NULLABLE" },
  { name: "target_latitude", type: "FLOAT", mode: "NULLABLE" },
  { name: "target_longitude", type: "FLOAT", mode: "NULLABLE" },
  { name: "target_asn", type: "STRING", mode: "NULLABLE" },
  { name: "target_org", type: "STRING", mode: "NULLABLE" },
  { name: "target_isp", type: "STRING", mode: "NULLABLE" },
  // Edge hints (best-effort)
  { name: "cdn_provider", type: "STRING", mode: "NULLABLE" },
  { name: "edge_pop", type: "STRING", mode: "NULLABLE" },
  { name: "edge_ray_id", type: "STRING", mode: "NULLABLE" },
  { name: "edge_headers_json", type: "STRING", mode: "NULLABLE" },
];

let schemaReadyPromise: Promise<void> | null = null;

async function ensureCheckHistoryTableSchema(): Promise<void> {
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    const dataset = bigquery.dataset(DATASET_ID);
    const table = dataset.table(TABLE_ID);

    try {
      const [datasetExists] = await dataset.exists();
      if (!datasetExists) {
        // Best-effort: create dataset in US (common default). If your dataset is elsewhere, it already exists.
        await dataset.create({ location: "US" });
      }
    } catch (e) {
      logger.warn("BigQuery dataset ensure failed (continuing best-effort)", { error: (e as Error)?.message ?? String(e) });
    }

    try {
      const [tableExists] = await table.exists();
      if (!tableExists) {
        await table.create({
          schema: { fields: DESIRED_SCHEMA },
          timePartitioning: {
            type: "DAY",
            field: "timestamp",
            expirationMs: HISTORY_RETENTION_MS,
          },
        });
        return;
      }
    } catch (e) {
      logger.warn("BigQuery table ensure failed (continuing best-effort)", { error: (e as Error)?.message ?? String(e) });
    }

    try {
      const [meta] = await table.getMetadata();
      const timePartitioning = meta?.timePartitioning as { field?: string; expirationMs?: number | string; type?: string } | undefined;
      const currentExpirationMs = typeof timePartitioning?.expirationMs === 'string' 
        ? parseInt(timePartitioning.expirationMs, 10) 
        : timePartitioning?.expirationMs;
      if (timePartitioning?.field && currentExpirationMs !== HISTORY_RETENTION_MS) {
        await table.setMetadata({
          timePartitioning: {
            ...timePartitioning,
            expirationMs: String(HISTORY_RETENTION_MS),
          },
        });
        logger.info(`BigQuery retention updated: ${DATASET_ID}.${TABLE_ID} now expires after ${HISTORY_RETENTION_DAYS} days`);
      } else if (!timePartitioning?.field) {
        logger.warn(`BigQuery table ${DATASET_ID}.${TABLE_ID} is not partitioned; retention relies on scheduled cleanup.`);
      }
      const existingFields: SchemaField[] = Array.isArray(meta?.schema?.fields)
        ? (meta.schema.fields as SchemaField[])
        : [];
      const existing = new Set(
        existingFields
          .map((f) => (typeof f.name === "string" ? f.name : undefined))
          .filter((name): name is string => Boolean(name))
      );

      const missing = DESIRED_SCHEMA.filter((f) => !existing.has(f.name));
      if (missing.length === 0) return;

      // Only add nullable columns (safe BigQuery schema evolution).
      const nextFields = existingFields.concat(missing.map((f) => ({ name: f.name, type: f.type, mode: f.mode ?? "NULLABLE" })));
      await table.setMetadata({ schema: { fields: nextFields } });
      logger.info(`BigQuery schema updated: added ${missing.length} column(s) to ${DATASET_ID}.${TABLE_ID}`);
    } catch (e) {
      logger.warn("BigQuery schema update failed (continuing best-effort)", { error: (e as Error)?.message ?? String(e) });
    }
  })();

  return schemaReadyPromise;
}

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
    await ensureCheckHistoryTableSchema();
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

function scheduleNextBackoffFlush() {
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
}

function queueFlushAfter(delayMs: number) {
  queueFlushAt(Date.now() + Math.max(delayMs, 0));
}

function queueFlushAt(targetTime: number) {
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
}

const touchIdleTimer = () => {
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
  }
  if (isShuttingDown) {
    return;
  }

  idleStopTimer = setTimeout(() => {
    if (bigQueryInsertBuffer.size === 0 && failureTracker.size === 0) {
      idleStopTimer = null;
      return;
    }
    queueFlushAfter(0);
    touchIdleTimer();
  }, IDLE_STOP_AFTER_MS);
};

const ensureOnDemandScheduler = () => {
  if (isShuttingDown) return;
  registerShutdownHandlers();
  touchIdleTimer();
};

// QA: ensure shutdown drains all buffered rows and idle timer releases after inactivity.
const registerShutdownHandlers = () => {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;

  const handle = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, flushing BigQuery buffer before shutdown...`);

    if (queuedFlushTimer) {
      clearTimeout(queuedFlushTimer);
      queuedFlushTimer = null;
    }
    if (idleStopTimer) {
      clearTimeout(idleStopTimer);
      idleStopTimer = null;
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
  dns_ms?: number;
  connect_ms?: number;
  tls_ms?: number;
  ttfb_ms?: number;

  target_hostname?: string;
  target_ip?: string;
  target_ips_json?: string;
  target_ip_family?: number;
  target_country?: string;
  target_region?: string;
  target_city?: string;
  target_latitude?: number;
  target_longitude?: number;
  target_asn?: string;
  target_org?: string;
  target_isp?: string;
  cdn_provider?: string;
  edge_pop?: string;
  edge_ray_id?: string;
  edge_headers_json?: string;
}

export interface BigQueryLatestStatusRow {
  website_id: string;
  status: string;
  timestamp: unknown;
  response_time?: number;
  status_code?: number;
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
        error,
        dns_ms,
        connect_ms,
        tls_ms,
        ttfb_ms,
        target_hostname,
        target_ip,
        target_ips_json,
        target_ip_family,
        target_country,
        target_region,
        target_city,
        target_latitude,
        target_longitude,
        target_asn,
        target_org,
        target_isp,
        cdn_provider,
        edge_pop,
        edge_ray_id,
        edge_headers_json
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

export interface DailySummary {
  day: Date; // Start of day (00:00:00)
  hasIssues: boolean; // true if any check that day had DOWN or ERROR status
  totalChecks: number;
  issueCount: number;
  avgResponseTime?: number; // Average response time in milliseconds for the day
}

export const getCheckHistoryDailySummary = async (
  websiteId: string,
  userId: string,
  startDate: number,
  endDate: number
): Promise<DailySummary[]> => {
  try {
    // Aggregate by day: check if any entry had issues
    // Issues = status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')
    //   OR (error IS NOT NULL AND error != '') OR status_code >= 400 OR status_code < 0
    // Note: status_code < 0 catches timeouts and connection errors (e.g., -1)
    // Note: BigQuery stores timestamp as TIMESTAMP, so we use DATE() function
    const query = `
      WITH range_rows AS (
        SELECT timestamp, status, response_time
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_row AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp < @startDate
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      seeded AS (
        SELECT timestamp, status FROM range_rows
        UNION ALL
        SELECT @startDate AS timestamp, status FROM prior_row
      ),
      ordered AS (
        SELECT
          timestamp,
          CASE
            WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
            ELSE 0
          END AS is_offline,
          LEAD(timestamp) OVER (ORDER BY timestamp) AS next_timestamp
        FROM seeded
        WHERE timestamp <= @endDate
      ),
      segments AS (
        SELECT
          timestamp AS start_time,
          COALESCE(next_timestamp, @endDate) AS end_time,
          is_offline
        FROM ordered
        WHERE timestamp < @endDate
      ),
      days AS (
        SELECT day
        FROM UNNEST(GENERATE_DATE_ARRAY(DATE(@startDate), DATE(@endDate))) AS day
      ),
      day_bounds AS (
        SELECT
          day,
          TIMESTAMP(day) AS day_start,
          TIMESTAMP(DATE_ADD(day, INTERVAL 1 DAY)) AS day_end
        FROM days
      ),
      issue_days AS (
        SELECT
          day_bounds.day AS day,
          COUNTIF(
            segments.is_offline = 1
            AND segments.start_time < day_bounds.day_end
            AND segments.end_time > day_bounds.day_start
          ) AS issue_count
        FROM day_bounds
        LEFT JOIN segments
          ON segments.start_time < day_bounds.day_end
         AND segments.end_time > day_bounds.day_start
        GROUP BY day_bounds.day
      ),
      daily_counts AS (
        SELECT DATE(timestamp) AS day, COUNT(*) AS total_checks
        FROM range_rows
        GROUP BY day
      ),
      daily_response_time AS (
        SELECT 
          DATE(timestamp) AS day,
          AVG(response_time) AS avg_response_time
        FROM range_rows
        WHERE response_time IS NOT NULL AND response_time > 0
        GROUP BY day
      )
      SELECT
        issue_days.day AS day,
        COALESCE(daily_counts.total_checks, 0) AS total_checks,
        issue_days.issue_count AS issue_count,
        daily_response_time.avg_response_time AS avg_response_time
      FROM issue_days
      LEFT JOIN daily_counts USING(day)
      LEFT JOIN daily_response_time USING(day)
      ORDER BY day ASC
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
    
    logger.info(`Daily summary query returned ${rows.length} rows for website ${websiteId} (date range: ${new Date(startDate).toISOString()} to ${new Date(endDate).toISOString()})`);
    
    const summaries = rows.map((row: { day: { value?: string } | Date | string; total_checks?: number; issue_count?: number; avg_response_time?: number | null }) => {
      // Handle BigQuery DATE type - it returns as { value: string }
      let dayDate: Date;
      if (row.day instanceof Date) {
        dayDate = row.day;
      } else if (typeof row.day === 'object' && row.day !== null && 'value' in row.day) {
        dayDate = new Date((row.day as { value: string }).value);
      } else {
        dayDate = new Date(row.day as string);
      }
      
      const issueCount = Number(row.issue_count || 0);
      const totalChecks = Number(row.total_checks || 0);
      const hasIssues = issueCount > 0;
      const avgResponseTime = row.avg_response_time != null && Number.isFinite(Number(row.avg_response_time)) 
        ? Number(row.avg_response_time) 
        : undefined;
      
      // Log all days with data, especially those with issues
      if (hasIssues) {
        logger.info(`Day ${dayDate.toISOString().split('T')[0]}: ${issueCount}/${totalChecks} checks had issues`);
      } else if (totalChecks > 0) {
        logger.debug(`Day ${dayDate.toISOString().split('T')[0]}: ${totalChecks} checks, all online`);
      }
      
      return {
        day: dayDate,
        hasIssues,
        totalChecks,
        issueCount,
        avgResponseTime,
      };
    });
    
    // Log summary
    const daysWithIssues = summaries.filter(s => s.hasIssues).length;
    logger.info(`Daily summary: ${daysWithIssues} days with issues out of ${summaries.length} days with data`);
    
    return summaries;
  } catch (error) {
    console.error('Error querying daily summary from BigQuery:', error);
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
  totalDurationMs: number;
  onlineDurationMs: number;
  offlineDurationMs: number;
  responseSampleCount: number;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
}> => {
  try {
    const effectiveStartDate = typeof startDate === 'number' && startDate > 0 ? startDate : 0;
    const effectiveEndDate = typeof endDate === 'number' && endDate > 0 ? endDate : Date.now();

    const query = `
      WITH range_rows AS (
        SELECT timestamp, status, response_time
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_row AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp < @startDate
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      seeded AS (
        SELECT timestamp, status FROM range_rows
        UNION ALL
        SELECT @startDate AS timestamp, status FROM prior_row
      ),
      ordered AS (
        SELECT
          timestamp,
          CASE
            WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
            ELSE 0
          END AS is_offline,
          LEAD(timestamp) OVER (ORDER BY timestamp) AS next_timestamp
        FROM seeded
        WHERE timestamp <= @endDate
      ),
      durations AS (
        SELECT
          is_offline,
          GREATEST(0, UNIX_MILLIS(COALESCE(next_timestamp, @endDate)) - UNIX_MILLIS(timestamp)) AS duration_ms
        FROM ordered
        WHERE timestamp < @endDate
      ),
      agg_counts AS (
        SELECT
          COUNT(*) AS totalChecks,
          COUNTIF(status IN ('online', 'UP', 'REDIRECT')) AS onlineChecks,
          COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) AS offlineChecks,
          COUNTIF(response_time > 0) AS responseSampleCount,
          AVG(IF(response_time > 0, response_time, NULL)) AS avgResponseTime,
          MIN(IF(response_time > 0, response_time, NULL)) AS minResponseTime,
          MAX(IF(response_time > 0, response_time, NULL)) AS maxResponseTime
        FROM range_rows
      ),
      agg_durations AS (
        SELECT
          SUM(duration_ms) AS totalDurationMs,
          SUM(IF(is_offline = 0, duration_ms, 0)) AS onlineDurationMs,
          SUM(IF(is_offline = 1, duration_ms, 0)) AS offlineDurationMs
        FROM durations
      )
      SELECT * FROM agg_counts CROSS JOIN agg_durations
    `;

    const params: Record<string, unknown> = {
      websiteId,
      userId,
      startDate: new Date(effectiveStartDate),
      endDate: new Date(effectiveEndDate),
    };

    const options = {
      query,
      params,
    };

    const [rows] = await bigquery.query(options);
    const row = rows[0];
    
    const totalChecks = Number(row.totalChecks) || 0;
    const onlineChecks = Number(row.onlineChecks) || 0;
    const offlineChecks = Number(row.offlineChecks) || 0;
    const totalDurationMs = Number(row.totalDurationMs) || 0;
    const onlineDurationMs = Number(row.onlineDurationMs) || 0;
    const offlineDurationMs = Number(row.offlineDurationMs) || 0;
    const responseSampleCount = Number(row.responseSampleCount) || 0;
    const uptimePercentage = totalDurationMs > 0 ? (onlineDurationMs / totalDurationMs) * 100 : 0;
    
    return {
      totalChecks,
      onlineChecks,
      offlineChecks,
      uptimePercentage,
      totalDurationMs,
      onlineDurationMs,
      offlineDurationMs,
      responseSampleCount,
      avgResponseTime: Number(row.avgResponseTime) || 0,
      minResponseTime: Number(row.minResponseTime) || 0,
      maxResponseTime: Number(row.maxResponseTime) || 0
    };
  } catch (error) {
    console.error('Error querying check stats from BigQuery:', error);
    throw error;
  }
};

export const getLatestCheckStatuses = async (
  userId: string,
  checkIds: string[]
): Promise<BigQueryLatestStatusRow[]> => {
  if (!checkIds.length) {
    return [];
  }

  const query = `
    SELECT website_id, status, response_time, status_code, timestamp
    FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
    WHERE user_id = @userId
      AND website_id IN UNNEST(@checkIds)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY website_id ORDER BY timestamp DESC) = 1
  `;

  try {
    const [rows] = await bigquery.query({
      query,
      params: { userId, checkIds },
    });
    return rows as BigQueryLatestStatusRow[];
  } catch (error) {
    logger.error('Error querying latest statuses from BigQuery:', error);
    return [];
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
        error,
        dns_ms,
        connect_ms,
        tls_ms,
        ttfb_ms,
        target_hostname,
        target_ip,
        target_ips_json,
        target_ip_family,
        target_country,
        target_region,
        target_city,
        target_latitude,
        target_longitude,
        target_asn,
        target_org,
        target_isp,
        cdn_provider,
        edge_pop,
        edge_ray_id,
        edge_headers_json
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

export interface BigQueryIncidentIntervalRow {
  started_at_ms: number;
  ended_at_ms: number;
}

export const getIncidentIntervals = async (
  websiteId: string,
  userId: string,
  startDate: number,
  endDate: number
): Promise<BigQueryIncidentIntervalRow[]> => {
  try {
    const query = `
      WITH range_rows AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_row AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp < @startDate
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      seeded AS (
        SELECT timestamp, status FROM range_rows
        UNION ALL
        SELECT @startDate AS timestamp, status FROM prior_row
      ),
      base AS (
        SELECT
          timestamp,
          CASE
            WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
            ELSE 0
          END AS is_offline,
          LAG(
            CASE
              WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
              ELSE 0
            END
          ) OVER (ORDER BY timestamp) AS prev_is_offline
        FROM seeded
        WHERE timestamp <= @endDate
      ),
      segmented AS (
        SELECT
          timestamp,
          is_offline,
          SUM(
            CASE
              WHEN prev_is_offline IS NULL OR is_offline != prev_is_offline THEN 1
              ELSE 0
            END
          ) OVER (ORDER BY timestamp) AS segment_id
        FROM base
      ),
      segments AS (
        SELECT
          segment_id,
          is_offline,
          MIN(timestamp) AS start_time
        FROM segmented
        GROUP BY segment_id, is_offline
      ),
      all_segments AS (
        SELECT
          segment_id,
          is_offline,
          start_time,
          LEAD(start_time) OVER (ORDER BY start_time) AS next_start_time
        FROM segments
      )
      SELECT
        UNIX_MILLIS(start_time) AS started_at_ms,
        UNIX_MILLIS(COALESCE(next_start_time, @endDate)) AS ended_at_ms
      FROM all_segments
      WHERE is_offline = 1
      ORDER BY started_at_ms ASC
    `;

    const params: Record<string, unknown> = {
      websiteId,
      userId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    };

    const [rows] = await bigquery.query({ query, params });
    return rows as BigQueryIncidentIntervalRow[];
  } catch (error) {
    console.error('Error querying incident intervals from BigQuery:', error);
    throw error;
  }
};

export interface BigQueryResponseTimeBucketRow {
  bucket_start_ms: number;
  avg_response_time: number;
  sample_count: number;
}

export const getResponseTimeBuckets = async (
  websiteId: string,
  userId: string,
  startDate: number,
  endDate: number,
  bucketSizeMs: number
): Promise<BigQueryResponseTimeBucketRow[]> => {
  try {
    const query = `
      SELECT
        DIV(UNIX_MILLIS(timestamp), @bucketSizeMs) * @bucketSizeMs AS bucket_start_ms,
        AVG(response_time) AS avg_response_time,
        COUNT(response_time) AS sample_count
      FROM \`exit1-dev.checks.check_history\`
      WHERE website_id = @websiteId
        AND user_id = @userId
        AND timestamp >= @startDate
        AND timestamp <= @endDate
        AND response_time IS NOT NULL
        AND response_time > 0
      GROUP BY bucket_start_ms
      ORDER BY bucket_start_ms ASC
    `;

    const params: Record<string, unknown> = {
      websiteId,
      userId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      bucketSizeMs,
    };

    const [rows] = await bigquery.query({ query, params });
    return rows as BigQueryResponseTimeBucketRow[];
  } catch (error) {
    console.error('Error querying response time buckets from BigQuery:', error);
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
        error,
        dns_ms,
        connect_ms,
        tls_ms,
        ttfb_ms,
        target_hostname,
        target_ip,
        target_ips_json,
        target_ip_family,
        target_country,
        target_region,
        target_city,
        target_latitude,
        target_longitude,
        target_asn,
        target_org,
        target_isp,
        cdn_provider,
        edge_pop,
        edge_ray_id,
        edge_headers_json
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

export const purgeOldCheckHistory = async (): Promise<void> => {
  const cutoffDate = new Date(Date.now() - HISTORY_RETENTION_MS);
  const query = `
    DELETE FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
    WHERE timestamp < @cutoffDate
  `;

  try {
    await ensureCheckHistoryTableSchema();
    await bigquery.query({
      query,
      params: { cutoffDate },
    });
    logger.info(`BigQuery retention purge completed (cutoff=${cutoffDate.toISOString()})`);
  } catch (error) {
    logger.error('Error purging BigQuery history rows:', error);
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
