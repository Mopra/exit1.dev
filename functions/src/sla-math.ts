// ============================================================================
// SLA MATH (pure)
//
// Turns check_sla_daily rows (one per check per UTC day, every non-up segment
// with exact timestamps) into the numbers of one SLA period in one time zone.
//
// Counting rules (docs/plans/sla-reporting.md, section 2.3):
//   availability = up / (up + down). Only confirmed down time burns budget.
//   Maintenance, WAF-blocked probes and no-data time are excluded from the
//   denominator and reported separately, with a coverage figure.
//
// Sub-window invariant of a row: [dayStart, coveredToMs) is fully described.
// Every instant there is inside exactly one segment (non-up) or up. Time after
// coveredToMs, and days with no row, are no_data.
// ============================================================================

import { SLA_FINALIZE_MARGIN_MS, localDayBounds, periodBounds, utcDay, utcDayStart } from "./sla-time";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bump when the classification rules change; stored on rows and period docs. */
export const SLA_ROLLUP_VERSION = 1;

/** Caps that keep a period doc well under Firestore's 1 MiB limit. */
export const SLA_MAX_INCIDENTS = 500;
export const SLA_MAX_EXCLUSIONS = 300;

/** A report or check with less measured time than this share is flagged. */
export const SLA_MIN_COVERAGE = 0.5;
/** MTD budget share at which a report turns "at risk". */
export const SLA_AT_RISK_BUDGET = 0.75;

export type SlaSegmentState = "down" | "maintenance" | "blocked" | "no_data";
export type SlaExclusionState = "maintenance" | "blocked" | "no_data";

export interface SlaSegment {
  state: SlaSegmentState;
  startMs: number;
  endMs: number;
}

export interface SlaDailyRow {
  checkId: string;
  /** UTC day, 'YYYY-MM-DD'. */
  day: string;
  coveredToMs: number;
  segments: SlaSegment[];
}

export interface SlaTotals {
  upMs: number;
  downMs: number;
  maintenanceMs: number;
  blockedMs: number;
  noDataMs: number;
}

export type SlaStatus = "met" | "breached" | "at_risk" | "on_track" | "no_data";

export interface SlaCheckInput {
  checkId: string;
  name: string;
  url: string;
  /** Check creation time; time before it is outside the span. */
  createdAtMs?: number | null;
  deleted?: boolean;
}

export interface SlaCheckResult extends SlaTotals {
  checkId: string;
  name: string;
  url: string;
  deleted?: boolean;
  availability: number | null;
  coverage: number;
  incidents: number;
  longestIncidentMs: number;
  status: SlaStatus;
  insufficientData: boolean;
}

export interface SlaOverall extends SlaTotals {
  availability: number | null;
  coverage: number;
  /** Allowed down time for the measured time so far. */
  budgetMs: number;
  /** downMs / budgetMs; can exceed 1. */
  budgetUsed: number;
  /** MTD: allowed down time for the whole month, projected. Equals budgetMs when final. */
  projectedBudgetMs: number;
  status: SlaStatus;
  insufficientData: boolean;
}

export interface SlaIncident {
  checkId: string;
  startMs: number;
  /** null while the incident is still ongoing at dataThrough. */
  endMs: number | null;
  durationMs: number;
}

export interface SlaExclusion {
  checkId: string;
  state: SlaExclusionState;
  startMs: number;
  endMs: number;
}

export interface SlaDailyEntry {
  /** Local day, 'YYYY-MM-DD'. */
  day: string;
  upMs: number;
  downMs: number;
  excludedMs: number;
}

export interface SlaPeriodComputation {
  period: string;
  timezone: string;
  status: "open" | "final";
  periodStart: number;
  periodEnd: number;
  dataThrough: number;
  rollupVersion: number;
  targetPercent: number;
  countBlockedAsDown: boolean;
  overall: SlaOverall;
  daily: SlaDailyEntry[];
  checks: SlaCheckResult[];
  incidents: SlaIncident[];
  incidentsTotal: number;
  exclusions: SlaExclusion[];
  exclusionsTotal: number;
}

const zeroTotals = (): SlaTotals => ({ upMs: 0, downMs: 0, maintenanceMs: 0, blockedMs: 0, noDataMs: 0 });

const overlap = (a: number, b: number, c: number, d: number): number => Math.max(0, Math.min(b, d) - Math.max(a, c));

function addState(t: SlaTotals, state: SlaSegmentState | "up", ms: number): void {
  if (ms <= 0) return;
  switch (state) {
    case "up": t.upMs += ms; break;
    case "down": t.downMs += ms; break;
    case "maintenance": t.maintenanceMs += ms; break;
    case "blocked": t.blockedMs += ms; break;
    case "no_data": t.noDataMs += ms; break;
  }
}

