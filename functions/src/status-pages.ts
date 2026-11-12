import { createHash } from "node:crypto";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { FieldPath } from "firebase-admin/firestore";
import { firestore } from "./init";
import { resolveAccount } from "./team-access";

const MAX_CHECKS = 50;
const HEARTBEAT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// Firestore-based cache TTLs (survives across Cloud Function instances)
// 1 hour: uptime % is read from the daily summary table, which
// aggregateDailySummariesScheduled only rebuilds twice a day, so a shorter TTL
// just re-ran the same BigQuery query for the same answer.
const UPTIME_CACHE_TTL_MS = 60 * 60 * 1000;
const HEARTBEAT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour: daily summaries change once a day
// Date range for uptime calculation on status pages (limits BigQuery scan)
const UPTIME_LOOKBACK_MS = 30 * DAY_MS;

// Read cost of a status page poll (Firestore read 3.95 kr per 1M, a write
// costs 3 reads). An open tab polls the snapshot every 60 s and the heartbeat
// every 5 min. Before these caches every call read the page doc, the cache
// doc and all N check docs, and a folder page also read every check its owner
// has (702 on the largest account: about 1.3M reads a day for one open tab).
//
// SNAPSHOT_TTL_MS: how old the up/down status served to a viewer may be. It
// has to be longer than the 60 s poll, or a lone viewer misses every time.
// With 75 s a lone viewer hits every second poll, and the worst case from a
// status change in Firestore to an open tab showing it is 75 s + the 60 s poll.
export const SNAPSHOT_TTL_MS = 75 * 1000;
// Folder pages. The checks in a page's folders are found with an indexed
// query (userId + folder) limited to the checks the page can show, so it reads
// at most about MAX_CHECKS docs, not every check the owner has (702 on the
// largest account, 327 of them in the page's folder).
//
// A marker bumped on every folder change would be cheaper still, but the app
// writes check folders straight to Firestore from the browser (useChecks.ts:
// move, bulk move, rename, delete folder), so no server hook sees a move.
//
// The snapshot runs that query on every memo miss and uses the docs it
// returns as its check reads, so finding the checks costs it no extra reads
// and a folder move shows on the page within one SNAPSHOT_TTL_MS.
// The heartbeat and uptime calls only need the ids. They reuse the list the
// snapshot stores in the cache doc for RESOLVED_IDS_TTL_MS, and run the query
// themselves (up to MAX_CHECKS reads) only when no snapshot kept it fresh.
// Edits to the page itself (checks or folders picked) apply at once, because
// the stored list is keyed on them.
export const RESOLVED_IDS_TTL_MS = 10 * 60 * 1000;
// The snapshot rewrites the stored list when it changed or has less than this
// left. A lone viewer misses the snapshot memo about every 2 min, so 3 min
// keeps the list from expiring under the heartbeat while a tab is open.
// Cost: 1 write per 7 to 8 min per polled folder page, about 190 a day.
export const RESOLVED_REFRESH_MARGIN_MS = 3 * 60 * 1000;
// Firestore allows 30 values in an `in` filter.
const FOLDER_IN_LIMIT = 30;
// The snapshot is also shared through Firestore (one write per miss) so
// another instance can serve it for 2 reads. A write costs 3 reads and saves
// N reads only when the next call lands on a different instance, so it pays
// when that happens more often than 3/N of the time: 15% at 20 checks, 30% at
// 10. Below this size the in-memory memo alone is cheaper.
export const SHARED_SNAPSHOT_MIN_CHECKS = 20;

type StatusPageDoc = {
  userId: string;
  visibility: 'public' | 'private';
  checkIds?: string[];
  /** Folder paths for dynamic inclusion: checks in these folders are resolved at query time */
  folderPaths?: string[];
  updatedAt?: number;
};

type UptimeEntry = {
  checkId: string;
  uptimePercentage: number;
};

export type SnapshotEntry = {
  checkId: string;
  name: string;
  url: string;
  status: string;
  lastChecked: number;
  responseTime: number | null;
  uptimePercentage: number | null;
  folder?: string | null;
};

export type HeartbeatDay = {
  day: number;
  status: 'online' | 'offline' | 'unknown';
  totalChecks: number;
  issueCount: number;
  onlineChecks: number;
  offlineChecks: number;
};

export type HeartbeatEntry = {
  checkId: string;
  days: HeartbeatDay[];
};

type HeartbeatCacheEntry = {
  data: HeartbeatEntry[];
  expiresAt: number;
  /** Key of the checks the data was computed for (deleted and domain checks removed). */
  checkIdsKey?: string;
  /** Key of the page's check ids before that filtering, so a hit needs no check reads. */
  sourceIdsKey?: string;
};

