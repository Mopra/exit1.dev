// functions/src/badge-analytics.ts
// Lightweight BigQuery analytics for badge views.
// Uses a simple buffer that flushes periodically to avoid per-request inserts.

import { BigQuery } from '@google-cloud/bigquery';
import * as logger from 'firebase-functions/logger';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });
const DATASET_ID = 'checks';
const TABLE_ID = 'badge_views';

const FLUSH_INTERVAL_MS = 10_000; // flush every 10s
const MAX_BUFFER_SIZE = 500;

interface BadgeViewRow {
  check_id: string;
  user_id: string;
  badge_type: string;
  referrer: string | null;
  user_agent: string | null;
  client_ip: string;
  embed: boolean;
  timestamp: Date;
}

const SCHEMA = [
  { name: 'check_id', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'user_id', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'badge_type', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'referrer', type: 'STRING', mode: 'NULLABLE' as const },
  { name: 'user_agent', type: 'STRING', mode: 'NULLABLE' as const },
  { name: 'client_ip', type: 'STRING', mode: 'REQUIRED' as const },
  { name: 'embed', type: 'BOOLEAN', mode: 'REQUIRED' as const },
  { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' as const },
];

// ---------------------------------------------------------------------------
// Table creation (once per instance)
// ---------------------------------------------------------------------------
let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;

  const dataset = bigquery.dataset(DATASET_ID);
  const table = dataset.table(TABLE_ID);

  try {
    const [exists] = await table.exists();
    if (!exists) {
      await table.create({
        schema: { fields: SCHEMA },
        timePartitioning: {
          type: 'DAY',
          field: 'timestamp',
          expirationMs: 90 * 24 * 60 * 60 * 1000, // 90 days retention
        },
        clustering: { fields: ['user_id', 'check_id'] },
      });
      logger.info(`Created badge analytics table: ${DATASET_ID}.${TABLE_ID}`);
    }
    tableReady = true;
  } catch (e) {
    logger.warn('Badge analytics table ensure failed', {
      error: (e as Error)?.message ?? String(e),
    });
  }
}

// ---------------------------------------------------------------------------
// Buffer & flush
// ---------------------------------------------------------------------------
const buffer: BadgeViewRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBadgeViews().catch((err) =>
      logger.warn('Badge analytics flush failed', { error: (err as Error)?.message ?? String(err) })
    );
  }, FLUSH_INTERVAL_MS);
}

export async function flushBadgeViews(): Promise<void> {
  if (buffer.length === 0) return;

  const rows = buffer.splice(0, buffer.length);
  try {
    await ensureTable();
    const table = bigquery.dataset(DATASET_ID).table(TABLE_ID);
    await table.insert(rows);
  } catch (err: unknown) {
    const e = err as { name?: string; errors?: unknown[] };
    // Log but don't re-throw — badge analytics should never break badge serving
    if (e.name === 'PartialFailureError') {
      logger.warn(`Badge analytics: ${(e.errors ?? []).length} rows failed to insert`);
    } else {
      logger.warn('Badge analytics insert failed', {
        error: (err as Error)?.message ?? String(err),
        rowCount: rows.length,
      });
    }
  }
}

export function trackBadgeView(params: {
  checkId: string;
  userId: string;
  badgeType: string;
  referrer: string | null;
  userAgent: string | null;
  clientIp: string;
  embed: boolean;
}): void {
  buffer.push({
    check_id: params.checkId,
    user_id: params.userId,
    badge_type: params.badgeType,
    referrer: params.referrer ? params.referrer.slice(0, 512) : null,
    user_agent: params.userAgent ? params.userAgent.slice(0, 512) : null,
    client_ip: params.clientIp,
    embed: params.embed,
    timestamp: new Date(),
  });

  if (buffer.length >= MAX_BUFFER_SIZE) {
    flushBadgeViews().catch(() => {});
  } else {
    scheduleFlush();
  }
}
