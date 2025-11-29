import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { CLERK_SECRET_KEY_PROD } from "./env";
import { createClerkClient } from '@clerk/backend';
import { BigQuery } from '@google-cloud/bigquery';
import { FieldPath, Timestamp, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";

const bigquery = new BigQuery({
  projectId: 'exit1-dev',
  keyFilename: undefined, // Use default credentials
});

const CHECK_STATS_BATCH_SIZE = 500;
const CHECK_STATS_MAX_DOCS = 50_000;
const BADGE_DOMAIN_VIEW_LIMIT = 5_000;
const BADGE_DOMAIN_MAX_DOMAINS = 1_000;
const BADGE_DOMAIN_CHECK_FETCH_CHUNK = 25;
const ADMIN_STATS_CACHE_COLLECTION = 'admin_metadata';
const ADMIN_STATS_CACHE_DOC_ID = 'stats_cache';
const ADMIN_STATS_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const BADGE_DOMAIN_CACHE_DOC_ID = 'badge_domains_cache';
const BADGE_DOMAIN_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CheckStatsResult {
  activeUsers: number;
  checksByStatus: {
    online: number;
    offline: number;
    unknown: number;
    disabled: number;
  };
  recentChecks: number;
  processedDocs: number;
  truncated: boolean;
}

interface DomainCheckSummary {
  checkId: string;
  checkName?: string;
  checkUrl?: string;
  viewCount: number;
  firstSeen: number;
  lastSeen: number;
}

interface DomainAggregate {
  domain: string;
  checks: Map<string, DomainCheckSummary>;
  totalViews: number;
}

interface DomainSummary {
  domain: string;
  checks: DomainCheckSummary[];
  totalViews: number;
}

interface BadgeDomainSummary {
  totalDomains: number;
  domains: DomainSummary[];
  truncated: boolean;
  skippedDomains: number;
  viewLimit: number;
  domainLimit: number;
}

interface CachedBadgeDomainsDoc {
  payload: BadgeDomainSummary;
  updatedAt: number;
  ttlMs: number;
  expired?: boolean;
}

interface AdminStatsPayload {
  totalUsers: number;
  activeUsers: number;
  totalChecks: number;
  totalCheckExecutions: number;
  totalWebhooks: number;
  enabledWebhooks: number;
  checksByStatus: {
    online: number;
    offline: number;
    unknown: number;
    disabled: number;
  };
  averageChecksPerUser: number;
  recentActivity: {
    newUsers: number;
    newChecks: number;
    checkExecutions: number;
  };
  badgeUsage: {
    checksWithBadges: number;
    uniqueDomainsWithBadges: number;
    totalBadgeViews: number;
    recentBadgeViews: number;
  };
}

interface CachedAdminStatsDoc {
  payload: AdminStatsPayload;
  updatedAt: number;
  ttlMs: number;
  expired?: boolean;
}

const toMillis = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  return null;
};

const getSafeCount = async (query: Query): Promise<number> => {
  try {
    const snapshot = await query.count().get();
    return snapshot.data().count ?? 0;
  } catch (error) {
    logger.error('Aggregate count failed', error);
    return 0;
  }
};

const collectCheckStats = async (sevenDaysAgo: number): Promise<CheckStatsResult> => {
  const uniqueUserIds = new Set<string>();
  const checksByStatus = {
    online: 0,
    offline: 0,
    unknown: 0,
    disabled: 0,
  };
  let recentChecks = 0;
  let processedDocs = 0;
  let truncated = false;
  let lastDoc: QueryDocumentSnapshot | null = null;

  const baseQuery = firestore.collection('checks')
    .orderBy(FieldPath.documentId())
    .select('userId', 'status', 'disabled', 'createdAt');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = baseQuery.limit(CHECK_STATS_BATCH_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const userId = data.userId;
      if (typeof userId === 'string' && userId) {
        uniqueUserIds.add(userId);
      }

      const disabled = data.disabled === true;
      const status = typeof data.status === 'string' ? data.status.toLowerCase() : undefined;
      if (disabled) {
        checksByStatus.disabled += 1;
      } else if (status === 'up' || status === 'online') {
        checksByStatus.online += 1;
      } else if (status === 'down' || status === 'offline') {
        checksByStatus.offline += 1;
      } else {
        checksByStatus.unknown += 1;
      }

      const createdAtMillis = toMillis(data.createdAt);
      if (createdAtMillis && createdAtMillis >= sevenDaysAgo) {
        recentChecks += 1;
      }
    }

    processedDocs += snapshot.size;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    if (processedDocs >= CHECK_STATS_MAX_DOCS) {
      truncated = true;
      logger.warn(
        `collectCheckStats truncated after ${processedDocs} documents. Increase CHECK_STATS_MAX_DOCS or rely on pre-aggregated metrics for full fidelity.`,
      );
      break;
    }

    if (snapshot.size < CHECK_STATS_BATCH_SIZE) {
      break;
    }
  }

  return {
    activeUsers: uniqueUserIds.size,
    checksByStatus,
    recentChecks,
    processedDocs,
    truncated,
  };
};

