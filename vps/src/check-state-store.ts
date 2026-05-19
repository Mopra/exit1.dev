/**
 * Append-on-write NDJSON persistence for check state-segments.
 *
 * Companion to CheckTimeseriesStore. Segments are far rarer than chart
 * points (a typical check has 0-3 per day vs ~720 points), so a single
 * shared writer with a 6h / 256 MB rotation is more than enough.
 *
 * Wire format: each segment is written twice — once on open (`e: null`)
 * and once on close (`e: <ms>`). Replay coalesces records by (c, k, s),
 * letting the close-record override the open-record. This makes
 * crash recovery trivial: if we crashed between open and close, the
 * open-record alone tells us the segment was still active.
 *
 * Retention: same 24h horizon as chart points; files whose mtime is past
 * the cutoff are pruned during rotation.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { CheckStateKind, StateSegment } from './ws-protocol.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const ROTATION_BYTES = 256 * 1024 * 1024; // 256 MB — segments are tiny
const ROTATION_MS = 6 * 60 * 60 * 1000;   // 6 h
const ROTATION_CHECK_EVERY_N = 64;

const FILE_PREFIX = 'state-segments-';
const FILE_SUFFIX = '.ndjson';

export interface DiskSegment {
  c: string;
  k: CheckStateKind;
  s: number;
  e: number | null;
}

export interface StateStoreStats {
  enabled: boolean;
  dir: string | null;
  activeFile: string | null;
  activeBytes: number;
  activeAgeMs: number;
  bytesWritten: number;
  linesWritten: number;
  writeErrors: number;
  rotations: number;
  openRefreshes: number;
  bootLoaded: {
    segments: number;
    files: number;
    parseErrors: number;
    skippedExpired: number;
    durationMs: number;
  } | null;
}

function timestampedFilename(now: number = Date.now()): string {
  const d = new Date(now);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const MM = String(d.getUTCMinutes()).padStart(2, '0');
  const SS = String(d.getUTCSeconds()).padStart(2, '0');
  return `${FILE_PREFIX}${yyyy}${mm}${dd}T${HH}${MM}${SS}Z${FILE_SUFFIX}`;
}

interface ActiveFile {
  stream: fs.WriteStream;
  path: string;
  bytes: number;
  openedAt: number;
}

/**
 * Caller-provided source of currently-open segments. The store calls this
 * during rotation (and via `refreshOpenSegments()`) to re-append every
 * open record into the active file. Without this, a file containing an
 * open record but no other recent activity has its mtime stuck at the
 * open's timestamp; once retention elapses, pruneExpiredFiles would
 * delete the file and the open record with it, losing the segment's
 * original start time across a restart.
 */
export type OpenSegmentsProvider = () => Iterable<{ checkId: string; seg: StateSegment }>;

export class CheckStateStore {
  private dir: string | null = null;
  private active: ActiveFile | null = null;
  private appendsSinceRotateCheck = 0;
  private rotating = false;
  private enabled = false;
  private openSegmentsProvider: OpenSegmentsProvider | null = null;

  private bytesWritten = 0;
  private linesWritten = 0;
  private writeErrors = 0;
  private rotations = 0;
  private openRefreshes = 0;
  private bootStats: StateStoreStats['bootLoaded'] = null;

  async init(dir: string): Promise<boolean> {
    try {
      await fsp.mkdir(dir, { recursive: true });
      this.dir = dir;
      await this.openNewActive();
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn(
        `[state-store] init failed for ${dir}; persistence disabled, state segments will be in-memory-only:`,
        err
      );
      this.enabled = false;
      this.dir = null;
      this.active = null;
      return false;
    }
  }

