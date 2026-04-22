import * as logger from "firebase-functions/logger";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { firestore } from "./init";
import type { UserTier } from "./init";
import { CONFIG } from "./config";
import { FieldValue } from "firebase-admin/firestore";

type EnforcementResult = {
  elapsed: number;
  checksDisabled: number;
  checksClamped: number;
  apiKeysDisabled: number;
  webhooksDisabled: number;
  statusPagesDisabled: number;
  smsDisabled: boolean;
  totalBatches: number;
};

// Small batched-writer that splits a single logical update into multiple
// 500-op Firestore batches. Sequentially committed so a failure isolates the
// failing batch.
function createBatcher() {
  const batches: FirebaseFirestore.WriteBatch[] = [];
  let current = firestore.batch();
  let ops = 0;

  function add(
    ref: FirebaseFirestore.DocumentReference,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: Record<string, any>,
  ) {
    if (ops >= 500) {
      batches.push(current);
      current = firestore.batch();
      ops = 0;
    }
    current.update(ref, data);
    ops++;
  }

  async function commit(label: string, userId: string): Promise<number> {
    if (ops > 0) batches.push(current);
    for (let i = 0; i < batches.length; i++) {
      try {
        await batches[i].commit();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        logger.error(`[plan-enforcement] ${label} batch ${i + 1}/${batches.length} failed for ${userId}`, { error: msg });
        throw e;
      }
    }
    return batches.length;
  }

  return { add, commit };
}

/**
 * Write `userTier: newTier` onto every check owned by a user. Used after any
 * subscription change so the denormalised cache stays in sync. Skips docs that
 * already hold the right value.
 */
export async function backfillCheckUserTier(userId: string, newTier: UserTier): Promise<number> {
  const checksSnap = await firestore.collection('checks').where('userId', '==', userId).get();
  const batcher = createBatcher();
  let updated = 0;

  for (const doc of checksSnap.docs) {
    if (doc.data().userTier === newTier) continue;
    batcher.add(doc.ref, { userTier: newTier });
    updated++;
  }

  await batcher.commit('backfillCheckUserTier', userId);
  return updated;
}

/**
 * Disable SLA reporting, custom status domains, and clear any agency-only
 * features. No-ops for users that don't have these enabled — idempotent.
 */
async function disableAgencyOnlyFeatures(userId: string): Promise<{ statusPagesUpdated: number }> {
  const statusSnap = await firestore.collection('status_pages').where('userId', '==', userId).get();
  const batcher = createBatcher();
  let statusPagesUpdated = 0;

  for (const doc of statusSnap.docs) {
    const data = doc.data();
    const updates: Record<string, unknown> = {};
    // Disable custom status domain if present (field shape may vary by version).
    const customDomain = data.customDomain as { status?: unknown } | undefined;
    if (customDomain && customDomain.status && customDomain.status !== 'disabled') {
      updates['customDomain.status'] = 'disabled';
    }
    if (data.slaReporting?.enabled === true) {
      updates['slaReporting.enabled'] = false;
    }
    if (Object.keys(updates).length > 0) {
      batcher.add(doc.ref, updates);
      statusPagesUpdated++;
    }
  }

  await batcher.commit('disableAgencyOnlyFeatures', userId);
  return { statusPagesUpdated };
}

/**
 * Prune the oldest checks when a user's cap shrinks. Oldest-first (by
 * createdAt). Disables — does not delete — so history and BigQuery retention
 * behave normally.
 */
async function pruneChecksToLimit(userId: string, maxAllowed: number, newTier: UserTier): Promise<number> {
  const enabledSnap = await firestore.collection('checks')
    .where('userId', '==', userId)
    .where('disabled', '==', false)
    .get();
  if (enabledSnap.size <= maxAllowed) return 0;

  const sorted = enabledSnap.docs
    .map((d) => ({ ref: d.ref, createdAt: Number(d.data().createdAt) || 0 }))
    .sort((a, b) => a.createdAt - b.createdAt); // oldest first

  const excess = sorted.slice(0, sorted.length - maxAllowed);
  const batcher = createBatcher();
  for (const { ref } of excess) {
    batcher.add(ref, {
      disabled: true,
      disabledAt: Date.now(),
      disabledReason: 'plan_downgrade',
      userTier: newTier,
    });
  }
  await batcher.commit(`pruneChecksToLimit(${maxAllowed})`, userId);
  return excess.length;
}

