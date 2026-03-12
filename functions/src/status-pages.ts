import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

const MAX_CHECKS = 50;
const HEARTBEAT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// Firestore-based cache TTLs (survives across Cloud Function instances)
const UPTIME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — uptime % changes slowly
const HEARTBEAT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — daily summaries change once/day
// Date range for uptime calculation on status pages (limits BigQuery scan)
const UPTIME_LOOKBACK_MS = 30 * DAY_MS;

type StatusPageDoc = {
  userId: string;
  visibility: 'public' | 'private';
  checkIds?: string[];
  /** Folder paths for dynamic inclusion — checks in these folders are resolved at query time */
  folderPaths?: string[];
  updatedAt?: number;
};

type UptimeEntry = {
  checkId: string;
  uptimePercentage: number;
};

type SnapshotEntry = {
  checkId: string;
  name: string;
  url: string;
  status: string;
  lastChecked: number;
  uptimePercentage: number | null;
  folder?: string | null;
};

type HeartbeatDay = {
  day: number;
  status: 'online' | 'offline' | 'unknown';
  totalChecks: number;
  issueCount: number;
};

type HeartbeatEntry = {
  checkId: string;
  days: HeartbeatDay[];
};

/**
 * Firestore-based cache for status page data.
 * Unlike in-memory Maps, this survives across Cloud Function cold starts,
 * which is critical because serverless instances lose memory on every cold start.
 * Cache docs live at: status_page_cache/{statusPageId}
 */
type FirestoreCacheDoc = {
  uptime?: { data: UptimeEntry[]; expiresAt: number };
  heartbeat?: { data: HeartbeatEntry[]; expiresAt: number };
};

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
 * Returns Map<checkId, uptimePercentage>.
 */
async function getCachedUptimeMap(statusPageId: string, checkIds: string[], userId: string): Promise<Map<string, number>> {
  const cached = await getFirestoreCache(statusPageId);
  if (cached?.uptime && cached.uptime.expiresAt > Date.now()) {
    const map = new Map<string, number>();
    for (const entry of cached.uptime.data) {
      map.set(entry.checkId, entry.uptimePercentage);
    }
    return map;
  }

  // Cache miss — use pre-aggregated daily summaries (12 MB scan vs 92 MB)
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
  setFirestoreCache(statusPageId, 'uptime', { data: uptimeEntries, expiresAt: Date.now() + UPTIME_CACHE_TTL_MS });

  return map;
}

/**
 * Get heartbeat data from Firestore cache or compute via BigQuery.
 * Returns HeartbeatEntry[] for all check IDs.
 */
