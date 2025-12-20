import * as logger from "firebase-functions/logger";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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

export type UserTier = 'free' | 'nano';

const USER_TIER_CACHE_MS = 60 * 60 * 1000; // 1 hour

function normalizeTier(value: unknown): UserTier | null {
  // Backward-compat: if an older deploy stored "premium", treat it as nano.
  if (value === 'premium') return 'nano';
  if (value === 'free' || value === 'nano') return value;
  return null;
}

function tierFromPlanString(value: string): UserTier {
  const s = value.toLowerCase();
  if (s.includes('nano')) return 'nano';
  // Any paid plan we don't recognize yet should still be treated as nano (only paid tier).
  return 'nano';
}

function safeSecretValue(secret: { value: () => string }): string | null {
  try {
    const v = secret.value();
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

async function fetchTierFromClerk(uid: string): Promise<UserTier> {
  // Try prod first, then dev (mirrors other code paths in this repo).
  const prodSecretKey = safeSecretValue(CLERK_SECRET_KEY_PROD);
  const devSecretKey = safeSecretValue(CLERK_SECRET_KEY_DEV);

  const tryFetch = async (secretKey: string): Promise<UserTier | null> => {
    const client = createClerkClient({ secretKey });
    const subscription = await client.billing.getUserBillingSubscription(uid);
    if (!subscription || subscription.status !== 'active') return 'free';

    const activeItem =
      subscription.subscriptionItems?.find((i) => i.status === 'active') ??
      subscription.subscriptionItems?.[0];

    const planSlug = activeItem?.plan?.slug ? String(activeItem.plan.slug) : '';
    const planName = activeItem?.plan?.name ? String(activeItem.plan.name) : '';
    const planHint = `${planSlug} ${planName}`.trim();

    return planHint ? tierFromPlanString(planHint) : 'nano';
  };

  if (prodSecretKey) {
    try {
      return (await tryFetch(prodSecretKey)) ?? 'free';
    } catch (e) {
      logger.info(`Clerk prod billing lookup failed for ${uid}, trying dev...`, e);
    }
  }

  if (devSecretKey) {
    try {
      return (await tryFetch(devSecretKey)) ?? 'free';
    } catch (e) {
      logger.info(`Clerk dev billing lookup failed for ${uid}`, e);
    }
  }

  return 'free';
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
          const freshTier = await fetchTierFromClerk(uid);
          await userRef.set({ tier: freshTier, tierUpdatedAt: Date.now() }, { merge: true });
          return freshTier;
        } catch (e) {
          logger.warn(`Tier refresh failed for ${uid}, using cached tier: ${cachedTier}`, e);
          return cachedTier;
        }
      }
    }

    const tier = await fetchTierFromClerk(uid);
    await userRef.set({ tier, tierUpdatedAt: Date.now() }, { merge: true });
    return tier;
  } catch (error) {
    logger.warn(`Error getting user tier for ${uid}, defaulting to free:`, error);
    return 'free';
  }
};

