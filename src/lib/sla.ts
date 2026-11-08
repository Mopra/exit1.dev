// SLA report helpers for the app: calendar months in a report's IANA zone and
// display formatting. The month math is a trimmed copy of
// functions/src/sla-time.ts so the page picks the same "current month" as the
// backend; keep the two in step.

import type { SlaPeriod, SlaStatus } from '@/types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

/** Presets offered in the editor; any value from 90 to 99.999 is allowed. */
export const SLA_TARGET_PRESETS = [99, 99.5, 99.9, 99.95, 99.99] as const;
export const SLA_TARGET_MIN = 90;
export const SLA_TARGET_MAX = 99.999;
export const SLA_MAX_RECIPIENTS = 10;
export const SLA_MAX_CHECKS = 250;
/** Check types with no availability; the backend skips them too. */
export const SLA_EXCLUDED_CHECK_TYPES = ['dns', 'domain'];
/** Months offered in the period picker: the current one plus 12 back (the backfill depth). */
export const SLA_HISTORY_MONTHS = 13;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = offsetFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(tz, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zoneOffsetMs(utcMs: number, tz: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const parts = offsetFormatter(tz).formatToParts(new Date(whole));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - whole;
}

function localMsOf(utcMs: number, tz: string): number {
  return utcMs + zoneOffsetMs(utcMs, tz);
}

function zonedLocalToUtc(localMs: number, tz: string): number {
  const offsets = new Set([
    zoneOffsetMs(localMs - DAY_MS, tz),
    zoneOffsetMs(localMs, tz),
    zoneOffsetMs(localMs + DAY_MS, tz),
  ]);
  const candidates = [...offsets].map((o) => localMs - o);
  const valid = candidates.filter((t) => localMsOf(t, tz) === localMs);
  if (valid.length > 0) return Math.min(...valid);
  let lo = Math.min(...candidates) - HOUR_MS;
  let hi = Math.max(...candidates) + HOUR_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localMsOf(mid, tz) >= localMs) hi = mid;
    else lo = mid;
  }
  return hi;
}

function parsePeriod(period: string): { year: number; month: number } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`Invalid period: ${period}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

function formatPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function isValidPeriod(period: unknown): period is string {
  if (typeof period !== 'string') return false;
  const m = PERIOD_RE.exec(period);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

export function nextPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

export function previousPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  return month === 1 ? formatPeriod(year - 1, 12) : formatPeriod(year, month - 1);
}

/** UTC bounds [startMs, endMs) of a local calendar month. DST-correct. */
export function periodBounds(period: string, tz: string): { startMs: number; endMs: number } {
  const { year, month } = parsePeriod(period);
  const next = parsePeriod(nextPeriod(period));
  return {
    startMs: zonedLocalToUtc(Date.UTC(year, month - 1, 1), tz),
    endMs: zonedLocalToUtc(Date.UTC(next.year, next.month - 1, 1), tz),
  };
}

/** The local month ('YYYY-MM') containing `nowMs` in `tz`. */
export function currentPeriod(nowMs: number, tz: string): string {
  const local = new Date(localMsOf(nowMs, tz));
  const period = formatPeriod(local.getUTCFullYear(), local.getUTCMonth() + 1);
  const { startMs, endMs } = periodBounds(period, tz);
  if (nowMs < startMs) return previousPeriod(period);
  if (nowMs >= endMs) return nextPeriod(period);
  return period;
}

/** The current month and the ones before it, newest first. */
export function recentPeriods(nowMs: number, tz: string, count = SLA_HISTORY_MONTHS): string[] {
  const out = [currentPeriod(nowMs, tz)];
  while (out.length < count) out.push(previousPeriod(out[out.length - 1]));
  return out;
}

/** "November 2026". */
export function periodLabel(period: string): string {
  const { year, month } = parsePeriod(period);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(key: string, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${key}|${tz}`;
  let fmt = formatterCache.get(id);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options });
    formatterCache.set(id, fmt);
  }
  return fmt;
}

/** "Nov 14, 03:12 CET" in the report's zone. */
export function formatDateTimeInZone(ms: number, tz: string): string {
  return cachedFormatter('dt', tz, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(new Date(ms));
}

/** "Nov 14" in the report's zone. */
export function formatDayInZone(ms: number, tz: string): string {
  return cachedFormatter('d', tz, { month: 'short', day: 'numeric' }).format(new Date(ms));
}

/** "14:10 CET" in the report's zone. */
export function formatTimeInZone(ms: number, tz: string): string {
  return cachedFormatter('t', tz, {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(new Date(ms));
}

/** "2026-11-14 02:12 UTC", for tooltips. */
export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "Nov 14" for a local 'YYYY-MM-DD' day key. */
export function formatDayKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** 0.99953 -> "99.953%". Three decimals so a 99.99% target stays readable. */
export function formatAvailability(value: number | null | undefined, decimals = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'No data';
  const pct = value * 100;
  // Never round a miss up to the target: floor to the shown precision.
  const factor = 10 ** decimals;
  const floored = Math.floor(pct * factor) / factor;
  return `${floored.toFixed(decimals)}%`;
}

/** 99.9 -> "99.9%". */
export function formatTarget(target: number): string {
  return `${Number(target.toFixed(3))}%`;
}

/** "1h 12m", "45s", "0s". Seconds matter for tight budgets. */
export function formatSlaDuration(ms: number): string {
  if (!ms || ms <= 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 && minutes < 10 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export const SLA_STATUS_LABEL: Record<SlaStatus, string> = {
  met: 'Met',
  breached: 'Breached',
  at_risk: 'At risk',
  on_track: 'On track',
  no_data: 'No data',
};

export const SLA_EXCLUSION_LABEL: Record<string, string> = {
  maintenance: 'Maintenance',
  blocked: 'Blocked probe',
  no_data: 'No data',
};

/**
 * Local day on which an open month's down time passed the full-month budget,
 * or null. Walks the daily chart, which is in the report's zone already.
 */
export function budgetExhaustedDay(period: SlaPeriod): string | null {
  const budget = period.overall.projectedBudgetMs;
  if (!(budget > 0) || period.overall.downMs <= budget) return null;
  let down = 0;
  for (const d of period.daily ?? []) {
    down += d.downMs;
    if (down > budget) return d.day;
  }
  return null;
}

/** Excluded time of a check or report, in ms. */
export function excludedMs(t: { maintenanceMs: number; blockedMs: number; noDataMs: number }): number {
  return (t.maintenanceMs || 0) + (t.blockedMs || 0) + (t.noDataMs || 0);
}
