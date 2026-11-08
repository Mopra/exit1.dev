// ============================================================================
// SLA TIME ZONE MATH (pure, no dependencies)
//
// An SLA period is a calendar month in the report's IANA time zone. Everything
// here converts between UTC instants and local wall-clock time with Intl, the
// same way checks.ts handles recurring maintenance. Node 22 ships full ICU, so
// no time zone library is needed.
//
// See docs/plans/sla-reporting.md, sections 2.2 and 4.5.
// ============================================================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long after a local month ends before its numbers are final. */
export const SLA_FINALIZE_MARGIN_MS = 2 * HOUR_MS;

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = offsetFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(tz, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC at instant `utcMs`, in ms (local = utc + offset). */
export function zoneOffsetMs(utcMs: number, tz: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const parts = offsetFormatter(tz).formatToParts(new Date(whole));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - whole;
}

/** Local wall-clock time of `utcMs` in `tz`, encoded as a UTC timestamp. */
export function localMsOf(utcMs: number, tz: string): number {
  return utcMs + zoneOffsetMs(utcMs, tz);
}

/**
 * UTC instant of local wall-clock time `localMs` (encoded as UTC) in `tz`.
 * When that local time occurs twice (clocks going back) the first occurrence
 * wins. When it does not exist (clocks jumping forward over it) the result is
 * the first instant after the gap.
 */
export function zonedLocalToUtc(localMs: number, tz: string): number {
  const offsets = new Set([
    zoneOffsetMs(localMs - DAY_MS, tz),
    zoneOffsetMs(localMs, tz),
    zoneOffsetMs(localMs + DAY_MS, tz),
  ]);
  const candidates = [...offsets].map((o) => localMs - o);
  const valid = candidates.filter((t) => localMsOf(t, tz) === localMs);
  if (valid.length > 0) return Math.min(...valid);

  // Local time falls in a gap. Binary search the first instant whose local
  // time is at or after the target; local time only moves forward across a
  // spring-forward transition, so the search is monotonic.
  let lo = Math.min(...candidates) - HOUR_MS;
  let hi = Math.max(...candidates) + HOUR_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localMsOf(mid, tz) >= localMs) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** UTC instant of local 00:00 on the given date (month 1-12). */
export function zonedMidnightToUtc(year: number, month: number, day: number, tz: string): number {
  return zonedLocalToUtc(Date.UTC(year, month - 1, day), tz);
}

export function isValidPeriod(period: unknown): period is string {
  if (typeof period !== "string") return false;
  const m = PERIOD_RE.exec(period);
  if (!m) return false;
  const month = Number(m[2]);
  const year = Number(m[1]);
  return month >= 1 && month <= 12 && year >= 2000 && year <= 2999;
}

function parsePeriod(period: string): { year: number; month: number } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`Invalid period: ${period}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

function formatPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function nextPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

export function previousPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  return month === 1 ? formatPeriod(year - 1, 12) : formatPeriod(year, month - 1);
}

/** Compare two 'YYYY-MM' strings. */
export function comparePeriods(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** UTC bounds [startMs, endMs) of a local calendar month. DST-correct. */
export function periodBounds(period: string, tz: string): { startMs: number; endMs: number } {
  const { year, month } = parsePeriod(period);
  const next = parsePeriod(nextPeriod(period));
  return {
    startMs: zonedMidnightToUtc(year, month, 1, tz),
    endMs: zonedMidnightToUtc(next.year, next.month, 1, tz),
  };
}

/** The local month ('YYYY-MM') containing `nowMs`. */
export function currentPeriod(nowMs: number, tz: string): string {
  const local = new Date(localMsOf(nowMs, tz));
  const period = formatPeriod(local.getUTCFullYear(), local.getUTCMonth() + 1);
  // Near a skipped midnight the wall clock can read the previous day while the
  // instant is already past the month start; trust the bounds.
  const { startMs, endMs } = periodBounds(period, tz);
  if (nowMs < startMs) return previousPeriod(period);
  if (nowMs >= endMs) return nextPeriod(period);
  return period;
}

/** When a period's numbers become final: local month end plus the margin. */
export function finalizeAt(period: string, tz: string): number {
  return periodBounds(period, tz).endMs + SLA_FINALIZE_MARGIN_MS;
}

/** Local days of a month with their UTC bounds, for the daily chart. */
export function localDayBounds(period: string, tz: string): Array<{ day: string; startMs: number; endMs: number }> {
  const { year, month } = parsePeriod(period);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const out: Array<{ day: string; startMs: number; endMs: number }> = [];
  let start = zonedMidnightToUtc(year, month, 1, tz);
  for (let d = 1; d <= daysInMonth; d++) {
    const end = d === daysInMonth
      ? periodBounds(period, tz).endMs
      : zonedMidnightToUtc(year, month, d + 1, tz);
    out.push({ day: `${formatPeriod(year, month)}-${String(d).padStart(2, "0")}`, startMs: start, endMs: end });
    start = end;
  }
  return out;
}

/** 'YYYY-MM-DD' of the UTC day containing `ms`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC midnight of a 'YYYY-MM-DD' day. */
export function utcDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** "November 2026". */
export function periodLabel(period: string): string {
  const { year, month } = parsePeriod(period);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Nov 14, 2026, 03:12 GMT+1" style timestamp in the report's zone. */
export function formatInZone(ms: number, tz: string): string {
  let fmt = displayFormatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    displayFormatters.set(tz, fmt);
  }
  return fmt.format(new Date(ms));
}
