/**
 * Pure pieces of GET /v1/public/checks/status, the endpoint built for
 * frequent polling (Zabbix and similar, where webhooks can't reach the box).
 *
 * Split out of `public-api.ts` (which needs firebase-admin at import time) so
 * the cache-merge and ETag rules can be unit-tested. The Firestore calls stay
 * in public-api.ts and feed these functions plain objects.
 *
 * Cost model: a poll must not cost a Firestore read per check. Each user gets
 * an in-memory snapshot of their checks. A refresh reads a count() (1 read)
 * plus only the docs whose `updatedAt` moved since the last sync, with an
 * overlap window because the VPS buffers writes and retries failed flushes.
 * A changed count (a delete, or a create the delta raced) or an old snapshot
 * triggers a full reload instead.
 */
import { createHash } from "node:crypto";

/** Per-key and per-user caps for the status route, kept apart from the general read limits. */
export const STATUS_POLL_RATE_LIMITS = {
  // 6/min per key: 10-second polling fits, 15 to 30 seconds has room for jitter.
  perKeyPerMinute: 6,
  // Spread across every credential the user owns.
  perUserPerMinute: 12,
} as const;

/** Polls inside this window reuse the snapshot without touching Firestore. */
export const STATUS_MIN_REFRESH_MS = 5_000;
/** How far back a delta refresh looks behind the last sync (buffered and retried writes land late). */
export const STATUS_DELTA_OVERLAP_MS = 10 * 60 * 1000;
/** Backstop: a snapshot older than this is reloaded in full. */
export const STATUS_FULL_RELOAD_MS = 10 * 60 * 1000;
export const STATUS_CACHE_MAX_USERS = 2_000;

/** Firestore fields the status route projects with select(). */
export const STATUS_SELECT_FIELDS = [
  "name", "url", "type", "status", "lastStatusChange", "lastError", "disabled",
  "maintenanceMode", "checkRegion", "peerRegion", "peerStatus", "peerCheckedAt",
  "peerReachable", "orderIndex", "updatedAt", "folder",
] as const;

export interface StatusSourceDoc {
  name?: unknown;
  url?: unknown;
  type?: unknown;
  status?: unknown;
  lastStatusChange?: unknown;
  lastError?: unknown;
  disabled?: unknown;
  maintenanceMode?: unknown;
  checkRegion?: unknown;
  peerRegion?: unknown;
  peerStatus?: unknown;
  peerCheckedAt?: unknown;
  peerReachable?: unknown;
  orderIndex?: unknown;
  updatedAt?: unknown;
  folder?: unknown;
}

export interface CheckRegions {
  /** Region that ran the latest probe. */
  primary: string | null;
  /** Second region that re-probed to confirm a failure, when it was consulted. */
  peer: string | null;
  /** Regions that observed the check in its latest confirmed state. */
  regionsTotal: number;
  /** How many of those saw it down. */
  regionsDown: number;
  /** Down, and the peer region agreed. False when no peer was consulted. */
  confirmedDown: boolean;
}