/**
 * Totals of one row inside the window [a, b). Only the part of the window the
 * row covers is counted; the caller treats the rest as no_data.
 */
export function windowFromRow(row: SlaDailyRow, a: number, b: number): SlaTotals & { coveredMs: number } {
  const dayStart = utcDayStart(row.day);
  const coveredEnd = Math.min(row.coveredToMs, dayStart + DAY_MS);
  const coveredMs = overlap(a, b, dayStart, coveredEnd);
  const t = zeroTotals();
  let nonUp = 0;
  for (const seg of row.segments) {
    const ms = overlap(a, b, Math.max(seg.startMs, dayStart), Math.min(seg.endMs, coveredEnd));
    addState(t, seg.state, ms);
    nonUp += ms;
  }
  t.upMs = Math.max(0, coveredMs - nonUp);
  return { ...t, coveredMs };
}

export interface CheckWindowOptions {
  countBlockedAsDown: boolean;
  createdAtMs?: number | null;
  /** Rows are trusted up to this instant; later time is outside the span. */
  dataThroughMs: number;
}

export interface CheckWindowResult extends SlaTotals {
  spanMs: number;
  /** Non-up segments inside the span, merged and in time order. */
  segments: SlaSegment[];
}

/** The part of [startMs, endMs) the check existed in and data is trusted for. */
export function checkSpan(startMs: number, endMs: number, opts: Pick<CheckWindowOptions, "createdAtMs" | "dataThroughMs">): { a: number; b: number } {
  const a = Math.max(startMs, typeof opts.createdAtMs === "number" && Number.isFinite(opts.createdAtMs) ? opts.createdAtMs : -Infinity);
  const b = Math.min(endMs, opts.dataThroughMs);
  return { a, b: Math.max(a, b) };
}

/**
 * Sum one check's states over [startMs, endMs). Missing days and time past a
 * row's coveredToMs count as no_data. Time before createdAt or after
 * dataThrough is outside the span and counts as nothing.
 */
export function aggregateCheck(
  rowsByDay: Map<string, SlaDailyRow>,
  startMs: number,
  endMs: number,
  opts: CheckWindowOptions,
): CheckWindowResult {
  const { a, b } = checkSpan(startMs, endMs, opts);
  const totals = zeroTotals();
  const segments: SlaSegment[] = [];
  if (b <= a) return { ...totals, spanMs: 0, segments };

  for (let dayStart = utcDayStart(utcDay(a)); dayStart < b; dayStart += DAY_MS) {
    const wa = Math.max(a, dayStart);
    const wb = Math.min(b, dayStart + DAY_MS);
    const row = rowsByDay.get(utcDay(dayStart));
    if (!row) {
      addState(totals, "no_data", wb - wa);
      segments.push({ state: "no_data", startMs: wa, endMs: wb });
      continue;
    }
    const part = windowFromRow(row, wa, wb);
    totals.upMs += part.upMs;
    totals.downMs += part.downMs;
    totals.maintenanceMs += part.maintenanceMs;
    totals.blockedMs += part.blockedMs;
    totals.noDataMs += part.noDataMs;
    const coveredEnd = Math.min(row.coveredToMs, dayStart + DAY_MS);
    for (const seg of row.segments) {
      const s = Math.max(seg.startMs, wa, dayStart);
      const e = Math.min(seg.endMs, wb, coveredEnd);
      if (e > s) segments.push({ state: seg.state, startMs: s, endMs: e });
    }
    const uncovered = (wb - wa) - part.coveredMs;
    if (uncovered > 0) {
      addState(totals, "no_data", uncovered);
      segments.push({ state: "no_data", startMs: Math.max(wa, coveredEnd), endMs: wb });
    }
  }

  if (opts.countBlockedAsDown) {
    totals.downMs += totals.blockedMs;
    totals.blockedMs = 0;
    for (const seg of segments) if (seg.state === "blocked") seg.state = "down";
  }

  return { ...totals, spanMs: b - a, segments: stitchSegments(segments) };
}

/**
 * Merge same-state segments that touch or overlap (for example across UTC
 * midnight), returning them in time order.
 */
export function stitchSegments(segments: SlaSegment[]): SlaSegment[] {
  const sorted = [...segments].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const out: SlaSegment[] = [];
  const lastByState = new Map<SlaSegmentState, SlaSegment>();
  for (const seg of sorted) {
    const last = lastByState.get(seg.state);
    if (last && seg.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, seg.endMs);
      continue;
    }
    const copy = { ...seg };
    out.push(copy);
    lastByState.set(seg.state, copy);
  }
  return out;
}

