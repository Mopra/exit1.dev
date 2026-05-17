/**
 * Append-on-write NDJSON persistence for the live-chart in-memory buffer.
 *
 * Phase 2 of live-charts.md. Why not shutdown-time JSON.stringify of the
 * whole Map: at the realistic ~400-800 MB heap target, stringify blocks
 * the event loop for 5-15s, well over the 25s budget that also holds
 * status/BigQuery/budget flushes (see runner.ts shutdown()). The amortized
 * append-on-write cost is paid per-probe instead.
 *
 * Lifecycle:
 *   await store.init(dir)                  // mkdir, open active writer
 *   await store.replay(now, p => …)        // boot: stream prior NDJSON
 *   store.append(checkId, point)           // hot path, non-blocking
 *   await store.close()                    // shutdown: flush + close
 *
 * Crash-safety: on hard crash we lose whatever sat in the WriteStream's
 * 16 KB buffer + OS page cache. A clean SIGTERM (`close()`) flushes the
 * writable; the OS still does its own deferred fsync, so the worst-case
 * gap is a few seconds of points — visually one missing tick, not hours.
 *
 * Retention invariant: a sealed file is replayable only if at least one of
 * its points is within the 24h retention window. Since we append-only, a
 * file's mtime equals the timestamp of its newest line. So mtime > 24h
 * old ⇒ every line is past retention ⇒ safe to unlink. This is stricter
 * than "keep two files" from the plan but correct under any rotation
 * cadence and the only invariant that makes 24h recovery safe.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { ChartPoint } from './ws-protocol.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const ROTATION_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
const ROTATION_MS = 6 * 60 * 60 * 1000;        // 6 h
// Only check size/age every N appends — avoids a Date.now() + branch on
// the hot path that would otherwise fire on every probe completion.
const ROTATION_CHECK_EVERY_N = 256;

const FILE_PREFIX = 'chart-points-';
const FILE_SUFFIX = '.ndjson';

export interface DiskPoint {
  /** checkId (kept short — file is hot-written). */
  c: string;
  t: number;
  rt: number | null;
  sc?: number;
  st: 'up' | 'down';
}

export interface StoreStats {
  enabled: boolean;
  dir: string | null;
  activeFile: string | null;
  activeBytes: number;
  activeAgeMs: number;
  bytesWritten: number;
  linesWritten: number;
  writeErrors: number;
  rotations: number;
  /** Populated by replay(); null until init+replay have run. */
  bootLoaded: {
    points: number;
    files: number;
    parseErrors: number;
    skippedExpired: number;
    durationMs: number;
  } | null;
}

/** UTC `YYYYMMDDTHHMMSSZ` is lexicographically sortable. */
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

export class CheckTimeseriesStore {
  private dir: string | null = null;
  private active: ActiveFile | null = null;
  private appendsSinceRotateCheck = 0;
  private rotating = false;
  private enabled = false;

  private bytesWritten = 0;
  private linesWritten = 0;
  private writeErrors = 0;
  private rotations = 0;
  private bootStats: StoreStats['bootLoaded'] = null;

  /**
   * Create the persistence directory and open the active write stream.
   * Fail-open: if mkdir or stream open fails (EACCES on dev boxes, missing
   * /var/lib mount, …) the store stays disabled and append() is a no-op,
   * so the runner keeps working with in-memory-only history.
   */
  async init(dir: string): Promise<boolean> {
    try {
      await fsp.mkdir(dir, { recursive: true });
      this.dir = dir;
      await this.openNewActive();
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn(
        `[timeseries-store] init failed for ${dir}; persistence disabled, live charts will be in-memory-only:`,
        err
      );
      this.enabled = false;
      this.dir = null;
      this.active = null;
      return false;
    }
  }