/**
 * Firestore-based cache for status page data.
 * Unlike in-memory Maps, this survives across Cloud Function cold starts,
 * which is critical because serverless instances lose memory on every cold start.
 * Cache docs live at: status_page_cache/{statusPageId}
 */
type FirestoreCacheDoc = {
  uptime?: { data: UptimeEntry[]; expiresAt: number; checkIdsKey?: string };
  heartbeat?: HeartbeatCacheEntry;
  /** Folder pages: the check ids the page resolves to. */
  resolved?: { checkIds: string[]; expiresAt: number; sourceKey: string };
  /** Pages with SHARED_SNAPSHOT_MIN_CHECKS or more checks: the last snapshot. */
  snapshot?: { data: SnapshotEntry[]; expiresAt: number; sourceKey: string };
};

// Cache entries are only valid for the exact check set they were computed for.
// Otherwise checks added to a page stay invisible until the TTL expires.
const buildCheckIdsKey = (checkIds: string[]): string => [...checkIds].sort().join('|');

/** The explicit check ids and folder paths a status page doc names, cleaned. */
export function readPageSources(
  statusPage: { checkIds?: unknown; folderPaths?: unknown },
): { explicitCheckIds: string[]; folderPaths: string[] } {
  const clean = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return { explicitCheckIds: clean(statusPage.checkIds), folderPaths: clean(statusPage.folderPaths) };
}

/**
 * Identifies what a page shows: its owner, its explicit checks and its folders.
 * Order is kept, because the snapshot lists checks in page order. Any edit to
 * the page changes the key, so cached entries for the old setup stop matching.
 */
export function buildPageSourceKey(userId: string, explicitCheckIds: string[], folderPaths: string[]): string {
  return createHash('sha1').update(JSON.stringify([userId, explicitCheckIds, folderPaths])).digest('hex');
}

/**
 * A cached entry, if it is for this page setup and still within its TTL.
 * An expiry further ahead than the TTL allows is treated as corrupt.
 */
export function pickFreshEntry<T extends { expiresAt: number; sourceKey: string }>(
  entry: T | null | undefined,
  sourceKey: string,
  now: number,
  ttlMs: number,
): T | null {
  if (!entry || typeof entry.expiresAt !== 'number') return null;
  if (entry.sourceKey !== sourceKey) return null;
  if (entry.expiresAt <= now || entry.expiresAt > now + ttlMs) return null;
  return entry;
}

/** Whether a snapshot of this many checks is worth a Firestore write to share. */
export function shouldShareSnapshot(checkCount: number): boolean {
  return checkCount >= SHARED_SNAPSHOT_MIN_CHECKS;
}

/**
 * Explicit check ids plus the owner's checks that sit in one of the page's
 * folders. A folder matches exactly: picking a parent folder does not include
 * its subfolders. Domain-only checks have no uptime data and are left out.
 */
export function matchFolderCheckIds(
  explicitCheckIds: string[],
  folderPaths: string[],
  ownerChecks: Array<{ id: string; folder?: string | null; type?: string }>,
): string[] {
  const all = new Set<string>(explicitCheckIds);
  if (folderPaths.length === 0) return Array.from(all);
  for (const check of ownerChecks) {
    if (check.type === 'domain') continue;
    const folder = normalizeFolder(check.folder);
    if (folder && folderPaths.includes(folder)) all.add(check.id);
  }
  return Array.from(all);
}

/**
 * The page folders an exact-match query can find. Checks store their folder
 * normalized (the app and the public API both normalize before writing), and
 * matchFolderCheckIds compares against the normalized form, so a page folder
 * that is not in that form matches nothing and is not worth a query.
 */
export function queryableFolderPaths(folderPaths: string[]): string[] {
  return Array.from(new Set(folderPaths.filter((path) => normalizeFolder(path) === path)));
}

/** How many folder checks still fit on a page after its explicit checks. */
export function folderSlotsLeft(explicitCheckIds: string[], maxChecks: number): number {
  return Math.max(0, maxChecks - new Set(explicitCheckIds).size);
}

/**
 * The page's check ids from the folder query results: explicit ids first, then
 * folder checks in id order (the order a scan of the owner's checks gives),
 * cut to what the page shows.
 */
export function pickPageCheckIds(
  explicitCheckIds: string[],
  folderPaths: string[],
  candidates: Array<{ id: string; folder?: string | null; type?: string }>,
  maxChecks: number,
): string[] {
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matchFolderCheckIds(explicitCheckIds, folderPaths, sorted).slice(0, maxChecks);
}