export interface StatusInput {
  final: boolean;
  targetPercent: number;
  upMs: number;
  downMs: number;
  /** Time observed so far (span). */
  spanMs: number;
  /** MTD: the span the period will have once it ends. Ignored when final. */
  fullSpanMs: number;
}

export interface StatusResult {
  availability: number | null;
  coverage: number;
  budgetMs: number;
  budgetUsed: number;
  projectedBudgetMs: number;
  status: SlaStatus;
  insufficientData: boolean;
}

export function errorBudgetMs(targetPercent: number, measuredMs: number): number {
  return Math.max(0, (1 - targetPercent / 100) * measuredMs);
}

/**
 * Availability, error budget and status for a check or a report.
 *
 * MTD projection: measured time is scaled to the full month
 * (measured / elapsed * month), so excluded time does not distort it. The
 * report is breached as soon as down time exceeds that full-month budget,
 * because no amount of later up time can bring it back.
 */
export function computeStatus(input: StatusInput): StatusResult {
  const measured = input.upMs + input.downMs;
  const availability = measured > 0 ? input.upMs / measured : null;
  const coverage = input.spanMs > 0 ? Math.min(1, measured / input.spanMs) : 0;
  const budgetMs = errorBudgetMs(input.targetPercent, measured);
  const budgetUsed = budgetMs > 0 ? input.downMs / budgetMs : input.downMs > 0 ? 1 : 0;
  const insufficientData = coverage < SLA_MIN_COVERAGE;

  if (availability === null) {
    return { availability, coverage, budgetMs, budgetUsed, projectedBudgetMs: budgetMs, status: "no_data", insufficientData: true };
  }

  const target = input.targetPercent / 100;
  if (input.final) {
    return {
      availability, coverage, budgetMs, budgetUsed, projectedBudgetMs: budgetMs,
      status: availability >= target ? "met" : "breached",
      insufficientData,
    };
  }

  const fullSpan = Math.max(input.fullSpanMs, input.spanMs);
  const projectedMeasured = input.spanMs > 0 ? (measured / input.spanMs) * fullSpan : measured;
  const projectedBudgetMs = errorBudgetMs(input.targetPercent, projectedMeasured);
  const projectedDown = input.spanMs > 0 ? (input.downMs / input.spanMs) * fullSpan : input.downMs;

  let status: SlaStatus;
  if (input.downMs > projectedBudgetMs) status = "breached";
  else if (budgetUsed >= SLA_AT_RISK_BUDGET || projectedDown > projectedBudgetMs) status = "at_risk";
  else status = "on_track";

  return { availability, coverage, budgetMs, budgetUsed, projectedBudgetMs, status, insufficientData };
}

export interface ComputePeriodInput {
  period: string;
  timezone: string;
  targetPercent: number;
  countBlockedAsDown: boolean;
  checks: SlaCheckInput[];
  rows: SlaDailyRow[];
  dataThroughMs: number;
}

const isFinalAt = (periodEndMs: number, dataThroughMs: number) => dataThroughMs >= periodEndMs + SLA_FINALIZE_MARGIN_MS;

/** True when a month's numbers can no longer change. */
export function isPeriodFinal(period: string, timezone: string, dataThroughMs: number): boolean {
  return isFinalAt(periodBounds(period, timezone).endMs, dataThroughMs);
}

function sumTotals(items: SlaTotals[]): SlaTotals {
  const t = zeroTotals();
  for (const i of items) {
    t.upMs += i.upMs;
    t.downMs += i.downMs;
    t.maintenanceMs += i.maintenanceMs;
    t.blockedMs += i.blockedMs;
    t.noDataMs += i.noDataMs;
  }
  return t;
}

/** Keep the `cap` longest items, returned in time order. */
function capLongest<T extends { startMs: number }>(items: T[], cap: number, length: (x: T) => number): T[] {
  const kept = items.length > cap ? [...items].sort((x, y) => length(y) - length(x)).slice(0, cap) : items;
  return [...kept].sort((x, y) => x.startMs - y.startMs);
}