const fetchCheckMetadata = async (checkIds: Set<string>): Promise<Map<string, { name?: string; url?: string }>> => {
  const metadata = new Map<string, { name?: string; url?: string }>();
  const ids = Array.from(checkIds);

  for (let i = 0; i < ids.length; i += BADGE_DOMAIN_CHECK_FETCH_CHUNK) {
    const chunk = ids.slice(i, i + BADGE_DOMAIN_CHECK_FETCH_CHUNK);
    const docs = await Promise.all(
      chunk.map(async (checkId) => {
        try {
          return await firestore.collection('checks').doc(checkId).get();
        } catch (error) {
          logger.warn(`Failed to fetch check metadata for ${checkId}`, error);
          return null;
        }
      }),
    );

    docs.forEach((doc, index) => {
      if (!doc || !doc.exists) {
        return;
      }
      const data = doc.data() ?? {};
      metadata.set(chunk[index], {
        name: data.name,
        url: data.url,
      });
    });
  }

  return metadata;
};

const buildBadgeDomainSummary = async (): Promise<BadgeDomainSummary> => {
  const badgeViewsSnapshot = await firestore.collection('badge_views')
    .where('domain', '!=', null)
    .limit(BADGE_DOMAIN_VIEW_LIMIT)
    .select('domain', 'checkId', 'timestamp', 'createdAt')
    .get();

  const domainMap = new Map<string, DomainAggregate>();
  const uniqueCheckIds = new Set<string>();
  let skippedDomains = 0;

  for (const doc of badgeViewsSnapshot.docs) {
    const data = doc.data();
    const domain = typeof data.domain === 'string' ? data.domain.trim() : '';
    const checkId = typeof data.checkId === 'string' ? data.checkId : '';
    if (!domain || !checkId) {
      continue;
    }

    let domainInfo = domainMap.get(domain);
    if (!domainInfo) {
      if (domainMap.size >= BADGE_DOMAIN_MAX_DOMAINS) {
        skippedDomains += 1;
        continue;
      }
      domainInfo = {
        domain,
        checks: new Map<string, DomainCheckSummary>(),
        totalViews: 0,
      };
      domainMap.set(domain, domainInfo);
    }

    uniqueCheckIds.add(checkId);
    domainInfo.totalViews += 1;

    const timestamp = toMillis(data.timestamp) ?? toMillis(data.createdAt) ?? Date.now();
    let checkInfo = domainInfo.checks.get(checkId);
    if (!checkInfo) {
      checkInfo = {
        checkId,
        viewCount: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
      };
      domainInfo.checks.set(checkId, checkInfo);
    }

    checkInfo.viewCount += 1;
    if (timestamp < checkInfo.firstSeen) {
      checkInfo.firstSeen = timestamp;
    }
    if (timestamp > checkInfo.lastSeen) {
      checkInfo.lastSeen = timestamp;
    }
  }

  const truncated = badgeViewsSnapshot.size === BADGE_DOMAIN_VIEW_LIMIT;
  if (truncated) {
    logger.warn(`getBadgeDomains processed ${BADGE_DOMAIN_VIEW_LIMIT} badge_views documents; results may be truncated.`);
  }
  if (skippedDomains > 0) {
    logger.warn(`Skipped ${skippedDomains} domains due to BADGE_DOMAIN_MAX_DOMAINS=${BADGE_DOMAIN_MAX_DOMAINS}`);
  }

  const checkMetadata = await fetchCheckMetadata(uniqueCheckIds);
  for (const domainInfo of domainMap.values()) {
    for (const checkInfo of domainInfo.checks.values()) {
      const meta = checkMetadata.get(checkInfo.checkId);
      if (meta) {
        checkInfo.checkName = meta.name;
        checkInfo.checkUrl = meta.url;
      }
    }
  }

  const domains = Array.from(domainMap.values())
    .map(domainInfo => ({
      domain: domainInfo.domain,
      checks: Array.from(domainInfo.checks.values()),
      totalViews: domainInfo.totalViews,
    }))
    .sort((a, b) => b.totalViews - a.totalViews);

  return {
    totalDomains: domains.length,
    domains,
    truncated,
    skippedDomains,
    viewLimit: BADGE_DOMAIN_VIEW_LIMIT,
    domainLimit: BADGE_DOMAIN_MAX_DOMAINS,
  };
};