/**
 * Whether the snapshot should store the list it just resolved: when nothing
 * usable is stored for this page setup, when the list changed, or when the
 * stored one is within RESOLVED_REFRESH_MARGIN_MS of expiring.
 */
export function shouldRewriteResolved(
  entry: { checkIds?: unknown; expiresAt: number; sourceKey: string } | null | undefined,
  sourceKey: string,
  checkIds: string[],
  now: number,
): boolean {
  const fresh = pickFreshEntry(entry, sourceKey, now, RESOLVED_IDS_TTL_MS);
  if (!fresh || !Array.isArray(fresh.checkIds)) return true;
  if (fresh.checkIds.length !== checkIds.length) return true;
  if (fresh.checkIds.some((id, i) => id !== checkIds[i])) return true;
  return fresh.expiresAt - now < RESOLVED_REFRESH_MARGIN_MS;
}

/** Entries written before the onlineChecks/offlineChecks fields existed are not usable. */
function heartbeatHasCountFields(data: HeartbeatEntry[]): boolean {
  return data.every((entry) =>
    Array.isArray(entry.days) &&
    entry.days.every((day) => typeof (day as Partial<HeartbeatDay>).onlineChecks === 'number')
  );
}

/**
 * The cached heartbeat, if it was computed for exactly this list of page check
 * ids. Lets a heartbeat poll skip reading the check docs.
 */
export function pickHeartbeatBySource(
  entry: HeartbeatCacheEntry | null | undefined,
  sourceIdsKey: string,
  now: number,
): HeartbeatEntry[] | null {
  if (!entry || !Array.isArray(entry.data) || typeof entry.expiresAt !== 'number') return null;
  if (entry.expiresAt <= now) return null;
  if (!entry.sourceIdsKey || entry.sourceIdsKey !== sourceIdsKey) return null;
  return heartbeatHasCountFields(entry.data) ? entry.data : null;
}

async function getFirestoreCache(statusPageId: string): Promise<FirestoreCacheDoc | null> {
  try {
    const doc = await firestore.collection('status_page_cache').doc(statusPageId).get();
    return doc.exists ? (doc.data() as FirestoreCacheDoc) : null;
  } catch {
    return null;
  }
}

async function setFirestoreCache(statusPageId: string, field: keyof FirestoreCacheDoc, value: unknown): Promise<void> {
  try {
    await firestore.collection('status_page_cache').doc(statusPageId).set(
      { [field]: value },
      { merge: true }
    );
  } catch (e) {
    logger.warn(`[status-page-cache] Failed to write cache for ${statusPageId}:`, e);
  }
}

/**
 * Get uptime map from Firestore cache or compute via BigQuery (with 30-day lookback).
 * Returns Map<checkId, uptimePercentage>. Pass the cache doc when the caller
 * has already read it, so it is not read twice.
 */
async function getCachedUptimeMap(
  statusPageId: string,
  checkIds: string[],
  userId: string,
  preloaded?: FirestoreCacheDoc | null,
): Promise<Map<string, number>> {
  const checkIdsKey = buildCheckIdsKey(checkIds);
  const cached = preloaded !== undefined ? preloaded : await getFirestoreCache(statusPageId);
  if (cached?.uptime && cached.uptime.expiresAt > Date.now() && cached.uptime.checkIdsKey === checkIdsKey) {
    const map = new Map<string, number>();
    for (const entry of cached.uptime.data) {
      map.set(entry.checkId, entry.uptimePercentage);
    }
    return map;
  }

  // Cache miss: use pre-aggregated daily summaries (12 MB scan vs 92 MB)
  const { getUptimeFromDailySummaries } = await import('./bigquery.js');
  const startDate = Date.now() - UPTIME_LOOKBACK_MS;
  const batchStats = await getUptimeFromDailySummaries(checkIds, userId, startDate);

  const uptimeEntries: UptimeEntry[] = [];
  const map = new Map<string, number>();
  for (const stats of batchStats) {
    const pct = Number(stats.uptimePercentage);
    if (Number.isFinite(pct)) {
      const rounded = Math.round(pct * 100) / 100;
      map.set(stats.websiteId, rounded);
      uptimeEntries.push({ checkId: stats.websiteId, uptimePercentage: rounded });
    }
  }

  // Write to Firestore cache (fire-and-forget)
  setFirestoreCache(statusPageId, 'uptime', { data: uptimeEntries, expiresAt: Date.now() + UPTIME_CACHE_TTL_MS, checkIdsKey });

  return map;
}