export interface CheckStatusEntry {
  id: string;
  name: string;
  status: string;
  lastStatusChange: number | null;
  lastError: string | null;
  disabled: boolean;
  maintenanceMode: boolean;
  regions: CheckRegions;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Peer fields are written on every probe and are null when the peer was not
 * consulted (peerCheckedAt IS NOT NULL is the "consulted" test). An
 * unreachable peer gave no verdict, so it does not count as a region.
 */
export function buildRegions(doc: StatusSourceDoc): CheckRegions {
  const primary = str(doc.checkRegion);
  const peerConsulted = num(doc.peerCheckedAt) !== null && doc.peerReachable !== false && str(doc.peerStatus) !== null;
  const primaryDown = doc.status === "offline";
  const peerDown = peerConsulted && doc.peerStatus === "offline";
  return {
    primary,
    peer: peerConsulted ? str(doc.peerRegion) : null,
    regionsTotal: peerConsulted ? 2 : 1,
    regionsDown: (primaryDown ? 1 : 0) + (peerDown ? 1 : 0),
    confirmedDown: primaryDown && peerDown,
  };
}

export function toStatusEntry(id: string, doc: StatusSourceDoc): CheckStatusEntry {
  return {
    id,
    name: str(doc.name) ?? str(doc.url) ?? id,
    status: str(doc.status) ?? "unknown",
    lastStatusChange: num(doc.lastStatusChange),
    lastError: doc.status === "offline" ? str(doc.lastError) : null,
    disabled: doc.disabled === true,
    maintenanceMode: doc.maintenanceMode === true,
    regions: buildRegions(doc),
  };
}

interface SnapshotRow {
  entry: CheckStatusEntry;
  orderIndex: number;
  /** Not in the response; kept so a folder-restricted API key can be filtered. */
  folder: string | null;
}

export interface StatusSnapshot {
  rows: Map<string, SnapshotRow>;
  /** Wall-clock time of the last Firestore refresh (full or delta). */
  syncedAt: number;
  /** Wall-clock time of the last full reload. */
  fullAt: number;
  body: string;
  etag: string;
}

export interface SourceRow {
  id: string;
  data: StatusSourceDoc;
}

const sortRows = (a: SnapshotRow, b: SnapshotRow) =>
  a.orderIndex - b.orderIndex || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);

function render(rows: Iterable<SnapshotRow>): { body: string; etag: string } {
  const data = [...rows].sort(sortRows).map((r) => r.entry);
  // The body carries no timestamps of its own, so it (and its ETag) only
  // changes when a check's reported state changes.
  const body = JSON.stringify({ data, meta: { total: data.length } });
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  return { body, etag };
}

function finalize(rows: Map<string, SnapshotRow>, syncedAt: number, fullAt: number): StatusSnapshot {
  return { rows, syncedAt, fullAt, ...render(rows.values()) };
}

/**
 * The snapshot narrowed to the checks an API key may see. The full snapshot
 * stays shared per user; this re-renders the body and ETag for the subset.
 */
export function restrictSnapshot(
  snapshot: StatusSnapshot,
  allowed: (checkId: string, folder: string | null) => boolean,
): StatusSnapshot {
  const rows = new Map([...snapshot.rows].filter(([id, row]) => allowed(id, row.folder)));
  return finalize(rows, snapshot.syncedAt, snapshot.fullAt);
}

const toRow = (r: SourceRow): SnapshotRow => ({
  entry: toStatusEntry(r.id, r.data),
  orderIndex: num(r.data.orderIndex) ?? 0,
  folder: str(r.data.folder),
});

export function buildSnapshot(source: SourceRow[], now: number): StatusSnapshot {
  const rows = new Map<string, SnapshotRow>();
  for (const r of source) rows.set(r.id, toRow(r));
  return finalize(rows, now, now);
}

/**
 * Fold changed docs into a snapshot. Returns null when the merged snapshot
 * disagrees with the live count, meaning a doc vanished (or the delta missed
 * one) and the caller must reload in full.
 */
export function mergeDelta(prev: StatusSnapshot, changed: SourceRow[], liveCount: number, now: number): StatusSnapshot | null {
  const rows = new Map(prev.rows);
  for (const r of changed) rows.set(r.id, toRow(r));
  if (rows.size !== liveCount) return null;
  return finalize(rows, now, prev.fullAt);
}

export type RefreshPlan = "cached" | "delta" | "full";

export function planRefresh(prev: StatusSnapshot | undefined, now: number): RefreshPlan {
  if (!prev) return "full";
  if (now - prev.fullAt >= STATUS_FULL_RELOAD_MS) return "full";
  if (now - prev.syncedAt < STATUS_MIN_REFRESH_MS) return "cached";
  return "delta";
}

/** Lower bound for the delta query's `updatedAt >` filter. */
export function deltaSince(prev: StatusSnapshot): number {
  return prev.syncedAt - STATUS_DELTA_OVERLAP_MS;
}

/** RFC 9110 If-None-Match: a list of entity tags, weak or strong, or `*`. */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((raw) => {
    const tag = raw.trim();
    return tag === "*" || tag.replace(/^W\//, "") === bare;
  });
}
