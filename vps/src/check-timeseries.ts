/**
 * In-memory response-time history per check.
 *
 * One time-bounded buffer per check, 24h retention. Appended to on every
 * probe completion from the status-buffer hook in runner.ts. Read by the
 * `subscribe_history` WS handler to backfill the detail-page chart on open.
 *
 * Phase 1 (live-charts.md): in-memory only. Phase 2 will add NDJSON
 * append-on-write so charts survive deploys without blocking shutdown on a
 * giant JSON.stringify.
 */
import type { ChartPoint } from './ws-protocol.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MIN_WINDOW_MS = 60_000;

/**
 * Binary search for the lowest index with buf[i].t >= cutoff. Returns
 * buf.length when every point is older than the cutoff. Used both for
 * front-trimming and for windowed reads.
 */
function lowerBound(buf: ChartPoint[], cutoff: number): number {
  let lo = 0;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buf[mid].t < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class CheckTimeseries {
  private buffers = new Map<string, ChartPoint[]>();

  append(checkId: string, point: ChartPoint): void {
    let buf = this.buffers.get(checkId);
    if (!buf) {
      buf = [];
      this.buffers.set(checkId, buf);
    }
    buf.push(point);
    // Trim front by binary-searching the cutoff rather than shift()-looping.
    // shift() is O(n) per call; a single splice of the prefix is one move.
    const cutoff = point.t - RETENTION_MS;
    if (buf[0].t < cutoff) {
      const drop = lowerBound(buf, cutoff);
      if (drop > 0) buf.splice(0, drop);
    }
  }

  /**
   * Return the slice of points within the last `windowMs` of `now`.
   * `windowMs` is clamped to [MIN_WINDOW_MS, RETENTION_MS] so out-of-range
   * clients still get a sensible response instead of an error.
   */
  window(checkId: string, windowMs: number, now: number): ChartPoint[] {
    const buf = this.buffers.get(checkId);
    if (!buf || buf.length === 0) return [];
    const clamped = Math.min(RETENTION_MS, Math.max(MIN_WINDOW_MS, windowMs));
    const cutoff = now - clamped;
    const start = lowerBound(buf, cutoff);
    if (start === 0) return buf.slice();
    return buf.slice(start);
  }

  /**
   * Drop the entire buffer for a check. Called when a check is removed
   * from the schedule so the timeseries doesn't leak memory across check
   * deletions.
   */
  remove(checkId: string): void {
    this.buffers.delete(checkId);
  }

  /**
   * Snapshot of memory pressure surfaced via /admin/ws-stats. Walks every
   * buffer to count points — O(N checks), not O(N points), so it's cheap
   * enough to call on demand without caching.
   */
  stats(): { checks: number; totalPoints: number; approxBytes: number } {
    let totalPoints = 0;
    for (const buf of this.buffers.values()) totalPoints += buf.length;
    // ~100 B per ChartPoint object in V8 (hidden class + key strings +
    // small-int boxing). Plus a flat ~16 B Map entry overhead per check.
    const approxBytes = totalPoints * 100 + this.buffers.size * 16;
    return { checks: this.buffers.size, totalPoints, approxBytes };
  }
}