/** Everything a period doc holds, computed from rollup rows. */
export function computePeriod(input: ComputePeriodInput): SlaPeriodComputation {
  const { period, timezone, targetPercent, countBlockedAsDown, dataThroughMs } = input;
  const { startMs, endMs } = periodBounds(period, timezone);
  const final = isFinalAt(endMs, dataThroughMs);

  const rowsByCheck = new Map<string, Map<string, SlaDailyRow>>();
  for (const row of input.rows) {
    let byDay = rowsByCheck.get(row.checkId);
    if (!byDay) rowsByCheck.set(row.checkId, (byDay = new Map()));
    byDay.set(row.day, row);
  }

  const incidents: SlaIncident[] = [];
  const exclusions: SlaExclusion[] = [];
  const checks: SlaCheckResult[] = [];
  let spanSum = 0;
  let fullSpanSum = 0;
  const perCheckRows: Array<{ input: SlaCheckInput; byDay: Map<string, SlaDailyRow> }> = [];

  for (const check of input.checks) {
    const byDay = rowsByCheck.get(check.checkId) ?? new Map<string, SlaDailyRow>();
    perCheckRows.push({ input: check, byDay });
    const opts: CheckWindowOptions = { countBlockedAsDown, createdAtMs: check.createdAtMs, dataThroughMs };
    const res = aggregateCheck(byDay, startMs, endMs, opts);
    const fullSpan = checkSpan(startMs, endMs, { createdAtMs: check.createdAtMs, dataThroughMs: Infinity });
    const fullSpanMs = fullSpan.b - fullSpan.a;
    spanSum += res.spanMs;
    fullSpanSum += fullSpanMs;

    const downSegs = res.segments.filter((s) => s.state === "down");
    let longest = 0;
    for (const seg of downSegs) {
      const ongoing = !final && seg.endMs >= Math.min(endMs, dataThroughMs);
      longest = Math.max(longest, seg.endMs - seg.startMs);
      incidents.push({
        checkId: check.checkId,
        startMs: seg.startMs,
        endMs: ongoing ? null : seg.endMs,
        durationMs: seg.endMs - seg.startMs,
      });
    }
    for (const seg of res.segments) {
      if (seg.state === "down") continue;
      exclusions.push({ checkId: check.checkId, state: seg.state, startMs: seg.startMs, endMs: seg.endMs });
    }

    const st = computeStatus({ final, targetPercent, upMs: res.upMs, downMs: res.downMs, spanMs: res.spanMs, fullSpanMs });
    checks.push({
      checkId: check.checkId,
      name: check.name,
      url: check.url,
      ...(check.deleted ? { deleted: true } : {}),
      upMs: res.upMs,
      downMs: res.downMs,
      maintenanceMs: res.maintenanceMs,
      blockedMs: res.blockedMs,
      noDataMs: res.noDataMs,
      availability: st.availability,
      coverage: st.coverage,
      incidents: downSegs.length,
      longestIncidentMs: longest,
      status: st.status,
      insufficientData: st.insufficientData,
    });
  }

  const totals = sumTotals(checks);
  const overallStatus = computeStatus({
    final,
    targetPercent,
    upMs: totals.upMs,
    downMs: totals.downMs,
    spanMs: spanSum,
    fullSpanMs: fullSpanSum,
  });

  // Daily chart, per local day, summed over checks.
  const daily: SlaDailyEntry[] = [];
  for (const d of localDayBounds(period, timezone)) {
    if (d.startMs >= Math.min(endMs, dataThroughMs)) break;
    const entry: SlaDailyEntry = { day: d.day, upMs: 0, downMs: 0, excludedMs: 0 };
    for (const { input: check, byDay } of perCheckRows) {
      const res = aggregateCheck(byDay, d.startMs, d.endMs, { countBlockedAsDown, createdAtMs: check.createdAtMs, dataThroughMs });
      entry.upMs += res.upMs;
      entry.downMs += res.downMs;
      entry.excludedMs += res.maintenanceMs + res.blockedMs + res.noDataMs;
    }
    daily.push(entry);
  }

  return {
    period,
    timezone,
    status: final ? "final" : "open",
    periodStart: startMs,
    periodEnd: endMs,
    dataThrough: Math.min(dataThroughMs, endMs),
    rollupVersion: SLA_ROLLUP_VERSION,
    targetPercent,
    countBlockedAsDown,
    overall: { ...totals, ...overallStatus },
    daily,
    checks,
    incidents: capLongest(incidents, SLA_MAX_INCIDENTS, (x) => x.durationMs),
    incidentsTotal: incidents.length,
    exclusions: capLongest(exclusions, SLA_MAX_EXCLUSIONS, (x) => x.endMs - x.startMs),
    exclusionsTotal: exclusions.length,
  };
}

/** UTC days ('YYYY-MM-DD') a window touches, for the report query's day range. */
export function utcDaysForWindow(startMs: number, endMs: number): { first: string; last: string } {
  return { first: utcDay(startMs), last: utcDay(Math.max(startMs, endMs - 1)) };
}