function heartbeatWindow(now: number): { startDate: number; endDate: number } {
  return { startDate: getDayStart(now - ((HEARTBEAT_DAYS - 1) * DAY_MS)), endDate: now };
}

/**
 * Get heartbeat data from Firestore cache or compute via BigQuery.
 * Returns HeartbeatEntry[] for all check IDs. `sourceIdsKey` is stored with
 * the entry so the next call can use pickHeartbeatBySource.
 */
async function getCachedHeartbeat(
  statusPageId: string,
  checkIds: string[],
  userId: string,
  cached: FirestoreCacheDoc | null,
  sourceIdsKey: string,
): Promise<{ entries: HeartbeatEntry[]; startDate: number; endDate: number }> {
  const { startDate, endDate } = heartbeatWindow(Date.now());
  const checkIdsKey = buildCheckIdsKey(checkIds);

  if (
    cached?.heartbeat &&
    cached.heartbeat.expiresAt > Date.now() &&
    cached.heartbeat.checkIdsKey === checkIdsKey &&
    heartbeatHasCountFields(cached.heartbeat.data)
  ) {
    // Same checks, but the entry does not carry this page setup's key yet
    // (written by older code, or a check on the page was deleted since).
    // Stamp it, so the following calls skip the check reads.
    if (cached.heartbeat.sourceIdsKey !== sourceIdsKey) {
      await setFirestoreCache(statusPageId, 'heartbeat', { sourceIdsKey });
    }
    return { entries: cached.heartbeat.data, startDate, endDate };
  }

  // Cache miss: use pre-aggregated daily summaries (12 MB scan vs 800 MB)
  const { getPreAggregatedDailySummaryBatch, getCheckHistoryDailySummaryBatch } = await import('./bigquery.js');
  const batchSummaries = await getPreAggregatedDailySummaryBatch(checkIds, userId, startDate, endDate);

  // Daily summaries aggregate only twice a day (02:00/14:00 UTC), so a brand-new
  // check has zero rows until the next run and would render a fully blank strip.
  // Backfill just those checks from the raw history table over a 2-day window.
  // A new check can't have more history than that gap anyway.
  const missingIds = checkIds.filter((id) => !batchSummaries.has(id));
  if (missingIds.length > 0) {
    try {
      const rawStart = Math.max(startDate, getDayStart(endDate - DAY_MS));
      const rawSummaries = await getCheckHistoryDailySummaryBatch(missingIds, userId, rawStart, endDate);
      for (const [checkId, summaries] of rawSummaries) {
        if (summaries.length > 0) batchSummaries.set(checkId, summaries);
      }
    } catch (e) {
      logger.warn(`[getCachedHeartbeat] Raw fallback for ${missingIds.length} new checks failed:`, e);
    }
  }

  const entries: HeartbeatEntry[] = checkIds.map((checkId) => {
    const summaries = batchSummaries.get(checkId) || [];
    const days = summaries.map((summary) => {
      const totalChecks = Number(summary.totalChecks ?? 0);
      const issueCount = Number(summary.issueCount ?? 0);
      const onlineChecks = Number(summary.onlineChecks ?? 0);
      const offlineChecks = Number(summary.offlineChecks ?? 0);
      const status = totalChecks > 0 ? (summary.hasIssues ? 'offline' : 'online') : 'unknown';
      return { day: summary.day.getTime(), status, totalChecks, issueCount, onlineChecks, offlineChecks } as HeartbeatDay;
    });
    return { checkId, days } as HeartbeatEntry;
  });

  // Write to Firestore cache (fire-and-forget)
  setFirestoreCache(statusPageId, 'heartbeat', {
    data: entries,
    expiresAt: Date.now() + HEARTBEAT_CACHE_TTL_MS,
    checkIdsKey,
    sourceIdsKey,
  });

  return { entries, startDate, endDate };
}

function getDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Normalize a folder path (trim, convert slashes, remove duplicates)
 */
function normalizeFolder(folder?: string | null): string | null {
  const raw = (folder ?? "").trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\s+/g, " ")
    .trim();

  const trimmedSlashes = cleaned.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmedSlashes || null;
}

type PageSources = { explicitCheckIds: string[]; folderPaths: string[] };

type CheckDocData = FirebaseFirestore.DocumentData;

type ResolvedPage = {
  checkIds: string[];
  /** Check docs the folder query already read, so callers do not read them again. */
  docs: Map<string, CheckDocData> | null;
  /** When those docs were read. */
  readAt: number;
};

