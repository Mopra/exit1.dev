import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { BigQuery } from "@google-cloud/bigquery";
import { firestore } from "./init";
import {
  WAF_BLOCK_ERROR_PREFIXES,
  WAF_BLOCK_RECORDED_SINCE_MS,
  buildPublicDay,
  publicCurrentStatus,
} from "./public-monitor-blocked";

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

import {
  deriveIncidents,
  mergeIncidentHistory,
  normalizeStoredIncidents,
  type IncidentIsland,
  type PublicIncident,
} from "./public-incidents";

const bigquery = new BigQuery({ projectId: "exit1-dev" });
const DATASET_ID = "checks";
const DAILY_SUMMARY_TABLE_ID = "check_daily_summaries";
const HISTORY_TABLE_ID = "check_history_new";

const INDEX_DOC = "public_monitors/index";
const PAGES_COLLECTION = "public_monitor_pages";

const DAY_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_DAYS = 90;
const FIRESTORE_BATCH_LIMIT = 450; // under the 500 hard cap, leaves headroom

// HTTP response cache headers — CDN caches for s-maxage; cron refreshes hourly.
const CACHE_CONTROL = "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400";
// One page is what exit1.dev re-reads when a monitor changes state
// (public-monitor-freshness.ts), so it must not hide behind an hour of CDN.
// Its only caller is the site's ISR, so a short TTL costs next to nothing.
const PAGE_CACHE_CONTROL = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";
// In-memory cache survives within a warm instance between requests.
const MEM_TTL_MS = 10 * 60 * 1000;
const PAGE_MEM_TTL_MS = 60 * 1000;

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

/**
 * Where a public page's up/down signal comes from. "direct" probes the site.
 * "vendor_status" reads the vendor's own status API, for sites whose bot
 * firewall refuses every datacenter probe (openai.com, medium.com, ...).
 * Those pages carry no response time: we would only be timing the status API.
 */
type MonitorSource = 'direct' | 'vendor_status';

type MonitorPage = MonitorIndexEntry & {
  checkId: string;
  source: MonitorSource;
  stats: MonitorStats;
  heartbeat: HeartbeatDay[];      // oldest → newest, up to 90 entries
  updatedAt: number;
  /** Outage windows, newest first, last 365 days. Merged into the stored list by persistPublicMonitors. */
  incidents?: PublicIncident[];
  /** When the status last changed, ms, and to what. Written on transitions by public-monitor-freshness.ts. */
  statusChangedAt?: number;
  statusChangedTo?: string;
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

  const blocked = await fetchBlockedCounts(websiteIds, userId, startDate, endDate);

  for (const row of rows as DailyRow[]) {
    const id = String(row.website_id);
    const dayValue = typeof row.day === 'string' ? row.day : row.day?.value;
    if (!dayValue) continue;
    const dayMs = getDayStartUtc(new Date(`${dayValue}T00:00:00Z`).getTime());
    const responseMs = row.avg_response_time != null ? Math.round(Number(row.avg_response_time)) : null;
    const counts = {
      totalChecks: Number(row.total_checks) || 0,
      onlineChecks: Number(row.online_checks) || 0,
      offlineChecks: Number(row.offline_checks) || 0,
      hasIssues: Boolean(row.has_issues),
    };

    const arr = result.get(id) ?? [];
    arr.push(buildPublicDay(dayMs, counts, responseMs, blocked.get(`${id}|${dayValue}`) ?? 0));
    result.set(id, arr);
  }

  return result;
}

/**
 * Count firewall-blocked observations per check per day, keyed `${id}|YYYY-MM-DD`.
 * The daily summary table has no error column, so this reads the raw history,
 * clustered on user_id/website_id and only from the day blocks started being
 * recorded. A failure here is logged and treated as "nothing blocked".
 */
