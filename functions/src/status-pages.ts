import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

const CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_CACHE_TTL_MS = 60 * 1000;
const HEARTBEAT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CHECKS = 50;
const MAX_CONCURRENT = 5;
const HEARTBEAT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type StatusPageDoc = {
  userId: string;
  visibility: 'public' | 'private';
  checkIds?: string[];
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
  uptimePercentage: number;
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

const statusPageUptimeCache = new Map<string, { data: UptimeEntry[]; expiresAt: number }>();
const statusPageSnapshotCache = new Map<string, { data: SnapshotEntry[]; expiresAt: number }>();
const statusPageHeartbeatCache = new Map<string, { data: HeartbeatEntry[]; expiresAt: number }>();

const getStatusPageCacheKey = (statusPageId: string, statusPage: StatusPageDoc) => {
  const updatedAt = typeof statusPage.updatedAt === 'number' ? statusPage.updatedAt : 0;
  return `${statusPageId}:${updatedAt}`;
};

const pruneStatusPageCache = <T>(cache: Map<string, T>, statusPageId: string, keepKey: string) => {
  const prefix = `${statusPageId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix) && key !== keepKey) {
      cache.delete(key);
    }
  }
};

const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length));

  const runners = Array.from({ length: concurrency }, async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        break;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
};

function parseBigQueryTimestamp(timestamp: unknown, fallback: number = 0): number {
  try {
    if (!timestamp) return fallback;
    if (typeof timestamp === 'object' && timestamp !== null && 'value' in timestamp) {
      const value = (timestamp as { value?: unknown }).value;
      if (typeof value === 'string' && value) {
        const parsed = new Date(value).getTime();
        return Number.isFinite(parsed) ? parsed : fallback;
      }
    } else if (timestamp instanceof Date) {
      return timestamp.getTime();
    } else if (typeof timestamp === 'number') {
      return Number.isFinite(timestamp) ? timestamp : fallback;
    } else if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp).getTime();
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function getDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
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

  const cacheKey = getStatusPageCacheKey(statusPageId, statusPage);
  const cached = statusPageUptimeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { success: true, data: { checkUptime: cached.data } };
  }
  if (cached) {
    statusPageUptimeCache.delete(cacheKey);
  }

  const rawIds = Array.isArray(statusPage.checkIds) ? statusPage.checkIds : [];
  const checkIds = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  if (checkIds.length === 0) {
    return { success: true, data: { checkUptime: [] } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageUptime] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  const { getCheckStats } = await import('./bigquery.js');

  const entries = await runWithConcurrency(checkIds, MAX_CONCURRENT, async (checkId) => {
    try {
      const stats = await getCheckStats(checkId, statusPage.userId);
      const uptimePercentage = Number(stats.uptimePercentage);
      if (!Number.isFinite(uptimePercentage)) {
        return null;
      }
      return {
        checkId,
        uptimePercentage: Math.round(uptimePercentage * 100) / 100
      } as UptimeEntry;
    } catch (error) {
      logger.warn(`[getStatusPageUptime] Failed BigQuery stats for ${checkId}`, error);
      return null;
    }
  });

  const uptimeEntries = entries.filter((entry): entry is UptimeEntry => Boolean(entry));
  pruneStatusPageCache(statusPageUptimeCache, statusPageId, cacheKey);
  statusPageUptimeCache.set(cacheKey, {
    data: uptimeEntries,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
  if (statusPageUptimeCache.size > 1000) {
    statusPageUptimeCache.clear();
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

  const cacheKey = getStatusPageCacheKey(statusPageId, statusPage);
  const cached = statusPageSnapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { success: true, data: { checks: cached.data } };
  }
  if (cached) {
    statusPageSnapshotCache.delete(cacheKey);
  }

  const rawIds = Array.isArray(statusPage.checkIds) ? statusPage.checkIds : [];
  const checkIds = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  if (checkIds.length === 0) {
    return { success: true, data: { checks: [] } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageSnapshot] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  const checkRefs = checkIds.map((id) => firestore.collection('checks').doc(id));
  const checkSnaps = await firestore.getAll(...checkRefs);
  const checkMeta = new Map<string, { name: string; url: string; disabled?: boolean; folder?: string | null }>();
  checkSnaps.forEach((snap) => {
    if (!snap.exists) return;
    const data = snap.data() as { name?: unknown; url?: unknown; disabled?: unknown; folder?: unknown };
    const name = typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled check';
    const url = typeof data.url === 'string' ? data.url : '';
    const disabled = typeof data.disabled === 'boolean' ? data.disabled : false;
    const folder = typeof data.folder === 'string' ? data.folder : null;
    checkMeta.set(snap.id, { name, url, disabled, folder });
  });

  const { getCheckStats, getLatestCheckStatuses } = await import('./bigquery.js');
  const latestRows = await getLatestCheckStatuses(statusPage.userId, checkIds);
  const latestMap = new Map<string, { status: string; lastChecked: number }>();
  latestRows.forEach((row) => {
    const lastChecked = parseBigQueryTimestamp(row.timestamp, 0);
    latestMap.set(row.website_id, {
      status: row.status || 'unknown',
      lastChecked,
    });
  });

  const uptimeEntries = await runWithConcurrency(checkIds, MAX_CONCURRENT, async (checkId) => {
    try {
      const stats = await getCheckStats(checkId, statusPage.userId);
      const uptimePercentage = Number(stats.uptimePercentage);
      if (!Number.isFinite(uptimePercentage)) {
        return null;
      }
      return {
        checkId,
        uptimePercentage: Math.round(uptimePercentage * 100) / 100
      } as UptimeEntry;
    } catch (error) {
      logger.warn(`[getStatusPageSnapshot] Failed BigQuery stats for ${checkId}`, error);
      return null;
    }
  });

  const uptimeMap = new Map<string, number>();
  uptimeEntries.forEach((entry) => {
    if (entry) {
      uptimeMap.set(entry.checkId, entry.uptimePercentage);
    }
  });

  const checks = checkIds.map((checkId) => {
    const meta = checkMeta.get(checkId);
    const latest = latestMap.get(checkId);
    const uptimePercentage = uptimeMap.get(checkId);
    const status = meta?.disabled ? 'disabled' : latest?.status ?? 'unknown';

    return {
      checkId,
      name: meta?.name ?? 'Untitled check',
      url: meta?.url ?? '',
      status,
      lastChecked: latest?.lastChecked ?? 0,
      uptimePercentage: uptimePercentage ?? Number.NaN,
      folder: meta?.folder ?? null,
    } as SnapshotEntry;
  });

  pruneStatusPageCache(statusPageSnapshotCache, statusPageId, cacheKey);
  statusPageSnapshotCache.set(cacheKey, {
    data: checks,
    expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS
  });
  if (statusPageSnapshotCache.size > 1000) {
    statusPageSnapshotCache.clear();
  }

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

  const cacheKey = getStatusPageCacheKey(statusPageId, statusPage);
  const cached = statusPageHeartbeatCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const endDate = Date.now();
    const startDate = getDayStart(endDate - ((HEARTBEAT_DAYS - 1) * DAY_MS));
    return { success: true, data: { heartbeat: cached.data, days: HEARTBEAT_DAYS, startDate, endDate } };
  }
  if (cached) {
    statusPageHeartbeatCache.delete(cacheKey);
  }

  const rawIds = Array.isArray(statusPage.checkIds) ? statusPage.checkIds : [];
  const checkIds = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  if (checkIds.length === 0) {
    return { success: true, data: { heartbeat: [], days: HEARTBEAT_DAYS } };
  }

  if (checkIds.length > MAX_CHECKS) {
    logger.warn(`[getStatusPageHeartbeat] Too many checks (${checkIds.length}) on ${statusPageId}, trimming to ${MAX_CHECKS}`);
    checkIds.length = MAX_CHECKS;
  }

  const endDate = Date.now();
  const startDate = getDayStart(endDate - ((HEARTBEAT_DAYS - 1) * DAY_MS));

  const { getCheckHistoryDailySummary } = await import('./bigquery.js');

  const entries = await runWithConcurrency(checkIds, MAX_CONCURRENT, async (checkId) => {
    try {
      const summaries = await getCheckHistoryDailySummary(checkId, statusPage.userId, startDate, endDate);
      const days = summaries.map((summary) => {
        const totalChecks = Number(summary.totalChecks ?? 0);
        const issueCount = Number(summary.issueCount ?? 0);
        const status = totalChecks > 0 ? (summary.hasIssues ? 'offline' : 'online') : 'unknown';
        return {
          day: summary.day.getTime(),
          status,
          totalChecks,
          issueCount,
        } as HeartbeatDay;
      });

      return { checkId, days } as HeartbeatEntry;
    } catch (error) {
      logger.warn(`[getStatusPageHeartbeat] Failed daily summary for ${checkId}`, error);
      return { checkId, days: [] } as HeartbeatEntry;
    }
  });

  pruneStatusPageCache(statusPageHeartbeatCache, statusPageId, cacheKey);
  statusPageHeartbeatCache.set(cacheKey, {
    data: entries,
    expiresAt: Date.now() + HEARTBEAT_CACHE_TTL_MS
  });
  if (statusPageHeartbeatCache.size > 1000) {
    statusPageHeartbeatCache.clear();
  }

  return { success: true, data: { heartbeat: entries, days: HEARTBEAT_DAYS, startDate, endDate } };
});
