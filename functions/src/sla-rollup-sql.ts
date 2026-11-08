// ============================================================================
// SLA ROLLUP SQL (pure)
//
// The BigQuery side of SLA reporting: the check_sla_daily schema, the MERGE
// that builds one UTC day of it from check_history_new, and the read used to
// refresh period docs. Kept free of the BigQuery client so the SQL and its
// parameters can be unit-tested and dry-run from a script.
//
// Every query here has a lower time bound (cost rule): the rollup reads
// [dayStart - 2 days, cut), the report read is bounded by day.
// See docs/plans/sla-reporting.md, sections 3.4, 4.3 and 4.4.
// ============================================================================

import { WAF_BLOCK_ERROR_PREFIXES } from "./public-monitor-blocked";
import { SLA_ROLLUP_VERSION } from "./sla-math";

export const SLA_DATASET_ID = "checks";
export const SLA_TABLE_ID = "check_sla_daily";
export const SLA_HISTORY_TABLE = "`exit1-dev.checks.check_history_new`";
export const SLA_TABLE = "`exit1-dev.checks.check_sla_daily`";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A row's state lasts until the next row, but never longer than this. */
export const SLA_DEFAULT_CARRY_MS = 3 * HOUR_MS;

/** Same as check_daily_summaries: Pro retention, 3 years. */
export const SLA_TABLE_EXPIRATION_MS = 1095 * DAY_MS;

export const SLA_DAILY_SCHEMA = [
  { name: "website_id", type: "STRING", mode: "REQUIRED" },
  { name: "user_id", type: "STRING", mode: "REQUIRED" },
  { name: "day", type: "DATE", mode: "REQUIRED" },
  { name: "covered_to_ms", type: "INT64", mode: "REQUIRED" },
  { name: "up_ms", type: "INT64", mode: "REQUIRED" },
  { name: "down_ms", type: "INT64", mode: "REQUIRED" },
  { name: "maintenance_ms", type: "INT64", mode: "REQUIRED" },
  { name: "blocked_ms", type: "INT64", mode: "REQUIRED" },
  { name: "no_data_ms", type: "INT64", mode: "REQUIRED" },
  {
    name: "segments",
    type: "RECORD",
    mode: "REPEATED",
    fields: [
      { name: "state", type: "STRING", mode: "NULLABLE" },
      { name: "start_ms", type: "INT64", mode: "NULLABLE" },
      { name: "end_ms", type: "INT64", mode: "NULLABLE" },
    ],
  },
  { name: "carry_ms", type: "INT64", mode: "NULLABLE" },
  { name: "rollup_version", type: "INT64", mode: "NULLABLE" },
  { name: "computed_at", type: "TIMESTAMP", mode: "NULLABLE" },
];

/**
 * Carry limit for one check. Daily or hourly checks write a row per probe, so
 * a 3 h carry would show most of their day as no_data.
 */
export function carryMsForFrequency(checkFrequencyMinutes: unknown): number {
  const f = typeof checkFrequencyMinutes === "number" && Number.isFinite(checkFrequencyMinutes) ? checkFrequencyMinutes : 0;
  return Math.max(SLA_DEFAULT_CARRY_MS, Math.round(2 * f * 60_000));
}

/**
 * The per-day classification and segment build, as a SELECT. Wrapped in a
 * MERGE by buildRollupMergeSql; run alone for dry runs.
 */
