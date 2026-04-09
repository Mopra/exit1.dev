import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { CLERK_SECRET_KEY_PROD } from "./env";
import { createClerkClient } from '@clerk/backend';
import { BigQuery } from '@google-cloud/bigquery';
import type { BigQueryCheckHistoryRow } from "./bigquery";
import { Query } from "firebase-admin/firestore";

const bigquery = new BigQuery({
  projectId: 'exit1-dev',
  keyFilename: undefined, // Use default credentials
});

const ADMIN_STATS_CACHE_COLLECTION = 'admin_metadata';
const ADMIN_STATS_CACHE_DOC_ID = 'stats_cache';

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
  nanoSubscriptions: {
    subscribers: number;
    mrrCents: number;
    arrCents: number;
    currency: string;
  };
}

interface CachedAdminStatsDoc {
  payload: AdminStatsPayload;
  updatedAt: number;
}

const planText = (plan: { slug?: unknown; name?: unknown } | null | undefined) =>
  `${typeof plan?.slug === "string" ? plan.slug : ""} ${typeof plan?.name === "string" ? plan.name : ""}`
    .trim()
    .toLowerCase();

const isActiveLikeStatus = (status: unknown): boolean => {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  return s === "active" || s === "upcoming" || s === "past_due";
};

const collectNanoSubscriptionStats = async (client: ReturnType<typeof createClerkClient>) => {
  const pageSize = 200;
  const concurrency = 10;
  let offset = 0;
  let subscribers = 0;
  let mrrCents = 0;
  let arrCents = 0;
  let currency: string | null = null;

  // Helper: safely extract a number from a BillingMoneyAmount-like object
  const cents = (v: unknown): number | null => {
    if (v && typeof v === "object" && "amount" in v && typeof (v as { amount: unknown }).amount === "number") {
      return (v as { amount: number }).amount;
    }
    return null;
  };

  const currencyOf = (v: unknown): string | null => {
    if (v && typeof v === "object" && "currency" in v && typeof (v as { currency: unknown }).currency === "string") {
      return (v as { currency: string }).currency;
    }
    return null;
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userPage = await client.users.getUserList({ limit: pageSize, offset });
    const users = userPage.data ?? [];
    if (users.length === 0) {
      break;
    }

    for (let i = 0; i < users.length; i += concurrency) {
      const chunk = users.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map(async (user) => {
          try {
            const subscription = await client.billing.getUserBillingSubscription(user.id);
            return { userId: user.id, email: user.emailAddresses?.[0]?.emailAddress ?? user.id, subscription };
          } catch (error) {
            logger.warn(`Failed to fetch Clerk subscription for ${user.id}`, error);
            return null;
          }
        }),
      );

      for (const result of results) {
        if (!result?.subscription) {
          continue;
        }
        const items = Array.isArray(result.subscription.subscriptionItems)
          ? result.subscription.subscriptionItems
          : [];
        const activeLike = items.filter((item) => isActiveLikeStatus(item?.status));
        const nanoItems = activeLike.filter((item) => {
          const text = planText(item?.plan);
          return text.includes("nano") || text.includes("starter") || text.includes("scale");
        });

        if (nanoItems.length === 0) {
          continue;
        }

        subscribers += 1;

        for (const item of nanoItems) {
          const plan = (item as { plan?: unknown }).plan as {
            fee?: unknown;
            annualFee?: unknown;
            annualMonthlyFee?: unknown;
          } | null | undefined;
          const period: "month" | "annual" = (item as { planPeriod?: unknown }).planPeriod === "annual" ? "annual" : "month";

          // Use plan-level fees (clear semantics) as primary source.
          // plan.fee = "The monthly fee" (always the monthly price)
          // plan.annualFee = "The annual fee" (always the full annual price)
          // plan.annualMonthlyFee = "The annual fee on a monthly basis" (annual / 12)
          // item.amount = "The current amount" (ambiguous per-period or effective rate)
          const planMonthlyFee = cents(plan?.fee);
          const planAnnualFee = cents(plan?.annualFee);
          const planAnnualMonthlyFee = cents(plan?.annualMonthlyFee);
          const itemAmount = cents((item as { amount?: unknown }).amount);
          const itemCurrency = currencyOf((item as { amount?: unknown }).amount)
            ?? currencyOf(plan?.fee)
            ?? currencyOf(plan?.annualFee);

          let userMrr = 0;
          let userArr = 0;

          if (period === "annual") {
            // For annual billing, use plan.annualFee as the definitive annual price.
            // Fall back to item.amount only if annualFee is missing.
            userArr = planAnnualFee ?? itemAmount ?? 0;
            userMrr = planAnnualMonthlyFee ?? (userArr > 0 ? Math.round(userArr / 12) : 0);
          } else {
            // For monthly billing, use plan.fee as the definitive monthly price.
            // Fall back to item.amount only if fee is missing.
            userMrr = planMonthlyFee ?? itemAmount ?? 0;
            userArr = userMrr * 12;
          }

          if (itemCurrency) {
            if (!currency) {
              currency = itemCurrency;
            } else if (currency !== itemCurrency) {
              logger.warn(`Mixed currencies: ${currency} vs ${itemCurrency}`);
            }
          }

          mrrCents += userMrr;
          arrCents += userArr;

          logger.info(`Nano subscriber: ${result.email}`, {
            period,
            planMonthlyFee,
            planAnnualFee,
            planAnnualMonthlyFee,
            itemAmount,
            computedMrr: userMrr,
            computedArr: userArr,
          });
        }
      }
    }

    offset += users.length;
    if (users.length < pageSize) {
      break;
    }
  }

  logger.info(`Nano subscription totals: ${subscribers} subscribers, MRR=${mrrCents}c, ARR=${arrCents}c, currency=${currency ?? "USD"}`);

  return {
    subscribers,
    mrrCents,
    arrCents,
    currency: currency ?? "USD",
  };
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
  const checksCollection = firestore.collection('checks');

  // Use aggregation queries for status counts (1 read per 1,000 docs instead of 1 read per doc)
  // Run all count queries in parallel for better performance
  const [
    totalCount,
    disabledCount,
    onlineCount,
    offlineCount,
    recentCount,
    activeUsersCount,
  ] = await Promise.all([
    // Total checks
    getSafeCount(checksCollection),
    // Disabled checks
    getSafeCount(checksCollection.where('disabled', '==', true)),
    // Online checks (status = 'up' or 'online', not disabled)
    getSafeCount(checksCollection.where('disabled', '!=', true).where('status', 'in', ['up', 'online'])),
    // Offline checks (status = 'down' or 'offline', not disabled)
    getSafeCount(checksCollection.where('disabled', '!=', true).where('status', 'in', ['down', 'offline'])),
    // Recent checks (created in last 7 days)
    getSafeCount(checksCollection.where('createdAt', '>=', sevenDaysAgo)),
    // Active users - count unique userIds using a separate aggregation approach
    // Note: Firestore doesn't support COUNT(DISTINCT), so we query user_check_stats collection
    // which has one doc per user with checks
    getSafeCount(firestore.collection('user_check_stats')),
  ]);

  // Calculate unknown count (total - disabled - online - offline)
  const unknownCount = Math.max(0, totalCount - disabledCount - onlineCount - offlineCount);

  return {
    activeUsers: activeUsersCount,
    checksByStatus: {
      online: onlineCount,
      offline: offlineCount,
      unknown: unknownCount,
      disabled: disabledCount,
    },
    recentChecks: recentCount,
    processedDocs: totalCount, // Now represents counted docs, not iterated
    truncated: false, // No longer truncating since we use aggregation
  };
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

    return {
      payload: data.payload,
      updatedAt: data.updatedAt,
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
    const cacheRecord = { payload, updatedAt };
    await docRef.set(cacheRecord);
    return cacheRecord;
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
      logger.info(`Returning cached admin stats from ${new Date(cachedStats.updatedAt).toISOString()}`);
      return {
        success: true,
        data: cachedStats.payload,
        cache: { hit: true, updatedAt: cachedStats.updatedAt },
      };
    }

    logger.info(forceRefresh ? 'Force refresh requested; recomputing admin stats.' : 'No cached stats; computing fresh snapshot.');

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
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

    const [totalChecksFromAggregate, checkStats] = await Promise.all([
      getSafeCount(firestore.collection('checks')),
      collectCheckStats(sevenDaysAgo),
    ]);

    const totalChecks = totalChecksFromAggregate || checkStats.processedDocs;
    const { checksByStatus, activeUsers } = checkStats;
    if (checkStats.truncated) {
      logger.warn('Check stat aggregation truncated; metrics may be slightly lower than actual totals.');
    }

    const averageChecksPerUser = totalUsers > 0 ? (totalChecks / totalUsers) : 0;

    // Get total webhooks count + enabled webhooks + recent checks (24h)
    const [webhooksSnapshot, enabledWebhooksSnapshot, recentChecks24h] = await Promise.all([
      firestore.collection('webhooks').count().get(),
      firestore.collection('webhooks').where('enabled', '==', true).count().get(),
      getSafeCount(firestore.collection('checks').where('createdAt', '>=', oneDayAgo)),
    ]);
    const totalWebhooks = webhooksSnapshot.data().count || 0;
    const enabledWebhooks = enabledWebhooksSnapshot.data().count || 0;

    // Get recent users (created in last 24 hours) from Clerk
    let recentUsers = 0;
    try {
      const recentClerkUsers = await prodClient.users.getUserList({
        limit: 500,
      });
      recentUsers = recentClerkUsers.data.filter(user => {
        const createdAt = user.createdAt || 0;
        return createdAt >= oneDayAgo;
      }).length;
      logger.info(`Found ${recentUsers} users created in last 24h`);
    } catch (error) {
      logger.error('Error getting recent users from Clerk:', error);
      recentUsers = 0;
    }

    // Get total check executions count from BigQuery
    // Use __TABLES__ metadata for total row count (much cheaper than COUNT(*))
    // and partition-pruned query for recent counts (24h)
    let totalCheckExecutions = 0;
    let recentCheckExecutions = 0;
    try {
      // Use table metadata for total count - avoids full table scan
      const metadataQuery = `
        SELECT row_count as total
        FROM \`exit1-dev.checks.__TABLES__\`
        WHERE table_id = 'check_history_new'
      `;
      const [rows] = await bigquery.query({ query: metadataQuery });
      if (rows && rows.length > 0) {
        const row = rows[0] as { total: number | string };
        totalCheckExecutions = Number(row.total) || 0;
      }

      // Get recent check executions (last 24 hours) - partition-pruned query
      const recentQuery = `
        SELECT COUNT(*) as total
        FROM \`exit1-dev.checks.check_history_new\`
        WHERE timestamp >= @startDate
      `;
      const [recentRows] = await bigquery.query({
        query: recentQuery,
        params: {
          startDate: new Date(oneDayAgo)
        }
      });
      if (recentRows && recentRows.length > 0) {
        const row = recentRows[0] as { total: number | string };
        recentCheckExecutions = Number(row.total) || 0;
      }
    } catch (error) {
      logger.error('Error getting check executions from BigQuery:', error);
      if (error instanceof Error) {
        logger.error('BigQuery error details:', {
          message: error.message,
          stack: error.stack
        });
      }
      totalCheckExecutions = 0;
      recentCheckExecutions = 0;
    }

    // Clerk nano plan subscribers + revenue metrics
    let nanoSubscriptions = {
      subscribers: 0,
      mrrCents: 0,
      arrCents: 0,
      currency: "USD",
    };
    try {
      nanoSubscriptions = await collectNanoSubscriptionStats(prodClient);
      logger.info('Nano subscription stats computed', nanoSubscriptions);
    } catch (error) {
      logger.warn('Failed to compute nano subscription stats:', error);
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
        newChecks: recentChecks24h,
        checkExecutions: recentCheckExecutions,
      },
      nanoSubscriptions,
    };

    logger.info(`Admin stats refreshed at ${new Date().toISOString()} (${totalUsers} users, ${totalChecks} checks)`);

    const savedCache = await saveCachedAdminStats(responseData);

    return {
      success: true,
      data: responseData,
      cache: { hit: false, updatedAt: savedCache?.updatedAt ?? Date.now() },
    };
  } catch (error) {
    logger.error('Error getting admin stats:', error);
    throw new Error(`Failed to get admin stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

// Get badge analytics from BigQuery (admin only)
export const getBadgeAnalytics = onCall({
  cors: true,
  maxInstances: 2,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const emptyResponse = (days: number) => ({
    success: true,
    data: { totalViews: 0, days, daily: [], byCheck: [], byOrigin: [], byType: [] },
  });

  try {
    const days = typeof request.data?.days === 'number' ? Math.min(request.data.days, 90) : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Check if the table exists before querying
    const [tableExists] = await bigquery.dataset('checks').table('badge_views').exists();
    if (!tableExists) {
      return emptyResponse(days);
    }

    // Run all queries in parallel
    const [totalRows, dailyRows, checkRows, referrerRows, typeRows] = await Promise.all([
      // Total views
      bigquery.query({
        query: `SELECT COUNT(*) as total FROM \`exit1-dev.checks.badge_views\` WHERE timestamp >= @since`,
        params: { since },
      }),
      // Views per day
      bigquery.query({
        query: `
          SELECT DATE(timestamp) as day, COUNT(*) as views, COUNT(DISTINCT client_ip) as unique_ips
          FROM \`exit1-dev.checks.badge_views\`
          WHERE timestamp >= @since
          GROUP BY day ORDER BY day DESC
        `,
        params: { since },
      }),
      // Views per check (top 50)
      bigquery.query({
        query: `
          SELECT check_id, user_id, COUNT(*) as views, COUNT(DISTINCT client_ip) as unique_ips
          FROM \`exit1-dev.checks.badge_views\`
          WHERE timestamp >= @since
          GROUP BY check_id, user_id ORDER BY views DESC LIMIT 50
        `,
        params: { since },
      }),
      // Top origins (extract hostname from referrer)
      bigquery.query({
        query: `
          SELECT NET.HOST(referrer) as origin, COUNT(*) as views
          FROM \`exit1-dev.checks.badge_views\`
          WHERE timestamp >= @since AND referrer IS NOT NULL
          GROUP BY origin ORDER BY views DESC LIMIT 30
        `,
        params: { since },
      }),
      // By badge type
      bigquery.query({
        query: `
          SELECT badge_type, embed, COUNT(*) as views
          FROM \`exit1-dev.checks.badge_views\`
          WHERE timestamp >= @since
          GROUP BY badge_type, embed ORDER BY views DESC
        `,
        params: { since },
      }),
    ]);

    // Enrich check rows with names from Firestore
    const checkRowsData = (checkRows[0] ?? []) as Record<string, unknown>[];
    const checkIds = [...new Set(checkRowsData.map((r) => String(r.check_id)))];
    const checkNames: Record<string, string> = {};
    if (checkIds.length > 0) {
      // Firestore getAll supports up to 500 docs at once
      const refs = checkIds.map((id) => firestore.collection('checks').doc(id));
      try {
        const docs = await firestore.getAll(...refs);
        for (const doc of docs) {
          if (doc.exists) {
            const d = doc.data();
            checkNames[doc.id] = d?.name || d?.url || doc.id;
          }
        }
      } catch (e) {
        logger.warn('Failed to fetch check names for badge analytics', e);
      }
    }

    return {
      success: true,
      data: {
        totalViews: Number(totalRows[0]?.[0]?.total ?? 0),
        days,
        daily: (dailyRows[0] ?? []).map((r: Record<string, unknown>) => ({
          day: (r.day as { value?: string })?.value ?? String(r.day),
          views: Number(r.views),
          uniqueIps: Number(r.unique_ips),
        })),
        byCheck: checkRowsData.map((r) => ({
          checkId: r.check_id,
          checkName: checkNames[String(r.check_id)] || String(r.check_id),
          userId: r.user_id,
          views: Number(r.views),
          uniqueIps: Number(r.unique_ips),
        })),
        byOrigin: (referrerRows[0] ?? []).map((r: Record<string, unknown>) => ({
          origin: r.origin,
          views: Number(r.views),
        })),
        byType: (typeRows[0] ?? []).map((r: Record<string, unknown>) => ({
          badgeType: r.badge_type,
          embed: r.embed,
          views: Number(r.views),
        })),
      },
    };
  } catch (error) {
    logger.error('Error getting badge analytics:', error);
    throw new HttpsError("internal", `Failed to get badge analytics: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Admin function to investigate why a check was auto-disabled
export const investigateCheck = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { checkId } = request.data || {};
  if (!checkId) {
    throw new HttpsError("invalid-argument", "Check ID required");
  }

  // Get check document
  const checkDoc = await firestore.collection("checks").doc(checkId).get();
  if (!checkDoc.exists) {
    throw new HttpsError("not-found", "Check not found");
  }

  const check = checkDoc.data();
  if (!check) {
    throw new HttpsError("not-found", "Check data not found");
  }

  // Verify user owns this check (or is admin - you can add admin check here)
  if (check.userId !== uid) {
    throw new HttpsError("permission-denied", "Insufficient permissions");
  }

  // Calculate auto-disable conditions
  const DISABLE_AFTER_DAYS = 7;
  const now = Date.now();
  const consecutiveFailures = Number(check.consecutiveFailures || 0);
  const hasFailureStreak = consecutiveFailures > 0;
  const daysSinceFirstFailure = hasFailureStreak && check.lastFailureTime
    ? (now - check.lastFailureTime) / (24 * 60 * 60 * 1000)
    : 0;
  
  const wouldDisable = hasFailureStreak && daysSinceFirstFailure >= DISABLE_AFTER_DAYS;

  // Get recent check history from BigQuery
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let history: BigQueryCheckHistoryRow[] = [];
  let historyError: string | null = null;

  try {
    const { getCheckHistory } = await import('./bigquery.js');
    history = await getCheckHistory(
      checkId,
      check.userId,
      100, // limit
      0,   // offset
      sevenDaysAgo,
      Date.now()
    );
  } catch (error) {
    historyError = error instanceof Error ? error.message : String(error);
    logger.error('Error fetching check history:', error);
  }

  const failures = history.filter(r => r.status === 'DOWN' || r.status === 'offline');
  const successes = history.filter(r => r.status === 'UP' || r.status === 'online');
  const successRate = history.length > 0 ? (successes.length / history.length) * 100 : 0;

  return {
    check: {
      id: checkId,
      name: check.name,
      url: check.url,
      status: check.status || 'unknown',
      disabled: check.disabled || false,
      disabledAt: check.disabledAt || null,
      disabledReason: check.disabledReason || null,
      consecutiveFailures: check.consecutiveFailures || 0,
      lastFailureTime: check.lastFailureTime || null,
      lastChecked: check.lastChecked || null,
      createdAt: check.createdAt || null,
      updatedAt: check.updatedAt || null,
    },
    analysis: {
      daysSinceFirstFailure: daysSinceFirstFailure.toFixed(2),
      disableThreshold: {
        days: DISABLE_AFTER_DAYS,
      },
      currentState: {
        consecutiveFailures,
        daysSinceFirstFailure: daysSinceFirstFailure.toFixed(2),
      },
      wouldAutoDisable: wouldDisable,
    },
    history: {
      total: history.length,
      failures: failures.length,
      successes: successes.length,
      successRate: successRate.toFixed(1),
      recentChecks: history.slice(0, 10).map(row => ({
        timestamp: row.timestamp?.value || row.timestamp,
        status: row.status,
        statusCode: row.status_code,
        error: row.error,
      })),
      error: historyError,
    },
  };
});
