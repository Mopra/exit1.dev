/**
 * In-memory state-segment store per check.
 *
 * Tracks time-ranges where a check was non-running (maintenance or disabled).
 * Used by the live-chart pipeline to shade bands on the frontend. Each
 * (checkId, kind) has at most one open segment at a time; closed segments
 * are kept until they age out of the 24h retention window.
 *
 * Mirrors the shape of CheckTimeseries: per-check sorted arrays, with a
 * lazy front-trim on append/close. Separate persistence layer
 * (CheckStateStore) handles NDJSON crash safety.
 */
import type { CheckStateKind, StateSegment } from './ws-protocol.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MIN_WINDOW_MS = 60_000;

/** Composite key for the open-segment index. */
function openKey(checkId: string, kind: CheckStateKind): string {
  return `${checkId}|${kind}`;
}

export class CheckState {
  private buffers = new Map<string, StateSegment[]>();
  // O(1) lookup of the currently-open segment for a (checkId, kind). Each
  // value is a reference into the corresponding buffer entry so mutating
  // `e` here mutates the array entry too — no resync needed.
  private openIndex = new Map<string, StateSegment>();

  /**
   * Apply a segment recovered from disk replay. Idempotent on (k, s):
   * a second call with the same key replaces the prior entry, so a
   * close-record applied after an open-record correctly seals the segment.
   * Caller is responsible for replay deduping if multiple records exist
   * for the same key — passing the final state is fine.
   */
  applyReplayed(checkId: string, seg: StateSegment): void {
    let buf = this.buffers.get(checkId);
    if (!buf) {
      buf = [];
      this.buffers.set(checkId, buf);
    }
    // Locate existing entry by (k, s). Linear scan is fine — even at the
    // max realistic count (~tens of segments per check across 24h) this
    // runs once per boot per segment.
    let entry = buf.find(s => s.k === seg.k && s.s === seg.s);
    if (entry) {
      // Mutate in place so any existing openIndex ref stays valid.
      entry.e = seg.e;
    } else {
      // Keep array sorted by start asc — newer-arriving segments are usually
      // appended at the end, so we use an insertion search rather than a
      // full sort.
      let ins = buf.length;
      while (ins > 0 && buf[ins - 1].s > seg.s) ins--;
      entry = { k: seg.k, s: seg.s, e: seg.e };
      buf.splice(ins, 0, entry);
    }
    // Sync the open-index with the canonical entry's current state.
    const key = openKey(checkId, seg.k);
    if (entry.e == null) {
      this.openIndex.set(key, entry);
    } else {
      const cur = this.openIndex.get(key);
      if (cur && cur.s === seg.s) this.openIndex.delete(key);
    }
  }

  /**
   * Open a new segment for (checkId, kind) starting at `start`. If a
   * segment of the same kind is already open, no-op and return null —
   * preserves the original `start` so the band's left edge doesn't jump.
   */
  open(checkId: string, kind: CheckStateKind, start: number): StateSegment | null {
    const key = openKey(checkId, kind);
    if (this.openIndex.has(key)) return null;
    let buf = this.buffers.get(checkId);
    if (!buf) {
      buf = [];
      this.buffers.set(checkId, buf);
    }
    const seg: StateSegment = { k: kind, s: start, e: null };
    buf.push(seg);
    // Keep sorted: a fresh open's start is normally >= every existing
    // segment's start, but a tiny clock jitter could violate that. Bubble
    // back if needed.
    let i = buf.length - 1;
    while (i > 0 && buf[i - 1].s > buf[i].s) {
      const tmp = buf[i - 1];
      buf[i - 1] = buf[i];
      buf[i] = tmp;
      i--;
    }
    this.openIndex.set(key, seg);
    this.trimExpired(buf, start);
    return seg;
  }

  /**
   * Close the open segment for (checkId, kind) at `end`. Returns the
   * closed segment, or null if none was open. `end < segment.s` is
   * clamped to `segment.s` to keep ordering invariants intact under
   * clock-jitter edge cases.
   */
  close(checkId: string, kind: CheckStateKind, end: number): StateSegment | null {
    const key = openKey(checkId, kind);
    const seg = this.openIndex.get(key);
    if (!seg) return null;
    seg.e = Math.max(end, seg.s);
    this.openIndex.delete(key);
    return seg;
  }

  /** True iff a segment of `kind` is currently open for the check. */
  isOpen(checkId: string, kind: CheckStateKind): boolean {
    return this.openIndex.has(openKey(checkId, kind));
  }

  /**
   * Return segments that overlap the window [now-windowMs, now]. Open
   * segments (e==null) are always included if they started before `now`.
   * Closed segments are included when `e > now - windowMs`.
   */
  window(checkId: string, windowMs: number, now: number): StateSegment[] {
    const buf = this.buffers.get(checkId);
    if (!buf || buf.length === 0) return [];
    const clamped = Math.min(RETENTION_MS, Math.max(MIN_WINDOW_MS, windowMs));
    const cutoff = now - clamped;
    const out: StateSegment[] = [];
    for (const seg of buf) {
      // Closed segment ending before the cutoff is out of range.
      if (seg.e != null && seg.e < cutoff) continue;
      // Segment that hasn't started yet (start in the future) is impossible
      // under sane wall clocks; skip defensively.
      if (seg.s > now) continue;
      out.push({ k: seg.k, s: seg.s, e: seg.e });
    }
    return out;
  }

  /** Drop all state for a check (called when the check is deleted). */
  remove(checkId: string): void {
    this.buffers.delete(checkId);
    for (const key of [...this.openIndex.keys()]) {
      if (key.startsWith(`${checkId}|`)) this.openIndex.delete(key);
    }
  }

  /**
   * Iterate currently-open segments across every check. Used by the
   * persistence layer to refresh open records into the active NDJSON
   * file so file-mtime-based pruning doesn't drop them.
   */
  *iterateOpenSegments(): IterableIterator<{ checkId: string; seg: StateSegment }> {
    for (const [key, seg] of this.openIndex) {
      // openKey format is `${checkId}|${kind}`. Slice on the LAST `|`
      // because a checkId can technically contain pipes (Firestore IDs
      // can contain almost anything); kinds are an enum that can't.
      const split = key.lastIndexOf('|');
      const checkId = split >= 0 ? key.slice(0, split) : key;
      yield { checkId, seg };
    }
  }

  /** Memory pressure snapshot for /admin/ws-stats. */
  stats(): { checks: number; openSegments: number; totalSegments: number } {
    let total = 0;
    for (const buf of this.buffers.values()) total += buf.length;
    return {
      checks: this.buffers.size,
      openSegments: this.openIndex.size,
      totalSegments: total,
    };
  }

  /**
   * Drop closed segments whose end is past the retention cutoff. Called
   * on open() so memory tracks the same 24h horizon as ChartPoints.
   * Walks the full array because an open segment (e=null) in the middle
   * doesn't stop later closed-expired segments from being trimmable —
   * the prior implementation bailed on the first open and leaked them.
   */
  private trimExpired(buf: StateSegment[], now: number): void {
    const cutoff = now - RETENTION_MS;
    if (buf.length === 0) return;
    let write = 0;
    for (let read = 0; read < buf.length; read++) {
      const seg = buf[read];
      if (seg.e != null && seg.e < cutoff) continue;
      buf[write++] = seg;
    }
    if (write < buf.length) buf.length = write;
  }
}