async function fetchBlockedCounts(
  websiteIds: string[],
  userId: string,
  startDate: number,
  endDate: number,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const since = Math.max(startDate, WAF_BLOCK_RECORDED_SINCE_MS);
  if (since > endDate) return result;

  const query = `
    SELECT website_id, DATE(timestamp) AS day, COUNT(*) AS blocked
    FROM \`${bigquery.projectId}.${DATASET_ID}.${HISTORY_TABLE_ID}\`
    WHERE user_id = @userId
      AND website_id IN UNNEST(@websiteIds)
      AND timestamp >= @since
      AND timestamp <= @endDate
      AND status = 'offline'
      AND (${WAF_BLOCK_ERROR_PREFIXES.map((_, i) => `STARTS_WITH(error, @prefix${i})`).join(' OR ')})
    GROUP BY website_id, day
  `;
  const params: Record<string, unknown> = {
    userId,
    websiteIds,
    since: new Date(since),
    endDate: new Date(endDate),
  };
  WAF_BLOCK_ERROR_PREFIXES.forEach((p, i) => { params[`prefix${i}`] = p; });

  try {
    const [rows] = await bigquery.query({ query, params });
    for (const row of rows as Array<{ website_id: string; day: { value: string } | string; blocked: number }>) {
      const dayValue = typeof row.day === 'string' ? row.day : row.day?.value;
      if (!dayValue) continue;
      result.set(`${row.website_id}|${dayValue}`, Number(row.blocked) || 0);
    }
  } catch (err) {
    logger.error('[public-monitors] blocked-count query failed:', err);
  }
  return result;
}

// How far back to look for a check's last probe. Public checks run every few
// minutes, so anything older than this means the check has stalled and the
// Firestore value is as good as anything.
const LAST_PROBE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * Latest probe timestamp per check, from the raw history. The checks doc's
 * lastChecked is not usable for this: the runner defers routine writes of it
 * (status-buffer.ts heartbeat defer), so it lags by hours while the status is
 * current. Scans a few hours of one partition range, clustered on
 * user_id/website_id. A failure is logged and the caller keeps the doc value.
 */
async function fetchLastProbed(
  websiteIds: string[],
  userId: string,
  now: number,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!websiteIds.length) return result;

  const query = `
    SELECT website_id, MAX(timestamp) AS last_probe
    FROM \`${bigquery.projectId}.${DATASET_ID}.${HISTORY_TABLE_ID}\`
    WHERE user_id = @userId
      AND website_id IN UNNEST(@websiteIds)
      AND timestamp >= @since
    GROUP BY website_id
  `;

  try {
    const [rows] = await bigquery.query({
      query,
      params: { userId, websiteIds, since: new Date(now - LAST_PROBE_LOOKBACK_MS) },
    });
    for (const row of rows as Array<{ website_id: string; last_probe: { value: string } | string | null }>) {
      const raw = typeof row.last_probe === 'string' ? row.last_probe : row.last_probe?.value;
      const ms = raw ? new Date(raw).getTime() : NaN;
      if (Number.isFinite(ms)) result.set(String(row.website_id), ms);
    }
  } catch (err) {
    logger.error('[public-monitors] last-probe query failed:', err);
  }
  return result;
}

/**
 * How much history each hourly run re-reads for outage windows. Long enough to
 * close any outage that ends within it; older incidents stay as stored. A
 * one-off backfill passes 90 days (scripts call runPublicMonitorsRefresh).
 */
export const INCIDENT_LOOKBACK_MS = 3 * DAY_MS;

/**
 * Islands of confirmed-offline history rows per check since `since`
 * (gaps-and-islands over the raw history), each closed by the next row of any
 * kind. Offline here matches the app's own incident calc (bigquery.ts):
 * confirmed, not in maintenance, legacy DOWN/REACHABLE_WITH_ERROR included.
 * On top of that, firewall blocks and 4xx answers are not offline: a 429 or
 * 404 means the service answered and refused our probe (homebrew.sh and
 * producthunt.com rate-limit us, a wrong path 404s). Those rows still count as
 * the row after an island, so a 503 followed by hours of 429 ends at the
 * first 429. Returns null on failure so stored incidents stay untouched.
 */
