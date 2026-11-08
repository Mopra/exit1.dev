// Pure scheduling decisions of the SLA rollup (which days to write, which
// months to refresh), split out of sla-rollup.ts so they test without
// firebase-admin.

import { comparePeriods, currentPeriod, periodBounds, previousPeriod, utcDay, utcDayStart } from "./sla-time";
import type { SlaReportDoc } from "./sla-types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A UTC day is rolled up as complete only this long after it ends (late inserts). */
export const SLA_DAY_COMPLETE_MARGIN_MS = 2 * HOUR_MS;
/** How far back a missed complete day heals itself. */
export const SLA_HEAL_DAYS = 3;

export interface PlannedDay {
  dayStartMs: number;
  cutMs: number;
  /** Written to its end and old enough to never change again. */
  complete: boolean;
}

/**
 * Which days a run at `cutMs` writes: every past day after `completeThrough`
 * (at most SLA_HEAL_DAYS back, so a missed run heals itself), each written to
 * its end, then today up to the cut. A past day still inside the 2 h margin
 * is written but not marked complete, so the next run writes it again once
 * late inserts have landed. Pure for tests.
 */
export function planRollupDays(cutMs: number, completeThrough: string | null | undefined): PlannedDay[] {
  const todayStart = utcDayStart(utcDay(cutMs));
  const earliest = todayStart - SLA_HEAL_DAYS * DAY_MS;
  const after = completeThrough ? utcDayStart(completeThrough) + DAY_MS : earliest;
  const out: PlannedDay[] = [];
  for (let d = Math.max(after, earliest); d < todayStart; d += DAY_MS) {
    out.push({ dayStartMs: d, cutMs: d + DAY_MS, complete: d + DAY_MS + SLA_DAY_COMPLETE_MARGIN_MS <= cutMs });
  }
  if (cutMs > todayStart) out.push({ dayStartMs: todayStart, cutMs, complete: false });
  return out;
}

/**
 * Months the cron computes for one report: the open local month, plus the
 * previous month while it is not yet written final (and existed for this
 * report). Pure for tests.
 */
export function periodsToRefresh(
  report: Pick<SlaReportDoc, "timezone" | "createdAt" | "lastFinalPeriod">,
  dataThroughMs: number,
): string[] {
  const current = currentPeriod(dataThroughMs, report.timezone);
  const out = [current];
  const prev = previousPeriod(current);
  const prevEnd = periodBounds(prev, report.timezone).endMs;
  const alreadyFinal = report.lastFinalPeriod && comparePeriods(report.lastFinalPeriod, prev) >= 0;
  if (!alreadyFinal && report.createdAt < prevEnd) out.unshift(prev);
  return out;
}