  /**
   * Stream-parse every NDJSON file in dir, oldest-first. Lines whose
   * timestamp is older than RETENTION_MS from `now` are dropped at read
   * time, so we never grow the in-memory buffer past its design size.
   * Corrupt / truncated lines (last-line torn writes after a hard crash)
   * are counted and skipped — boot never fails on bad data.
   */
  async replay(now: number, onPoint: (p: DiskPoint) => void): Promise<void> {
    const start = Date.now();
    const stats: NonNullable<StoreStats['bootLoaded']> = {
      points: 0,
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
      console.warn('[timeseries-store] readdir failed during replay:', err);
      this.bootStats = { ...stats };
      return;
    }
    const ndjson = entries
      .filter(name => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
      .sort(); // lexicographic == chronological

    for (const name of ndjson) {
      const full = path.join(this.dir, name);
      // Don't try to read a file we're currently writing — at boot we
      // haven't opened the active file yet, but be defensive.
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
            typeof (parsed as DiskPoint).c !== 'string' ||
            typeof (parsed as DiskPoint).t !== 'number'
          ) {
            stats.parseErrors++;
            continue;
          }
          const dp = parsed as DiskPoint;
          if (dp.t < cutoff) {
            stats.skippedExpired++;
            continue;
          }
          if (dp.st !== 'up' && dp.st !== 'down') {
            stats.parseErrors++;
            continue;
          }
          onPoint(dp);
          stats.points++;
        }
      } catch (err) {
        console.warn(`[timeseries-store] failed to read ${full}:`, err);
      }
    }
    stats.durationMs = Date.now() - start;
    this.bootStats = stats;
    console.info(
      `[timeseries-store] boot replay: ${stats.points} points from ${stats.files} files ` +
        `(${stats.parseErrors} parse errors, ${stats.skippedExpired} expired) in ${stats.durationMs}ms`
    );
  }

  /**
   * Async-append one point as a single NDJSON line. Fire-and-forget — we
   * tolerate WriteStream backpressure (Node's writable buffers internally),
   * so this never blocks the status-buffer hook. Errors are counted and
   * logged with rate-limiting so a dead disk doesn't spam stderr.
   */
  append(checkId: string, point: ChartPoint): void {
    if (!this.enabled || !this.active) return;
    const disk: DiskPoint = { c: checkId, t: point.t, rt: point.rt, st: point.st };
    if (typeof point.sc === 'number') disk.sc = point.sc;
    let buf: Buffer;
    try {
      buf = Buffer.from(JSON.stringify(disk) + '\n', 'utf8');
    } catch (err) {
      this.writeErrors++;
      console.warn('[timeseries-store] stringify failed:', err);
      return;
    }
    try {
      this.active.stream.write(buf, err => {
        if (err) {
          this.writeErrors++;
          if (this.writeErrors <= 5 || this.writeErrors % 1000 === 0) {
            console.warn(`[timeseries-store] write error #${this.writeErrors}:`, err);
          }
        }
      });
      this.active.bytes += buf.length;
      this.bytesWritten += buf.length;
      this.linesWritten++;
    } catch (err) {
      this.writeErrors++;
      console.warn('[timeseries-store] write threw:', err);
      return;
    }
    if (++this.appendsSinceRotateCheck >= ROTATION_CHECK_EVERY_N) {
      this.appendsSinceRotateCheck = 0;
      this.maybeRotate();
    }
  }

  /** Force a rotation check (used by tests / admin). */
  checkRotation(): void {
    this.maybeRotate();
  }

  private maybeRotate(): void {
    if (this.rotating || !this.active) return;
    const ageMs = Date.now() - this.active.openedAt;
    if (this.active.bytes < ROTATION_BYTES && ageMs < ROTATION_MS) return;
    this.rotate().catch(err => {
      console.warn('[timeseries-store] rotation failed:', err);
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
      console.warn('[timeseries-store] openNewActive failed mid-rotate:', err);
      return;
    }
    // Swap is implicit now (openNewActive replaced this.active). Close
    // the old stream after the swap so any in-flight write callbacks
    // resolve cleanly — Node's end() flushes the buffer before closing.
    if (old) {
      await new Promise<void>(resolve => old.stream.end(() => resolve()));
    }
    this.rotations++;
    await this.pruneExpiredFiles().catch(err => {
      console.warn('[timeseries-store] prune failed:', err);
    });
    this.rotating = false;
  }

  /**
   * Delete sealed files whose mtime is older than the retention window.
   * Mtime tracks the file's newest write; since we append-only, a file
   * whose mtime is past retention contains only expired points and is
   * safe to remove — replay() would discard every line in it anyway.
   */
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
        // Don't bail the loop — a missing file (concurrent delete) is fine.
        console.warn(`[timeseries-store] prune entry ${name} failed:`, err);
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
      // brand-new file
    }
    // Surface late stream errors so they don't go silent — error count
    // shows up in /admin/ws-stats.
    stream.on('error', err => {
      this.writeErrors++;
      console.warn('[timeseries-store] stream error:', err);
    });
    this.active = { stream, path: full, bytes: initialBytes, openedAt: Date.now() };
  }

  /**
   * Flush the writable buffer to the OS and close the file. Called from
   * shutdown(). Cheap — no JSON serialization, no Map walk — so it
   * doesn't compete with the existing 25s flush budget.
   */
  async close(): Promise<void> {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    this.enabled = false;
    await new Promise<void>(resolve => a.stream.end(() => resolve()));
  }

  stats(): StoreStats {
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
      bootLoaded: this.bootStats,
    };
  }
}