async function fetchIncidentIslands(
  websiteIds: string[],
  userId: string,
  since: number,
): Promise<Map<string, IncidentIsland[]> | null> {
  const result = new Map<string, IncidentIsland[]>();
  if (!websiteIds.length) return result;

  const wafClause = WAF_BLOCK_ERROR_PREFIXES.map((_, i) => `STARTS_WITH(IFNULL(error, ''), @prefix${i})`).join(' OR ');
  const query = `
    WITH probes AS (
      SELECT website_id, timestamp, status_code, error, peer_status,
        (UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR')
          AND COALESCE(confirmed, TRUE) = TRUE
          AND COALESCE(maintenance, FALSE) = FALSE
          AND NOT (${wafClause})
          AND NOT (IFNULL(status_code, 0) BETWEEN 400 AND 499)) AS off
      FROM \`${bigquery.projectId}.${DATASET_ID}.${HISTORY_TABLE_ID}\`
      WHERE user_id = @userId
        AND website_id IN UNNEST(@websiteIds)
        AND timestamp >= @since
    ),
    marked AS (
      SELECT *,
        LAG(off) OVER w AS prev_off,
        LEAD(timestamp) OVER w AS next_ts
      FROM probes
      WINDOW w AS (PARTITION BY website_id ORDER BY timestamp)
    ),
    grouped AS (
      SELECT *,
        COUNTIF(prev_off IS NULL OR off != prev_off)
          OVER (PARTITION BY website_id ORDER BY timestamp ROWS UNBOUNDED PRECEDING) AS grp
      FROM marked
    )
    SELECT
      website_id,
      MIN(timestamp) AS started_at,
      MAX(timestamp) AS last_failed_at,
      ARRAY_AGG(next_ts ORDER BY timestamp DESC LIMIT 1)[OFFSET(0)] AS next_probe_at,
      COUNT(*) AS probes,
      ARRAY_AGG(STRUCT(status_code, error)
        ORDER BY (status_code IS NULL AND error IS NULL), timestamp LIMIT 1)[OFFSET(0)] AS first_failure,
      COUNTIF(peer_status = 'offline') AS peer_offline
    FROM grouped
    WHERE off
    GROUP BY website_id, grp
  `;
  const params: Record<string, unknown> = { userId, websiteIds, since: new Date(since) };
  WAF_BLOCK_ERROR_PREFIXES.forEach((p, i) => { params[`prefix${i}`] = p; });

  type Row = {
    website_id: string;
    started_at: { value: string } | string;
    last_failed_at: { value: string } | string;
    next_probe_at: { value: string } | string | null;
    probes: number;
    first_failure: { status_code: number | null; error: string | null } | null;
    peer_offline: number;
  };
  const ms = (v: { value: string } | string | null): number | null => {
    const raw = typeof v === 'string' ? v : v?.value;
    const t = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };

  try {
    const [rows] = await bigquery.query({ query, params });
    for (const row of rows as Row[]) {
      const startedAt = ms(row.started_at);
      const lastFailedAt = ms(row.last_failed_at);
      if (startedAt == null || lastFailedAt == null) continue;
      const id = String(row.website_id);
      const arr = result.get(id) ?? [];
      arr.push({
        startedAt,
        lastFailedAt,
        nextProbeAt: ms(row.next_probe_at),
        probes: Number(row.probes) || 0,
        statusCode: row.first_failure?.status_code != null ? Number(row.first_failure.status_code) : null,
        error: typeof row.first_failure?.error === 'string' ? row.first_failure.error : null,
        peerOfflineProbes: Number(row.peer_offline) || 0,
      });
      result.set(id, arr);
    }
    return result;
  } catch (err) {
    logger.error('[public-monitors] incident query failed:', err);
    return null;
  }
}

/** Freshly derived incidents per slug over [windowStart, now], or null when the read failed. */
type FreshIncidents = { windowStart: number; bySlug: Map<string, PublicIncident[]> } | null;

/**
 * Build the full set of public monitor pages + index from Firestore + BigQuery.
 * Pure-ish: returns the artifacts so both the cron and the cold-start fallback
 * can persist them.
 */
