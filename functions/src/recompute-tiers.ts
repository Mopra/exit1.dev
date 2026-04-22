import * as logger from "firebase-functions/logger";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { createClerkClient } from "@clerk/backend";
import { firestore, tierFromPlanKey } from "./init";
import type { UserTier } from "./init";
import { backfillCheckUserTier } from "./plan-enforcement";
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV } from "./env";

// Per-invocation user cap. Clerk page fetches dominate wall time; 200 users
// per batch × ~200ms each ≈ 40s, leaves plenty of headroom under the 540s
// timeout even with Firestore writes + check backfills.
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 500;
const CLERK_PAGE_SIZE = 100;

/**
 * Admin callable: recompute `tier` + `subscribedPlanKey` for every Clerk user,
 * invalidate the tier cache, and re-denormalise `userTier` onto their checks.
 *
 * Resumable: processes up to `batchSize` users per invocation and returns
 * `{ done, nextOffset }`. Clerk paginates server-side — a full scan of tens of
 * thousands of users takes longer than the 9-minute gateway timeout, so the
 * client loops until `done === true`.
 *
 * Idempotent — safe to re-run; users whose tier + plan key are already correct
 * get no writes.
 *
 * Output of each invocation:
 *   - total: users processed in this invocation
 *   - recomputed: users whose tier or subscribedPlanKey changed
 *   - unchanged: users already in sync
 *   - errors: soft-fail count; first 20 included in the response
 *   - done / nextOffset: resumability markers
 */
