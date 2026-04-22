import * as logger from "firebase-functions/logger";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { createClerkClient } from '@clerk/backend';
import { CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from "./env";

// Initialize Firebase Admin
initializeApp({
  credential: applicationDefault(),
});

// Initialize Firestore
export const firestore = getFirestore();
// Avoid failing updates due to undefined fields in partial updates
firestore.settings({ ignoreUndefinedProperties: true });

// Initialize Clerk clients for dual-instance support (dev and prod)
// Environment variables:
// - CLERK_SECRET_KEY: Production instance secret key (backward compatibility)
// - CLERK_SECRET_KEY_PROD: Production instance secret key (explicit)
// - CLERK_SECRET_KEY_DEV: Development instance secret key
// 
// To set these via Firebase CLI:
// firebase functions:config:set clerk.secret_key_prod="your_prod_key"
// firebase functions:config:set clerk.secret_key_dev="your_dev_key"
// Then redeploy functions

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
let clerkClientDev: ReturnType<typeof createClerkClient> | null = null;
let clerkClientProd: ReturnType<typeof createClerkClient> | null = null;

try {
  // Initialize production client
  // Firebase Functions v2 automatically makes secrets available as environment variables
  // Secrets set via 'firebase functions:secrets:set' are accessible via process.env
  const secretKey = process.env.CLERK_SECRET_KEY || process.env.CLERK_SECRET_KEY_PROD;

  if (secretKey) {
    clerkClientProd = createClerkClient({
      secretKey: secretKey,
    });
    clerkClient = clerkClientProd; // Default to prod for backward compatibility
    logger.info('Clerk production client initialized successfully');
  }

  // Initialize development client
  const devSecretKey = process.env.CLERK_SECRET_KEY_DEV;

  if (devSecretKey) {
    clerkClientDev = createClerkClient({
      secretKey: devSecretKey,
    });
    logger.info('Clerk development client initialized successfully');
  }

  if (!secretKey && !devSecretKey) {
    logger.warn('No Clerk secret keys found. User management features will be limited.');
    logger.warn('Available env vars:', Object.keys(process.env).filter(key => key.includes('CLERK')));
  }
} catch (error) {
  logger.error('Failed to initialize Clerk clients:', error);
}

// Helper function to get the appropriate Clerk client based on instance type
export function getClerkClient(instance: 'dev' | 'prod'): ReturnType<typeof createClerkClient> | null {
  if (instance === 'dev') {
    return clerkClientDev;
  } else {
    return clerkClientProd || clerkClient; // Fallback to default client
  }
}

export type UserTier = 'free' | 'nano' | 'pro' | 'agency';

// OPTIMIZATION: Extended from 1 hour to 2 hours to reduce Clerk API calls
// Trade-off: Tier changes take longer to reflect (acceptable since subscription changes are rare)
const USER_TIER_CACHE_MS = 2 * 60 * 60 * 1000; // 2 hours

function normalizeTier(value: unknown): UserTier | null {
  // Back-compat: migrate values stored by older deploys.
  if (value === 'premium') return 'nano';
  if (value === 'scale') return 'agency';
  if (value === 'free' || value === 'nano' || value === 'pro' || value === 'agency') return value;
  return null;
}

// Exact plan-key → tier mapping (Docs/plans/tier-restructure-plan-1-rollout.md §2.3).
// Keys match Clerk plan.slug verbatim. Unknown keys fall back to 'free'.
export const PLAN_KEY_TO_TIER: Record<string, UserTier> = {
  free_user: 'free',
  nano: 'pro',       // Founders — grandfathered onto Pro entitlements
  nanov2: 'nano',    // new Nano
  pro: 'pro',
  agency: 'agency',
  scale: 'agency',   // legacy, no subscribers — mapped to Agency
  starter: 'nano',   // legacy
};

export function tierFromPlanKey(planKey: string | null | undefined): UserTier {
  if (!planKey) return 'free';
  return PLAN_KEY_TO_TIER[planKey] ?? 'free';
}

function safeSecretValue(secret: { value: () => string }): string | null {
  try {
    const v = secret.value();
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

async function fetchTierFromClerk(uid: string): Promise<{ tier: UserTier; planKey: string | null }> {
  // Try prod first, then dev (mirrors other code paths in this repo).
  const prodSecretKey = safeSecretValue(CLERK_SECRET_KEY_PROD);
  const devSecretKey = safeSecretValue(CLERK_SECRET_KEY_DEV);

  // If no Clerk secrets are available, throw instead of returning 'free'.
  // This prevents caching a wrong tier when secrets aren't configured
  // (e.g. scheduler functions missing secrets in their config).
  if (!prodSecretKey && !devSecretKey) {
    throw new Error('No Clerk secret keys available — cannot determine tier');
  }

  const tryFetch = async (secretKey: string, instance: string): Promise<{ tier: UserTier; planKey: string | null }> => {
    const client = createClerkClient({ secretKey });

    // Check for admin/lifetime overrides in public metadata before billing lookup
    try {
      const user = await client.users.getUser(uid);
      if (user.publicMetadata?.admin === true) {
        logger.debug(`Admin detected for ${uid} via publicMetadata in ${instance} — granting agency tier`);
        return { tier: 'agency', planKey: null };
      }
      // Legacy lifetime-deal flag — grandfather onto Pro for parity with the
      // Founders `nano` plan-key path. Emit a debug log so we can track usage.
      if (user.publicMetadata?.lifetimeNano === true) {
        logger.debug(`Legacy lifetimeNano metadata detected for ${uid} in ${instance} — mapping to pro tier`);
        return { tier: 'pro', planKey: 'nano' };
      }
    } catch (e) {
      logger.warn(`Failed to fetch user metadata for ${uid} in ${instance}, continuing to billing check`, e);
    }

    const subscription: unknown = await client.billing.getUserBillingSubscription(uid);
    logger.debug(`Clerk ${instance} subscription lookup for ${uid}:`, {
      hasSubscription: !!subscription,
      subscriptionType: typeof subscription
    });
    if (!subscription || typeof subscription !== "object") {
      logger.debug(`No subscription found for ${uid} in ${instance}`);
      return { tier: "free", planKey: null };
    }

    const sub = subscription as {
      subscriptionItems?: Array<{
        status?: unknown;
        plan?: { slug?: unknown; name?: unknown } | null;
      }>;
    };

    const items = Array.isArray(sub.subscriptionItems) ? sub.subscriptionItems : [];
    const activeLike = items.filter((item) => {
      const s = typeof item?.status === "string" ? item.status.toLowerCase() : "";
      return s === "active" || s === "upcoming" || s === "past_due";
    });

    const planSlugOf = (plan: { slug?: unknown } | null | undefined): string | null => {
      const raw = typeof plan?.slug === 'string' ? plan.slug.trim() : '';
      return raw ? raw : null;
    };

    logger.debug(`Clerk ${instance} subscription items for ${uid}:`, {
      totalItems: items.length,
      activeLikeCount: activeLike.length,
      activeItems: activeLike.map(item => ({
        status: item.status,
        planSlug: planSlugOf(item.plan),
        planName: typeof item.plan?.name === "string" ? item.plan.name : undefined,
      }))
    });

    // Tier ranking so we pick the strongest active subscription when a user has multiple.
    const rank: Record<UserTier, number> = { free: 0, nano: 1, pro: 2, agency: 3 };
    let bestTier: UserTier = 'free';
    let bestPlanKey: string | null = null;
    for (const item of activeLike) {
      const slug = planSlugOf(item.plan);
      if (!slug) continue;
      const resolved = tierFromPlanKey(slug);
      if (rank[resolved] > rank[bestTier]) {
        bestTier = resolved;
        bestPlanKey = slug;
      } else if (rank[resolved] === rank[bestTier] && bestPlanKey === null) {
        bestPlanKey = slug;
      }
    }

    logger.debug(`Detected tier for ${uid} in ${instance}: ${bestTier}`, {
      planKey: bestPlanKey,
    });
    return { tier: bestTier, planKey: bestPlanKey };
  };

  if (prodSecretKey) {
    try {
      const result = await tryFetch(prodSecretKey, "prod");
      return result;
    } catch (e) {
      logger.warn(`Clerk prod billing lookup failed for ${uid}, trying dev...`, e);
    }
  }

  if (devSecretKey) {
    try {
      const result = await tryFetch(devSecretKey, "dev");
      return result;
    } catch (e) {
      logger.warn(`Clerk dev billing lookup failed for ${uid}`, e);
    }
  }

  return { tier: 'free', planKey: null };
}

// Helper function to get user tier (cached in Firestore, falls back safely to free)
export const getUserTier = async (uid: string): Promise<UserTier> => {
  const userRef = firestore.collection('users').doc(uid);

  try {
    const snap = await userRef.get();
    if (snap.exists) {
      const data = snap.data() || {};
      const cachedTier = normalizeTier((data as { tier?: unknown }).tier);
      const cachedAt = Number((data as { tierUpdatedAt?: unknown }).tierUpdatedAt || 0);

      if (cachedTier && cachedAt > Date.now() - USER_TIER_CACHE_MS) {
        return cachedTier;
      }

      // If we have any cached tier at all, keep it as a safe fallback if Clerk is unavailable.
      if (cachedTier) {
        try {
          const fresh = await fetchTierFromClerk(uid);
          await userRef.set(
            { tier: fresh.tier, subscribedPlanKey: fresh.planKey, tierUpdatedAt: Date.now() },
            { merge: true },
          );
          return fresh.tier;
        } catch (e) {
          logger.warn(`Tier refresh failed for ${uid}, using cached tier: ${cachedTier}`, e);
          return cachedTier;
        }
      }
    }

    const fresh = await fetchTierFromClerk(uid);
    await userRef.set(
      { tier: fresh.tier, subscribedPlanKey: fresh.planKey, tierUpdatedAt: Date.now() },
      { merge: true },
    );
    return fresh.tier;
  } catch (error) {
    logger.warn(`Error getting user tier for ${uid}, defaulting to free:`, error);
    return 'free';
  }
};

// Force a live lookup against Clerk and refresh cache.
// Used for user-initiated tier-gated actions to match billing page behavior.
export const getUserTierLive = async (uid: string): Promise<UserTier> => {
  const userRef = firestore.collection('users').doc(uid);

  try {
    const fresh = await fetchTierFromClerk(uid);
    await userRef.set(
      { tier: fresh.tier, subscribedPlanKey: fresh.planKey, tierUpdatedAt: Date.now() },
      { merge: true },
    );
    return fresh.tier;
  } catch (error) {
    logger.warn(`Live tier lookup failed for ${uid}, falling back to cached tier`, error);
    try {
      const snap = await userRef.get();
      if (snap.exists) {
        const data = snap.data() || {};
        const cachedTier = normalizeTier((data as { tier?: unknown }).tier);
        if (cachedTier) {
          return cachedTier;
        }
      }
    } catch (readError) {
      logger.warn(`Failed to read cached tier for ${uid}`, readError);
    }
    return 'free';
  }
};

/**
 * Get the full plan-info record for a user: resolved tier, the raw Clerk plan
 * key, and a derived `isFounders` flag (true iff subscribed to the legacy
 * `nano` plan which maps to Pro entitlements). Uses the cached Firestore row
 * first; falls back to a live Clerk lookup when the cache is stale or empty.
 */
export const getUserPlanInfo = async (
  uid: string,
): Promise<{ tier: UserTier; subscribedPlanKey: string | null; isFounders: boolean }> => {
  const userRef = firestore.collection('users').doc(uid);
  let tier: UserTier = 'free';
  let subscribedPlanKey: string | null = null;

  try {
    const snap = await userRef.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const cachedTier = normalizeTier((data as { tier?: unknown }).tier);
    const cachedPlanKey = typeof (data as { subscribedPlanKey?: unknown }).subscribedPlanKey === 'string'
      ? ((data as { subscribedPlanKey: string }).subscribedPlanKey || null)
      : null;
    const cachedAt = Number((data as { tierUpdatedAt?: unknown }).tierUpdatedAt || 0);

    const isFresh = cachedTier && cachedAt > Date.now() - USER_TIER_CACHE_MS;
    if (isFresh && cachedTier) {
      tier = cachedTier;
      subscribedPlanKey = cachedPlanKey;
    } else {
      try {
        const fresh = await fetchTierFromClerk(uid);
        tier = fresh.tier;
        subscribedPlanKey = fresh.planKey;
        await userRef.set(
          { tier, subscribedPlanKey, tierUpdatedAt: Date.now() },
          { merge: true },
        );
      } catch (e) {
        logger.warn(`getUserPlanInfo: Clerk lookup failed for ${uid}, using cache`, e);
        if (cachedTier) {
          tier = cachedTier;
          subscribedPlanKey = cachedPlanKey;
        }
      }
    }
  } catch (error) {
    logger.warn(`getUserPlanInfo: Firestore read failed for ${uid}`, error);
  }

  return {
    tier,
    subscribedPlanKey,
    isFounders: subscribedPlanKey === 'nano',
  };
};

/**
 * Callable function that lets the frontend force-sync a user's tier from Clerk to Firestore.
 * This closes the gap where Firestore caches 'free' but Clerk has already processed payment.
 * The frontend calls this when it detects a mismatch between client-side Clerk tier and
 * backend-reported quotas.
 */
export const syncMyTier = onCall({
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    return { success: false, tier: 'free' as UserTier, subscribedPlanKey: null, isFounders: false };
  }

  // getUserTierLive writes tier + subscribedPlanKey on the user doc.
  await getUserTierLive(uid);
  const info = await getUserPlanInfo(uid);
  logger.info(`syncMyTier: refreshed tier for ${uid} → ${info.tier}`, {
    subscribedPlanKey: info.subscribedPlanKey,
    isFounders: info.isFounders,
  });
  return {
    success: true,
    tier: info.tier,
    subscribedPlanKey: info.subscribedPlanKey,
    isFounders: info.isFounders,
  };
});