const getCachedBadgeDomains = async (): Promise<CachedBadgeDomainsDoc | null> => {
  try {
    const doc = await firestore
      .collection(ADMIN_STATS_CACHE_COLLECTION)
      .doc(BADGE_DOMAIN_CACHE_DOC_ID)
      .get();

    if (!doc.exists) {
      return null;
    }

    const data = doc.data() as Partial<CachedBadgeDomainsDoc> | undefined;
    if (!data || !data.payload || typeof data.updatedAt !== 'number') {
      return null;
    }

    const ttl = typeof data.ttlMs === 'number' && data.ttlMs > 0 ? data.ttlMs : BADGE_DOMAIN_CACHE_TTL_MS;
    const expired = Date.now() - data.updatedAt > ttl;

    return {
      payload: data.payload,
      updatedAt: data.updatedAt,
      ttlMs: ttl,
      expired,
    };
  } catch (error) {
    logger.warn('Failed to read badge domains cache', error);
    return null;
  }
};

const saveCachedBadgeDomains = async (payload: BadgeDomainSummary): Promise<CachedBadgeDomainsDoc | null> => {
  try {
    const docRef = firestore.collection(ADMIN_STATS_CACHE_COLLECTION).doc(BADGE_DOMAIN_CACHE_DOC_ID);
    const updatedAt = Date.now();
    const cacheRecord = {
      payload,
      updatedAt,
      ttlMs: BADGE_DOMAIN_CACHE_TTL_MS,
    };
    await docRef.set(cacheRecord);
    return {
      ...cacheRecord,
      expired: false,
    };
  } catch (error) {
    logger.warn('Failed to write badge domains cache', error);
    return null;
  }
};

const getCachedAdminStats = async (): Promise<CachedAdminStatsDoc | null> => {
  try {
    const doc = await firestore
      .collection(ADMIN_STATS_CACHE_COLLECTION)
      .doc(ADMIN_STATS_CACHE_DOC_ID)
      .get();

    if (!doc.exists) {
      return null;
    }

    const data = doc.data() as Partial<CachedAdminStatsDoc> | undefined;
    if (!data || !data.payload || typeof data.updatedAt !== 'number') {
      return null;
    }

    const ttl = typeof data.ttlMs === 'number' && data.ttlMs > 0 ? data.ttlMs : ADMIN_STATS_CACHE_TTL_MS;
    const expired = Date.now() - data.updatedAt > ttl;

    return {
      payload: data.payload,
      updatedAt: data.updatedAt,
      ttlMs: ttl,
      expired,
    };
  } catch (error) {
    logger.warn('Failed to read admin stats cache', error);
    return null;
  }
};

const saveCachedAdminStats = async (payload: AdminStatsPayload): Promise<CachedAdminStatsDoc | null> => {
  try {
    const docRef = firestore.collection(ADMIN_STATS_CACHE_COLLECTION).doc(ADMIN_STATS_CACHE_DOC_ID);
    const updatedAt = Date.now();
    const cacheRecord = {
      payload,
      updatedAt,
      ttlMs: ADMIN_STATS_CACHE_TTL_MS,
    };
    await docRef.set(cacheRecord);
    return {
      ...cacheRecord,
      expired: false,
    };
  } catch (error) {
    logger.warn('Failed to write admin stats cache', error);
    return null;
  }
};

