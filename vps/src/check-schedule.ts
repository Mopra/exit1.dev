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

// ── Resync merge ───────────────────────────────────────────────────────────
//
// The runner lets the Firestore copy of a check go stale on purpose (hourly
// deferred flush, steady-state skip up to a day). A resync that trusted the
// doc's `nextCheckAt` therefore saw thousands of checks as overdue and fired
// them in one herd, 2.5x the normal probe rate, and put intervals in phase so
// the wave echoed for 20 minutes. So for a check already in memory the resync
// keeps what the runner knows and takes only config from the doc.

/**
 * Fields the runner writes after each probe (see the status buffer hook in
 * runner.ts). In memory they are always at least as fresh as the doc, unless
 * another writer changed the doc.
 */
const RUNNER_OWNED_FIELDS = [
  'nextCheckAt',
  'lastChecked',
  'status',
  'detailedStatus',
  'lastStatusChange',
  'responseTime',
  'lastStatusCode',
  'consecutiveFailures',
  'consecutiveSuccesses',
  'lastFailureTime',
  'lastDowntime',
  'lastError',
  'lastHistoryAt',
  'pendingDownEmail',
  'pendingUpEmail',
  'pendingDownSince',
  'pendingUpSince',
  'pendingDownSms',
  'pendingUpSms',
  'pendingDownWebhooks',
  'pendingUpWebhooks',
] as const;

/**
 * Config that decides whether and when a check runs. A difference between
 * memory and the doc means an edit this process never heard about.
 */
const SCHEDULE_CONFIG_FIELDS = ['disabled', 'checkFrequency', 'type', 'url', 'maintenanceMode', 'userId'] as const;

/** More overdue checks than this in one resync is a herd, and gets spread. */
export const RESYNC_SPREAD_THRESHOLD = 25;
/** Longest delay the spread gives an overdue check. */
export const RESYNC_SPREAD_MAX_MS = 5 * 60 * 1000;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * True when the doc holds something this process did not write: an edit that
 * never reached the `check_edits` listener, or a write by another process.
 * False when the doc is only a stale copy of the runner's own state.
 */
export function docWasChangedElsewhere(prev: Website, doc: Website): boolean {
  for (const key of SCHEDULE_CONFIG_FIELDS) {
    if ((prev[key] ?? null) !== (doc[key] ?? null)) return true;
  }
  const prevChecked = num(prev.lastChecked);
  const docChecked = num(doc.lastChecked);
  // Edits and "check now" reset lastChecked to 0 to force a fresh probe.
  if (docChecked === 0 && prevChecked > 0) return true;
  // The runner's doc copy only ever lags memory. A doc that is ahead was
  // written by someone else.
  if (docChecked > prevChecked) return true;
  if (num(doc.nextCheckAt) > num(prev.nextCheckAt)) return true;
  return false;
}

/** Newest timestamp under `field` in a map keyed by DNS record type. */
function newestStamp(byType: unknown, field: 'capturedAt' | 'queriedAt'): number {
  if (!byType || typeof byType !== 'object') return 0;
  let newest = 0;
  for (const entry of Object.values(byType as Record<string, Record<string, unknown> | null>)) {
    newest = Math.max(newest, num(entry?.[field]));
  }
  return newest;
}

/**
 * A check read from Firestore, with the DNS drift state taken from whichever
 * side is newer.
 *
 * The runner re-baselines in memory when it alerts on a DNS change, and that
 * write can sit in the status buffer for a while. A doc read in that window
 * (full resync, or the reload after any edit) still holds the old baseline.
 * Trusting it made the next probe see the same drift and alert again. The
 * accept-baseline endpoint also writes a baseline, so memory cannot simply
 * win: the baseline with the newest `capturedAt` does, and `changes` and the
 * auto-accept counter travel with it. Config (`recordTypes`, `autoAccept`)
 * always comes from the doc. Returns `doc` itself when nothing is replaced.
 */
export function withFreshestDnsState(prev: Website | undefined, doc: Website): Website {
  const mem = prev?.dnsMonitoring as Record<string, unknown> | undefined;
  const stored = doc.dnsMonitoring as Record<string, unknown> | undefined;
  if (!mem || !stored || typeof mem !== 'object' || typeof stored !== 'object') return doc;

  const merged: Record<string, unknown> = { ...stored };
  let replaced = false;
  if (newestStamp(mem.baseline, 'capturedAt') > newestStamp(stored.baseline, 'capturedAt')) {
    for (const key of ['baseline', 'changes', 'autoAcceptConsecutiveCount']) {
      if (key in mem) merged[key] = mem[key];
    }
    replaced = true;
  }
  if (newestStamp(mem.lastResult, 'queriedAt') > newestStamp(stored.lastResult, 'queriedAt')) {
    merged.lastResult = mem.lastResult;
    replaced = true;
  }
  return replaced ? { ...doc, dnsMonitoring: merged } : doc;
}