async function getCachedHeartbeat(statusPageId: string, checkIds: string[], userId: string): Promise<{ entries: HeartbeatEntry[]; startDate: number; endDate: number }> {
  const endDate = Date.now();
  const startDate = getDayStart(endDate - ((HEARTBEAT_DAYS - 1) * DAY_MS));

  const cached = await getFirestoreCache(statusPageId);
  if (cached?.heartbeat && cached.heartbeat.expiresAt > Date.now()) {
    return { entries: cached.heartbeat.data, startDate, endDate };
  }

  // Cache miss — use pre-aggregated daily summaries (12 MB scan vs 800 MB)
  const { getPreAggregatedDailySummaryBatch } = await import('./bigquery.js');
  const batchSummaries = await getPreAggregatedDailySummaryBatch(checkIds, userId, startDate, endDate);

  const entries: HeartbeatEntry[] = checkIds.map((checkId) => {
    const summaries = batchSummaries.get(checkId) || [];
    const days = summaries.map((summary) => {
      const totalChecks = Number(summary.totalChecks ?? 0);
      const issueCount = Number(summary.issueCount ?? 0);
      const status = totalChecks > 0 ? (summary.hasIssues ? 'offline' : 'online') : 'unknown';
      return { day: summary.day.getTime(), status, totalChecks, issueCount } as HeartbeatDay;
    });
    return { checkId, days } as HeartbeatEntry;
  });

  // Write to Firestore cache (fire-and-forget)
  setFirestoreCache(statusPageId, 'heartbeat', { data: entries, expiresAt: Date.now() + HEARTBEAT_CACHE_TTL_MS });

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

/**
 * Resolve folderPaths to check IDs by querying all user's checks and matching folder paths
 * Returns combined set of explicit checkIds plus checks from matched folders
 */
async function resolveStatusPageCheckIds(
  userId: string,
  explicitCheckIds: string[],
  folderPaths: string[]
): Promise<string[]> {
  // Start with explicit check IDs
  const allCheckIds = new Set<string>(explicitCheckIds);

  // If no folder paths, just return explicit IDs
  if (folderPaths.length === 0) {
    return Array.from(allCheckIds);
  }

  // Query all user's checks to find those matching folder paths
  const checksSnapshot = await firestore
    .collection('checks')
    .where('userId', '==', userId)
    .get();

  for (const doc of checksSnapshot.docs) {
    const checkData = doc.data() as { folder?: string | null };
    const checkFolder = normalizeFolder(checkData.folder);

    // Check if this check's folder exactly matches any selected folder path
    // (parent folder selection does NOT cascade to subfolders)
    if (checkFolder && folderPaths.includes(checkFolder)) {
      allCheckIds.add(doc.id);
    }
  }

  return Array.from(allCheckIds);
}

export const getStatusPageUptime = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const { statusPageId } = request.data || {};
  if (!statusPageId || typeof statusPageId !== 'string') {
    throw new HttpsError("invalid-argument", "statusPageId is required");
  }

  const statusDoc = await firestore.collection('status_pages').doc(statusPageId).get();
  if (!statusDoc.exists) {
    throw new HttpsError("not-found", "Status page not found");
  }

  const statusPage = statusDoc.data() as StatusPageDoc;
  if (!statusPage?.userId) {
    throw new HttpsError("not-found", "Status page data not found");
  }

  const isOwner = request.auth?.uid && request.auth.uid === statusPage.userId;
  if (!isOwner && statusPage.visibility !== 'public') {
    throw new HttpsError("permission-denied", "Status page is private");
  }

  // Get explicit check IDs
  const rawIds = Array.isArray(statusPage.checkIds) ? statusPage.checkIds : [];
  const explicitCheckIds = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  // Get folder paths
  const rawFolderPaths = Array.isArray(statusPage.folderPaths) ? statusPage.folderPaths : [];
  const folderPaths = rawFolderPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

  // Resolve all check IDs (explicit + from folders)
  const checkIds = await resolveStatusPageCheckIds(statusPage.userId, explicitCheckIds, folderPaths);

  if (checkIds.length === 0) {
    return { success: true, data: { checkUptime: [] } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageUptime] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  // Fetch check metadata to filter out deleted checks
  const checkRefs = checkIds.map((id) => firestore.collection('checks').doc(id));
  const checkSnaps = await firestore.getAll(...checkRefs);
  const validCheckIds: string[] = [];
  checkSnaps.forEach((snap) => {
    if (snap.exists) validCheckIds.push(snap.id);
  });

  if (validCheckIds.length === 0) {
    return { success: true, data: { checkUptime: [] } };
  }

  // Firestore-cached uptime % with 5-min TTL + 30-day BigQuery lookback
  const uptimeMap = await getCachedUptimeMap(statusPageId, validCheckIds, statusPage.userId);

  const uptimeEntries: UptimeEntry[] = [];
  for (const checkId of validCheckIds) {
    const pct = uptimeMap.get(checkId);
    if (pct != null) {
      uptimeEntries.push({ checkId, uptimePercentage: pct });
    }
  }

  return { success: true, data: { checkUptime: uptimeEntries } };
});