// Get admin statistics (admin only)
export const getAdminStats = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  logger.info('getAdminStats called by user:', uid);

  try {
    const forceRefresh = typeof request.data === 'object' && request.data !== null
      ? (request.data as { refresh?: unknown }).refresh === true
      : false;

    const cachedStats = await getCachedAdminStats();
    if (!forceRefresh && cachedStats) {
      const stale = cachedStats.expired === true;
      if (stale) {
        logger.info('Serving stale admin stats cache; call with { refresh: true } to recompute.');
      } else {
        logger.info(`Returning cached admin stats computed at ${new Date(cachedStats.updatedAt).toISOString()}`);
      }
      return {
        success: true,
        data: cachedStats.payload,
        cache: {
          hit: true,
          updatedAt: cachedStats.updatedAt,
          ttlMs: cachedStats.ttlMs,
          expiresAt: cachedStats.updatedAt + cachedStats.ttlMs,
          stale,
        },
      };
    }

    if (!cachedStats) {
      logger.warn('Admin stats cache missing; generating snapshot.');
    } else if (forceRefresh) {
      logger.info('Force refresh requested; recomputing admin stats.');
    } else if (cachedStats.expired) {
      logger.info('Admin stats cache expired; recomputing snapshot.');
    }

    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // Get total users count from Clerk (prod instance)
    // IMPORTANT: Always use prod instance for admin stats
    // Use CLERK_SECRET_KEY_PROD explicitly to avoid confusion with CLERK_SECRET_KEY
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    if (!prodSecretKey) {
      throw new Error('Clerk prod secret key (CLERK_SECRET_KEY_PROD) not found. Please ensure it is set via firebase functions:secrets:set CLERK_SECRET_KEY_PROD');
    }
    
    const prodClient = createClerkClient({ secretKey: prodSecretKey });
    logger.info('Using Clerk prod client for admin stats (explicitly initialized from CLERK_SECRET_KEY_PROD)');

    // Get total count from Clerk
    const clerkUsers = await prodClient.users.getUserList({
      limit: 1, // Just need the total count
    });
    const totalUsers = clerkUsers.totalCount || 0;
    logger.info(`Total users from prod Clerk: ${totalUsers}`);

    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

    const [totalChecksFromAggregate, checkStats] = await Promise.all([
      getSafeCount(firestore.collection('checks')),
      collectCheckStats(sevenDaysAgo),
    ]);

    const totalChecks = totalChecksFromAggregate || checkStats.processedDocs;
    const { checksByStatus, activeUsers, recentChecks } = checkStats;
    if (checkStats.truncated) {
      logger.warn('Check stat aggregation truncated; metrics may be slightly lower than actual totals.');
    }

    const averageChecksPerUser = totalUsers > 0 ? (totalChecks / totalUsers) : 0;

    // Get total webhooks count
    const webhooksSnapshot = await firestore.collection('webhooks').count().get();
    const totalWebhooks = webhooksSnapshot.data().count || 0;

    // Get enabled webhooks count
    const enabledWebhooksSnapshot = await firestore.collection('webhooks')
      .where('enabled', '==', true)
      .count()
      .get();
    const enabledWebhooks = enabledWebhooksSnapshot.data().count || 0;

    // Get recent users (created in last 7 days) - approximate from Clerk
    // Use the same explicit prod client
    let recentUsers = 0;
    try {
      const recentClerkUsers = await prodClient.users.getUserList({
        limit: 500, // Get recent users (Clerk doesn't support date filtering directly)
      });
      recentUsers = recentClerkUsers.data.filter(user => {
        const createdAt = user.createdAt || 0;
        return createdAt >= sevenDaysAgo;
      }).length;
      logger.info(`Found ${recentUsers} recent users from prod Clerk`);
    } catch (error) {
      logger.error('Error getting recent users from Clerk:', error);
      recentUsers = 0;
    }

    // Get total check executions count from BigQuery
    let totalCheckExecutions = 0;
    let recentCheckExecutions = 0;
    try {
      // Use parameterized query for total count
      const query = `
        SELECT COUNT(*) as total
        FROM \`exit1-dev.checks.check_history\`
      `;
      const [rows] = await bigquery.query({ query });
      if (rows && rows.length > 0) {
        const row = rows[0] as { total: number | string };
        totalCheckExecutions = Number(row.total) || 0;
      }
      
      // Get recent check executions (last 7 days) using parameterized query with Date object
      const recentQuery = `
        SELECT COUNT(*) as total
        FROM \`exit1-dev.checks.check_history\`
        WHERE timestamp >= @startDate
      `;
      const [recentRows] = await bigquery.query({
        query: recentQuery,
        params: {
          startDate: new Date(sevenDaysAgo)
        }
      });
      if (recentRows && recentRows.length > 0) {
        const row = recentRows[0] as { total: number | string };
        recentCheckExecutions = Number(row.total) || 0;
      }
    } catch (error) {
      logger.error('Error getting check executions from BigQuery:', error);
      // Log the full error for debugging
      if (error instanceof Error) {
        logger.error('BigQuery error details:', {
          message: error.message,
          stack: error.stack
        });
      }
      // Don't fail the whole request if BigQuery query fails
      totalCheckExecutions = 0;
      recentCheckExecutions = 0;
    }

    // Get badge usage stats
    let checksWithBadges = 0;
    let totalBadgeViews = 0;
    let recentBadgeViews = 0;
    let uniqueDomainsWithBadges = 0;
    try {
      // Count unique checks with badges (from badge_stats collection)
      const badgeStatsSnapshot = await firestore.collection('badge_stats').get();
      checksWithBadges = badgeStatsSnapshot.size;
      
      // Sum total views from all badge stats
      badgeStatsSnapshot.forEach(doc => {
        const data = doc.data();
        const views = data.totalViews || 0;
        totalBadgeViews += typeof views === 'number' ? views : 0;
      });

      // Get unique domains from badge_views collection (where badges are actually displayed)
      // This counts domains where badges are installed, not domains being checked
      const uniqueDomains = new Set<string>();
      const badgeViewsSnapshot = await firestore.collection('badge_views')
        .where('domain', '!=', null)
        .get();
      
      badgeViewsSnapshot.forEach(doc => {
        const domain = doc.data().domain;
        if (domain && typeof domain === 'string') {
          uniqueDomains.add(domain);
        }
      });

      uniqueDomainsWithBadges = uniqueDomains.size;

      // Count recent badge views (last 7 days)
      const recentBadgeViewsSnapshot = await firestore.collection('badge_views')
        .where('timestamp', '>=', sevenDaysAgo)
        .count()
        .get();
      recentBadgeViews = recentBadgeViewsSnapshot.data().count || 0;
    } catch (error) {
      logger.warn('Error getting badge stats:', error);
      // Don't fail the whole request if badge stats fail
      checksWithBadges = 0;
      totalBadgeViews = 0;
      recentBadgeViews = 0;
      uniqueDomainsWithBadges = 0;
    }

    const responseData: AdminStatsPayload = {
      totalUsers,
      activeUsers,
      totalChecks,
      totalCheckExecutions,
      totalWebhooks,
      enabledWebhooks,
      checksByStatus,
      averageChecksPerUser: Math.round(averageChecksPerUser * 10) / 10,
      recentActivity: {
        newUsers: recentUsers,
        newChecks: recentChecks,
        checkExecutions: recentCheckExecutions,
      },
      badgeUsage: {
        checksWithBadges,
        uniqueDomainsWithBadges,
        totalBadgeViews,
        recentBadgeViews,
      },
    };

    logger.info(`Admin stats refreshed at ${new Date().toISOString()} (${totalUsers} users, ${totalChecks} checks)`);

    const savedCache = await saveCachedAdminStats(responseData);
    const cacheMeta = savedCache ?? {
      updatedAt: Date.now(),
      ttlMs: ADMIN_STATS_CACHE_TTL_MS,
      expired: false,
    };

    return {
      success: true,
      data: responseData,
      cache: {
        hit: false,
        updatedAt: cacheMeta.updatedAt,
        ttlMs: cacheMeta.ttlMs,
        expiresAt: cacheMeta.updatedAt + cacheMeta.ttlMs,
        stale: cacheMeta.expired === true,
      },
    };
  } catch (error) {
    logger.error('Error getting admin stats:', error);
    throw new Error(`Failed to get admin stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Get list of all domains with badges installed (admin only)
export const getBadgeDomains = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  logger.info('getBadgeDomains called by user:', uid);

  try {
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    const forceRefresh = typeof request.data === 'object' && request.data !== null
      ? (request.data as { refresh?: unknown }).refresh === true
      : false;

    const cachedSummary = await getCachedBadgeDomains();
    if (!forceRefresh && cachedSummary) {
      const stale = cachedSummary.expired === true;
      if (stale) {
        logger.info('Serving stale badge domain cache; call with { refresh: true } to recompute.');
      }
      return {
        success: true,
        data: cachedSummary.payload,
        cache: {
          hit: true,
          updatedAt: cachedSummary.updatedAt,
          ttlMs: cachedSummary.ttlMs,
          expiresAt: cachedSummary.updatedAt + cachedSummary.ttlMs,
          stale,
        },
      };
    }

    if (!cachedSummary) {
      logger.warn('Badge domains cache missing; generating summary.');
    } else if (forceRefresh) {
      logger.info('Force refresh requested; recomputing badge domains.');
    } else if (cachedSummary.expired) {
      logger.info('Badge domains cache expired; recomputing summary.');
    }

    const summary = await buildBadgeDomainSummary();
    const savedCache = await saveCachedBadgeDomains(summary);
    const cacheMeta = savedCache ?? {
      updatedAt: Date.now(),
      ttlMs: BADGE_DOMAIN_CACHE_TTL_MS,
      expired: false,
    };

    return {
      success: true,
      data: summary,
      cache: {
        hit: false,
        updatedAt: cacheMeta.updatedAt,
        ttlMs: cacheMeta.ttlMs,
        expiresAt: cacheMeta.updatedAt + cacheMeta.ttlMs,
        stale: cacheMeta.expired === true,
      },
    };
  } catch (error) {
    logger.error('Error getting badge domains:', error);
    throw new Error(`Failed to get badge domains: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Get BigQuery usage stats (admin only)
export const getBigQueryUsage = onCall({
  cors: true,
  maxInstances: 1,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    const { getDatabaseUsage, getQueryUsage } = await import('./bigquery.js');
    
    // Fetch stats safely
    let storageUsage = { totalRows: 0, totalBytes: 0, activeBytes: 0, longTermBytes: 0 };
    try {
      storageUsage = await getDatabaseUsage();
    } catch (e) {
      logger.error('Failed to get database usage:', e);
    }

    let queryUsage = { totalBytesBilled: 0, totalBytesProcessed: 0 };
    try {
      queryUsage = await getQueryUsage();
    } catch (e) {
      logger.error('Failed to get query usage:', e);
    }
    
    // Limits
    const storageLimitBytes = 10 * 1024 * 1024 * 1024; // 10 GB
    const queryLimitBytes = 1 * 1024 * 1024 * 1024 * 1024; // 1 TB
    const firestoreStorageLimitBytes = 1 * 1024 * 1024 * 1024; // 1 GiB (approx)

    return {
      success: true,
      data: {
        storage: {
          ...storageUsage,
          limitBytes: storageLimitBytes,
          usagePercentage: (storageUsage.activeBytes / storageLimitBytes) * 100
        },
        query: {
          ...queryUsage,
          limitBytes: queryLimitBytes,
          usagePercentage: (queryUsage.totalBytesBilled / queryLimitBytes) * 100
        },
        firestore: {
          limitBytes: firestoreStorageLimitBytes,
          note: "Detailed Firestore size not available via API"
        }
      }
    };
  } catch (error) {
    logger.error('Critical error in getBigQueryUsage:', error);
    throw new Error('Failed to retrieve database usage');
  }
});
