// ============================================================================
// SLA ROLLUP (VPS cron `slaRollup`, 02:10, 08:10, 14:10, 20:10 UTC)
//
// 1. Builds checks.check_sla_daily from check_history_new: complete days that
//    are at least 2 h old and not yet complete, then today up to the run's
//    cut. One MERGE per day.
// 2. Records the cut as `dataThrough` in system_settings/sla_rollup.
// 3. Refreshes every Pro report's open month (and finalizes the month that
//    just ended) in its own time zone, from one read of check_sla_daily.
//
// Imported by the VPS runner (vps/src/cron.ts), so no Cloud Function
// definitions here. See docs/plans/sla-reporting.md, section 4.
//
// Cost (dry runs, see the commit message): ~36 MB per complete day and ~27 MB
// per partial day of check_history_new, ~15 MB per refresh read.
// ============================================================================

import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { createBigQuery } from "./bigquery-client";
import {
  SLA_DAILY_SCHEMA,
  SLA_DATASET_ID,
  SLA_TABLE_EXPIRATION_MS,
  SLA_TABLE_ID,
  buildRollupMergeSql,
  buildRollupSelectSql,
  carryMsForFrequency,
  rollupParams,
  type CarryEntry,
} from "./sla-rollup-sql";
import { utcDay, utcDayStart } from "./sla-time";
import { SLA_DAY_COMPLETE_MARGIN_MS, periodsToRefresh, planRollupDays } from "./sla-rollup-plan";
import { isPeriodFinal } from "./sla-math";
import {
  computeAndWritePeriods,
  ownerHasSlaReporting,
  readRollupSettings,
  resolveReportChecks,
  type PeriodJob,
} from "./sla-snapshot";
import type { OwnerCheck } from "./sla-reports-policy";
import {
  SLA_REPORTS_COLLECTION,
  SLA_ROLLUP_SETTINGS_DOC,
  type SlaReportDoc,
  type SlaRollupSettings,
} from "./sla-types";

const bigquery = createBigQuery();

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

let tableReady = false;

/** Create check_sla_daily if it does not exist. Partitioned by day, clustered by user and check. */
export async function ensureSlaDailyTableSchema(): Promise<void> {
  if (tableReady) return;
  const table = bigquery.dataset(SLA_DATASET_ID).table(SLA_TABLE_ID);
  const [exists] = await table.exists();
  if (!exists) {
    await table.create({
      schema: { fields: SLA_DAILY_SCHEMA },
      timePartitioning: { type: "DAY", field: "day", expirationMs: String(SLA_TABLE_EXPIRATION_MS) },
      clustering: { fields: ["user_id", "website_id"] },
    });
    logger.info(`Created SLA table ${SLA_DATASET_ID}.${SLA_TABLE_ID}`);
  }
  tableReady = true;
}

/**
 * Checks slower than hourly get a longer carry. One Firestore query over the
 * few hundred checks with checkFrequency > 60.
 */
export async function buildCarryList(): Promise<CarryEntry[]> {
  const snap = await firestore.collection("checks").where("checkFrequency", ">", 60).select("checkFrequency").get();
  return snap.docs.map((d) => ({ website_id: d.id, carry_ms: carryMsForFrequency(d.get("checkFrequency")) }));
}

export interface RollupDayResult {
  day: string;
  cutMs: number;
  bytesBilled: number;
  bytesProcessed: number;
  rows: number | null;
}

/**
 * Roll up one UTC day into check_sla_daily, covering [dayStart, cut).
 * dryRun runs the SELECT half as a dry run (no table needed, nothing billed).
 */
export async function rollupSlaDay(
  dayStartMs: number,
  cutMs: number,
  carry: CarryEntry[],
  opts: { dryRun?: boolean } = {},
): Promise<RollupDayResult> {
  const { params, types } = rollupParams(dayStartMs, cutMs, carry);
  const day = utcDay(dayStartMs);
  if (opts.dryRun) {
    const [job] = await bigquery.createQueryJob({ query: buildRollupSelectSql(), params, types, dryRun: true });
    const processed = Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
    return { day, cutMs, bytesBilled: 0, bytesProcessed: processed, rows: null };
  }
  await ensureSlaDailyTableSchema();
  const [job] = await bigquery.createQueryJob({ query: buildRollupMergeSql(), params, types });
  await job.getQueryResults();
  const [meta] = await job.getMetadata();
  const stats = meta?.statistics?.query ?? {};
  const result: RollupDayResult = {
    day,
    cutMs,
    bytesBilled: Number(stats.totalBytesBilled ?? 0),
    bytesProcessed: Number(stats.totalBytesProcessed ?? 0),
    rows: stats.numDmlAffectedRows !== undefined ? Number(stats.numDmlAffectedRows) : null,
  };
  logger.info("[sla] rollup day", result);
  return result;
}

export interface SlaRollupResult {
  days: RollupDayResult[];
  dataThrough: number;
  reports: number;
  periods: number;
  refreshBytesBilled: number;
}