/**
 * Build the in-memory record for a check read by fullResync. `prev` is the
 * record already in memory, if any. Returns the record and whether its
 * schedule time came from memory (`kept`) or from the doc.
 */
export function mergeResyncedCheck(prev: Website | undefined, doc: Website): { check: Website; kept: boolean } {
  if (!prev) return { check: doc, kept: false };
  if (docWasChangedElsewhere(prev, doc)) return { check: withFreshestDnsState(prev, doc), kept: false };

  const check = withFreshestDnsState(prev, { ...doc });
  for (const key of RUNNER_OWNED_FIELDS) {
    if (key in prev) check[key] = prev[key];
  }
  // The certificate and its alert state travel together, and a cron also
  // writes them. Whichever side observed the certificate last wins.
  if (num(prev.sslCertificate?.lastChecked) >= num(doc.sslCertificate?.lastChecked)) {
    if ('sslCertificate' in prev) check.sslCertificate = prev.sslCertificate;
    if ('sslAlertedState' in prev) check.sslAlertedState = prev.sslAlertedState;
  }
  return { check, kept: true };
}

/**
 * Delay for one overdue check when a resync finds a herd of them: uniform
 * over one check interval, capped at RESYNC_SPREAD_MAX_MS.
 */
export function resyncSpreadDelayMs(check: Website, random: () => number): number {
  const intervalMs = num(check.checkFrequency) * 60_000;
  const windowMs = intervalMs > 0 ? Math.min(intervalMs, RESYNC_SPREAD_MAX_MS) : RESYNC_SPREAD_MAX_MS;
  return Math.floor(random() * windowMs);
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
  private onCheckEdited: ((checkId: string, gone: boolean) => void) | null = null;
  private onCheckResynced: ((checkId: string, doc: Record<string, unknown>) => void) | null = null;

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

  /**
   * Register a callback fired for every `check_edits` notification (added,
   * modified or removed). An edit means another writer changed the check doc,
   * so the runner drops what the status buffer remembers having written: the
   * steady-state flush skip must not leave a foreign value (an edit resets
   * lastChecked to 0, for example) in the doc until the refresh floor.
   * `gone` is true when this region no longer owns the check (deleted, or
   * moved to another region): anything still buffered for it must be dropped.
   */
  setCheckEditedCallback(cb: (checkId: string, gone: boolean) => void): void {
    this.onCheckEdited = cb;
  }

  /**
   * Register a callback fired with every check doc read by fullResync, before
   * the swap. Lets the runner notice docs another writer changed without an
   * edit notification reaching it.
   */
  setCheckResyncedCallback(cb: (checkId: string, doc: Record<string, unknown>) => void): void {
    this.onCheckResynced = cb;
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
   *
   * At boot there is no memory to keep, and the Firestore copy lags on
   * purpose, so most checks read as overdue. A herd of them is spread with
   * jitter, the same way fullResync does it.
   */
  async init(
    region: CheckRegion,
    firestore: Firestore,
    opts: { now?: number; random?: () => number } = {},
  ): Promise<void> {
    this.region = region;
    this.firestoreRef = firestore;

    const start = Date.now();
    const snapshot = await firestore
      .collection('checks')
      .where('checkRegion', '==', region)
      .get();

    const now = opts.now ?? Date.now();
    const random = opts.random ?? Math.random;

    this.checks.clear();
    this.schedule = [];
    this.userIndex.clear();

    const overdue: Website[] = [];
    for (const doc of snapshot.docs) {
      const data = { ...doc.data(), id: doc.id } as Website;
      this.checks.set(doc.id, data);
      this.indexUserAdd(data.userId, doc.id);
      if (!data.disabled && data.nextCheckAt != null) {
        if (data.nextCheckAt <= now) overdue.push(data);
        else this.schedule.push({ id: doc.id, nextCheckAt: data.nextCheckAt });
      }
    }

    // The jittered time lives in memory only; the next probe writes a real one.
    const spread = overdue.length > RESYNC_SPREAD_THRESHOLD;
    for (const data of overdue) {
      if (spread) data.nextCheckAt = now + resyncSpreadDelayMs(data, random);
      this.schedule.push({ id: data.id, nextCheckAt: data.nextCheckAt });
    }

    this.schedule.sort((a, b) => a.nextCheckAt - b.nextCheckAt);
    this.initialized = true;

    console.info(
      `[CheckSchedule] Loaded ${this.checks.size} checks (${this.schedule.length} scheduled) in ${Date.now() - start}ms` +
        ` | ${overdue.length} overdue` +
        (spread ? ' (spread with jitter)' : '')
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
    this.onCheckEdited?.(checkId, action === 'removed');
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
          this.onCheckEdited?.(checkId, true);
          this.checks.delete(checkId);
          this.removeFromSchedule(checkId);
          return;
        }

        // An edit reloads the whole doc. Keep a DNS re-baseline the status
        // buffer has not written yet (see withFreshestDnsState).
        const data = withFreshestDnsState(
          this.checks.get(checkId),
          { ...doc.data(), id: doc.id } as Website,
        );

        // If the check has moved to a different region, drop our stale copy.
        // Firestore's onSnapshot delivers events from `check_edits` (a notification
        // stream), not from `checks` directly — so there is no "doc no longer
        // matches my filter" removal event when checkRegion changes. Without
        // this branch, the losing region keeps a stale entry until the next
        // 30-minute fullResync().
        if (data.checkRegion && data.checkRegion !== this.region) {
          this.onCheckEdited?.(checkId, true);
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
   *
   * A check already in memory keeps its schedule time and probe state; only
   * its config comes from the doc. The doc's values are used for checks that
   * are new here or that another writer changed (see mergeResyncedCheck).
   * If those leave a herd of overdue checks, it is spread with jitter.
   */
  async fullResync(opts: { now?: number; random?: () => number } = {}): Promise<void> {
    if (!this.firestoreRef) return;

    const start = Date.now();
    const snapshot = await this.firestoreRef
      .collection('checks')
      .where('checkRegion', '==', this.region)
      .get();

    // Everything below is synchronous: memory is read and swapped in one
    // tick, so no probe result landing during the Firestore await is lost.
    const now = opts.now ?? Date.now();
    const random = opts.random ?? Math.random;

    // Build new structures first, then swap atomically.
    // Avoids a window where the Map is empty (status buffer hook
    // would silently drop updates during the Firestore await).
    const newChecks = new Map<string, Website>();
    const newSchedule: ScheduleEntry[] = [];
    const newUserIndex = new Map<string, Set<string>>();
    // Overdue checks whose schedule time came from the doc, not from memory.
    const overdueFromDoc: Website[] = [];
    let kept = 0;

    for (const doc of snapshot.docs) {
      const raw = { ...doc.data(), id: doc.id } as Website;
      this.onCheckResynced?.(doc.id, raw as unknown as Record<string, unknown>);
      const merged = mergeResyncedCheck(this.checks.get(doc.id), raw);
      const data = merged.check;
      if (merged.kept) kept++;
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
        if (!merged.kept && data.nextCheckAt <= now) overdueFromDoc.push(data);
        else newSchedule.push({ id: doc.id, nextCheckAt: data.nextCheckAt });
      }
    }

    // A few overdue checks are real work (a missed edit, a new check) and run
    // at once. A herd would spike the probe rate, so it is spread out. The
    // jittered time lives in memory only; the next probe writes a real one.
    const spread = overdueFromDoc.length > RESYNC_SPREAD_THRESHOLD;
    for (const data of overdueFromDoc) {
      if (spread) data.nextCheckAt = now + resyncSpreadDelayMs(data, random);
      newSchedule.push({ id: data.id, nextCheckAt: data.nextCheckAt });
    }

    newSchedule.sort((a, b) => a.nextCheckAt - b.nextCheckAt);

    const prevSize = this.checks.size;
    this.checks = newChecks;
    this.schedule = newSchedule;
    this.userIndex = newUserIndex;

    const drift = Math.abs(this.checks.size - prevSize);
    console.info(
      `[CheckSchedule] Resync: ${this.checks.size} checks (${this.schedule.length} scheduled) in ${Date.now() - start}ms` +
        ` | kept in-memory schedule for ${kept}, ${overdueFromDoc.length} overdue from Firestore` +
        (spread ? ' (spread with jitter)' : '') +
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
