/**
 * Shadow-mode telemetry comparing WS-streamed state transitions against
 * Firestore arrivals for the same check.
 *
 * What this measures: WHEN a check actually transitions states (UP→DOWN,
 * disabled toggled, etc.), do WS and Firestore agree on the transition
 * and deliver it within a reasonable convergence window? That's the
 * question Phase 5 cutover depends on.
 *
 * What this DOESN'T measure: per-tick heartbeat alignment. WS broadcasts
 * every check execution; Firestore status-buffer dedups heartbeats that
 * don't change meaningfully. Comparing those would always show massive
 * "WS-only" deltas — that's by design, not a bug.
 *
 * Two design decisions enable correct measurement:
 *
 *   1. **Accumulator per side.** WS sends deltas (only fields that
 *      changed in this tick); Firestore arrives with full state. We
 *      merge each WS delta into a per-check "WS-known full state" map
 *      so hashes are computed over equivalent state shapes on both
 *      sides.
 *
 *   2. **Transition-field hash, not full-state hash.** Convergence is
 *      computed over `{status, detailedStatus, disabled, maintenanceMode,
 *      lastError}` only — the fields whose change represents a real
 *      state transition. The continuous-valued fields (lastChecked,
 *      responseTime, etc.) are tracked in the accumulator but excluded
 *      from the convergence hash, because WS will always observe them
 *      earlier than Firestore by ~1.5–3s and reporting that as mismatch
 *      would make the bake target unreachable.
 *
 * The convergence window logic itself is unchanged from before:
 *   - Same source recorded twice in a row with same hash → no-op (dedup).
 *   - WS transition arrives → record entry. Within 5s of an FS entry of
 *     same hash → converged. Otherwise pending.
 *   - Pending → unmatched after 10s → wsOnly / firestoreOnly.
 *   - Both arrived in-window with different hashes → hashDiverged.
 *
 * Bake target ([Docs/vps-live-primary.md] Phase 4): <0.1% mismatch
 * sustained 24h across all regions.
 */

import type { LiveFields } from './ws-protocol';

const CONVERGE_WINDOW_MS = 5_000;
const SETTLE_WINDOW_MS = 10_000;
const RECENT_ENTRIES_PER_CHECK = 16;
const SWEEP_INTERVAL_MS = 2_000;
const PENDING_TTL_MS = 60_000;

/**
 * Fields whose change counts as a "transition" for shadow-mode purposes.
 * Continuous-valued fields (lastChecked, nextCheckAt, responseTime,
 * lastStatusCode, consecutiveFailures, consecutiveSuccesses) are tracked
 * in the accumulator but excluded from the convergence hash — they always
 * differ between WS and FS by delivery jitter, and reporting that as
 * mismatch drowns out real bugs.
 */
const TRANSITION_FIELDS = [
  'status',
  'detailedStatus',
  'disabled',
  'maintenanceMode',
  'lastError',
] as const;

type Source = 'ws' | 'fs';
type Region = string;

interface RingEntry {
  source: Source;
  region: Region;
  hash: string;
  at: number;
  matched: boolean;
  classified: boolean;
}

interface CountersRegion {
  converged: number;
  wsOnly: number;
  firestoreOnly: number;
  hashDiverged: number;
  wsArrivals: number;
  fsArrivals: number;
  wsTransitions: number;
  fsTransitions: number;
}

function freshCounters(): CountersRegion {
  return {
    converged: 0,
    wsOnly: 0,
    firestoreOnly: 0,
    hashDiverged: 0,
    wsArrivals: 0,
    fsArrivals: 0,
    wsTransitions: 0,
    fsTransitions: 0,
  };
}

const checkRings = new Map<string, RingEntry[]>();
const counters = new Map<Region, CountersRegion>();

// Per-side per-check accumulators of full live-state. WS deltas merge
// into wsState; FS arrivals overwrite into fsState. Both sides hash
// equivalent state shapes for convergence comparison.
const wsState = new Map<string, LiveFields>();
const fsState = new Map<string, LiveFields>();
// Last transition-hash observed per side, used to dedup non-transition
// updates so we don't push a record for every heartbeat tick.
const wsLastHash = new Map<string, string>();
const fsLastHash = new Map<string, string>();

function getCounters(region: Region): CountersRegion {
  let c = counters.get(region);
  if (!c) {
    c = freshCounters();
    counters.set(region, c);
  }
  return c;
}

/**
 * Hash of just the transition-relevant fields. Two states with different
 * lastChecked but the same status/detailedStatus/etc. hash identically.
 */
export function transitionHash(fields: LiveFields): string {
  const parts: string[] = [];
  for (const k of TRANSITION_FIELDS) {
    const v = fields[k];
    if (v !== undefined) parts.push(`${k}:${JSON.stringify(v)}`);
  }
  return parts.join('|');
}

/**
 * Canonical full-state hash (all live fields). Retained because the
 * useCheckStream Firestore-feed effect uses it to skip recording when no
 * live field changed at all — a perf gate independent of the shadow
 * comparison.
 */
export function canonicalLiveFields(fields: LiveFields): string {
  // Same key order as TRANSITION_FIELDS but extended with the continuous
  // fields, kept stable across calls.
  const parts: string[] = [];
  const keys: Array<keyof LiveFields> = [
    'status',
    'detailedStatus',
    'lastChecked',
    'nextCheckAt',
    'responseTime',
    'lastStatusCode',
    'consecutiveFailures',
    'consecutiveSuccesses',
    'lastError',
    'disabled',
    'maintenanceMode',
  ];
  for (const k of keys) {
    const v = fields[k];
    if (v !== undefined) parts.push(`${k}:${JSON.stringify(v)}`);
  }
  return parts.join('|');
}

