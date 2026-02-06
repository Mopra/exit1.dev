import { BigQuery } from '@google-cloud/bigquery';
import * as logger from 'firebase-functions/logger';
import { CONFIG } from './config';

const bigquery = new BigQuery({
  projectId: 'exit1-dev',
  keyFilename: undefined, // Use default credentials
});

// Table configuration
const DATASET_ID = 'checks';
// Main table - partitioned by timestamp, clustered by user_id, website_id
// Clustering reduces query costs by ~90% compared to unclustered tables
const TABLE_ID = 'check_history_new';
// Pre-aggregated daily summaries table - partitioned by day, clustered by user_id, website_id
// This reduces timeline view query costs by 80-90% by avoiding real-time aggregation
const DAILY_SUMMARY_TABLE_ID = 'check_daily_summaries';

// Buffer size tuning: Reduced from 2000/500 for ~50% memory savings
// Trade-off: More frequent flushes, but batch size (400) remains the same
const MAX_BUFFER_SIZE = 1000;
const HIGH_WATERMARK = 300;
const DEFAULT_FLUSH_DELAY_MS = 2_000;
const IDLE_STOP_AFTER_MS = 25_000;
const LOG_SAMPLE_RATE = 0.05;
const MAX_BATCH_ROWS = 400;
const MAX_BATCH_BYTES = 9 * 1024 * 1024; // 9MB to stay under BigQuery 10MB limit
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_FAILURES_BEFORE_DROP = 10;
const FAILURE_TIMEOUT_MS = 10 * 60 * 1000;
// Retention: Partition expiration set to max tier (nano = 365 days).
// Per-tier purging is handled in purgeOldCheckHistory().
const HISTORY_RETENTION_DAYS = CONFIG.HISTORY_RETENTION_DAYS_NANO;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Maximum lookback for incident intervals - most users care about recent incidents
// This limits expensive scans in getIncidentIntervals and related functions
const MAX_INCIDENT_LOOKBACK_DAYS = 30;
const MAX_INCIDENT_LOOKBACK_MS = MAX_INCIDENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

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
          // Clustering dramatically reduces scanned bytes for queries filtering by user_id/website_id
          clustering: {
            fields: ["user_id", "website_id"],
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

// Minimal columns for list views (optimized for cost)
const MINIMAL_HISTORY_COLUMNS = `
  id,
  website_id,
  user_id,
  timestamp,
  status,
  response_time,
  status_code,
  error
`;

// Full columns including all metadata (for detail views)
const FULL_HISTORY_COLUMNS = `
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
`;

export const getCheckHistory = async (
  websiteId: string,
  userId: string,
  limit: number = 100,
  offset: number = 0,
  startDate?: number,
  endDate?: number,
  statusFilter?: string,
  searchTerm?: string,
  includeFullDetails: boolean = false
): Promise<BigQueryCheckHistoryRow[]> => {
  try {
    const columns = includeFullDetails ? FULL_HISTORY_COLUMNS : MINIMAL_HISTORY_COLUMNS;
    let query = `
      SELECT ${columns}
      FROM \`exit1-dev.checks.${TABLE_ID}\`
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
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_row AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.${TABLE_ID}\`
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
      FROM \`exit1-dev.checks.${TABLE_ID}\`
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
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_row AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.${TABLE_ID}\`
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

// Batch stats interface for multi-website queries
export interface BatchCheckStats {
  websiteId: string;
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
}

// Maximum websites per batch query to prevent excessive scans
const MAX_BATCH_WEBSITES = 25;

// Batch query for stats across multiple websites in a single query (cost optimized)
export const getCheckStatsBatch = async (
  websiteIds: string[],
  userId: string,
  startDate?: number,
  endDate?: number
): Promise<BatchCheckStats[]> => {
  if (!websiteIds.length) {
    return [];
  }

  // Limit to prevent excessive scans
  const limitedIds = websiteIds.slice(0, MAX_BATCH_WEBSITES);
  
  const effectiveStartDate = typeof startDate === 'number' && startDate > 0 ? startDate : 0;
  const effectiveEndDate = typeof endDate === 'number' && endDate > 0 ? endDate : Date.now();

  try {
    const query = `
      WITH range_rows AS (
        SELECT website_id, timestamp, status, response_time
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id IN UNNEST(@websiteIds)
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_rows AS (
        SELECT website_id, timestamp, status
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id IN UNNEST(@websiteIds)
          AND user_id = @userId
          AND timestamp < @startDate
        QUALIFY ROW_NUMBER() OVER (PARTITION BY website_id ORDER BY timestamp DESC) = 1
      ),
      seeded AS (
        SELECT website_id, timestamp, status FROM range_rows
        UNION ALL
        SELECT website_id, @startDate AS timestamp, status FROM prior_rows
      ),
      ordered AS (
        SELECT
          website_id,
          timestamp,
          CASE
            WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
            ELSE 0
          END AS is_offline,
          LEAD(timestamp) OVER (PARTITION BY website_id ORDER BY timestamp) AS next_timestamp
        FROM seeded
        WHERE timestamp <= @endDate
      ),
      durations AS (
        SELECT
          website_id,
          is_offline,
          GREATEST(0, UNIX_MILLIS(COALESCE(next_timestamp, @endDate)) - UNIX_MILLIS(timestamp)) AS duration_ms
        FROM ordered
        WHERE timestamp < @endDate
      ),
      agg_counts AS (
        SELECT
          website_id,
          COUNT(*) AS totalChecks,
          COUNTIF(status IN ('online', 'UP', 'REDIRECT')) AS onlineChecks,
          COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) AS offlineChecks,
          COUNTIF(response_time > 0) AS responseSampleCount,
          AVG(IF(response_time > 0, response_time, NULL)) AS avgResponseTime,
          MIN(IF(response_time > 0, response_time, NULL)) AS minResponseTime,
          MAX(IF(response_time > 0, response_time, NULL)) AS maxResponseTime
        FROM range_rows
        GROUP BY website_id
      ),
      agg_durations AS (
        SELECT
          website_id,
          SUM(duration_ms) AS totalDurationMs,
          SUM(IF(is_offline = 0, duration_ms, 0)) AS onlineDurationMs,
          SUM(IF(is_offline = 1, duration_ms, 0)) AS offlineDurationMs
        FROM durations
        GROUP BY website_id
      )
      SELECT 
        agg_counts.website_id,
        agg_counts.totalChecks,
        agg_counts.onlineChecks,
        agg_counts.offlineChecks,
        agg_counts.responseSampleCount,
        agg_counts.avgResponseTime,
        agg_counts.minResponseTime,
        agg_counts.maxResponseTime,
        COALESCE(agg_durations.totalDurationMs, 0) AS totalDurationMs,
        COALESCE(agg_durations.onlineDurationMs, 0) AS onlineDurationMs,
        COALESCE(agg_durations.offlineDurationMs, 0) AS offlineDurationMs
      FROM agg_counts
      LEFT JOIN agg_durations USING (website_id)
    `;

    const params: Record<string, unknown> = {
      websiteIds: limitedIds,
      userId,
      startDate: new Date(effectiveStartDate),
      endDate: new Date(effectiveEndDate),
    };

    const [rows] = await bigquery.query({ query, params });
    
    return rows.map((row: Record<string, unknown>) => {
      const totalDurationMs = Number(row.totalDurationMs) || 0;
      const onlineDurationMs = Number(row.onlineDurationMs) || 0;
      const uptimePercentage = totalDurationMs > 0 ? (onlineDurationMs / totalDurationMs) * 100 : 0;
      
      return {
        websiteId: String(row.website_id || ''),
        totalChecks: Number(row.totalChecks) || 0,
        onlineChecks: Number(row.onlineChecks) || 0,
        offlineChecks: Number(row.offlineChecks) || 0,
        uptimePercentage,
        totalDurationMs,
        onlineDurationMs,
        offlineDurationMs: Number(row.offlineDurationMs) || 0,
        responseSampleCount: Number(row.responseSampleCount) || 0,
        avgResponseTime: Number(row.avgResponseTime) || 0,
        minResponseTime: Number(row.minResponseTime) || 0,
        maxResponseTime: Number(row.maxResponseTime) || 0,
      };
    });
  } catch (error) {
    console.error('Error querying batch check stats from BigQuery:', error);
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

// Maximum rows to return for stats queries to prevent unbounded scans
const MAX_STATS_ROWS = 50000;

// Function to get check history for statistics (with time range) - uses minimal columns
export const getCheckHistoryForStats = async (
  websiteId: string,
  userId: string,
  startDate: number,
  endDate: number,
  limit: number = MAX_STATS_ROWS
): Promise<BigQueryCheckHistoryRow[]> => {
  try {
    // Only fetch columns needed for stats calculations
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
      FROM \`exit1-dev.checks.${TABLE_ID}\`
      WHERE website_id = @websiteId 
        AND user_id = @userId
        AND timestamp >= @startDate
        AND timestamp <= @endDate
      ORDER BY timestamp DESC
      LIMIT @limit
    `;
    
    const params: Record<string, unknown> = {
      websiteId,
      userId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      limit: Math.min(limit, MAX_STATS_ROWS),
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
  // Enforce maximum incident lookback to reduce expensive scans
  // If date range exceeds MAX_INCIDENT_LOOKBACK_MS, adjust startDate
  const now = Date.now();
  const maxLookbackStart = now - MAX_INCIDENT_LOOKBACK_MS;
  const effectiveStartDate = Math.max(startDate, maxLookbackStart);
  
  // If the entire range is beyond the lookback window, return empty
  if (effectiveStartDate >= endDate) {
    return [];
  }

  try {
    const query = `
      WITH range_rows AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_row AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.${TABLE_ID}\`
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
      startDate: new Date(effectiveStartDate),
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
      FROM \`exit1-dev.checks.${TABLE_ID}\`
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

// Combined report metrics result interface
export interface CombinedReportMetrics {
  stats: {
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
  };
  incidents: BigQueryIncidentIntervalRow[];
  responseTimeBuckets: BigQueryResponseTimeBucketRow[];
}

/**
 * Combined query that fetches stats, incidents, and response time buckets in a SINGLE table scan.
 * This replaces 3-5 separate queries that each scanned the full date range.
 * Cost reduction: ~60-80% fewer bytes scanned.
 */
export const getReportMetricsCombined = async (
  websiteId: string,
  userId: string,
  startDate: number,
  endDate: number,
  bucketSizeMs: number
): Promise<CombinedReportMetrics> => {
  // Enforce maximum lookback to reduce expensive scans
  const now = Date.now();
  const maxLookbackStart = now - MAX_INCIDENT_LOOKBACK_MS;
  const effectiveStartDate = Math.max(startDate, maxLookbackStart);
  
  // If the entire range is beyond the lookback window, return empty metrics
  if (effectiveStartDate >= endDate) {
    return {
      stats: {
        totalChecks: 0,
        onlineChecks: 0,
        offlineChecks: 0,
        uptimePercentage: 0,
        totalDurationMs: 0,
        onlineDurationMs: 0,
        offlineDurationMs: 0,
        responseSampleCount: 0,
        avgResponseTime: 0,
        minResponseTime: 0,
        maxResponseTime: 0,
      },
      incidents: [],
      responseTimeBuckets: [],
    };
  }

  try {
    // Single query that computes all metrics in one scan
    // Uses a single CTE for the base data, then computes stats, incidents, and buckets
    const query = `
      WITH
      -- Fetch all rows in the date range
      range_rows AS (
        SELECT timestamp, status, response_time, 0 AS is_seed
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      -- Get the most recent row before the start date (for duration seeding)
      prior_row AS (
        SELECT timestamp, status, CAST(NULL AS FLOAT64) AS response_time, 1 AS is_seed
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp < @startDate
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      -- Combine range rows with prior row seed
      base_data AS (
        SELECT * FROM range_rows
        UNION ALL
        SELECT * FROM prior_row
      ),
      -- Seed the prior row with the startDate for duration calculation
      seeded AS (
        SELECT
          CASE WHEN is_seed = 1 THEN @startDate ELSE timestamp END AS timestamp,
          status,
          response_time,
          is_seed
        FROM base_data
      ),
      -- Add offline flag and next timestamp for duration calculation
      with_lead AS (
        SELECT
          timestamp,
          status,
          response_time,
          is_seed,
          CASE WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1 ELSE 0 END AS is_offline,
          LEAD(timestamp) OVER (ORDER BY timestamp) AS next_timestamp,
          LAG(CASE WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1 ELSE 0 END) OVER (ORDER BY timestamp) AS prev_is_offline
        FROM seeded
        WHERE timestamp <= @endDate
      ),
      -- Calculate durations
      durations AS (
        SELECT
          is_offline,
          GREATEST(0, UNIX_MILLIS(COALESCE(next_timestamp, @endDate)) - UNIX_MILLIS(timestamp)) AS duration_ms
        FROM with_lead
        WHERE timestamp < @endDate
      ),
      -- Aggregate stats from range rows only (exclude seed row)
      agg_counts AS (
        SELECT
          COUNT(*) AS totalChecks,
          COUNTIF(status IN ('online', 'UP', 'REDIRECT')) AS onlineChecks,
          COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) AS offlineChecks,
          COUNTIF(response_time > 0) AS responseSampleCount,
          AVG(IF(response_time > 0, response_time, NULL)) AS avgResponseTime,
          MIN(IF(response_time > 0, response_time, NULL)) AS minResponseTime,
          MAX(IF(response_time > 0, response_time, NULL)) AS maxResponseTime
        FROM with_lead
        WHERE is_seed = 0
      ),
      -- Aggregate durations
      agg_durations AS (
        SELECT
          SUM(duration_ms) AS totalDurationMs,
          SUM(IF(is_offline = 0, duration_ms, 0)) AS onlineDurationMs,
          SUM(IF(is_offline = 1, duration_ms, 0)) AS offlineDurationMs
        FROM durations
      ),
      -- Incident intervals using segment detection
      segmented AS (
        SELECT
          timestamp,
          is_offline,
          SUM(CASE WHEN prev_is_offline IS NULL OR is_offline != prev_is_offline THEN 1 ELSE 0 END) OVER (ORDER BY timestamp) AS segment_id
        FROM with_lead
      ),
      segments AS (
        SELECT
          segment_id,
          is_offline,
          MIN(timestamp) AS start_time
        FROM segmented
        GROUP BY segment_id, is_offline
      ),
      incident_intervals AS (
        SELECT
          UNIX_MILLIS(start_time) AS started_at_ms,
          UNIX_MILLIS(COALESCE(LEAD(start_time) OVER (ORDER BY start_time), @endDate)) AS ended_at_ms
        FROM segments
        WHERE is_offline = 1
      ),
      -- Response time buckets
      response_buckets AS (
        SELECT
          DIV(UNIX_MILLIS(timestamp), @bucketSizeMs) * @bucketSizeMs AS bucket_start_ms,
          AVG(response_time) AS avg_response_time,
          COUNT(response_time) AS sample_count
        FROM with_lead
        WHERE is_seed = 0 AND response_time IS NOT NULL AND response_time > 0
        GROUP BY bucket_start_ms
      )
      -- Return all results as JSON arrays for efficient single-row result
      SELECT
        (SELECT AS STRUCT * FROM agg_counts CROSS JOIN agg_durations) AS stats,
        ARRAY(SELECT AS STRUCT started_at_ms, ended_at_ms FROM incident_intervals ORDER BY started_at_ms) AS incidents,
        ARRAY(SELECT AS STRUCT bucket_start_ms, avg_response_time, sample_count FROM response_buckets ORDER BY bucket_start_ms) AS buckets
    `;

    const params: Record<string, unknown> = {
      websiteId,
      userId,
      startDate: new Date(effectiveStartDate),
      endDate: new Date(endDate),
      bucketSizeMs,
    };

    const [rows] = await bigquery.query({ query, params });
    const row = rows[0];

    if (!row) {
      return {
        stats: {
          totalChecks: 0,
          onlineChecks: 0,
          offlineChecks: 0,
          uptimePercentage: 0,
          totalDurationMs: 0,
          onlineDurationMs: 0,
          offlineDurationMs: 0,
          responseSampleCount: 0,
          avgResponseTime: 0,
          minResponseTime: 0,
          maxResponseTime: 0,
        },
        incidents: [],
        responseTimeBuckets: [],
      };
    }

    const stats = row.stats || {};
    const totalDurationMs = Number(stats.totalDurationMs) || 0;
    const onlineDurationMs = Number(stats.onlineDurationMs) || 0;

    return {
      stats: {
        totalChecks: Number(stats.totalChecks) || 0,
        onlineChecks: Number(stats.onlineChecks) || 0,
        offlineChecks: Number(stats.offlineChecks) || 0,
        uptimePercentage: totalDurationMs > 0 ? (onlineDurationMs / totalDurationMs) * 100 : 0,
        totalDurationMs,
        onlineDurationMs,
        offlineDurationMs: Number(stats.offlineDurationMs) || 0,
        responseSampleCount: Number(stats.responseSampleCount) || 0,
        avgResponseTime: Number(stats.avgResponseTime) || 0,
        minResponseTime: Number(stats.minResponseTime) || 0,
        maxResponseTime: Number(stats.maxResponseTime) || 0,
      },
      incidents: (row.incidents || []).map((i: { started_at_ms: unknown; ended_at_ms: unknown }) => ({
        started_at_ms: Number(i.started_at_ms) || 0,
        ended_at_ms: Number(i.ended_at_ms) || 0,
      })),
      responseTimeBuckets: (row.buckets || []).map((b: { bucket_start_ms: unknown; avg_response_time: unknown; sample_count: unknown }) => ({
        bucket_start_ms: Number(b.bucket_start_ms) || 0,
        avg_response_time: Number(b.avg_response_time) || 0,
        sample_count: Number(b.sample_count) || 0,
      })),
    };
  } catch (error) {
    console.error('Error querying combined report metrics from BigQuery:', error);
    throw error;
  }
};

// Maximum rows to return for hourly incident queries
const MAX_HOURLY_INCIDENT_ROWS = 1000;

// Function to get incidents for a specific hour - uses minimal columns
export const getIncidentsForHour = async (
  websiteId: string,
  userId: string,
  hourStart: number,
  hourEnd: number,
  limit: number = MAX_HOURLY_INCIDENT_ROWS
): Promise<BigQueryCheckHistoryRow[]> => {
  try {
    // Only fetch columns needed for incident display
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
      FROM \`exit1-dev.checks.${TABLE_ID}\`
      WHERE website_id = @websiteId 
        AND user_id = @userId
        AND timestamp >= @hourStart
        AND timestamp < @hourEnd
      ORDER BY timestamp DESC
      LIMIT @limit
    `;
    
    const params: Record<string, unknown> = {
      websiteId,
      userId,
      hourStart: new Date(hourStart),
      hourEnd: new Date(hourEnd),
      limit: Math.min(limit, MAX_HOURLY_INCIDENT_ROWS),
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

export const purgeOldCheckHistory = async (nanoUserIds?: string[]): Promise<void> => {
  const now = Date.now();
  const nanoSet = new Set(nanoUserIds ?? []);

  try {
    await ensureCheckHistoryTableSchema();

    // 1. Purge free-tier rows older than free retention
    const freeCutoff = new Date(now - CONFIG.HISTORY_RETENTION_DAYS_FREE * 24 * 60 * 60 * 1000);
    if (nanoSet.size > 0) {
      // Delete rows older than 60 days that do NOT belong to nano users
      const freeQuery = `
        DELETE FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
        WHERE timestamp < @cutoffDate
          AND user_id NOT IN UNNEST(@nanoUserIds)
      `;
      await bigquery.query({
        query: freeQuery,
        params: { cutoffDate: freeCutoff, nanoUserIds: Array.from(nanoSet) },
      });
    } else {
      // No nano users – purge everything older than free retention
      const allQuery = `
        DELETE FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
        WHERE timestamp < @cutoffDate
      `;
      await bigquery.query({
        query: allQuery,
        params: { cutoffDate: freeCutoff },
      });
    }

    // 2. Purge nano-tier rows older than nano retention (catches all remaining old data)
    const nanoCutoff = new Date(now - CONFIG.HISTORY_RETENTION_DAYS_NANO * 24 * 60 * 60 * 1000);
    const nanoQuery = `
      DELETE FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
      WHERE timestamp < @cutoffDate
    `;
    await bigquery.query({
      query: nanoQuery,
      params: { cutoffDate: nanoCutoff },
    });

    logger.info(`BigQuery retention purge completed (free cutoff=${freeCutoff.toISOString()}, nano cutoff=${nanoCutoff.toISOString()}, nano users=${nanoSet.size})`);
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

// Batch daily summary type for multiple checks
export interface BatchDailySummary {
  websiteId: string;
  day: Date;
  hasIssues: boolean;
  totalChecks: number;
  issueCount: number;
}

// Batch query for daily summaries across multiple checks in a single query (cost optimized)
export const getCheckHistoryDailySummaryBatch = async (
  websiteIds: string[],
  userId: string,
  startDate: number,
  endDate: number
): Promise<Map<string, BatchDailySummary[]>> => {
  if (!websiteIds.length) {
    return new Map();
  }

  // Limit to prevent excessive scans
  const limitedIds = websiteIds.slice(0, MAX_BATCH_WEBSITES);

  try {
    const query = `
      WITH range_rows AS (
        SELECT website_id, timestamp, status
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id IN UNNEST(@websiteIds)
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
      ),
      prior_rows AS (
        SELECT website_id, timestamp, status
        FROM \`exit1-dev.checks.${TABLE_ID}\`
        WHERE website_id IN UNNEST(@websiteIds)
          AND user_id = @userId
          AND timestamp < @startDate
        QUALIFY ROW_NUMBER() OVER (PARTITION BY website_id ORDER BY timestamp DESC) = 1
      ),
      seeded AS (
        SELECT website_id, timestamp, status FROM range_rows
        UNION ALL
        SELECT website_id, @startDate AS timestamp, status FROM prior_rows
      ),
      ordered AS (
        SELECT
          website_id,
          timestamp,
          CASE
            WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
            ELSE 0
          END AS is_offline,
          LEAD(timestamp) OVER (PARTITION BY website_id ORDER BY timestamp) AS next_timestamp
        FROM seeded
        WHERE timestamp <= @endDate
      ),
      segments AS (
        SELECT
          website_id,
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
          segments.website_id,
          day_bounds.day AS day,
          COUNTIF(
            segments.is_offline = 1
            AND segments.start_time < day_bounds.day_end
            AND segments.end_time > day_bounds.day_start
          ) AS issue_count
        FROM day_bounds
        CROSS JOIN (SELECT DISTINCT website_id FROM seeded) AS websites
        LEFT JOIN segments
          ON segments.website_id = websites.website_id
          AND segments.start_time < day_bounds.day_end
          AND segments.end_time > day_bounds.day_start
        GROUP BY segments.website_id, day_bounds.day
      ),
      daily_counts AS (
        SELECT website_id, DATE(timestamp) AS day, COUNT(*) AS total_checks
        FROM range_rows
        GROUP BY website_id, day
      )
      SELECT
        issue_days.website_id,
        issue_days.day AS day,
        COALESCE(daily_counts.total_checks, 0) AS total_checks,
        issue_days.issue_count AS issue_count
      FROM issue_days
      LEFT JOIN daily_counts 
        ON issue_days.website_id = daily_counts.website_id 
        AND issue_days.day = daily_counts.day
      WHERE issue_days.website_id IS NOT NULL
      ORDER BY issue_days.website_id, issue_days.day ASC
    `;
    
    const params: Record<string, unknown> = {
      websiteIds: limitedIds,
      userId,
      startDate: new Date(startDate),
      endDate: new Date(endDate)
    };
    
    const [rows] = await bigquery.query({ query, params });
    
    // Group results by websiteId
    const resultMap = new Map<string, BatchDailySummary[]>();
    
    for (const row of rows as Array<{ website_id: string; day: { value?: string } | Date | string; total_checks?: number; issue_count?: number }>) {
      const websiteId = String(row.website_id || '');
      if (!websiteId) continue;
      
      // Handle BigQuery DATE type
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
      
      if (!resultMap.has(websiteId)) {
        resultMap.set(websiteId, []);
      }
      
      resultMap.get(websiteId)!.push({
        websiteId,
        day: dayDate,
        hasIssues,
        totalChecks,
        issueCount,
      });
    }
    
    logger.info(`Batch daily summary query returned data for ${resultMap.size} websites`);
    return resultMap;
  } catch (error) {
    console.error('Error querying batch daily summary from BigQuery:', error);
    throw error;
  }
};

// ============================================================================
// PRE-AGGREGATED DAILY SUMMARIES
// ============================================================================
// These functions support a pre-aggregated daily summaries table that reduces
// timeline view query costs by 80-90% by avoiding real-time aggregation.

// Schema for daily summaries table
const DAILY_SUMMARY_SCHEMA: SchemaField[] = [
  { name: "website_id", type: "STRING", mode: "REQUIRED" },
  { name: "user_id", type: "STRING", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "total_checks", type: "INTEGER", mode: "REQUIRED" },
  { name: "online_checks", type: "INTEGER", mode: "REQUIRED" },
  { name: "offline_checks", type: "INTEGER", mode: "REQUIRED" },
  { name: "issue_count", type: "INTEGER", mode: "REQUIRED" },
  { name: "has_issues", type: "BOOLEAN", mode: "REQUIRED" },
  { name: "avg_response_time", type: "FLOAT", mode: "NULLABLE" },
  { name: "min_response_time", type: "FLOAT", mode: "NULLABLE" },
  { name: "max_response_time", type: "FLOAT", mode: "NULLABLE" },
  { name: "aggregated_at", type: "TIMESTAMP", mode: "REQUIRED" },
];

let dailySummarySchemaReady = false;

/**
 * Ensures the daily summaries table exists with the correct schema
 */
async function ensureDailySummaryTableSchema(): Promise<void> {
  if (dailySummarySchemaReady) return;

  const dataset = bigquery.dataset(DATASET_ID);
  const table = dataset.table(DAILY_SUMMARY_TABLE_ID);

  try {
    const [tableExists] = await table.exists();
    if (!tableExists) {
      await table.create({
        schema: { fields: DAILY_SUMMARY_SCHEMA },
        timePartitioning: {
          type: "DAY",
          field: "day",
          expirationMs: HISTORY_RETENTION_MS,
        },
        clustering: {
          fields: ["user_id", "website_id"],
        },
      });
      logger.info(`Created daily summaries table: ${DATASET_ID}.${DAILY_SUMMARY_TABLE_ID}`);
    }
    dailySummarySchemaReady = true;
  } catch (e) {
    logger.warn("Daily summary table creation failed (continuing best-effort)", { 
      error: (e as Error)?.message ?? String(e) 
    });
  }
}

export interface PreAggregatedDailySummary {
  website_id: string;
  user_id: string;
  day: Date;
  total_checks: number;
  online_checks: number;
  offline_checks: number;
  issue_count: number;
  has_issues: boolean;
  avg_response_time: number | null;
  min_response_time: number | null;
  max_response_time: number | null;
  aggregated_at: Date;
}

/**
 * Aggregates daily summaries for a specific date and inserts them into the summaries table.
 * This should be called by a scheduled function once per day (e.g., at midnight UTC).
 * 
 * @param targetDate - The date to aggregate (defaults to yesterday)
 */
export const aggregateDailySummaries = async (targetDate?: Date): Promise<number> => {
  await ensureDailySummaryTableSchema();

  // Default to yesterday if no date provided
  const date = targetDate || new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Use UTC dates to ensure consistent day boundaries regardless of local timezone
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  try {
    // Use MERGE to upsert - this allows re-running for the same day without duplicates
    const query = `
      MERGE INTO \`${bigquery.projectId}.${DATASET_ID}.${DAILY_SUMMARY_TABLE_ID}\` AS target
      USING (
        WITH daily_data AS (
          SELECT
            website_id,
            user_id,
            DATE(timestamp) AS day,
            COUNT(*) AS total_checks,
            COUNTIF(status IN ('online', 'UP', 'REDIRECT')) AS online_checks,
            COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) AS offline_checks,
            AVG(IF(response_time > 0, response_time, NULL)) AS avg_response_time,
            MIN(IF(response_time > 0, response_time, NULL)) AS min_response_time,
            MAX(IF(response_time > 0, response_time, NULL)) AS max_response_time
          FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
          WHERE timestamp >= @dayStart
            AND timestamp < @dayEnd
          GROUP BY website_id, user_id, day
        ),
        -- Calculate issue_count using segment analysis (same logic as getCheckHistoryDailySummary)
        range_rows AS (
          SELECT website_id, user_id, timestamp, status
          FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
          WHERE timestamp >= @dayStart
            AND timestamp < @dayEnd
        ),
        prior_rows AS (
          SELECT website_id, user_id, timestamp, status
          FROM \`${bigquery.projectId}.${DATASET_ID}.${TABLE_ID}\`
          WHERE timestamp < @dayStart
          QUALIFY ROW_NUMBER() OVER (PARTITION BY website_id, user_id ORDER BY timestamp DESC) = 1
        ),
        seeded AS (
          SELECT website_id, user_id, timestamp, status FROM range_rows
          UNION ALL
          SELECT website_id, user_id, @dayStart AS timestamp, status FROM prior_rows
        ),
        ordered AS (
          SELECT
            website_id,
            user_id,
            timestamp,
            CASE WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1 ELSE 0 END AS is_offline,
            LEAD(timestamp) OVER (PARTITION BY website_id, user_id ORDER BY timestamp) AS next_timestamp
          FROM seeded
          WHERE timestamp <= @dayEnd
        ),
        segments AS (
          SELECT
            website_id,
            user_id,
            timestamp AS start_time,
            COALESCE(next_timestamp, @dayEnd) AS end_time,
            is_offline
          FROM ordered
          WHERE timestamp < @dayEnd
        ),
        issue_counts AS (
          SELECT
            website_id,
            user_id,
            COUNTIF(is_offline = 1 AND start_time < @dayEnd AND end_time > @dayStart) AS issue_count
          FROM segments
          GROUP BY website_id, user_id
        )
        SELECT
          daily_data.website_id,
          daily_data.user_id,
          daily_data.day,
          daily_data.total_checks,
          daily_data.online_checks,
          daily_data.offline_checks,
          COALESCE(issue_counts.issue_count, 0) AS issue_count,
          COALESCE(issue_counts.issue_count, 0) > 0 AS has_issues,
          daily_data.avg_response_time,
          daily_data.min_response_time,
          daily_data.max_response_time,
          CURRENT_TIMESTAMP() AS aggregated_at
        FROM daily_data
        LEFT JOIN issue_counts 
          ON daily_data.website_id = issue_counts.website_id 
          AND daily_data.user_id = issue_counts.user_id
      ) AS source
      ON target.website_id = source.website_id 
        AND target.user_id = source.user_id 
        AND target.day = source.day
      WHEN MATCHED THEN
        UPDATE SET
          total_checks = source.total_checks,
          online_checks = source.online_checks,
          offline_checks = source.offline_checks,
          issue_count = source.issue_count,
          has_issues = source.has_issues,
          avg_response_time = source.avg_response_time,
          min_response_time = source.min_response_time,
          max_response_time = source.max_response_time,
          aggregated_at = source.aggregated_at
      WHEN NOT MATCHED THEN
        INSERT (website_id, user_id, day, total_checks, online_checks, offline_checks, 
                issue_count, has_issues, avg_response_time, min_response_time, max_response_time, aggregated_at)
        VALUES (source.website_id, source.user_id, source.day, source.total_checks, source.online_checks, 
                source.offline_checks, source.issue_count, source.has_issues, source.avg_response_time,
                source.min_response_time, source.max_response_time, source.aggregated_at)
    `;

    const params = {
      dayStart,
      dayEnd,
    };

    const [job] = await bigquery.createQueryJob({ query, params });
    const [metadata] = await job.getMetadata();
    const rowsAffected = Number(metadata.statistics?.query?.numDmlAffectedRows || 0);

    logger.info(`Daily summary aggregation completed for ${dayStart.toISOString().split('T')[0]}: ${rowsAffected} rows upserted`);
    return rowsAffected;
  } catch (error) {
    logger.error('Error aggregating daily summaries:', error);
    throw error;
  }
};

/**
 * Query pre-aggregated daily summaries for a website.
 * Falls back to real-time aggregation if pre-aggregated data is not available.
 * 
 * @param websiteId - The website ID to query
 * @param userId - The user ID
 * @param startDate - Start of the date range (timestamp)
 * @param endDate - End of the date range (timestamp)
 * @returns Array of daily summaries
 */
export const getPreAggregatedDailySummary = async (
  websiteId: string,
  userId: string,
  startDate: number,
  endDate: number
): Promise<DailySummary[]> => {
  try {
    await ensureDailySummaryTableSchema();

    const query = `
      SELECT
        day,
        total_checks,
        issue_count,
        has_issues,
        avg_response_time
      FROM \`${bigquery.projectId}.${DATASET_ID}.${DAILY_SUMMARY_TABLE_ID}\`
      WHERE website_id = @websiteId
        AND user_id = @userId
        AND day >= DATE(@startDate)
        AND day <= DATE(@endDate)
      ORDER BY day ASC
    `;

    const params = {
      websiteId,
      userId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    };

    const [rows] = await bigquery.query({ query, params });

    if (rows.length === 0) {
      // No pre-aggregated data available, fall back to real-time aggregation
      logger.info(`No pre-aggregated data for website ${websiteId}, falling back to real-time aggregation`);
      return getCheckHistoryDailySummary(websiteId, userId, startDate, endDate);
    }

    return rows.map((row: { 
      day: { value?: string } | Date | string; 
      total_checks?: number; 
      issue_count?: number; 
      has_issues?: boolean;
      avg_response_time?: number | null;
    }) => {
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
      const hasIssues = row.has_issues ?? issueCount > 0;
      const avgResponseTime = row.avg_response_time != null && Number.isFinite(Number(row.avg_response_time)) 
        ? Number(row.avg_response_time) 
        : undefined;

      return {
        day: dayDate,
        hasIssues,
        totalChecks,
        issueCount,
        avgResponseTime,
      };
    });
  } catch (error) {
    // If the table doesn't exist or query fails, fall back to real-time aggregation
    logger.warn('Pre-aggregated daily summary query failed, falling back to real-time:', error);
    return getCheckHistoryDailySummary(websiteId, userId, startDate, endDate);
  }
};

// Delay between backfill operations to avoid BigQuery DML rate limits (20 concurrent DML statements)
const BACKFILL_DELAY_MS = 3000; // 3 seconds between days

/**
 * Backfill pre-aggregated daily summaries for a date range.
 * Useful for initial setup or when re-aggregating historical data.
 * 
 * @param startDate - Start date for backfill
 * @param endDate - End date for backfill (defaults to yesterday)
 */
export const backfillDailySummaries = async (
  startDate: Date,
  endDate?: Date
): Promise<{ daysProcessed: number; totalRows: number }> => {
  const end = endDate || new Date(Date.now() - 24 * 60 * 60 * 1000);
  let currentDate = new Date(startDate);
  let daysProcessed = 0;
  let totalRows = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  while (currentDate <= end) {
    try {
      const rows = await aggregateDailySummaries(currentDate);
      totalRows += rows;
      daysProcessed++;
      consecutiveErrors = 0; // Reset on success
      logger.info(`Backfill: processed ${currentDate.toISOString().split('T')[0]} (${rows} rows)`);
    } catch (error) {
      consecutiveErrors++;
      logger.error(`Backfill failed for ${currentDate.toISOString().split('T')[0]}:`, error);
      
      // If we hit too many consecutive errors, wait longer
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.warn(`Too many consecutive errors (${consecutiveErrors}), waiting 30s before retry...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
        consecutiveErrors = 0;
      }
    }

    // Move to next day
    currentDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000);
    
    // Add delay between days to avoid DML rate limits
    if (currentDate <= end) {
      await new Promise(resolve => setTimeout(resolve, BACKFILL_DELAY_MS));
    }
  }

  logger.info(`Backfill completed: ${daysProcessed} days, ${totalRows} total rows`);
  return { daysProcessed, totalRows };
};
