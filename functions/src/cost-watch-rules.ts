/**
 * Pure rules behind the daily cost watch (cost-watch.ts): spot a cost line
 * that jumped against its own recent baseline, a new line that is already
 * expensive, and a monthly free tier on course to run out before month end.
 * Kept free of I/O so the thresholds are testable.
 */

export type CostUnit = "DKK" | "GB";

export interface CostSeries {
  /** Stable identity (service name, function name, query fingerprint). */
  key: string;
  /** What kind of line this is, for grouping in the email. */
  group: "service" | "function" | "query";
  /** Human label (for a query, the start of its SQL). */
  label: string;
  unit: CostUnit;
  /** Daily totals, oldest first; the last entry is the day being judged. */
  days: number[];
}

export interface FreeTierUsage {
  name: string;
  unit: string;
  /** Usage so far this month, through the last complete day. */
  used: number;
  /** The same, one day earlier. A warning fires only on the day it first applies. */
  usedDayBefore?: number;
  /** Monthly free allowance. */
  limit: number;
  /** Complete days of the month the usage covers. */
  daysElapsed: number;
  daysInMonth: number;
}

export interface CostFinding {
  kind: "spike" | "new" | "free-tier";
  key: string;
  message: string;
}

/** A day must cost at least this many times its baseline to count as a spike. */
export const SPIKE_RATIO = 2;
/** Ignore jumps smaller than this per day: noise, not money. */
export const MIN_DAILY_DELTA: Record<CostUnit, number> = { DKK: 0.5, GB: 5 };
/** Warn once the month is projected to use this share of a free tier. */
export const FREE_TIER_WARN_SHARE = 0.9;

const fmt = (n: number, unit: string) =>
  `${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n >= 10 ? 1 : 2)} ${unit}`;

export function findSpikes(series: CostSeries[]): CostFinding[] {
  const out: CostFinding[] = [];
  for (const s of series) {
    if (!s.days.length) continue;
    const latest = s.days[s.days.length - 1];
    const prior = s.days.slice(0, -1);
    const baseline = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    const floor = MIN_DAILY_DELTA[s.unit];
    if (latest - baseline < floor) continue;

    if (baseline <= 0) {
      out.push({
        kind: "new",
        key: s.key,
        message: `New ${s.group} line: ${s.label} cost ${fmt(latest, s.unit)} yesterday, nothing before.`,
      });
    } else if (latest >= SPIKE_RATIO * baseline) {
      out.push({
        kind: "spike",
        key: s.key,
        message: `${s.label} (${s.group}): ${fmt(latest, s.unit)} yesterday vs ${fmt(baseline, s.unit)}/day before (${(latest / baseline).toFixed(1)}x).`,
      });
    }
  }
  return out;
}

export function findFreeTierRisks(tiers: FreeTierUsage[]): CostFinding[] {
  const out: CostFinding[] = [];
  for (const t of tiers) {
    if (t.daysElapsed <= 0 || t.used <= 0) continue;
    const projected = (t.used / t.daysElapsed) * t.daysInMonth;
    if (projected < FREE_TIER_WARN_SHARE * t.limit) continue;
    if (t.usedDayBefore !== undefined && t.daysElapsed > 1) {
      const projectedBefore = (t.usedDayBefore / (t.daysElapsed - 1)) * t.daysInMonth;
      if (projectedBefore >= FREE_TIER_WARN_SHARE * t.limit) continue;
    }
    const runsOutDay = Math.ceil((t.limit / t.used) * t.daysElapsed);
    const when = t.used >= t.limit
      ? "already used up"
      : runsOutDay <= t.daysInMonth ? `runs out around day ${runsOutDay}` : "just inside it";
    out.push({
      kind: "free-tier",
      key: t.name,
      message: `${t.name}: ${fmt(t.used, t.unit)} used in ${t.daysElapsed} days, on course for ${fmt(projected, t.unit)} vs ${fmt(t.limit, t.unit)} free (${when}).`,
    });
  }
  return out;
}

/** The biggest lines over the window, for the weekly digest. */
export function topSeries(series: CostSeries[], group: CostSeries["group"], n: number): Array<{ label: string; total: number; unit: CostUnit }> {
  return series
    .filter(s => s.group === group)
    .map(s => ({ label: s.label, unit: s.unit, total: s.days.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}
