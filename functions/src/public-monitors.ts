import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { BigQuery } from "@google-cloud/bigquery";
import { firestore } from "./init";

/**
 * Public monitors — powers the curated uptime landing pages on the marketing
 * site (exit1.dev/status/<slug>). Mirrors the public-stats.ts pattern: a cron
 * precomputes everything into Firestore so the unauthenticated HTTP endpoints
 * never touch BigQuery on the request path (critical at hundreds of pages).
 *
 * Only checks flagged `public: true` (curated under the connect@exit1.dev
 * account) are surfaced. Two Firestore artifacts are produced each run:
 *   - public_monitors/index           → lightweight list for the hub + sitemap
 *   - public_monitor_pages/{slug}      → full per-monitor page payload
 */

const bigquery = new BigQuery({ projectId: "exit1-dev" });
const DATASET_ID = "checks";
const DAILY_SUMMARY_TABLE_ID = "check_daily_summaries";

const INDEX_DOC = "public_monitors/index";
const PAGES_COLLECTION = "public_monitor_pages";

const DAY_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_DAYS = 90;
const FIRESTORE_BATCH_LIMIT = 450; // under the 500 hard cap, leaves headroom

// HTTP response cache headers — CDN caches for s-maxage; cron refreshes hourly.
const CACHE_CONTROL = "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400";
// In-memory cache survives within a warm instance between requests.
const MEM_TTL_MS = 10 * 60 * 1000;

type HeartbeatDay = {
  day: number;            // start-of-day UTC, ms
  status: 'online' | 'offline' | 'unknown';
  uptimePercentage: number | null;
  totalChecks: number;
  responseMs: number | null;
};

type MonitorStats = {
  uptime7d: number | null;
  uptime30d: number | null;
  uptime90d: number | null;
  avgResponseMs: number | null;   // 30-day average
  totalChecks30d: number;
};

type MonitorIndexEntry = {
  slug: string;
  name: string;
  url: string;
  host: string;
  type: string;
  status: string;
  lastChecked: number;
  uptime30d: number | null;
  // Count of days (in the 90-day window) that have at least one recorded check.
  // The marketing site uses this as a data-maturity signal: pages below a
  // threshold are kept out of the sitemap and noindexed until they have enough
  // history to be worth ranking (prevents thin/near-empty pages at scale).
  daysWithData: number;
};

type MonitorPage = MonitorIndexEntry & {
  checkId: string;
  stats: MonitorStats;
  heartbeat: HeartbeatDay[];      // oldest → newest, up to 90 entries
  updatedAt: number;
};

type DailyRow = {
  website_id: string;
  day: { value: string } | string;
  total_checks: number | null;
  online_checks: number | null;
  offline_checks: number | null;
  has_issues: boolean | null;
  avg_response_time: number | null;
};