function pushRing(checkId: string, entry: RingEntry): RingEntry[] {
  let ring = checkRings.get(checkId);
  if (!ring) {
    ring = [];
    checkRings.set(checkId, ring);
  }
  ring.push(entry);
  if (ring.length > RECENT_ENTRIES_PER_CHECK) {
    ring.splice(0, ring.length - RECENT_ENTRIES_PER_CHECK);
  }
  return ring;
}

function tryConverge(incoming: RingEntry, ring: RingEntry[]): void {
  const otherSource: Source = incoming.source === 'ws' ? 'fs' : 'ws';
  const cutoff = incoming.at - CONVERGE_WINDOW_MS;
  for (let i = ring.length - 1; i >= 0; i--) {
    const candidate = ring[i];
    if (candidate === incoming) continue;
    if (candidate.matched) continue;
    if (candidate.source !== otherSource) continue;
    if (candidate.at < cutoff) break;

    candidate.matched = true;
    incoming.matched = true;
    candidate.classified = true;
    incoming.classified = true;
    const region = incoming.region;
    if (candidate.hash === incoming.hash) {
      getCounters(region).converged++;
    } else {
      getCounters(region).hashDiverged++;
    }
    return;
  }
}

let sweepStarted = false;
function ensureSweepRunning(): void {
  if (typeof window === 'undefined') return;
  if (sweepStarted) return;
  sweepStarted = true;
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

function sweep(): void {
  const now = Date.now();
  for (const [checkId, ring] of checkRings) {
    for (let i = 0; i < ring.length; i++) {
      const entry = ring[i];
      if (entry.classified) continue;
      if (now - entry.at < SETTLE_WINDOW_MS) continue;
      entry.classified = true;
      const c = getCounters(entry.region);
      if (entry.source === 'ws') c.wsOnly++;
      else c.firestoreOnly++;
    }
    while (ring.length > 0 && ring[0].classified && now - ring[0].at > PENDING_TTL_MS) {
      ring.shift();
    }
    if (ring.length === 0) checkRings.delete(checkId);
  }
}

/**
 * Shared record path. Returns whether the call produced a recorded
 * transition (true) or was deduped to a no-op (false). Caller updates
 * total-arrivals separately so the dashboard can show both "raw
 * observations" and "transitions" counts.
 */
function recordSide(
  source: Source,
  region: Region,
  checkId: string,
  fields: LiveFields,
  stateMap: Map<string, LiveFields>,
  hashMap: Map<string, string>,
): boolean {
  const prev = stateMap.get(checkId);
  const merged: LiveFields = prev ? { ...prev, ...fields } : { ...fields };
  stateMap.set(checkId, merged);

  const newHash = transitionHash(merged);
  const oldHash = hashMap.get(checkId);
  hashMap.set(checkId, newHash);

  // First observation: seed only. We don't know if this is a transition
  // until we've seen at least one prior state to compare against. Without
  // this guard, page-load would record every initial snapshot entry as a
  // one-sided "transition" until both sides happened to deliver.
  if (oldHash === undefined) return false;
  if (oldHash === newHash) return false;

  const entry: RingEntry = {
    source,
    region,
    hash: newHash,
    at: Date.now(),
    matched: false,
    classified: false,
  };
  const ring = pushRing(checkId, entry);
  tryConverge(entry, ring);
  return true;
}

export function recordWsArrival(region: Region, checkId: string, fields: LiveFields): void {
  ensureSweepRunning();
  const c = getCounters(region);
  c.wsArrivals++;
  if (recordSide('ws', region, checkId, fields, wsState, wsLastHash)) {
    c.wsTransitions++;
  }
}

export function recordFirestoreArrival(region: Region, checkId: string, fields: LiveFields): void {
  ensureSweepRunning();
  const c = getCounters(region);
  c.fsArrivals++;
  if (recordSide('fs', region, checkId, fields, fsState, fsLastHash)) {
    c.fsTransitions++;
  }
}

export interface ShadowSnapshot {
  perRegion: Array<{ region: Region } & CountersRegion>;
  totals: CountersRegion;
  totalClassified: number;
  /** mismatchRate = (wsOnly + firestoreOnly + hashDiverged) / totalClassified */
  mismatchRate: number;
  pendingChecks: number;
}

export function getShadowSnapshot(): ShadowSnapshot {
  const totals = freshCounters();
  const perRegion: ShadowSnapshot['perRegion'] = [];
  for (const [region, c] of counters) {
    perRegion.push({ region, ...c });
    totals.converged += c.converged;
    totals.wsOnly += c.wsOnly;
    totals.firestoreOnly += c.firestoreOnly;
    totals.hashDiverged += c.hashDiverged;
    totals.wsArrivals += c.wsArrivals;
    totals.fsArrivals += c.fsArrivals;
    totals.wsTransitions += c.wsTransitions;
    totals.fsTransitions += c.fsTransitions;
  }
  const mismatches = totals.wsOnly + totals.firestoreOnly + totals.hashDiverged;
  const totalClassified = totals.converged + mismatches;
  return {
    perRegion,
    totals,
    totalClassified,
    mismatchRate: totalClassified === 0 ? 0 : mismatches / totalClassified,
    pendingChecks: checkRings.size,
  };
}

export function resetShadowTelemetry(): void {
  checkRings.clear();
  counters.clear();
  wsState.clear();
  fsState.clear();
  wsLastHash.clear();
  fsLastHash.clear();
}
