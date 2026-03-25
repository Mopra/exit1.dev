/**
 * In-memory check schedule for the VPS runner.
 *
 * Replaces the per-cycle Firestore query (`paginateDueChecks`) with a local
 * sorted schedule that is kept in sync via:
 *   1. `onSnapshot` listener — picks up user edits (add/edit/delete/disable/enable)
 *   2. Status buffer callback — picks up `nextCheckAt` updates after each check runs
 *   3. Periodic full resync (every 30 min) — safety net for any missed events
 */

import type { Firestore, Query, DocumentData } from '@google-cloud/firestore';

// Website type mirrors functions/src/types.ts. We use a lightweight alias here
// to avoid importing from the compiled functions/lib/ at module level (the VPS
// loads those via dynamic import after .env is loaded).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Website = any;
type CheckRegion = 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1';

interface ScheduleEntry {
  id: string;
  nextCheckAt: number;
}

// ── Binary search helpers ──────────────────────────────────────────────────

/** Find the index at which `nextCheckAt` should be inserted to keep ascending order. */
function binarySearchInsertIndex(schedule: ScheduleEntry[], nextCheckAt: number): number {
  let lo = 0;
  let hi = schedule.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (schedule[mid].nextCheckAt <= nextCheckAt) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ── CheckSchedule ──────────────────────────────────────────────────────────

export class CheckSchedule {
  /** Full check data keyed by check ID (includes disabled checks for re-enable tracking). */
  private checks = new Map<string, Website>();

  /** Sorted ascending by nextCheckAt. Only non-disabled checks appear here. */
  private schedule: ScheduleEntry[] = [];

  private region: CheckRegion = 'vps-eu-1';
  private firestoreRef: Firestore | null = null;
  private snapshotUnsubscribe: (() => void) | null = null;
  private initialized = false;

  // ── Initialization ─────────────────────────────────────────────────────

  /**
   * One-time load of all checks for this region from Firestore.
   * Must be called before `getDueChecks()` or `startRealtimeSync()`.
   */
  async init(region: CheckRegion, firestore: Firestore): Promise<void> {
    this.region = region;
    this.firestoreRef = firestore;

    const start = Date.now();
    const snapshot = await firestore
      .collection('checks')
      .where('checkRegion', '==', region)
      .get();

    this.checks.clear();
    this.schedule = [];

    for (const doc of snapshot.docs) {
      const data = { ...doc.data(), id: doc.id } as Website;
      this.checks.set(doc.id, data);
      if (!data.disabled && data.nextCheckAt != null) {
        this.schedule.push({ id: doc.id, nextCheckAt: data.nextCheckAt });
      }
    }

    this.schedule.sort((a, b) => a.nextCheckAt - b.nextCheckAt);
    this.initialized = true;

    console.info(
      `[CheckSchedule] Loaded ${this.checks.size} checks (${this.schedule.length} scheduled) in ${Date.now() - start}ms`
    );
  }

  // ── Real-time sync via onSnapshot on check_edits ────────────────────────
  // Listens on the lightweight `check_edits` collection instead of the full
  // `checks` collection. This avoids a feedback loop where the VPS's own
  // status buffer writes trigger onSnapshot reads back (~150K+ reads/day).
  // `check_edits` only contains user-initiated mutations (~350 docs/day).

  /**
   * Attach a Firestore `onSnapshot` listener on `check_edits`.
   * When a user adds/edits/deletes a check, Cloud Functions write a small
   * doc to `check_edits`. This listener picks it up and fetches the actual
   * check data with a single Firestore read.
   */
  startRealtimeSync(): void {
    if (!this.firestoreRef) throw new Error('CheckSchedule not initialized');
    if (this.snapshotUnsubscribe) return; // already listening

    const editsCollection = this.firestoreRef.collection('check_edits');

    this.snapshotUnsubscribe = editsCollection.onSnapshot(
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          // Only process newly added edit docs (not the initial snapshot backlog)
          if (change.type !== 'added') continue;

          const editDoc = change.doc.data() as {
            checkId: string;
            action: 'added' | 'modified' | 'removed';
            timestamp: number;
          };

          if (!editDoc.checkId || !editDoc.action) continue;

          // Ignore edit docs older than 2 minutes (stale from before this process started)
          if (editDoc.timestamp && editDoc.timestamp < Date.now() - 2 * 60 * 1000) continue;

          this.handleCheckEdit(editDoc.checkId, editDoc.action);
        }
      },
      (err) => {
        console.error('[CheckSchedule] onSnapshot error on check_edits:', err);
      }
    );

    console.info('[CheckSchedule] Real-time sync started (listening on check_edits)');
  }

  /**
   * Process a single check edit notification.
   * Fetches the current check data from Firestore for adds/modifications.
   */
  private handleCheckEdit(checkId: string, action: 'added' | 'modified' | 'removed'): void {
    if (action === 'removed') {
      this.checks.delete(checkId);
      this.removeFromSchedule(checkId);
      console.info(`[CheckSchedule] Check removed: ${checkId}`);
      return;
    }

    // For added/modified, fetch the latest check data from Firestore
    this.firestoreRef!
      .collection('checks')
      .doc(checkId)
      .get()
      .then((doc) => {
        if (!doc.exists) {
          // Check was deleted between the edit notification and our read
          this.checks.delete(checkId);
          this.removeFromSchedule(checkId);
          return;
        }

        const data = { ...doc.data(), id: doc.id } as Website;

        // Only process checks for our region
        if (data.checkRegion && data.checkRegion !== this.region) return;

        const prev = this.checks.get(checkId);
        this.checks.set(checkId, data);

        const wasScheduled = prev && !prev.disabled && prev.nextCheckAt != null;
        const shouldBeScheduled = !data.disabled && data.nextCheckAt != null;

        if (wasScheduled && !shouldBeScheduled) {
          this.removeFromSchedule(checkId);
        } else if (!wasScheduled && shouldBeScheduled) {
          this.insertIntoSchedule(checkId, data.nextCheckAt);
        } else if (shouldBeScheduled) {
          // Always reposition on edit — user may have changed frequency, URL, etc.
          this.removeFromSchedule(checkId);
          this.insertIntoSchedule(checkId, data.nextCheckAt);
        }

        console.info(`[CheckSchedule] Check ${action}: ${checkId}`);
      })
      .catch((err) => {
        console.error(`[CheckSchedule] Failed to fetch check ${checkId}:`, err);
      });
  }

  /** Detach the onSnapshot listener. Call during graceful shutdown. */
  stopRealtimeSync(): void {
    if (this.snapshotUnsubscribe) {
      this.snapshotUnsubscribe();
      this.snapshotUnsubscribe = null;
      console.info('[CheckSchedule] Real-time sync stopped');
    }
  }

  // ── Due check retrieval ────────────────────────────────────────────────

  /**
   * Return all checks with `nextCheckAt <= now`.
   * Returns full Website objects for passing to `processCheckBatches`.
   */
  getDueChecks(now: number): Website[] {
    if (!this.initialized) return [];

    const due: Website[] = [];
    for (const entry of this.schedule) {
      if (entry.nextCheckAt > now) break;
      const check = this.checks.get(entry.id);
      if (check && !check.disabled) {
        due.push(check);
      }
    }
    return due;
  }

  // ── Schedule mutation (called from status buffer hook) ─────────────────

  /**
   * Update the nextCheckAt for a check in the in-memory schedule.
   * Called by the status buffer hook after each check execution.
   */
  updateNextCheckAt(checkId: string, nextCheckAt: number): void {
    const check = this.checks.get(checkId);
    if (!check) return;

    check.nextCheckAt = nextCheckAt;
    this.removeFromSchedule(checkId);
    if (!check.disabled) {
      this.insertIntoSchedule(checkId, nextCheckAt);
    }
  }

  /**
   * Merge partial data into a check's in-memory record.
   * Used by the status buffer hook for fields beyond nextCheckAt.
   */
  updateCheck(checkId: string, partial: Partial<Website>): void {
    const check = this.checks.get(checkId);
    if (!check) return;

    const wasDisabled = check.disabled;
    Object.assign(check, partial);

    // Handle disable/enable transitions
    if (!wasDisabled && check.disabled) {
      this.removeFromSchedule(checkId);
    } else if (wasDisabled && !check.disabled && check.nextCheckAt != null) {
      this.insertIntoSchedule(checkId, check.nextCheckAt);
    }
  }

  // ── Safety net resync ──────────────────────────────────────────────────

  /**
   * Full re-read from Firestore. Replaces both checks Map and schedule array.
   * Called every 30 minutes as a safety net for missed onSnapshot events.
   */
  async fullResync(): Promise<void> {
    if (!this.firestoreRef) return;

    const start = Date.now();
    const snapshot = await this.firestoreRef
      .collection('checks')
      .where('checkRegion', '==', this.region)
      .get();

    // Build new structures first, then swap atomically.
    // Avoids a window where the Map is empty (status buffer hook
    // would silently drop updates during the Firestore await).
    const newChecks = new Map<string, Website>();
    const newSchedule: ScheduleEntry[] = [];

    for (const doc of snapshot.docs) {
      const data = { ...doc.data(), id: doc.id } as Website;
      newChecks.set(doc.id, data);
      if (!data.disabled && data.nextCheckAt != null) {
        newSchedule.push({ id: doc.id, nextCheckAt: data.nextCheckAt });
      }
    }

    newSchedule.sort((a, b) => a.nextCheckAt - b.nextCheckAt);

    const prevSize = this.checks.size;
    this.checks = newChecks;
    this.schedule = newSchedule;

    const drift = Math.abs(this.checks.size - prevSize);
    console.info(
      `[CheckSchedule] Resync: ${this.checks.size} checks (${this.schedule.length} scheduled) in ${Date.now() - start}ms` +
        (drift > 0 ? ` | drift: ${drift} checks` : '')
    );
  }

  // ── Stats (for health endpoint) ────────────────────────────────────────

  getStats(): { totalChecks: number; scheduledChecks: number; dueNow: number; nextDueInMs: number | null } {
    const now = Date.now();
    let dueNow = 0;
    for (const entry of this.schedule) {
      if (entry.nextCheckAt > now) break;
      dueNow++;
    }
    const nextDueInMs = this.schedule.length > 0
      ? Math.max(0, this.schedule[0].nextCheckAt - now)
      : null;

    return {
      totalChecks: this.checks.size,
      scheduledChecks: this.schedule.length,
      dueNow,
      nextDueInMs,
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private insertIntoSchedule(id: string, nextCheckAt: number): void {
    const idx = binarySearchInsertIndex(this.schedule, nextCheckAt);
    this.schedule.splice(idx, 0, { id, nextCheckAt });
  }

  private removeFromSchedule(id: string): void {
    const idx = this.schedule.findIndex((e) => e.id === id);
    if (idx !== -1) this.schedule.splice(idx, 1);
  }
}
