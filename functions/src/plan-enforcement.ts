import * as logger from "firebase-functions/logger";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { firestore } from "./init";
import { CONFIG } from "./config";
import { FieldValue } from "firebase-admin/firestore";

type EnforcementResult = {
  elapsed: number;
  checksDisabled: number;
  apiKeysDisabled: number;
  webhooksDisabled: number;
  statusPagesDisabled: number;
  smsDisabled: boolean;
  totalBatches: number;
};

/**
 * Handle plan downgrade from Nano → Free.
 * Disables all resources that exceed Free tier limits and resets check intervals.
 * Idempotent — safe to call multiple times (e.g., webhook retry).
 */
export async function handlePlanDowngrade(userId: string): Promise<EnforcementResult> {
  const startMs = Date.now();
  logger.info(`[plan-enforcement] Starting downgrade enforcement for ${userId}`);

  const freeTierMinInterval = CONFIG.MIN_CHECK_INTERVAL_MINUTES_FREE;

  // Collect all queries in parallel
  const [checksSnap, apiKeysSnap, webhooksSnap, statusPagesSnap, smsSettingsSnap] = await Promise.all([
    firestore.collection("checks").where("userId", "==", userId).get(),
    firestore.collection("apiKeys").where("userId", "==", userId).get(),
    firestore.collection("webhooks").where("userId", "==", userId).get(),
    firestore.collection("status_pages").where("userId", "==", userId).get(),
    firestore.collection("smsSettings").doc(userId).get(),
  ]);

  // Firestore batches have a 500-operation limit. We'll split across multiple batches.
  const batches: FirebaseFirestore.WriteBatch[] = [];
  let currentBatch = firestore.batch();
  let opCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addOp(ref: FirebaseFirestore.DocumentReference, data: Record<string, any>) {
    if (opCount >= 500) {
      batches.push(currentBatch);
      currentBatch = firestore.batch();
      opCount = 0;
    }
    currentBatch.update(ref, data);
    opCount++;
  }

  // Step 1: Disable all checks, reset frequency to Free tier minimum
  let checksDisabled = 0;
  for (const doc of checksSnap.docs) {
    const data = doc.data();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {
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

    // Clear maintenance mode
    if (data.maintenanceMode) {
      updates.maintenanceMode = false;
      updates.maintenanceStartedAt = null;
      updates.maintenanceExpiresAt = null;
      updates.maintenanceDuration = null;
      updates.maintenanceReason = null;
    }
    // Clear scheduled maintenance
    if (data.maintenanceScheduledStart) {
      updates.maintenanceScheduledStart = null;
      updates.maintenanceScheduledDuration = null;
      updates.maintenanceScheduledReason = null;
    }
    // Clear recurring maintenance
    if (data.maintenanceRecurring) {
      updates.maintenanceRecurring = null;
      updates.maintenanceRecurringActiveUntil = null;
    }

    // Disable domain intelligence
    if (data.domainExpiry?.enabled) {
      updates["domainExpiry.enabled"] = false;
    }

    addOp(doc.ref, updates);
    checksDisabled++;
  }

  // Step 2: Disable all API keys
  let apiKeysDisabled = 0;
  for (const doc of apiKeysSnap.docs) {
    const data = doc.data();
    if (data.enabled !== false) {
      addOp(doc.ref, {
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
      addOp(doc.ref, {
        enabled: false,
        disabledReason: "plan_downgrade",
      });
      webhooksDisabled++;
    }
  }

  // Step 4: Disable all status pages
  let statusPagesDisabled = 0;
  for (const doc of statusPagesSnap.docs) {
    addOp(doc.ref, {
      enabled: false,
      disabledReason: "plan_downgrade",
    });
    statusPagesDisabled++;
  }

  // Step 5: Disable SMS settings
  let smsDisabled = false;
  if (smsSettingsSnap.exists) {
    const smsData = smsSettingsSnap.data();
    if (smsData?.enabled !== false) {
      addOp(smsSettingsSnap.ref, {
        enabled: false,
        disabledReason: "plan_downgrade",
      });
      smsDisabled = true;
    }
  }

  // Write downgradedAt on user doc
  addOp(firestore.collection("users").doc(userId), {
    downgradedAt: FieldValue.serverTimestamp(),
  });

  // Push the last batch
  if (opCount > 0) {
    batches.push(currentBatch);
  }

  // Commit batches sequentially so a failure tells us exactly which batch broke
  // and prior batches are already persisted (idempotency handles retries)
  for (let i = 0; i < batches.length; i++) {
    try {
      await batches[i].commit();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logger.error(`[plan-enforcement] Batch ${i + 1}/${batches.length} failed for ${userId}`, { error: msg });
      throw e; // Re-throw so the webhook returns 500 and Clerk retries
    }
  }

  const elapsed = Date.now() - startMs;
  const result: EnforcementResult = {
    elapsed,
    checksDisabled,
    apiKeysDisabled,
    webhooksDisabled,
    statusPagesDisabled,
    smsDisabled,
    totalBatches: batches.length,
  };

  logger.info(`[plan-enforcement] Downgrade enforcement complete for ${userId}`, result);
  return result;
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