// Concurrent calls for a folder page on the same instance share one query.
const resolveInFlight = new Map<string, Promise<ResolvedPage>>();

/**
 * The owner's checks in the page's folders, in id order, read until `slots`
 * of them can be shown. Reads: one per doc returned, so about `slots`, plus
 * the explicit and domain-only checks that sit in the same folders (at least
 * 1 for an empty folder). Uses the existing userId + folder index.
 */
async function queryFolderChecks(
  userId: string,
  folderPaths: string[],
  explicitCheckIds: string[],
  slots: number,
): Promise<Map<string, CheckDocData>> {
  const docs = new Map<string, CheckDocData>();
  const paths = queryableFolderPaths(folderPaths);
  if (slots <= 0 || paths.length === 0) return docs;

  const explicit = new Set(explicitCheckIds);
  for (let i = 0; i < paths.length; i += FOLDER_IN_LIMIT) {
    const chunk = paths.slice(i, i + FOLDER_IN_LIMIT);
    let usable = 0;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = firestore
        .collection('checks')
        .where('userId', '==', userId)
        .where('folder', 'in', chunk)
        .orderBy(FieldPath.documentId())
        .limit(slots);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const data = doc.data();
        docs.set(doc.id, data);
        // Explicit checks already have a place and domain-only checks are not
        // shown, so neither fills a slot.
        if (data.type !== 'domain' && !explicit.has(doc.id)) usable++;
      }
      if (page.size < slots || usable >= slots) break;
      cursor = page.docs[page.docs.length - 1];
    }
  }
  return docs;
}

/** Fallback: every check the owner has, one read per check. */
async function scanOwnerChecks(userId: string, sources: PageSources): Promise<string[]> {
  const checksSnapshot = await firestore
    .collection('checks')
    .where('userId', '==', userId)
    .get();
  const ownerChecks = checksSnapshot.docs.map((doc) => {
    const data = doc.data() as { folder?: string | null; type?: string };
    return { id: doc.id, folder: data.folder, type: data.type };
  });
  return matchFolderCheckIds(sources.explicitCheckIds, sources.folderPaths, ownerChecks);
}

/**
 * The check ids a page shows: its explicit ids plus the checks in its folders,
 * at most MAX_CHECKS.
 *
 * `live` (the snapshot) always asks Firestore, because it needs those check
 * docs anyway. Without it (heartbeat, uptime) the list stored in the cache doc
 * is used while it is fresh. See RESOLVED_IDS_TTL_MS for the cost.
 *
 * If the folder query fails, the stored list is used, or else the owner's
 * checks are scanned as before and that list is stored for the TTL.
 */
async function resolvePageCheckIds(
  statusPageId: string,
  userId: string,
  sources: PageSources,
  sourceKey: string,
  cache: FirestoreCacheDoc | null,
  live = false,
): Promise<ResolvedPage> {
  if (sources.folderPaths.length === 0) {
    return { checkIds: matchFolderCheckIds(sources.explicitCheckIds, [], []), docs: null, readAt: Date.now() };
  }

  const stored = pickFreshEntry(cache?.resolved, sourceKey, Date.now(), RESOLVED_IDS_TTL_MS);
  const storedIds = stored && Array.isArray(stored.checkIds) ? stored.checkIds : null;
  if (storedIds && !live) {
    return { checkIds: [...storedIds], docs: null, readAt: Date.now() };
  }

  const flightKey = `${statusPageId}:${sourceKey}`;
  let flight = resolveInFlight.get(flightKey);
  if (!flight) {
    flight = (async (): Promise<ResolvedPage> => {
      const readAt = Date.now();
      let checkIds: string[];
      let docs: Map<string, CheckDocData> | null = null;
      try {
        docs = await queryFolderChecks(
          userId,
          sources.folderPaths,
          sources.explicitCheckIds,
          folderSlotsLeft(sources.explicitCheckIds, MAX_CHECKS),
        );
        const candidates = Array.from(docs, ([id, data]) => ({ id, folder: data.folder, type: data.type }));
        checkIds = pickPageCheckIds(sources.explicitCheckIds, sources.folderPaths, candidates, MAX_CHECKS);
      } catch (e) {
        logger.warn(`[status-page] Folder query failed for ${statusPageId}, falling back:`, e);
        if (storedIds) return { checkIds: storedIds, docs: null, readAt };
        docs = null;
        checkIds = await scanOwnerChecks(userId, sources);
      }
      if (shouldRewriteResolved(cache?.resolved, sourceKey, checkIds, Date.now())) {
        // Awaited: losing this write means the heartbeat repeats the query.
        await setFirestoreCache(statusPageId, 'resolved', {
          checkIds,
          expiresAt: Date.now() + RESOLVED_IDS_TTL_MS,
          sourceKey,
        });
      }
      return { checkIds, docs, readAt };
    })().finally(() => resolveInFlight.delete(flightKey));
    resolveInFlight.set(flightKey, flight);
  }
  // Callers trim the list in place, so each gets its own copy.
  const resolved = await flight;
  return { ...resolved, checkIds: [...resolved.checkIds] };
}