/**
 * Disable the oldest enabled webhooks beyond `maxAllowed`. Oldest-first by
 * createdAt.
 */
async function pruneWebhooksToLimit(userId: string, maxAllowed: number): Promise<number> {
  const snap = await firestore.collection('webhooks')
    .where('userId', '==', userId)
    .where('enabled', '==', true)
    .get();
  if (snap.size <= maxAllowed) return 0;

  const sorted = snap.docs
    .map((d) => ({ ref: d.ref, createdAt: Number(d.data().createdAt) || 0 }))
    .sort((a, b) => a.createdAt - b.createdAt);

  const excess = sorted.slice(0, sorted.length - maxAllowed);
  const batcher = createBatcher();
  for (const { ref } of excess) {
    batcher.add(ref, { enabled: false, disabledReason: 'plan_downgrade' });
  }
  await batcher.commit(`pruneWebhooksToLimit(${maxAllowed})`, userId);
  return excess.length;
}

/**
 * Disable status pages beyond `maxAllowed`. Oldest-first by createdAt.
 */
async function pruneStatusPagesToLimit(userId: string, maxAllowed: number): Promise<number> {
  const snap = await firestore.collection('status_pages').where('userId', '==', userId).get();
  // Prune oldest enabled pages first.
  const enabled = snap.docs.filter((d) => d.data().enabled !== false);
  if (enabled.length <= maxAllowed) return 0;
  const sorted = enabled
    .map((d) => ({ ref: d.ref, createdAt: Number(d.data().createdAt) || 0 }))
    .sort((a, b) => a.createdAt - b.createdAt);
  const excess = sorted.slice(0, sorted.length - maxAllowed);
  const batcher = createBatcher();
  for (const { ref } of excess) {
    batcher.add(ref, { enabled: false, disabledReason: 'plan_downgrade' });
  }
  await batcher.commit(`pruneStatusPagesToLimit(${maxAllowed})`, userId);
  return excess.length;
}

async function disableAllApiKeys(userId: string): Promise<number> {
  const snap = await firestore.collection('apiKeys').where('userId', '==', userId).get();
  const batcher = createBatcher();
  let n = 0;
  for (const doc of snap.docs) {
    if (doc.data().enabled !== false) {
      batcher.add(doc.ref, { enabled: false, disabledReason: 'plan_downgrade' });
      n++;
    }
  }
  await batcher.commit('disableAllApiKeys', userId);
  return n;
}

