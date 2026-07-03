/**
 * In-memory check schedule for the VPS runner.
 *
 * Replaces the per-cycle Firestore query (`paginateDueChecks`) with a local
 * sorted schedule that is kept in sync via:
 *   1. `onSnapshot` listener — picks up user edits (add/edit/delete/disable/enable)
 *   2. Status buffer callback — picks up `nextCheckAt` updates after each check runs
 *   3. Periodic full resync (every 12h, see RESYNC_INTERVAL_MS in runner.ts)
 *      — safety net for any missed events
 */

import type { Firestore, Query, DocumentData } from '@google-cloud/firestore';
import { LIVE_FIELD_NAMES, type LiveFields } from './ws-protocol.js';

// Website type mirrors functions/src/types.ts. We use a lightweight alias here
// to avoid importing from the compiled functions/lib/ at module level (the VPS
// loads those via dynamic import after .env is loaded).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Website = any;
type CheckRegion = 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1' | 'vps-us-1';

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

  /**
   * userId → set of checkIds owned by that user. Maintained in lockstep with
   * `checks` so the WS server can compute snapshot-on-auth in O(checks-owned)
   * instead of O(total-checks-in-region). Without this, snapshot cost would
   * scale with regional check count (~10K per VPS) per connection — fine for
   * a single user, ruinous when 100 tabs open simultaneously.
   *
   * Includes disabled checks so the snapshot reflects the user's full
   * dashboard state, mirroring what the frontend's Firestore `onSnapshot`
   * delivers today.
   */
  private userIndex = new Map<string, Set<string>>();

  private region: CheckRegion = 'vps-eu-1';
  private firestoreRef: Firestore | null = null;
  private snapshotUnsubscribe: (() => void) | null = null;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private onHeartbeatChange: ((action: 'added' | 'modified' | 'removed', checkId: string, check?: Website) => void) | null = null;
  private onLiveFieldsChange: ((checkId: string, ownerUserId: string, delta: LiveFields) => void) | null = null;
  private onSettingsEdit: ((userId: string) => void) | null = null;

  /**
   * Register a callback fired when a user's alert settings (emailSettings,
   * smsSettings, webhooks) change. Settings mutations write a
   * `{settingsUserId}` doc to `check_edits` (same collection/listener/TTL as
   * check edits); the runner uses this to evict its per-user settings cache
   * so unchecking an email alert takes effect immediately instead of after
   * the 5-minute cache TTL.
   */
  setSettingsEditCallback(cb: (userId: string) => void): void {
    this.onSettingsEdit = cb;
  }

  /** Register a callback for heartbeat check changes (add/modify/remove). */
  setHeartbeatChangeCallback(cb: (action: 'added' | 'modified' | 'removed', checkId: string, check?: Website) => void): void {
    this.onHeartbeatChange = cb;
  }

  /**
   * Register a callback fired when a user edit (via `check_edits`) changes
   * any of the streamed live fields. Used by the runner to bridge user
   * edits into the WS broadcast pipeline — the status-buffer hook only
   * covers probe-driven changes, so without this path the frontend
   * Firestore watcher would see toggles like `disabled` / `maintenanceMode`
   * that WS never broadcasts.
   */
  setLiveFieldsChangeCallback(
    cb: (checkId: string, ownerUserId: string, delta: LiveFields) => void,
  ): void {
    this.onLiveFieldsChange = cb;
  }

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
    this.userIndex.clear();

    for (const doc of snapshot.docs) {
      const data = { ...doc.data(), id: doc.id } as Website;
      this.checks.set(doc.id, data);
      this.indexUserAdd(data.userId, doc.id);
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

    // The first snapshot callback delivers the existing backlog as 'added'
    // changes. Those all predate init()'s full load, so skip that one
    // callback wholesale. Do NOT filter later events by doc timestamp: after
    // a stream disconnect the SDK delivers edits made while offline in a
    // later callback, and an age filter silently drops them — leaving a
    // disabled check probing (and alerting) until the next full resync.
    let isInitialSnapshot = true;

    this.snapshotUnsubscribe = editsCollection.onSnapshot(
      (snapshot) => {
        if (isInitialSnapshot) {
          isInitialSnapshot = false;
          return;
        }
        for (const change of snapshot.docChanges()) {
          // Edit docs are append-only; 'removed' changes are just TTL cleanup.
          if (change.type !== 'added') continue;

          const editDoc = change.doc.data() as {
            checkId?: string;
            action?: 'added' | 'modified' | 'removed';
            settingsUserId?: string;
            timestamp: number;
          };

          // Settings-invalidation docs share the collection but carry
          // `settingsUserId` instead of `checkId`/`action`.
          if (editDoc.settingsUserId && this.onSettingsEdit) {
            this.onSettingsEdit(editDoc.settingsUserId);
            continue;
          }

          if (!editDoc.checkId || !editDoc.action) continue;

          this.handleCheckEdit(editDoc.checkId, editDoc.action);
        }
      },
      (err) => {
        // An errored listener is dead — the SDK does not retry after
        // surfacing an error here. Resubscribe after a short delay (the
        // error handler fires again if it keeps failing, giving a 10s retry
        // loop) and run a full resync to recover edits missed while down.
        console.error('[CheckSchedule] onSnapshot error on check_edits, resubscribing in 10s:', err);
        this.snapshotUnsubscribe = null;
        this.resubscribeTimer = setTimeout(() => {
          this.resubscribeTimer = null;
          try {
            this.startRealtimeSync();
            this.fullResync().catch((e) =>
              console.error('[CheckSchedule] Post-resubscribe resync failed:', e)
            );
          } catch (e) {
            console.error('[CheckSchedule] Resubscribe failed:', e);
          }
        }, 10_000);
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
      const removedCheck = this.checks.get(checkId);
      if (removedCheck?.type === 'heartbeat' && this.onHeartbeatChange) {
        this.onHeartbeatChange('removed', checkId);
      }
      if (removedCheck) this.indexUserRemove(removedCheck.userId, checkId);
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

        // If the check has moved to a different region, drop our stale copy.
        // Firestore's onSnapshot delivers events from `check_edits` (a notification
        // stream), not from `checks` directly — so there is no "doc no longer
        // matches my filter" removal event when checkRegion changes. Without
        // this branch, the losing region keeps a stale entry until the next
        // 30-minute fullResync().
        if (data.checkRegion && data.checkRegion !== this.region) {
          if (this.checks.has(checkId)) {
            const stale = this.checks.get(checkId);
            if (stale?.type === 'heartbeat' && this.onHeartbeatChange) {
              this.onHeartbeatChange('removed', checkId);
            }
            if (stale) this.indexUserRemove(stale.userId, checkId);
            this.checks.delete(checkId);
            this.removeFromSchedule(checkId);
            console.info(`[CheckSchedule] Check ${checkId} moved to ${data.checkRegion}, removed locally`);
          }
          return;
        }

        const prev = this.checks.get(checkId);
        // Ownership shouldn't change on a normal edit, but if it does (admin
        // reassignment, data fixup), reflect it in the index so the WS layer
        // doesn't keep broadcasting to the old owner.
        if (prev && prev.userId !== data.userId) {
          this.indexUserRemove(prev.userId, checkId);
        }
        this.indexUserAdd(data.userId, checkId);
        this.checks.set(checkId, data);

        if (data.type === 'heartbeat' && this.onHeartbeatChange) {
          this.onHeartbeatChange(action, checkId, data);
        }

        // WS bridge for user-driven edits. Probe-driven changes already
        // flow through the status-buffer hook; this path covers edits made
        // through the API/UI (toggling disabled, maintenanceMode, etc.).
        // Skipped on `added` because new checks reach existing WS clients
        // via the next snapshot-on-auth — there's no prior state to diff
        // against and re-broadcasting the whole thing would duplicate the
        // snapshot path.
        //
        // Known hole: a check born with `disabled: true` or
        // `maintenanceMode: true` doesn't get a state segment opened
        // here. Acceptable in practice because (a) born-disabled checks
        // produce no ChartPoints, so the chart has no waveform to band
        // anyway; (b) the next runner restart's boot reconciliation
        // opens the segment from `disabledAt` / `maintenanceStartedAt`.
        // If we ever want born-state bands without waiting for a
        // restart, fire a dedicated `onCheckBorn` callback here.
        if (action === 'modified' && prev && data.userId && this.onLiveFieldsChange) {
          const delta: LiveFields = {};
          const deltaBag = delta as unknown as Record<string, unknown>;
          for (const key of LIVE_FIELD_NAMES) {
            // Use !== for shallow inequality; objects/arrays would always
            // mismatch via this, but the streamed schema is scalar-only so
            // this is safe.
            if (prev[key] !== data[key]) {
              const next = data[key];
              if (next !== undefined) deltaBag[key] = next;
            }
          }
          if (Object.keys(delta).length > 0) {
            this.onLiveFieldsChange(checkId, data.userId, delta);
          }
        }

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
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
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
   * Return the in-memory check object (or undefined if not tracked).
   * Used by the status buffer hook to read current dnsMonitoring before merging sub-fields.
   */
  getCheck(checkId: string): Website | undefined {
    return this.checks.get(checkId);
  }

  /**
   * Iterate every loaded check. Used by state-segment reconciliation at
   * boot to walk current `disabled` / `maintenanceMode` flags after the
   * NDJSON replay so any segment that was implicitly closed (while the
   * VPS was offline) gets resolved against the authoritative Firestore
   * snapshot.
   */
  allChecks(): IterableIterator<Website> {
    return this.checks.values();
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
      this.removeFromSchedule(checkId); // defensive: remove first to prevent duplicates
      this.insertIntoSchedule(checkId, check.nextCheckAt);
    }
  }

  // ── Safety net resync ──────────────────────────────────────────────────

  /**
   * Full re-read from Firestore. Replaces both checks Map and schedule array.
   * Called periodically (12h) and after listener resubscription as a safety
   * net for missed onSnapshot events.
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
    const newUserIndex = new Map<string, Set<string>>();

    for (const doc of snapshot.docs) {
      const data = { ...doc.data(), id: doc.id } as Website;
      newChecks.set(doc.id, data);
      if (data.userId) {
        let set = newUserIndex.get(data.userId);
        if (!set) {
          set = new Set<string>();
          newUserIndex.set(data.userId, set);
        }
        set.add(doc.id);
      }
      if (!data.disabled && data.nextCheckAt != null) {
        newSchedule.push({ id: doc.id, nextCheckAt: data.nextCheckAt });
      }
    }

    newSchedule.sort((a, b) => a.nextCheckAt - b.nextCheckAt);

    const prevSize = this.checks.size;
    this.checks = newChecks;
    this.schedule = newSchedule;
    this.userIndex = newUserIndex;

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

  // ── Heartbeat helpers ──────────────────────────────────────────────────

  /** Return all heartbeat checks with their tokens for populating the VPS token index. */
  getHeartbeatTokens(): Array<{ checkId: string; token: string }> {
    const tokens: Array<{ checkId: string; token: string }> = [];
    for (const [id, check] of this.checks) {
      if (check.type === 'heartbeat' && check.heartbeatToken) {
        tokens.push({ checkId: id, token: check.heartbeatToken });
      }
    }
    return tokens;
  }

  // ── User index helpers (for WS snapshot/broadcast) ─────────────────────

  /**
   * Return every check owned by `userId` in this region. Used by the WS
   * server to compute snapshot-on-auth without scanning the full check map.
   * Includes disabled checks so the snapshot mirrors the user's complete
   * dashboard state (the frontend hides disabled checks but tracks them).
   */
  getChecksForUser(userId: string): Website[] {
    const ids = this.userIndex.get(userId);
    if (!ids || ids.size === 0) return [];
    const result: Website[] = [];
    for (const id of ids) {
      const check = this.checks.get(id);
      if (check) result.push(check);
    }
    return result;
  }

  /** Return the owner userId for a check (or undefined if unknown). */
  getCheckOwner(checkId: string): string | undefined {
    return this.checks.get(checkId)?.userId;
  }

  private indexUserAdd(userId: string | undefined, checkId: string): void {
    if (!userId) return;
    let set = this.userIndex.get(userId);
    if (!set) {
      set = new Set<string>();
      this.userIndex.set(userId, set);
    }
    set.add(checkId);
  }

  private indexUserRemove(userId: string | undefined, checkId: string): void {
    if (!userId) return;
    const set = this.userIndex.get(userId);
    if (!set) return;
    set.delete(checkId);
    if (set.size === 0) this.userIndex.delete(userId);
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private insertIntoSchedule(id: string, nextCheckAt: number): void {
    const idx = binarySearchInsertIndex(this.schedule, nextCheckAt);
    this.schedule.splice(idx, 0, { id, nextCheckAt });
  }

  private removeFromSchedule(id: string): void {
    // Remove ALL occurrences — duplicates can accumulate from races between
    // status hook and realtime sync, and a single stale entry corrupts sort order.
    for (let i = this.schedule.length - 1; i >= 0; i--) {
      if (this.schedule[i].id === id) this.schedule.splice(i, 1);
    }
  }
}