export const recomputeAllTiers = onCall({
  cors: true,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
  timeoutSeconds: 540,
  maxInstances: 2,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  // Admin gate: users/{uid}.admin === true
  const callerSnap = await firestore.collection("users").doc(uid).get();
  if (!callerSnap.exists || callerSnap.data()?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const {
    instance = "prod",
    startOffset = 0,
    batchSize: rawBatchSize,
    dryRun = false,
  } = (request.data || {}) as {
    instance?: string;
    startOffset?: number;
    batchSize?: number;
    dryRun?: boolean;
  };

  if (instance !== "prod" && instance !== "dev") {
    throw new HttpsError("invalid-argument", 'Instance must be "prod" or "dev"');
  }

  const normalizedOffset = Math.max(0, Math.floor(Number(startOffset) || 0));
  const normalizedBatchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Math.floor(Number(rawBatchSize) || DEFAULT_BATCH_SIZE)),
  );

  let secretKey: string | null = null;
  try {
    secretKey = (instance === "prod"
      ? CLERK_SECRET_KEY_PROD.value()
      : CLERK_SECRET_KEY_DEV.value()
    )?.trim() || null;
  } catch {
    secretKey = (instance === "prod"
      ? process.env.CLERK_SECRET_KEY_PROD
      : process.env.CLERK_SECRET_KEY_DEV
    )?.trim() || null;
  }

  if (!secretKey) {
    throw new HttpsError("failed-precondition", `Clerk ${instance} secret key not configured`);
  }

  const clerk = createClerkClient({ secretKey });

  const stats = {
    total: 0,
    recomputed: 0,
    unchanged: 0,
    errors: 0,
    dryRun,
    startOffset: normalizedOffset,
    batchSize: normalizedBatchSize,
  };
  const errors: Array<{ userId: string; error: string }> = [];

  const resolveForUser = async (userId: string): Promise<{ tier: UserTier; planKey: string | null }> => {
    // Mirror fetchTierFromClerk semantics without the Firestore write (we own that here).
    try {
      const user = await clerk.users.getUser(userId);
      if (user.publicMetadata?.admin === true) {
        return { tier: "agency", planKey: null };
      }
      if (user.publicMetadata?.lifetimeNano === true) {
        return { tier: "pro", planKey: "nano" };
      }
    } catch (e) {
      logger.debug(`recomputeAllTiers: metadata lookup failed for ${userId}`, e);
    }

    try {
      const subscription: unknown = await clerk.billing.getUserBillingSubscription(userId);
      if (!subscription || typeof subscription !== "object") {
        return { tier: "free", planKey: null };
      }
      const sub = subscription as {
        subscriptionItems?: Array<{
          status?: unknown;
          plan?: { slug?: unknown } | null;
        }>;
      };
      const items = Array.isArray(sub.subscriptionItems) ? sub.subscriptionItems : [];
      const rank: Record<UserTier, number> = { free: 0, nano: 1, pro: 2, agency: 3 };
      let best: UserTier = "free";
      let bestKey: string | null = null;
      for (const item of items) {
        const statusStr = typeof item?.status === "string" ? item.status.toLowerCase() : "";
        if (statusStr !== "active" && statusStr !== "upcoming" && statusStr !== "past_due") continue;
        const slug = typeof item.plan?.slug === "string" ? item.plan.slug.trim() : "";
        if (!slug) continue;
        const resolved = tierFromPlanKey(slug);
        if (rank[resolved] > rank[best]) {
          best = resolved;
          bestKey = slug;
        } else if (rank[resolved] === rank[best] && bestKey === null) {
          bestKey = slug;
        }
      }
      return { tier: best, planKey: bestKey };
    } catch (e) {
      logger.warn(`recomputeAllTiers: billing lookup failed for ${userId}`, e);
      throw e;
    }
  };

  try {
    const targetTotal = normalizedOffset + normalizedBatchSize;
    let offset = normalizedOffset;
    let reachedEnd = false;

    while (offset < targetTotal && !reachedEnd) {
      const remaining = targetTotal - offset;
      const limit = Math.min(CLERK_PAGE_SIZE, remaining);
      const response = await clerk.users.getUserList({ limit, offset });
      const users = response.data;

      if (users.length === 0) {
        reachedEnd = true;
        break;
      }

      for (const user of users) {
        stats.total++;
        const userId = user.id;

        try {
          const { tier, planKey } = await resolveForUser(userId);

          // Read the current cached doc to detect changes without writing.
          const userRef = firestore.collection("users").doc(userId);
          const snap = await userRef.get();
          const data = snap.exists ? (snap.data() || {}) : {};
          const cachedTier = (data as { tier?: unknown }).tier;
          const cachedPlanKey = typeof (data as { subscribedPlanKey?: unknown }).subscribedPlanKey === "string"
            ? (data as { subscribedPlanKey: string }).subscribedPlanKey
            : null;

          const changed = cachedTier !== tier || cachedPlanKey !== planKey;

          if (!changed) {
            stats.unchanged++;
            continue;
          }

          if (dryRun) {
            stats.recomputed++;
            continue;
          }

          // Invalidate cache so any getUserTier() call within the TTL refetches.
          await userRef.set(
            {
              tier,
              subscribedPlanKey: planKey,
              tierUpdatedAt: 0, // forces next getUserTier() to refetch from Clerk
            },
            { merge: true },
          );

          // Re-denormalise userTier on every check doc the user owns.
          try {
            await backfillCheckUserTier(userId, tier);
          } catch (e) {
            logger.warn(`recomputeAllTiers: check backfill failed for ${userId}`, e);
          }

          stats.recomputed++;
        } catch (e) {
          stats.errors++;
          errors.push({ userId, error: e instanceof Error ? e.message : String(e) });
        }
      }

      offset += users.length;
      if (users.length < limit) reachedEnd = true;
    }

    const done = reachedEnd;
    const nextOffset = offset;

    logger.info("recomputeAllTiers batch completed", { ...stats, done, nextOffset });

    return {
      success: true,
      done,
      nextOffset,
      stats,
      errors: errors.slice(0, 20),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "recomputeAllTiers failed";
    logger.error("recomputeAllTiers failed", { error: message });
    throw new HttpsError("internal", message);
  }
});