/**
 * The check docs for these ids, keyed by id; deleted checks are left out.
 * Docs the folder query already returned are not read again.
 */
async function readCheckDocs(
  checkIds: string[],
  prefetched: Map<string, CheckDocData> | null,
): Promise<Map<string, CheckDocData>> {
  const out = new Map<string, CheckDocData>();
  const missing: string[] = [];
  for (const id of checkIds) {
    const data = prefetched?.get(id);
    if (data) out.set(id, data);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const snaps = await firestore.getAll(...missing.map((id) => firestore.collection('checks').doc(id)));
    for (const snap of snaps) {
      const data = snap.data();
      if (snap.exists && data) out.set(snap.id, data);
    }
  }
  return out;
}

/**
 * Private status pages are visible to the account that owns them: the owner,
 * plus teammates with access to that account. The page already names its
 * account, so this does not depend on the app sending accountId.
 */
async function canViewPrivateStatusPage(
  request: Pick<CallableRequest, 'auth'>,
  ownerUid: string,
): Promise<boolean> {
  const actorUid = request.auth?.uid;
  if (!actorUid) return false;
  if (actorUid === ownerUid) return true;
  try {
    await resolveAccount({ auth: request.auth, data: { accountId: ownerUid } }, 'read');
    return true;
  } catch {
    return false;
  }
}

function requireStatusPageId(request: CallableRequest): string {
  const { statusPageId } = request.data || {};
  if (!statusPageId || typeof statusPageId !== 'string') {
    throw new HttpsError("invalid-argument", "statusPageId is required");
  }
  return statusPageId;
}

/** Reads the page doc (1 read) and applies the private-page access rule. */
async function loadViewableStatusPage(request: CallableRequest, statusPageId: string): Promise<StatusPageDoc> {
  const statusDoc = await firestore.collection('status_pages').doc(statusPageId).get();
  if (!statusDoc.exists) {
    throw new HttpsError("not-found", "Status page not found");
  }

  const statusPage = statusDoc.data() as StatusPageDoc;
  if (!statusPage?.userId) {
    throw new HttpsError("not-found", "Status page data not found");
  }

  if (statusPage.visibility !== 'public' && !(await canViewPrivateStatusPage(request, statusPage.userId))) {
    throw new HttpsError("permission-denied", "Status page is private");
  }
  return statusPage;
}

export const getStatusPageUptime = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const statusPageId = requireStatusPageId(request);
  const statusPage = await loadViewableStatusPage(request, statusPageId);

  const sources = readPageSources(statusPage);
  const sourceKey = buildPageSourceKey(statusPage.userId, sources.explicitCheckIds, sources.folderPaths);
  const cache = await getFirestoreCache(statusPageId);

  // Resolve all check IDs (explicit + from folders)
  const { checkIds, docs: prefetched } = await resolvePageCheckIds(statusPageId, statusPage.userId, sources, sourceKey, cache);

  if (checkIds.length === 0) {
    return { success: true, data: { checkUptime: [] } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageUptime] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  // Fetch check metadata to filter out deleted checks and domain-only entries
  // (the latter have no uptime data: they're RDAP-tracked, not probed).
  const checkDocs = await readCheckDocs(checkIds, prefetched);
  const validCheckIds = checkIds.filter((id) => {
    const data = checkDocs.get(id);
    return !!data && data.type !== 'domain';
  });

  if (validCheckIds.length === 0) {
    return { success: true, data: { checkUptime: [] } };
  }

  // Firestore-cached uptime % (UPTIME_CACHE_TTL_MS) + 30-day BigQuery lookback
  const uptimeMap = await getCachedUptimeMap(statusPageId, validCheckIds, statusPage.userId, cache);

  const uptimeEntries: UptimeEntry[] = [];
  for (const checkId of validCheckIds) {
    const pct = uptimeMap.get(checkId);
    if (pct != null) {
      uptimeEntries.push({ checkId, uptimePercentage: pct });
    }
  }

  return { success: true, data: { checkUptime: uptimeEntries } };
});