export function buildRollupSelectSql(): string {
  return `
  WITH
  range_rows AS (
    SELECT website_id, user_id, timestamp, status, confirmed, maintenance, error
    FROM ${SLA_HISTORY_TABLE}
    WHERE timestamp >= @dayStart AND timestamp < @cut
      # check_sla_daily keys are REQUIRED; history has a few NULL website_id
      # rows (2026-01-06), which would fail the MERGE insert.
      AND website_id IS NOT NULL AND user_id IS NOT NULL
  ),
  prior_rows AS (
    # Seed: the last row before the day. The lower bound is mandatory (cost rule).
    SELECT website_id, user_id, timestamp, status, confirmed, maintenance, error
    FROM ${SLA_HISTORY_TABLE}
    WHERE timestamp >= TIMESTAMP_SUB(@dayStart, INTERVAL 2 DAY) AND timestamp < @dayStart
      AND website_id IS NOT NULL AND user_id IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY website_id, user_id ORDER BY timestamp DESC) = 1
  ),
  # confirmed, maintenance and error must be projected through every CTE that
  # feeds the classifier, or BigQuery fails with "Unrecognized name".
  seeded AS (
    SELECT website_id, user_id, timestamp AS row_ts, timestamp AS start_ts, status, confirmed, maintenance, error FROM range_rows
    UNION ALL
    SELECT website_id, user_id, timestamp AS row_ts, @dayStart AS start_ts, status, confirmed, maintenance, error FROM prior_rows
  ),
  classified AS (
    SELECT s.website_id, s.user_id, s.start_ts, s.row_ts,
      COALESCE(c.carry_ms, @defaultCarryMs) AS carry_ms,
      CASE
        WHEN COALESCE(s.maintenance, FALSE) THEN 'maintenance'
        WHEN LOWER(s.status) = 'disabled' THEN 'no_data'
        WHEN LOWER(s.status) IN ('offline', 'down', 'reachable_with_error')
             AND EXISTS(SELECT 1 FROM UNNEST(@wafPrefixes) p WHERE STARTS_WITH(COALESCE(s.error, ''), p)) THEN 'blocked'
        WHEN LOWER(s.status) IN ('offline', 'down', 'reachable_with_error')
             AND COALESCE(s.confirmed, TRUE) THEN 'down'
        ELSE 'up'
      END AS state,
      LEAD(s.start_ts) OVER (PARTITION BY s.website_id, s.user_id ORDER BY s.start_ts, s.row_ts) AS next_ts
    FROM seeded s
    LEFT JOIN UNNEST(@carry) c ON c.website_id = s.website_id
  ),
  raw_segs AS (
    SELECT website_id, user_id, state, start_ts, carry_ms,
      # A seed whose carry ran out before the day starts covers nothing.
      GREATEST(start_ts, LEAST(COALESCE(next_ts, @cut), @cut, TIMESTAMP_ADD(row_ts, INTERVAL carry_ms MILLISECOND))) AS end_ts,
      LEAST(COALESCE(next_ts, @cut), @cut) AS gap_end
    FROM classified
  ),
  # Leading gap: no seed row, so the time before the first row is no_data.
  # Without it uncovered time is invisible and sub-day windows are wrong.
  # Aggregated in a subquery on purpose: with start_ts aliased in the same
  # SELECT, HAVING MIN(start_ts) would resolve to the alias and never fire.
  leading AS (
    SELECT website_id, user_id, 'no_data' AS state, @dayStart AS start_ts, first_ts AS end_ts, carry_ms
    FROM (
      SELECT website_id, user_id, MIN(start_ts) AS first_ts, ANY_VALUE(carry_ms) AS carry_ms
      FROM raw_segs
      GROUP BY website_id, user_id
    )
    WHERE first_ts > @dayStart
  ),
  with_gaps AS (
    SELECT website_id, user_id, state, start_ts, end_ts, carry_ms FROM raw_segs WHERE end_ts > start_ts
    UNION ALL
    SELECT website_id, user_id, 'no_data' AS state, end_ts AS start_ts, gap_end AS end_ts, carry_ms FROM raw_segs WHERE gap_end > end_ts
    UNION ALL
    SELECT website_id, user_id, state, start_ts, end_ts, carry_ms FROM leading
  ),
  islands AS (
    SELECT *, COUNTIF(prev_state IS NULL OR state != prev_state OR start_ts != prev_end)
      OVER (PARTITION BY website_id, user_id ORDER BY start_ts, end_ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS island
    FROM (
      SELECT *, LAG(state) OVER w AS prev_state, LAG(end_ts) OVER w AS prev_end
      FROM with_gaps WINDOW w AS (PARTITION BY website_id, user_id ORDER BY start_ts, end_ts)
    )
  ),
  merged AS (
    SELECT website_id, user_id, state, ANY_VALUE(carry_ms) AS carry_ms, MIN(start_ts) AS s, MAX(end_ts) AS e
    FROM islands GROUP BY website_id, user_id, state, island
  )
  SELECT website_id, user_id, DATE(@dayStart) AS day,
    UNIX_MILLIS(@cut) AS covered_to_ms,
    SUM(IF(state = 'up',          UNIX_MILLIS(e) - UNIX_MILLIS(s), 0)) AS up_ms,
    SUM(IF(state = 'down',        UNIX_MILLIS(e) - UNIX_MILLIS(s), 0)) AS down_ms,
    SUM(IF(state = 'maintenance', UNIX_MILLIS(e) - UNIX_MILLIS(s), 0)) AS maintenance_ms,
    SUM(IF(state = 'blocked',     UNIX_MILLIS(e) - UNIX_MILLIS(s), 0)) AS blocked_ms,
    SUM(IF(state = 'no_data',     UNIX_MILLIS(e) - UNIX_MILLIS(s), 0)) AS no_data_ms,
    IFNULL(
      ARRAY_AGG(IF(state != 'up', STRUCT(state, UNIX_MILLIS(s) AS start_ms, UNIX_MILLIS(e) AS end_ms), NULL) IGNORE NULLS ORDER BY s),
      ARRAY<STRUCT<state STRING, start_ms INT64, end_ms INT64>>[]
    ) AS segments,
    ANY_VALUE(carry_ms) AS carry_ms,
    @rollupVersion AS rollup_version,
    CURRENT_TIMESTAMP() AS computed_at
  FROM merged
  GROUP BY website_id, user_id`;
}