async function disableSmsSettings(userId: string): Promise<boolean> {
  const ref = firestore.collection('smsSettings').doc(userId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if (snap.data()?.enabled === false) return false;
  await ref.update({ enabled: false, disabledReason: 'plan_downgrade' });
  return true;
}

/**
 * Handle plan downgrade from any paid tier → Free.
 * Disables all resources that exceed Free tier limits and resets check intervals.
 * Idempotent — safe to call multiple times (e.g., webhook retry).
 */
export async function handlePlanDowngrade(userId: string): Promise<EnforcementResult> {
  const startMs = Date.now();
  logger.info(`[plan-enforcement] Starting downgrade enforcement (→ free) for ${userId}`);

  const freeTierMinInterval = CONFIG.getMinCheckIntervalMinutesForTier('free');

  // Collect all queries in parallel
  const [checksSnap, apiKeysSnap, webhooksSnap, statusPagesSnap, smsSettingsSnap] = await Promise.all([
    firestore.collection("checks").where("userId", "==", userId).get(),
    firestore.collection("apiKeys").where("userId", "==", userId).get(),
    firestore.collection("webhooks").where("userId", "==", userId).get(),
    firestore.collection("status_pages").where("userId", "==", userId).get(),
    firestore.collection("smsSettings").doc(userId).get(),
  ]);

  const batcher = createBatcher();

  // Step 1: Disable all checks, reset frequency to Free tier minimum
  let checksDisabled = 0;
  for (const doc of checksSnap.docs) {
    const data = doc.data();
    const updates: Record<string, unknown> = {
      disabled: true,
      disabledReason: "plan_downgrade",
      disabledAt: Date.now(),
      userTier: "free",
    };

    // Clamp frequency to Free tier minimum
    const currentFreq = Number(data.checkFrequency) || CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES;
    if (currentFreq < freeTierMinInterval) {
      updates.checkFrequency = freeTierMinInterval;
    }

    // Clear maintenance mode (Free doesn't allow it)
    if (data.maintenanceMode) {
      updates.maintenanceMode = false;
      updates.maintenanceStartedAt = null;
      updates.maintenanceExpiresAt = null;
      updates.maintenanceDuration = null;
      updates.maintenanceReason = null;
    }
    if (data.maintenanceScheduledStart) {
      updates.maintenanceScheduledStart = null;
      updates.maintenanceScheduledDuration = null;
      updates.maintenanceScheduledReason = null;
    }
    if (data.maintenanceRecurring) {
      updates.maintenanceRecurring = null;
      updates.maintenanceRecurringActiveUntil = null;
    }

    // Disable domain intelligence
    if (data.domainExpiry?.enabled) {
      updates["domainExpiry.enabled"] = false;
    }

    batcher.add(doc.ref, updates);
    checksDisabled++;
  }

  // Step 2: Disable all API keys
  let apiKeysDisabled = 0;
  for (const doc of apiKeysSnap.docs) {
    const data = doc.data();
    if (data.enabled !== false) {
      batcher.add(doc.ref, {
        enabled: false,
        disabledReason: "plan_downgrade",
      });
      apiKeysDisabled++;
    }
  }

  // Step 3: Disable all webhooks
  let webhooksDisabled = 0;
  for (const doc of webhooksSnap.docs) {
    const data = doc.data();
    if (data.enabled !== false) {
      batcher.add(doc.ref, {
        enabled: false,
        disabledReason: "plan_downgrade",
      });
      webhooksDisabled++;
    }
  }

  // Step 4: Disable all status pages beyond the Free cap of 1.
  // Free allows 1 status page — disable the rest, keep the newest enabled (by createdAt desc).
  let statusPagesDisabled = 0;
  const freeStatusCap = 1; // Matches TIER_LIMITS.free.maxStatusPages
  const enabledStatus = statusPagesSnap.docs.filter((d) => d.data().enabled !== false);
  const sortedEnabled = enabledStatus
    .map((d) => ({ doc: d, createdAt: Number(d.data().createdAt) || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt); // newest first
  const toDisable = sortedEnabled.slice(freeStatusCap); // everything beyond the first N
  const alreadyDisabled = statusPagesSnap.docs.filter((d) => d.data().enabled === false);

  for (const { doc } of toDisable) {
    batcher.add(doc.ref, { enabled: false, disabledReason: "plan_downgrade" });
    statusPagesDisabled++;
  }
  // Also stamp disabledReason on ones that were already disabled without a reason — idempotent no-op otherwise.
  for (const doc of alreadyDisabled) {
    if (!doc.data().disabledReason) {
      batcher.add(doc.ref, { disabledReason: "plan_downgrade" });
    }
  }

  // Step 5: Disable SMS settings
  let smsDisabled = false;
  if (smsSettingsSnap.exists) {
    const smsData = smsSettingsSnap.data();
    if (smsData?.enabled !== false) {
      batcher.add(smsSettingsSnap.ref, {
        enabled: false,
        disabledReason: "plan_downgrade",
      });
      smsDisabled = true;
    }
  }

  // Write downgradedAt on user doc
  batcher.add(firestore.collection("users").doc(userId), {
    downgradedAt: FieldValue.serverTimestamp(),
  });

  const totalBatches = await batcher.commit('downgrade→free', userId);

  const result: EnforcementResult = {
    elapsed: Date.now() - startMs,
    checksDisabled,
    checksClamped: 0,
    apiKeysDisabled,
    webhooksDisabled,
    statusPagesDisabled,
    smsDisabled,
    totalBatches,
  };

  logger.info(`[plan-enforcement] Downgrade enforcement complete for ${userId}`, result);
  return result;
}

/**
 * Pro → Nano. Clamp intervals, disable SMS + API keys, prune excess checks to
 * 50, webhooks to 5, status pages to 5. Does NOT delete check history; retention
 * is managed separately by BigQuery purge jobs reading tier retention.
 */
export async function handleProToNanoDowngrade(userId: string): Promise<{
  checksClamped: number;
  checksPruned: number;
  webhooksPruned: number;
  statusPagesPruned: number;
  apiKeysDisabled: number;
  smsDisabled: boolean;
}> {
  logger.info(`[plan-enforcement] Starting Pro→Nano enforcement for ${userId}`);

  const nanoMinInterval = CONFIG.getMinCheckIntervalMinutesForTier('nano');
  const nanoMaxChecks = CONFIG.getMaxChecksForTier('nano');
  const nanoMaxWebhooks = CONFIG.getMaxWebhooksForTier('nano');

  // 1. Clamp + denormalise tier on every check.
  const checksSnap = await firestore.collection('checks').where('userId', '==', userId).get();
  const clampBatcher = createBatcher();
  let checksClamped = 0;
  for (const doc of checksSnap.docs) {
    const data = doc.data();
    const currentFreq = Number(data.checkFrequency) || CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES;
    const updates: Record<string, unknown> = {};
    if (data.userTier !== 'nano') updates.userTier = 'nano';
    if (currentFreq < nanoMinInterval) updates.checkFrequency = nanoMinInterval;
    if (Object.keys(updates).length > 0) {
      clampBatcher.add(doc.ref, updates);
      checksClamped++;
    }
  }
  await clampBatcher.commit('pro→nano clamp', userId);

  // 2. Prune excess checks (beyond 50).
  const checksPruned = await pruneChecksToLimit(userId, nanoMaxChecks, 'nano');

  // 3. Prune excess webhooks (beyond 5).
  const webhooksPruned = await pruneWebhooksToLimit(userId, nanoMaxWebhooks);

  // 4. Prune status pages (beyond 5) — Nano maxStatusPages = 5.
  const statusPagesPruned = await pruneStatusPagesToLimit(userId, 5);

  // 5. Disable all API keys (Nano has maxApiKeys = 0).
  const apiKeysDisabled = await disableAllApiKeys(userId);

  // 6. Disable SMS.
  const smsDisabled = await disableSmsSettings(userId);

  const result = { checksClamped, checksPruned, webhooksPruned, statusPagesPruned, apiKeysDisabled, smsDisabled };
  logger.info(`[plan-enforcement] Pro→Nano enforcement complete for ${userId}`, result);
  return result;
}

/**
 * Pro → Free. Delegates to handlePlanDowngrade (which zeroes out everything for
 * Free), plus explicitly ensures Pro-only state is cleared. CSV export and SLA
 * reporting have no persistent state yet, so nothing to clear there.
 */
export async function handleProToFreeDowngrade(userId: string): Promise<EnforcementResult> {
  logger.info(`[plan-enforcement] Starting Pro→Free enforcement for ${userId}`);
  // handlePlanDowngrade already: disables all checks (clamps to 5 min),
  // disables all API keys, disables all webhooks, disables SMS, and prunes
  // status pages down to 1. That covers Pro→Free.
  const result = await handlePlanDowngrade(userId);
  logger.info(`[plan-enforcement] Pro→Free enforcement complete for ${userId}`, result);
  return result;
}

/**
 * Agency → (pro | nano | free). Dispatches to the right handler and also
 * clears Agency-only state (custom status domain, SLA reporting). Team seats
 * have no persistent state yet — coming in Plan 2.
 */
export async function handleAgencyDowngrade(
  userId: string,
  newTier: 'pro' | 'nano' | 'free',
): Promise<void> {
  logger.info(`[plan-enforcement] Starting Agency→${newTier} enforcement for ${userId}`);

  // Always clear agency-only features first.
  await disableAgencyOnlyFeatures(userId);

  if (newTier === 'free') {
    await handleProToFreeDowngrade(userId);
  } else if (newTier === 'nano') {
    await handleProToNanoDowngrade(userId);
  } else {
    // Agency → Pro. Clamp intervals to Pro minimum, prune to Pro caps, but
    // keep SMS/API/webhooks/status pages enabled (Pro allows them).
    const proMinInterval = CONFIG.getMinCheckIntervalMinutesForTier('pro');
    const proMaxChecks = CONFIG.getMaxChecksForTier('pro');
    const proMaxWebhooks = CONFIG.getMaxWebhooksForTier('pro');
    const proMaxApiKeys = CONFIG.getMaxApiKeysForTier('pro');

    // Clamp + retag userTier on every check.
    const checksSnap = await firestore.collection('checks').where('userId', '==', userId).get();
    const clampBatcher = createBatcher();
    for (const doc of checksSnap.docs) {
      const data = doc.data();
      const currentFreq = Number(data.checkFrequency) || CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES;
      const updates: Record<string, unknown> = {};
      if (data.userTier !== 'pro') updates.userTier = 'pro';
      if (currentFreq < proMinInterval) updates.checkFrequency = proMinInterval;
      if (Object.keys(updates).length > 0) clampBatcher.add(doc.ref, updates);
    }
    await clampBatcher.commit('agency→pro clamp', userId);

    await pruneChecksToLimit(userId, proMaxChecks, 'pro');
    await pruneWebhooksToLimit(userId, proMaxWebhooks);
    await pruneStatusPagesToLimit(userId, 25);

    // Prune excess API keys (Agency: 25 → Pro: 10). Disable oldest first.
    const apiSnap = await firestore.collection('apiKeys')
      .where('userId', '==', userId)
      .where('enabled', '==', true)
      .get();
    if (apiSnap.size > proMaxApiKeys) {
      const sorted = apiSnap.docs
        .map((d) => ({ ref: d.ref, createdAt: Number(d.data().createdAt) || 0 }))
        .sort((a, b) => a.createdAt - b.createdAt);
      const excess = sorted.slice(0, sorted.length - proMaxApiKeys);
      const apiBatcher = createBatcher();
      for (const { ref } of excess) {
        apiBatcher.add(ref, { enabled: false, disabledReason: 'plan_downgrade' });
      }
      await apiBatcher.commit('agency→pro api keys', userId);
    }
  }

  logger.info(`[plan-enforcement] Agency→${newTier} enforcement complete for ${userId}`);
}

/**
 * @deprecated Scale is gone — legacy cached rows now resolve to 'agency' via
 * normalizeTier. This wrapper stays for back-compat with any tooling that
 * hard-codes the old name. Dispatches to handleAgencyDowngrade.
 */
export async function handleScaleToNanoDowngrade(userId: string): Promise<{ checksUpdated: number }> {
  logger.info(`[plan-enforcement] Legacy handleScaleToNanoDowngrade for ${userId} — delegating to Agency→Nano`);
  await handleAgencyDowngrade(userId, 'nano');
  // Legacy return shape — not reliable, kept only for API compat.
  return { checksUpdated: 0 };
}

/**
 * Admin-callable function to manually trigger downgrade enforcement for a user.
 * Useful for retroactive enforcement or debugging.
 */
export const enforcePlanDowngrade = onCall({
  cors: true,
  maxInstances: 5,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  // Verify caller is admin
  const callerSnap = await firestore.collection("users").doc(uid).get();
  if (!callerSnap.exists || callerSnap.data()?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const { userId } = request.data || {};
  if (!userId || typeof userId !== "string") {
    throw new HttpsError("invalid-argument", "userId is required");
  }

  const result = await handlePlanDowngrade(userId);
  return { success: true, result };
});