type SnapshotResult = { success: true; data: { checks: SnapshotEntry[] } };
type SnapshotMemoEntry = { expiresAt: number; sourceKey: string; result: SnapshotResult };

// Per-instance copy of the last snapshot of each page. Viewers of the same
// page within SNAPSHOT_TTL_MS share one set of check reads.
const snapshotMemo = new Map<string, SnapshotMemoEntry>();
// Calls for the same page that arrive while one is being built wait for it.
const snapshotInFlight = new Map<string, Promise<SnapshotMemoEntry>>();

function rememberSnapshot(statusPageId: string, entry: SnapshotMemoEntry): SnapshotMemoEntry {
  if (!snapshotMemo.has(statusPageId) && snapshotMemo.size >= 500) {
    snapshotMemo.delete(snapshotMemo.keys().next().value!);
  }
  snapshotMemo.set(statusPageId, entry);
  return entry;
}

/**
 * Builds the snapshot of a page on a memo miss.
 * Reads: 1 (cache doc) when another instance shared a fresh snapshot;
 * otherwise 1 + N check docs, plus 1 write on pages of
 * SHARED_SNAPSHOT_MIN_CHECKS or more. On a folder page the folder query
 * supplies those check docs, so it costs the same N (see RESOLVED_IDS_TTL_MS).
 */
async function buildSnapshot(
  statusPageId: string,
  statusPage: StatusPageDoc,
  sources: PageSources,
  sourceKey: string,
): Promise<SnapshotMemoEntry> {
  const cache = await getFirestoreCache(statusPageId);

  const shared = pickFreshEntry(cache?.snapshot, sourceKey, Date.now(), SNAPSHOT_TTL_MS);
  if (shared && Array.isArray(shared.data)) {
    // Keeps the expiry of the shared copy, so the two caches never add up to
    // more than one SNAPSHOT_TTL_MS of staleness.
    return rememberSnapshot(statusPageId, {
      expiresAt: shared.expiresAt,
      sourceKey,
      result: { success: true, data: { checks: shared.data } },
    });
  }

  // Resolve all check IDs (explicit + from folders), always live: the folder
  // query returns the check docs this snapshot needs anyway.
  const { checkIds, docs: prefetched, readAt } = await resolvePageCheckIds(
    statusPageId, statusPage.userId, sources, sourceKey, cache, true,
  );

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageSnapshot] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  // The TTL counts from the moment the check docs are read, not from the end
  // of the (possibly slow) uptime lookup below.
  const expiresAt = (prefetched ? readAt : Date.now()) + SNAPSHOT_TTL_MS;

  if (checkIds.length === 0) {
    return rememberSnapshot(statusPageId, { expiresAt, sourceKey, result: { success: true, data: { checks: [] } } });
  }

  // Read check docs from Firestore. These already contain status, lastChecked, etc.
  // from the scheduler's status-buffer writes (every 2 min).
  // This eliminates the need for a separate BigQuery getLatestCheckStatuses query.
  const checkDocs = await readCheckDocs(checkIds, prefetched);
  const checkMeta = new Map<string, { name: string; url: string; disabled?: boolean; folder?: string | null; status?: string; lastChecked?: number; responseTime?: number | null }>();
  checkDocs.forEach((raw, id) => {
    const data = raw as { type?: string; name?: unknown; url?: unknown; disabled?: unknown; folder?: unknown; status?: unknown; lastChecked?: unknown; responseTime?: unknown };
    if (data.type === 'domain') return; // domain-only checks have no uptime data
    const name = typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled check';
    const url = typeof data.url === 'string' ? data.url : '';
    const disabled = typeof data.disabled === 'boolean' ? data.disabled : false;
    const folder = typeof data.folder === 'string' ? data.folder : null;
    const status = typeof data.status === 'string' ? data.status : 'unknown';
    const lastChecked = typeof data.lastChecked === 'number' ? data.lastChecked : 0;
    const responseTime = typeof data.responseTime === 'number' ? data.responseTime : null;
    checkMeta.set(id, { name, url, disabled, folder, status, lastChecked, responseTime });
  });

  // Uptime % requires BigQuery: use the Firestore-cached result (UPTIME_CACHE_TTL_MS).
  // Pass the filtered ids so the cache key matches getStatusPageUptime's
  // (deleted/domain checks would otherwise make the two callers thrash the cache).
  const uptimeMap = checkMeta.size > 0
    ? await getCachedUptimeMap(statusPageId, Array.from(checkMeta.keys()), statusPage.userId, cache)
    : new Map<string, number>();

  // Filter out deleted/orphaned checks: only include checks that still exist in Firestore
  const checks = checkIds
    .filter((checkId) => checkMeta.has(checkId))
    .map((checkId) => {
      const meta = checkMeta.get(checkId)!;
      const uptimePercentage = uptimeMap.get(checkId);
      const status = meta.disabled ? 'disabled' : meta.status ?? 'unknown';

      return {
        checkId,
        name: meta.name,
        url: meta.url,
        status,
        lastChecked: meta.lastChecked ?? 0,
        responseTime: meta.responseTime ?? null,
        uptimePercentage: uptimePercentage ?? null,
        folder: meta.folder ?? null,
      } as SnapshotEntry;
    });

  if (shouldShareSnapshot(checkIds.length)) {
    await setFirestoreCache(statusPageId, 'snapshot', { data: checks, expiresAt, sourceKey });
  }

  return rememberSnapshot(statusPageId, { expiresAt, sourceKey, result: { success: true, data: { checks } } });
}