export function buildRollupMergeSql(): string {
  return `
MERGE ${SLA_TABLE} AS target
USING (${buildRollupSelectSql()}
) AS source
ON target.day = DATE(@dayStart)
   AND target.website_id = source.website_id AND target.user_id = source.user_id AND target.day = source.day
WHEN MATCHED THEN UPDATE SET
  covered_to_ms = source.covered_to_ms,
  up_ms = source.up_ms, down_ms = source.down_ms, maintenance_ms = source.maintenance_ms,
  blocked_ms = source.blocked_ms, no_data_ms = source.no_data_ms, segments = source.segments,
  carry_ms = source.carry_ms, rollup_version = source.rollup_version, computed_at = source.computed_at
WHEN NOT MATCHED THEN INSERT ROW`;
}

export interface CarryEntry {
  website_id: string;
  carry_ms: number;
}

/** Query parameters and their types for one day of the rollup. */
export function rollupParams(dayStartMs: number, cutMs: number, carry: CarryEntry[]) {
  if (dayStartMs % DAY_MS !== 0) throw new Error("dayStart must be a UTC midnight");
  if (cutMs <= dayStartMs || cutMs > dayStartMs + DAY_MS) throw new Error("cut must fall inside the day");
  return {
    params: {
      dayStart: new Date(dayStartMs),
      cut: new Date(cutMs),
      defaultCarryMs: SLA_DEFAULT_CARRY_MS,
      wafPrefixes: [...WAF_BLOCK_ERROR_PREFIXES],
      rollupVersion: SLA_ROLLUP_VERSION,
      carry,
    },
    types: {
      dayStart: "TIMESTAMP",
      cut: "TIMESTAMP",
      defaultCarryMs: "INT64",
      wafPrefixes: ["STRING"],
      rollupVersion: "INT64",
      carry: [{ website_id: "STRING", carry_ms: "INT64" }],
    },
  };
}

/** Report refresh read. day bounds are mandatory (cost rule). */
export function buildReportRowsSql(): string {
  return `
SELECT website_id, FORMAT_DATE('%F', day) AS day, covered_to_ms, segments
FROM ${SLA_TABLE}
WHERE website_id IN UNNEST(@ids)
  AND day >= @firstDay
  AND day <= @lastDay`;
}
