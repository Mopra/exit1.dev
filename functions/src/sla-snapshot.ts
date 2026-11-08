// ============================================================================
// SLA SNAPSHOT: report checks, the rollup read, and period doc writes.
//
// Shared by the VPS cron (sla-rollup.ts, all Pro reports in one query) and
// the on-demand callable (sla-reports.ts, one report). The UI, email, public
// API and MCP only ever read the period docs written here.
//
// Imported by the VPS runner through sla-rollup.ts, so no Cloud Function
// definitions in this module.
// ============================================================================

import * as logger from "firebase-functions/logger";
import { firestore, getUserTier } from "./init";
import { TIER_LIMITS } from "./config";
import { createBigQuery } from "./bigquery-client";
import { buildReportRowsSql } from "./sla-rollup-sql";
import { computePeriod, type SlaCheckInput, type SlaDailyRow, type SlaSegmentState } from "./sla-math";
import { periodBounds, utcDay } from "./sla-time";
import { selectReportChecks, type OwnerCheck } from "./sla-reports-policy";
import {
  SLA_PERIODS_SUBCOLLECTION,
  SLA_REPORTS_COLLECTION,
  SLA_ROLLUP_SETTINGS_DOC,
  type SlaPeriodDoc,
  type SlaReportDoc,
  type SlaRollupSettings,
} from "./sla-types";

const bigquery = createBigQuery();

export async function readRollupSettings(): Promise<SlaRollupSettings | null> {
  const snap = await firestore.doc(SLA_ROLLUP_SETTINGS_DOC).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<SlaRollupSettings>;
  return typeof data.dataThrough === "number" ? (data as SlaRollupSettings) : null;
}

/** SLA reporting is gated on the account owner's tier at runtime. */
export async function ownerHasSlaReporting(ownerUid: string): Promise<boolean> {
  const tier = await getUserTier(ownerUid);
  return TIER_LIMITS[tier]?.slaReporting === true;
}

function toOwnerCheck(id: string, data: Record<string, unknown>): OwnerCheck {
  return {
    id,
    userId: typeof data.userId === "string" ? data.userId : "",
    name: typeof data.name === "string" ? data.name : null,
    url: typeof data.url === "string" ? data.url : "",
    folder: typeof data.folder === "string" ? data.folder : null,
    type: typeof data.type === "string" ? data.type : null,
    createdAt: typeof data.createdAt === "number" ? data.createdAt : null,
  };
}

const CHECK_FIELDS = ["userId", "name", "url", "folder", "type", "createdAt"];

/** All of an owner's checks (only the fields SLA needs). One query. */
export async function loadOwnerChecks(ownerUid: string): Promise<OwnerCheck[]> {
  const snap = await firestore.collection("checks").where("userId", "==", ownerUid).select(...CHECK_FIELDS).get();
  return snap.docs.map((d) => toOwnerCheck(d.id, d.data()));
}

/** Explicit checks by id; missing ones come back absent. */
export async function loadChecksById(ids: string[]): Promise<OwnerCheck[]> {
  const out: OwnerCheck[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map((id) => firestore.collection("checks").doc(id));
    if (refs.length === 0) continue;
    const snaps = await firestore.getAll(...refs, { fieldMask: CHECK_FIELDS });
    for (const s of snaps) if (s.exists) out.push(toOwnerCheck(s.id, s.data() ?? {}));
  }
  return out;
}

/**
 * The checks a report covers right now. Folder reports need the owner's full
 * check list; pass `ownerChecksCache` to share it across one owner's reports.
 */
export async function resolveReportChecks(
  report: Pick<SlaReportDoc, "userId" | "checkIds" | "folderPaths">,
  ownerChecksCache?: Map<string, Promise<OwnerCheck[]>>,
): Promise<{ checks: SlaCheckInput[]; truncated: boolean }> {
  let pool: OwnerCheck[];
  if ((report.folderPaths ?? []).length > 0) {
    let pending = ownerChecksCache?.get(report.userId);
    if (!pending) {
      pending = loadOwnerChecks(report.userId);
      ownerChecksCache?.set(report.userId, pending);
    }
    pool = await pending;
  } else {
    pool = await loadChecksById(report.checkIds ?? []);
  }
  return selectReportChecks(report, pool);
}