// Polled every 60 s by every open, visible status page tab.
// Reads per call: 1 (page doc) on a memo hit, 2 on a shared-cache hit,
// 2 + N on a miss. The page doc is read on every call so that page edits and
// a switch to private apply at once instead of after the memo expires.
export const getStatusPageSnapshot = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const statusPageId = requireStatusPageId(request);
  const statusPage = await loadViewableStatusPage(request, statusPageId);

  const sources = readPageSources(statusPage);
  const sourceKey = buildPageSourceKey(statusPage.userId, sources.explicitCheckIds, sources.folderPaths);

  const memo = pickFreshEntry(snapshotMemo.get(statusPageId), sourceKey, Date.now(), SNAPSHOT_TTL_MS);
  if (memo) return memo.result;

  const flightKey = `${statusPageId}:${sourceKey}`;
  let flight = snapshotInFlight.get(flightKey);
  if (!flight) {
    flight = buildSnapshot(statusPageId, statusPage, sources, sourceKey)
      .finally(() => snapshotInFlight.delete(flightKey));
    snapshotInFlight.set(flightKey, flight);
  }
  return (await flight).result;
});

// Polled every 5 min per open tab. Reads per call: 2 (page doc + cache doc)
// while the hourly heartbeat cache is valid for the page's checks, whatever
// the page size. Once an hour it also reads the N check docs and BigQuery.
// A folder page adds the folder query (up to N reads) only when no snapshot
// call kept the stored id list fresh.
export const getStatusPageHeartbeat = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const statusPageId = requireStatusPageId(request);
  const [statusPage, cache] = await Promise.all([
    loadViewableStatusPage(request, statusPageId),
    getFirestoreCache(statusPageId),
  ]);

  const sources = readPageSources(statusPage);
  const sourceKey = buildPageSourceKey(statusPage.userId, sources.explicitCheckIds, sources.folderPaths);

  // Resolve all check IDs (explicit + from folders)
  const { checkIds, docs: prefetched } = await resolvePageCheckIds(statusPageId, statusPage.userId, sources, sourceKey, cache);

  if (checkIds.length === 0) {
    return { success: true, data: { heartbeat: [], days: HEARTBEAT_DAYS } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageHeartbeat] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  // Already computed for exactly these page checks: no check reads needed.
  // A check deleted since then keeps its strip in the response until the entry
  // expires, which the page ignores because the snapshot no longer lists it.
  const sourceIdsKey = buildCheckIdsKey(checkIds);
  const cachedEntries = pickHeartbeatBySource(cache?.heartbeat, sourceIdsKey, Date.now());
  if (cachedEntries) {
    const { startDate, endDate } = heartbeatWindow(Date.now());
    return { success: true, data: { heartbeat: cachedEntries, days: HEARTBEAT_DAYS, startDate, endDate } };
  }

  // Fetch check metadata to filter out deleted checks and domain-only entries
  // (the latter have no uptime data: they're RDAP-tracked, not probed).
  const checkDocs = await readCheckDocs(checkIds, prefetched);
  const validCheckIds = checkIds.filter((id) => {
    const data = checkDocs.get(id);
    return !!data && data.type !== 'domain';
  });

  if (validCheckIds.length === 0) {
    return { success: true, data: { heartbeat: [], days: HEARTBEAT_DAYS } };
  }

  // Firestore-cached heartbeat with 1-hour TTL
  const { entries, startDate, endDate } = await getCachedHeartbeat(statusPageId, validCheckIds, statusPage.userId, cache, sourceIdsKey);

  return { success: true, data: { heartbeat: entries, days: HEARTBEAT_DAYS, startDate, endDate } };
});