function getDayStartUtc(timestamp: number): number {
  const d = new Date(timestamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Normalize a check URL into a hostname-based slug (e.g. https://www.GitHub.com/x → github.com). */
function hostFromUrl(url: string): string {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Sum online/total across daily rows on/after `sinceMs` → uptime %, rounded to 2dp. */
function uptimeSince(days: HeartbeatDay[], sinceMs: number): number | null {
  let online = 0;
  let total = 0;
  for (const d of days) {
    if (d.day < sinceMs) continue;
    if (d.totalChecks <= 0) continue;
    total += d.totalChecks;
    // Recover online count from stored uptime% × total (we only persist pct + total).
    online += d.uptimePercentage != null ? (d.uptimePercentage / 100) * d.totalChecks : 0;
  }
  if (total <= 0) return null;
  return Math.round((online / total) * 10000) / 100;
}

/**
 * One batched BigQuery scan per user over the 90-day window. Returns a map of
 * checkId → ordered daily summaries. Scans check_daily_summaries (~12 MB),
 * never the raw history table.
 */
async function fetchDailyBatch(
  websiteIds: string[],
  userId: string,
  startDate: number,
  endDate: number,
): Promise<Map<string, HeartbeatDay[]>> {
  const result = new Map<string, HeartbeatDay[]>();
  if (!websiteIds.length) return result;

  const query = `
    SELECT website_id, day, total_checks, online_checks, offline_checks, has_issues, avg_response_time
    FROM \`${bigquery.projectId}.${DATASET_ID}.${DAILY_SUMMARY_TABLE_ID}\`
    WHERE website_id IN UNNEST(@websiteIds)
      AND user_id = @userId
      AND day >= DATE(@startDate)
      AND day <= DATE(@endDate)
    ORDER BY website_id, day ASC
  `;

  const [rows] = await bigquery.query({
    query,
    params: {
      websiteIds,
      userId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    },
  });

  for (const row of rows as DailyRow[]) {
    const id = String(row.website_id);
    const dayValue = typeof row.day === 'string' ? row.day : row.day?.value;
    if (!dayValue) continue;
    const dayMs = getDayStartUtc(new Date(`${dayValue}T00:00:00Z`).getTime());
    const totalChecks = Number(row.total_checks) || 0;
    const onlineChecks = Number(row.online_checks) || 0;
    const responseMs = row.avg_response_time != null ? Math.round(Number(row.avg_response_time)) : null;
    const uptimePercentage = totalChecks > 0 ? Math.round((onlineChecks / totalChecks) * 10000) / 100 : null;
    const status: HeartbeatDay['status'] =
      totalChecks <= 0 ? 'unknown' : row.has_issues ? 'offline' : 'online';

    const arr = result.get(id) ?? [];
    arr.push({ day: dayMs, status, uptimePercentage, totalChecks, responseMs });
    result.set(id, arr);
  }

  return result;
}

/**
 * Build the full set of public monitor pages + index from Firestore + BigQuery.
 * Pure-ish: returns the artifacts so both the cron and the cold-start fallback
 * can persist them.
 */
async function buildPublicMonitors(): Promise<{ index: MonitorIndexEntry[]; pages: MonitorPage[] }> {
  const snap = await firestore.collection('checks').where('public', '==', true).get();

  type CheckMeta = {
    id: string;
    userId: string;
    name: string;
    url: string;
    type: string;
    status: string;
    lastChecked: number;
    responseTime: number | null;
    explicitSlug: string | null;
  };

  const checks: CheckMeta[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (d.type === 'domain') continue; // domain-only checks have no uptime data
    if (d.disabled === true) continue;
    const userId = typeof d.userId === 'string' ? d.userId : '';
    const url = typeof d.url === 'string' ? d.url : '';
    if (!userId || !url) continue;
    checks.push({
      id: doc.id,
      userId,
      url,
      name: typeof d.name === 'string' && d.name.trim() ? d.name : hostFromUrl(url),
      type: typeof d.type === 'string' ? d.type : 'website',
      status: typeof d.status === 'string' ? d.status : 'unknown',
      lastChecked: typeof d.lastChecked === 'number' ? d.lastChecked : 0,
      responseTime: typeof d.responseTime === 'number' ? d.responseTime : null,
      explicitSlug: typeof d.publicSlug === 'string' && d.publicSlug.trim() ? slugify(d.publicSlug) : null,
    });
  }

  if (!checks.length) {
    return { index: [], pages: [] };
  }

  // Resolve unique slugs (explicit publicSlug wins; else hostname; suffix on collision).
  const usedSlugs = new Set<string>();
  const slugOf = new Map<string, string>();
  for (const c of checks) {
    const base = c.explicitSlug || slugify(hostFromUrl(c.url)) || slugify(c.name) || c.id;
    let slug = base;
    let n = 2;
    while (usedSlugs.has(slug)) {
      slug = `${base}-${n++}`;
    }
    usedSlugs.add(slug);
    slugOf.set(c.id, slug);
  }

  // Batch the BigQuery scan per user (all curated checks share one account today,
  // but group defensively in case the public set ever spans accounts).
  const endDate = Date.now();
  const startDate = getDayStartUtc(endDate - (HEARTBEAT_DAYS - 1) * DAY_MS);
  const byUser = new Map<string, string[]>();
  for (const c of checks) {
    const arr = byUser.get(c.userId) ?? [];
    arr.push(c.id);
    byUser.set(c.userId, arr);
  }

  const dailyByCheck = new Map<string, HeartbeatDay[]>();
  for (const [userId, ids] of byUser) {
    try {
      const batch = await fetchDailyBatch(ids, userId, startDate, endDate);
      for (const [id, days] of batch) dailyByCheck.set(id, days);
    } catch (err) {
      logger.error(`[public-monitors] daily batch failed for user ${userId}:`, err);
    }
  }

  const sevenDaysAgo = endDate - 7 * DAY_MS;
  const thirtyDaysAgo = endDate - 30 * DAY_MS;
  const ninetyDaysAgo = endDate - 90 * DAY_MS;

  const pages: MonitorPage[] = [];
  const index: MonitorIndexEntry[] = [];

  for (const c of checks) {
    const slug = slugOf.get(c.id)!;
    const heartbeat = dailyByCheck.get(c.id) ?? [];

    // 30-day average response + total checks from the daily series.
    let respSum = 0;
    let respDays = 0;
    let totalChecks30d = 0;
    let daysWithData = 0;
    for (const d of heartbeat) {
      if (d.totalChecks > 0) daysWithData += 1;
      if (d.day < thirtyDaysAgo) continue;
      totalChecks30d += d.totalChecks;
      if (d.responseMs != null && d.totalChecks > 0) {
        respSum += d.responseMs;
        respDays += 1;
      }
    }
    const avgResponseMs = respDays > 0 ? Math.round(respSum / respDays) : c.responseTime;
    const uptime30d = uptimeSince(heartbeat, thirtyDaysAgo);

    const host = hostFromUrl(c.url);
    const indexEntry: MonitorIndexEntry = {
      slug,
      name: c.name,
      url: c.url,
      host,
      type: c.type,
      status: c.status,
      lastChecked: c.lastChecked,
      uptime30d,
      daysWithData,
    };
    index.push(indexEntry);

    pages.push({
      ...indexEntry,
      checkId: c.id,
      stats: {
        uptime7d: uptimeSince(heartbeat, sevenDaysAgo),
        uptime30d,
        uptime90d: uptimeSince(heartbeat, ninetyDaysAgo),
        avgResponseMs,
        totalChecks30d,
      },
      heartbeat,
      updatedAt: endDate,
    });
  }

  index.sort((a, b) => a.name.localeCompare(b.name));
  return { index, pages };
}

/** Persist the index doc + per-slug page docs, pruning stale page docs. */
async function persistPublicMonitors(index: MonitorIndexEntry[], pages: MonitorPage[]): Promise<void> {
  const updatedAt = Date.now();
  await firestore.doc(INDEX_DOC).set({ monitors: index, count: index.length, updatedAt });

  // Upsert page docs in chunks.
  for (let i = 0; i < pages.length; i += FIRESTORE_BATCH_LIMIT) {
    const batch = firestore.batch();
    for (const page of pages.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
      batch.set(firestore.collection(PAGES_COLLECTION).doc(page.slug), page);
    }
    await batch.commit();
  }

  // Prune page docs whose slug no longer appears (unflagged / deleted checks).
  const liveSlugs = new Set(pages.map((p) => p.slug));
  const existing = await firestore.collection(PAGES_COLLECTION).listDocuments();
  const stale = existing.filter((ref) => !liveSlugs.has(ref.id));
  for (let i = 0; i < stale.length; i += FIRESTORE_BATCH_LIMIT) {
    const batch = firestore.batch();
    for (const ref of stale.slice(i, i + FIRESTORE_BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}

export const refreshPublicMonitors = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "UTC",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async () => {
    try {
      const { index, pages } = await buildPublicMonitors();
      await persistPublicMonitors(index, pages);
      logger.info(`[public-monitors] refreshed ${index.length} public monitors`);
    } catch (error) {
      logger.error("[public-monitors] refresh failed:", error);
    }
  }
);

let indexMemCache: { data: MonitorIndexEntry[]; expiresAt: number } | null = null;

export const getPublicMonitors = onRequest(
  { cors: true, memory: "256MiB", timeoutSeconds: 30 },
  async (_req, res) => {
    try {
      const now = Date.now();
      if (indexMemCache && indexMemCache.expiresAt > now) {
        res.set("Cache-Control", CACHE_CONTROL);
        res.json({ monitors: indexMemCache.data, count: indexMemCache.data.length });
        return;
      }

      const snap = await firestore.doc(INDEX_DOC).get();
      let monitors = snap.exists ? ((snap.data()?.monitors as MonitorIndexEntry[]) ?? []) : [];

      // Cold path: index doc missing (first deploy before cron runs).
      if (!snap.exists) {
        const built = await buildPublicMonitors();
        await persistPublicMonitors(built.index, built.pages);
        monitors = built.index;
      }

      indexMemCache = { data: monitors, expiresAt: now + MEM_TTL_MS };
      res.set("Cache-Control", CACHE_CONTROL);
      res.json({ monitors, count: monitors.length });
    } catch (error) {
      logger.error("[public-monitors] getPublicMonitors failed:", error);
      res.status(500).json({ error: "Failed to load monitors" });
    }
  }
);

const pageMemCache = new Map<string, { data: MonitorPage; expiresAt: number }>();

export const getPublicMonitor = onRequest(
  { cors: true, memory: "256MiB", timeoutSeconds: 30 },
  async (req, res) => {
    try {
      const slugParam = (req.query.slug ?? req.path.replace(/^\/+/, '')) as string;
      const slug = slugify(String(slugParam || ''));
      if (!slug) {
        res.status(400).json({ error: "slug is required" });
        return;
      }

      const now = Date.now();
      const cached = pageMemCache.get(slug);
      if (cached && cached.expiresAt > now) {
        res.set("Cache-Control", CACHE_CONTROL);
        res.json({ monitor: cached.data });
        return;
      }

      const doc = await firestore.collection(PAGES_COLLECTION).doc(slug).get();
      if (!doc.exists) {
        res.status(404).json({ error: "Monitor not found" });
        return;
      }

      const monitor = doc.data() as MonitorPage;
      pageMemCache.set(slug, { data: monitor, expiresAt: now + MEM_TTL_MS });
      res.set("Cache-Control", CACHE_CONTROL);
      res.json({ monitor });
    } catch (error) {
      logger.error("[public-monitors] getPublicMonitor failed:", error);
      res.status(500).json({ error: "Failed to load monitor" });
    }
  }
);