export const getStatusPageSnapshot = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const { statusPageId } = request.data || {};
  if (!statusPageId || typeof statusPageId !== 'string') {
    throw new HttpsError("invalid-argument", "statusPageId is required");
  }

  const statusDoc = await firestore.collection('status_pages').doc(statusPageId).get();
  if (!statusDoc.exists) {
    throw new HttpsError("not-found", "Status page not found");
  }

  const statusPage = statusDoc.data() as StatusPageDoc;
  if (!statusPage?.userId) {
    throw new HttpsError("not-found", "Status page data not found");
  }

  const isOwner = request.auth?.uid && request.auth.uid === statusPage.userId;
  if (!isOwner && statusPage.visibility !== 'public') {
    throw new HttpsError("permission-denied", "Status page is private");
  }

  // Get explicit check IDs
  const rawIds = Array.isArray(statusPage.checkIds) ? statusPage.checkIds : [];
  const explicitCheckIds = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  // Get folder paths
  const rawFolderPaths = Array.isArray(statusPage.folderPaths) ? statusPage.folderPaths : [];
  const folderPaths = rawFolderPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

  // Resolve all check IDs (explicit + from folders)
  const checkIds = await resolveStatusPageCheckIds(statusPage.userId, explicitCheckIds, folderPaths);

  if (checkIds.length === 0) {
    return { success: true, data: { checks: [] } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageSnapshot] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  // Read check docs from Firestore — these already contain status, lastChecked, etc.
  // from the scheduler's status-buffer writes (every 2 min).
  // This eliminates the need for a separate BigQuery getLatestCheckStatuses query.
  const checkRefs = checkIds.map((id) => firestore.collection('checks').doc(id));
  const checkSnaps = await firestore.getAll(...checkRefs);
  const checkMeta = new Map<string, { name: string; url: string; disabled?: boolean; folder?: string | null; status?: string; lastChecked?: number }>();
  checkSnaps.forEach((snap) => {
    if (!snap.exists) return;
    const data = snap.data() as { name?: unknown; url?: unknown; disabled?: unknown; folder?: unknown; status?: unknown; lastChecked?: unknown };
    const name = typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled check';
    const url = typeof data.url === 'string' ? data.url : '';
    const disabled = typeof data.disabled === 'boolean' ? data.disabled : false;
    const folder = typeof data.folder === 'string' ? data.folder : null;
    const status = typeof data.status === 'string' ? data.status : 'unknown';
    const lastChecked = typeof data.lastChecked === 'number' ? data.lastChecked : 0;
    checkMeta.set(snap.id, { name, url, disabled, folder, status, lastChecked });
  });

  // Uptime % requires BigQuery — use Firestore-cached result with 5-min TTL
  const uptimeMap = await getCachedUptimeMap(statusPageId, checkIds, statusPage.userId);

  // Filter out deleted/orphaned checks - only include checks that still exist in Firestore
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
        uptimePercentage: uptimePercentage ?? null,
        folder: meta.folder ?? null,
      } as SnapshotEntry;
    });

  return { success: true, data: { checks } };
});

export const getStatusPageHeartbeat = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const { statusPageId } = request.data || {};
  if (!statusPageId || typeof statusPageId !== 'string') {
    throw new HttpsError("invalid-argument", "statusPageId is required");
  }

  const statusDoc = await firestore.collection('status_pages').doc(statusPageId).get();
  if (!statusDoc.exists) {
    throw new HttpsError("not-found", "Status page not found");
  }

  const statusPage = statusDoc.data() as StatusPageDoc;
  if (!statusPage?.userId) {
    throw new HttpsError("not-found", "Status page data not found");
  }

  const isOwner = request.auth?.uid && request.auth.uid === statusPage.userId;
  if (!isOwner && statusPage.visibility !== 'public') {
    throw new HttpsError("permission-denied", "Status page is private");
  }

  // Get explicit check IDs
  const rawIds = Array.isArray(statusPage.checkIds) ? statusPage.checkIds : [];
  const explicitCheckIds = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  // Get folder paths
  const rawFolderPaths = Array.isArray(statusPage.folderPaths) ? statusPage.folderPaths : [];
  const folderPaths = rawFolderPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

  // Resolve all check IDs (explicit + from folders)
  const checkIds = await resolveStatusPageCheckIds(statusPage.userId, explicitCheckIds, folderPaths);

  if (checkIds.length === 0) {
    return { success: true, data: { heartbeat: [], days: HEARTBEAT_DAYS } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageHeartbeat] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  // Fetch check metadata to filter out deleted checks
  const checkRefs = checkIds.map((id) => firestore.collection('checks').doc(id));
  const checkSnaps = await firestore.getAll(...checkRefs);
  const validCheckIds: string[] = [];
  checkSnaps.forEach((snap) => {
    if (snap.exists) validCheckIds.push(snap.id);
  });

  if (validCheckIds.length === 0) {
    return { success: true, data: { heartbeat: [], days: HEARTBEAT_DAYS } };
  }

  // Firestore-cached heartbeat with 1-hour TTL
  const { entries, startDate, endDate } = await getCachedHeartbeat(statusPageId, validCheckIds, statusPage.userId);

  return { success: true, data: { heartbeat: entries, days: HEARTBEAT_DAYS, startDate, endDate } };
});