  /**
   * Stream every NDJSON file, oldest-first, and call `onSegment` for the
   * final state of each (c, k, s) tuple. Close-records override open-records,
   * so an open segment from before a crash is replayed as still-open.
   * Expired segments (closed before the retention cutoff) are dropped at
   * read time.
   */
  async replay(
    now: number,
    onSegment: (checkId: string, seg: StateSegment) => void,
  ): Promise<void> {
    const start = Date.now();
    const stats: NonNullable<StateStoreStats['bootLoaded']> = {
      segments: 0,
      files: 0,
      parseErrors: 0,
      skippedExpired: 0,
      durationMs: 0,
    };
    if (!this.dir) {
      this.bootStats = { ...stats };
      return;
    }
    const cutoff = now - RETENTION_MS;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.dir);
    } catch (err) {
      console.warn('[state-store] readdir failed during replay:', err);
      this.bootStats = { ...stats };
      return;
    }
    const ndjson = entries
      .filter(name => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
      .sort();

    // Coalesce records by (c, k, s); close-record overrides open-record.
    // We do this in a Map so a single segment doesn't get callback-applied
    // twice during boot.
    const byKey = new Map<string, DiskSegment>();
    for (const name of ndjson) {
      const full = path.join(this.dir, name);
      if (this.active && full === this.active.path) continue;
      stats.files++;
      try {
        const stream = fs.createReadStream(full, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            stats.parseErrors++;
            continue;
          }
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            typeof (parsed as DiskSegment).c !== 'string' ||
            typeof (parsed as DiskSegment).s !== 'number'
          ) {
            stats.parseErrors++;
            continue;
          }
          const ds = parsed as DiskSegment;
          if (ds.k !== 'maintenance' && ds.k !== 'disabled') {
            stats.parseErrors++;
            continue;
          }
          if (ds.e !== null && typeof ds.e !== 'number') {
            stats.parseErrors++;
            continue;
          }
          const key = `${ds.c}|${ds.k}|${ds.s}`;
          const prev = byKey.get(key);
          // Close-record overrides open-record. If we see two opens or
          // two closes for the same key (shouldn't happen), the later
          // one wins — file order is chronological.
          if (!prev || (prev.e == null && ds.e != null)) {
            byKey.set(key, ds);
          }
        }
      } catch (err) {
        console.warn(`[state-store] failed to read ${full}:`, err);
      }
    }
    for (const ds of byKey.values()) {
      // Drop segments that closed before the retention cutoff.
      if (ds.e != null && ds.e < cutoff) {
        stats.skippedExpired++;
        continue;
      }
      onSegment(ds.c, { k: ds.k, s: ds.s, e: ds.e });
      stats.segments++;
    }
    stats.durationMs = Date.now() - start;
    this.bootStats = stats;
    console.info(
      `[state-store] boot replay: ${stats.segments} segments from ${stats.files} files ` +
        `(${stats.parseErrors} parse errors, ${stats.skippedExpired} expired) in ${stats.durationMs}ms`
    );
  }

  /**
   * Append one record. Called twice per segment: once with `e: null` on
   * open, once with `e: <ms>` on close. Fire-and-forget like the
   * timeseries store.
   */
  append(checkId: string, seg: StateSegment): void {
    if (!this.enabled || !this.active) return;
    const disk: DiskSegment = { c: checkId, k: seg.k, s: seg.s, e: seg.e };
    let buf: Buffer;
    try {
      buf = Buffer.from(JSON.stringify(disk) + '\n', 'utf8');
    } catch (err) {
      this.writeErrors++;
      console.warn('[state-store] stringify failed:', err);
      return;
    }
    try {
      this.active.stream.write(buf, err => {
        if (err) {
          this.writeErrors++;
          if (this.writeErrors <= 5 || this.writeErrors % 1000 === 0) {
            console.warn(`[state-store] write error #${this.writeErrors}:`, err);
          }
        }
      });
      this.active.bytes += buf.length;
      this.bytesWritten += buf.length;
      this.linesWritten++;
    } catch (err) {
      this.writeErrors++;
      console.warn('[state-store] write threw:', err);
      return;
    }
    if (++this.appendsSinceRotateCheck >= ROTATION_CHECK_EVERY_N) {
      this.appendsSinceRotateCheck = 0;
      this.maybeRotate();
    }
  }

  checkRotation(): void {
    this.maybeRotate();
  }

  /**
   * Register the provider that lists currently-open segments. Must be
   * called before the periodic refresh timer fires; init() is fine
   * before this is set because boot replay doesn't depend on it.
   */
  setOpenSegmentsProvider(provider: OpenSegmentsProvider): void {
    this.openSegmentsProvider = provider;
  }

  /**
   * Re-append every currently-open segment to the active file. Called on
   * a slow timer from the runner so the active file's mtime advances
   * even when no real state activity happens — this is what makes
   * mtime-based pruning safe for long-lived open segments. Cheap: typical
   * deployments have a handful of open segments at any time.
   */
  refreshOpenSegments(): void {
    if (!this.enabled || !this.active || !this.openSegmentsProvider) return;
    let count = 0;
    for (const { checkId, seg } of this.openSegmentsProvider()) {
      // Defensive: provider should only yield open segments, but skip
      // closed ones if a race let one slip through.
      if (seg.e != null) continue;
      this.append(checkId, seg);
      count++;
    }
    if (count > 0) this.openRefreshes++;
  }

  private maybeRotate(): void {
    if (this.rotating || !this.active) return;
    const ageMs = Date.now() - this.active.openedAt;
    if (this.active.bytes < ROTATION_BYTES && ageMs < ROTATION_MS) return;
    this.rotate().catch(err => {
      console.warn('[state-store] rotation failed:', err);
      this.rotating = false;
    });
  }

  private async rotate(): Promise<void> {
    if (!this.dir || this.rotating) return;
    this.rotating = true;
    const old = this.active;
    try {
      await this.openNewActive();
    } catch (err) {
      this.rotating = false;
      console.warn('[state-store] openNewActive failed mid-rotate:', err);
      return;
    }
    // Re-append every open segment into the new active file before
    // closing the old one. This is the structural invariant pruning
    // relies on: every open segment exists in the most recent file. A
    // file with mtime past the retention cutoff therefore contains only
    // closed-expired records and is safe to delete.
    if (this.openSegmentsProvider) {
      for (const { checkId, seg } of this.openSegmentsProvider()) {
        if (seg.e != null) continue;
        this.append(checkId, seg);
      }
    }
    if (old) {
      await new Promise<void>(resolve => old.stream.end(() => resolve()));
    }
    this.rotations++;
    await this.pruneExpiredFiles().catch(err => {
      console.warn('[state-store] prune failed:', err);
    });
    this.rotating = false;
  }

  private async pruneExpiredFiles(): Promise<void> {
    if (!this.dir) return;
    const cutoff = Date.now() - RETENTION_MS;
    const entries = await fsp.readdir(this.dir);
    for (const name of entries) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
      const full = path.join(this.dir, name);
      if (this.active && full === this.active.path) continue;
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs < cutoff) {
          await fsp.unlink(full);
        }
      } catch (err) {
        console.warn(`[state-store] prune entry ${name} failed:`, err);
      }
    }
  }

  private async openNewActive(): Promise<void> {
    if (!this.dir) throw new Error('store not initialized');
    const file = timestampedFilename();
    const full = path.join(this.dir, file);
    const stream = fs.createWriteStream(full, { flags: 'a' });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        stream.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        stream.off('open', onOpen);
        reject(err);
      };
      stream.once('open', onOpen);
      stream.once('error', onError);
    });
    let initialBytes = 0;
    try {
      const st = await fsp.stat(full);
      initialBytes = st.size;
    } catch {
      /* brand-new file */
    }
    stream.on('error', err => {
      this.writeErrors++;
      console.warn('[state-store] stream error:', err);
    });
    this.active = { stream, path: full, bytes: initialBytes, openedAt: Date.now() };
  }

  async close(): Promise<void> {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    this.enabled = false;
    await new Promise<void>(resolve => a.stream.end(() => resolve()));
  }

  stats(): StateStoreStats {
    return {
      enabled: this.enabled,
      dir: this.dir,
      activeFile: this.active?.path ?? null,
      activeBytes: this.active?.bytes ?? 0,
      activeAgeMs: this.active ? Date.now() - this.active.openedAt : 0,
      bytesWritten: this.bytesWritten,
      linesWritten: this.linesWritten,
      writeErrors: this.writeErrors,
      rotations: this.rotations,
      openRefreshes: this.openRefreshes,
      bootLoaded: this.bootStats,
    };
  }
}