/**
 * One read of check_sla_daily for a set of checks and UTC days.
 * Cost: ~0.5 MB of table per day of history, so a month of all Pro checks is
 * ~15 MB (10 MB minimum per table).
 */
export async function loadSlaRows(
  ids: string[],
  firstDay: string,
  lastDay: string,
): Promise<{ rows: SlaDailyRow[]; bytesBilled: number }> {
  if (ids.length === 0) return { rows: [], bytesBilled: 0 };
  const [job] = await bigquery.createQueryJob({
    query: buildReportRowsSql(),
    params: { ids, firstDay, lastDay },
    types: { ids: ["STRING"], firstDay: "DATE", lastDay: "DATE" },
  });
  const [raw] = await job.getQueryResults();
  const [meta] = await job.getMetadata();
  const bytesBilled = Number(meta?.statistics?.query?.totalBytesBilled ?? 0);
  const rows: SlaDailyRow[] = (raw as Array<Record<string, unknown>>).map((r) => ({
    checkId: String(r.website_id),
    day: String(r.day),
    coveredToMs: Number(r.covered_to_ms),
    segments: ((r.segments as Array<Record<string, unknown>> | null) ?? []).map((s) => ({
      state: String(s.state) as SlaSegmentState,
      startMs: Number(s.start_ms),
      endMs: Number(s.end_ms),
    })),
  }));
  return { rows, bytesBilled };
}

export interface PeriodJob {
  reportId: string;
  report: SlaReportDoc;
  period: string;
  checks: SlaCheckInput[];
}

export function periodDocRef(reportId: string, period: string) {
  return firestore.collection(SLA_REPORTS_COLLECTION).doc(reportId).collection(SLA_PERIODS_SUBCOLLECTION).doc(period);
}

/**
 * Compute and write a batch of period docs from ONE rollup read covering all
 * of them. Writes merge, so a sentRecord already on the doc survives.
 */
export async function computeAndWritePeriods(
  jobs: PeriodJob[],
  dataThroughMs: number,
  opts: { nowMs?: number; previousTimezones?: Map<string, string> } = {},
): Promise<{ docs: Map<string, SlaPeriodDoc>; bytesBilled: number }> {
  const docs = new Map<string, SlaPeriodDoc>();
  if (jobs.length === 0) return { docs, bytesBilled: 0 };
  const now = opts.nowMs ?? Date.now();

  const ids = new Set<string>();
  let first = Infinity;
  let last = -Infinity;
  for (const job of jobs) {
    const { startMs, endMs } = periodBounds(job.period, job.report.timezone);
    first = Math.min(first, startMs);
    last = Math.max(last, Math.min(endMs, dataThroughMs) - 1);
    for (const c of job.checks) ids.add(c.checkId);
  }
  const { rows, bytesBilled } = last >= first
    ? await loadSlaRows([...ids], utcDay(first), utcDay(last))
    : { rows: [], bytesBilled: 0 };

  const rowsByCheck = new Map<string, SlaDailyRow[]>();
  for (const r of rows) {
    const list = rowsByCheck.get(r.checkId);
    if (list) list.push(r);
    else rowsByCheck.set(r.checkId, [r]);
  }

  let batch = firestore.batch();
  let pending = 0;
  for (const job of jobs) {
    const jobRows = job.checks.flatMap((c) => rowsByCheck.get(c.checkId) ?? []);
    const computed = computePeriod({
      period: job.period,
      timezone: job.report.timezone,
      targetPercent: job.report.targetPercent,
      countBlockedAsDown: job.report.countBlockedAsDown === true,
      checks: job.checks,
      rows: jobRows,
      dataThroughMs,
    });
    const key = `${job.reportId}/${job.period}`;
    const previousTimezone = opts.previousTimezones?.get(key) ?? null;
    const doc: SlaPeriodDoc = {
      ...computed,
      userId: job.report.userId,
      reportId: job.reportId,
      computedAt: now,
      ...(previousTimezone ? { previousTimezone } : {}),
    };
    docs.set(key, doc);
    batch.set(periodDocRef(job.reportId, job.period), doc, { merge: true });
    // Period docs run to ~120 KB; keep each batch well under the 10 MiB limit.
    if (++pending >= 40) {
      await batch.commit();
      batch = firestore.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();

  logger.info("[sla] period docs written", { periods: jobs.length, checks: ids.size, rows: rows.length, bytesBilled });
  return { docs, bytesBilled };
}