export async function buildPublicMonitors(
  incidentLookbackMs: number = INCIDENT_LOOKBACK_MS,
): Promise<{ index: MonitorIndexEntry[]; pages: MonitorPage[]; incidents: FreshIncidents }> {
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
    source: MonitorSource;
  };

  const checks: CheckMeta[] = [];
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    if (d.type === 'domain') continue; // domain-only checks have no uptime data
    if (d.disabled === true) continue;
    const userId = typeof d.userId === 'string' ? d.userId : '';
    // publicUrl is the site the page is about when the check probes a
    // different URL (robots.txt, or a vendor status API). The slug, host and
    // shown link all follow it, so switching the probe never moves the page.
    const probeUrl = typeof d.url === 'string' ? d.url : '';
    const url = typeof d.publicUrl === 'string' && d.publicUrl.trim() ? d.publicUrl.trim() : probeUrl;
    if (!userId || !url) continue;
    const source: MonitorSource = d.publicSource === 'vendor_status' ? 'vendor_status' : 'direct';
    checks.push({
      id: doc.id,
      userId,
      url,
      name: typeof d.name === 'string' && d.name.trim() ? d.name : hostFromUrl(url),
      type: typeof d.type === 'string' ? d.type : 'website',
      status: publicCurrentStatus(typeof d.status === 'string' ? d.status : 'unknown', d.lastError),
      lastChecked: typeof d.lastChecked === 'number' ? d.lastChecked : 0,
      responseTime: source === 'direct' && typeof d.responseTime === 'number' ? d.responseTime : null,
      source,
      explicitSlug: typeof d.publicSlug === 'string' && d.publicSlug.trim() ? slugify(d.publicSlug) : null,
    });
  }

  if (!checks.length) {
    return { index: [], pages: [], incidents: null };
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

  // The probe time the pages print as "last checked". Take the later of the
  // history and the doc, since a transition push writes the doc at once.
  const lastProbed = new Map<string, number>();
  for (const [userId, ids] of byUser) {
    for (const [id, ms] of await fetchLastProbed(ids, userId, endDate)) lastProbed.set(id, ms);
  }
  for (const c of checks) {
    c.lastChecked = Math.max(c.lastChecked, lastProbed.get(c.id) ?? 0);
  }

  // Outage windows. One failed read leaves every stored list untouched. No
  // rows are written while a check stays down, so an outage still open began
  // with a row that may sit before the lookback: read back to its start.
  let windowStart = endDate - incidentLookbackMs;
  for (let i = 0; i < checks.length; i += FIRESTORE_BATCH_LIMIT) {
    const refs = checks
      .slice(i, i + FIRESTORE_BATCH_LIMIT)
      .map((c) => firestore.collection(PAGES_COLLECTION).doc(slugOf.get(c.id)!));
    for (const doc of await firestore.getAll(...refs)) {
      for (const inc of normalizeStoredIncidents(doc.get("incidents"))) {
        if (inc.ongoing && inc.startedAt < windowStart) windowStart = inc.startedAt - 60 * 1000;
      }
    }
  }
  const islandsByCheck = new Map<string, IncidentIsland[]>();
  let incidentsOk = true;
  for (const [userId, ids] of byUser) {
    const islands = await fetchIncidentIslands(ids, userId, windowStart);
    if (!islands) {
      incidentsOk = false;
      break;
    }
    for (const [id, list] of islands) islandsByCheck.set(id, list);
  }
  const incidentsBySlug = new Map<string, PublicIncident[]>();
  if (incidentsOk) {
    for (const c of checks) {
      // A vendor_status page reads the vendor's own status API; its "outages"
      // would be that API's, which the outage pages can't present as ours.
      const islands = c.source === 'vendor_status' ? [] : islandsByCheck.get(c.id) ?? [];
      incidentsBySlug.set(slugOf.get(c.id)!, deriveIncidents(islands, c.status === 'offline'));
    }
  }

  const sevenDaysAgo = endDate - 7 * DAY_MS;
  const thirtyDaysAgo = endDate - 30 * DAY_MS;
  const ninetyDaysAgo = endDate - 90 * DAY_MS;

  const pages: MonitorPage[] = [];
  const index: MonitorIndexEntry[] = [];

  for (const c of checks) {
    const slug = slugOf.get(c.id)!;
    const daily = dailyByCheck.get(c.id) ?? [];
    const heartbeat = c.source === 'vendor_status' ? daily.map((d) => ({ ...d, responseMs: null })) : daily;

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
      source: c.source,
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
  return { index, pages, incidents: incidentsOk ? { windowStart, bySlug: incidentsBySlug } : null };
}

/** Persist the index doc + per-slug page docs, pruning stale page docs. */
async function persistPublicMonitors(
  index: MonitorIndexEntry[],
  pages: MonitorPage[],
  buildStartedAt: number,
  incidents: FreshIncidents,
): Promise<void> {
  const updatedAt = Date.now();
  await firestore.doc(INDEX_DOC).set({ monitors: index, count: index.length, updatedAt });

  // Upsert page docs in chunks. Merge keeps statusChangedAt/To, which only the
  // transition push writes. A push that landed while this build was reading
  // BigQuery is newer than our snapshot of the check, so its status and
  // lastChecked win.
  for (let i = 0; i < pages.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = pages.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const refs = chunk.map((page) => firestore.collection(PAGES_COLLECTION).doc(page.slug));
    const existing = await firestore.getAll(...refs);
    const batch = firestore.batch();
    chunk.forEach((page, j) => {
      if (incidents) {
        page.incidents = mergeIncidentHistory(
          normalizeStoredIncidents(existing[j].get("incidents")),
          incidents.bySlug.get(page.slug) ?? [],
          incidents.windowStart,
          updatedAt,
        );
      }
      const pushedAt = existing[j].get("statusChangedAt");
      if (typeof pushedAt === "number" && pushedAt > buildStartedAt) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { status, lastChecked, ...rest } = page;
        batch.set(refs[j], rest, { merge: true });
      } else {
        batch.set(refs[j], page, { merge: true });
      }
    });
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

export async function runPublicMonitorsRefresh(incidentLookbackMs: number = INCIDENT_LOOKBACK_MS): Promise<void> {
  try {
    const buildStartedAt = Date.now();
    const { index, pages, incidents } = await buildPublicMonitors(incidentLookbackMs);
    await persistPublicMonitors(index, pages, buildStartedAt, incidents);
    logger.info(`[public-monitors] refreshed ${index.length} public monitors`);
  } catch (error) {
    logger.error("[public-monitors] refresh failed:", error);
  }
}

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
        const buildStartedAt = Date.now();
        const built = await buildPublicMonitors();
        await persistPublicMonitors(built.index, built.pages, buildStartedAt, built.incidents);
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
  { cors: true, memory: "256MiB", timeoutSeconds: 30, maxInstances: 20 },
  async (req, res) => {
    try {
      const slugParam = (req.query.slug ?? req.path.replace(/^\/+/, '')) as string;
      const slug = slugify(String(slugParam || ''));
      if (!slug) {
        res.status(400).json({ error: "slug is required" });
        return;
      }

      const now = Date.now();
      // ?fresh=<anything> is the site's status-refresh route checking a
      // transition push: skip this cache and the CDN's (the value varies).
      const fresh = req.query.fresh != null;
      const cached = fresh ? undefined : pageMemCache.get(slug);
      if (cached && cached.expiresAt > now) {
        res.set("Cache-Control", PAGE_CACHE_CONTROL);
        res.json({ monitor: cached.data });
        return;
      }

      const doc = await firestore.collection(PAGES_COLLECTION).doc(slug).get();
      if (!doc.exists) {
        res.status(404).json({ error: "Monitor not found" });
        return;
      }

      const monitor = doc.data() as MonitorPage;
      pageMemCache.set(slug, { data: monitor, expiresAt: now + PAGE_MEM_TTL_MS });
      res.set("Cache-Control", fresh ? "no-store" : PAGE_CACHE_CONTROL);
      res.json({ monitor });
    } catch (error) {
      logger.error("[public-monitors] getPublicMonitor failed:", error);
      res.status(500).json({ error: "Failed to load monitor" });
    }
  }
);