/** The whole cron job. */
export async function runSlaRollup(nowMs: number = Date.now()): Promise<SlaRollupResult> {
  const cutMs = Math.floor(nowMs / MIN_MS) * MIN_MS;
  const settings = await readRollupSettings();
  const plan = planRollupDays(cutMs, settings?.completeThrough ?? null);
  const carry = await buildCarryList();

  // Sequential, and a failure throws before dataThrough moves, so dataThrough
  // never claims time a row does not cover.
  const days: RollupDayResult[] = [];
  let completeThrough = settings?.completeThrough ?? null;
  let stillComplete = true;
  for (const d of plan) {
    days.push(await rollupSlaDay(d.dayStartMs, d.cutMs, carry));
    stillComplete = stillComplete && d.complete;
    if (stillComplete) completeThrough = utcDay(d.dayStartMs);
  }

  const next: SlaRollupSettings = { dataThrough: cutMs, ranAt: Date.now(), completeThrough };
  await firestore.doc(SLA_ROLLUP_SETTINGS_DOC).set(next, { merge: true });

  const refresh = await refreshAllSlaReports(cutMs, nowMs);
  const rollupBytes = days.reduce((s, d) => s + d.bytesBilled, 0);
  logger.info("[sla] rollup done", {
    days: days.map((d) => d.day),
    rollupBytesBilled: rollupBytes,
    refreshBytesBilled: refresh.bytesBilled,
    reports: refresh.reports,
    periods: refresh.periods,
  });
  return { days, dataThrough: cutMs, reports: refresh.reports, periods: refresh.periods, refreshBytesBilled: refresh.bytesBilled };
}

/** Steps 5 to 7 of the plan: refresh every Pro report from one rollup read. */
export async function refreshAllSlaReports(
  dataThroughMs: number,
  nowMs: number = Date.now(),
): Promise<{ reports: number; periods: number; bytesBilled: number }> {
  const snap = await firestore.collection(SLA_REPORTS_COLLECTION).get();
  if (snap.empty) return { reports: 0, periods: 0, bytesBilled: 0 };

  const proByOwner = new Map<string, Promise<boolean>>();
  const ownerChecks = new Map<string, Promise<OwnerCheck[]>>();
  const jobs: PeriodJob[] = [];
  const finalizing: Array<{ reportId: string; period: string }> = [];

  for (const doc of snap.docs) {
    const report = doc.data() as SlaReportDoc;
    if (!report.userId || !report.timezone) continue;
    let pro = proByOwner.get(report.userId);
    if (!pro) {
      pro = ownerHasSlaReporting(report.userId).catch(() => false);
      proByOwner.set(report.userId, pro);
    }
    if (!(await pro)) continue;

    let resolved;
    try {
      resolved = await resolveReportChecks(report, ownerChecks);
    } catch (err) {
      logger.warn("[sla] could not resolve report checks", { reportId: doc.id, error: String(err) });
      continue;
    }
    if (resolved.truncated) logger.warn("[sla] report scope truncated to the check cap", { reportId: doc.id });

    for (const period of periodsToRefresh(report, dataThroughMs)) {
      jobs.push({ reportId: doc.id, report, period, checks: resolved.checks });
      if (isPeriodFinal(period, report.timezone, dataThroughMs)) finalizing.push({ reportId: doc.id, period });
    }
  }

  const { bytesBilled } = await computeAndWritePeriods(jobs, dataThroughMs, { nowMs });

  // Remember finalized months so later runs stop recomputing them.
  for (const f of finalizing) {
    await firestore.collection(SLA_REPORTS_COLLECTION).doc(f.reportId).update({ lastFinalPeriod: f.period });
  }

  return { reports: new Set(jobs.map((j) => j.reportId)).size, periods: jobs.length, bytesBilled };
}

/**
 * One-off backfill: complete days from startDay to endDay inclusive
 * ('YYYY-MM-DD'). At most 31 days per call; run it in chunks. dryRun only
 * dry-runs the SELECT and reports bytes.
 */
export async function backfillSlaRollup(
  startDay: string,
  endDay: string,
  opts: { dryRun?: boolean; nowMs?: number } = {},
): Promise<{ days: RollupDayResult[]; bytesBilled: number; bytesProcessed: number }> {
  const start = utcDayStart(startDay);
  const end = utcDayStart(endDay);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("startDay and endDay must be YYYY-MM-DD, start <= end");
  if ((end - start) / DAY_MS + 1 > 31) throw new Error("Backfill at most 31 days per call");
  const now = opts.nowMs ?? Date.now();
  if (end + DAY_MS + SLA_DAY_COMPLETE_MARGIN_MS > now) throw new Error("endDay must be a complete day at least 2 hours old");

  const carry = await buildCarryList();
  const days: RollupDayResult[] = [];
  for (let d = start; d <= end; d += DAY_MS) {
    days.push(await rollupSlaDay(d, d + DAY_MS, carry, { dryRun: opts.dryRun }));
  }
  return {
    days,
    bytesBilled: days.reduce((s, d) => s + d.bytesBilled, 0),
    bytesProcessed: days.reduce((s, d) => s + d.bytesProcessed, 0),
  };
}
