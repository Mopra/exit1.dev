import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { createClerkClient } from '@clerk/backend';
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV } from "./env";

const DEPLOY_MODE_DOC = "system_settings/deploy_mode";
const DEFAULT_DURATION_MINUTES = 30;
const MAX_DURATION_MINUTES = 120;

// Interface for deploy mode state
interface DeployModeData {
  enabled: boolean;
  enabledAt: number;
  expiresAt: number;
  enabledBy: string;
  reason?: string;
  disabledAt?: number;
  disabledBy?: string;
}

// Helper function to sync admin status from Clerk to Firestore (same pattern as notifications.ts)
async function syncAdminStatus(uid: string): Promise<boolean> {
  try {
    const userRef = firestore.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      const userData = userDoc.data();
      const updatedAt = userData?.updatedAt || 0;
      const oneHourAgo = Date.now() - (60 * 60 * 1000);

      if (updatedAt > oneHourAgo && typeof userData?.admin === 'boolean') {
        return userData.admin;
      }
    }

    let prodSecretKey: string | undefined;
    try {
      prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    } catch {
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') return userData.admin;
      }
      throw new Error("Cannot access Clerk secret key");
    }

    if (!prodSecretKey) {
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') return userData.admin;
      }
      return false;
    }

    let clerkUser;
    try {
      const prodClient = createClerkClient({ secretKey: prodSecretKey });
      clerkUser = await prodClient.users.getUser(uid);
    } catch (prodError: unknown) {
      const error = prodError as { status?: number; errors?: Array<{ code?: string }> };
      if (error?.status === 404 || error?.errors?.[0]?.code === 'resource_not_found') {
        try {
          let devSecretKey: string | undefined;
          try { devSecretKey = CLERK_SECRET_KEY_DEV.value(); } catch { /* noop */ }
          if (devSecretKey) {
            const devClient = createClerkClient({ secretKey: devSecretKey });
            clerkUser = await devClient.users.getUser(uid);
          } else {
            await userRef.set({ admin: false, updatedAt: Date.now() }, { merge: true });
            return false;
          }
        } catch (devError: unknown) {
          const devErr = devError as { status?: number; errors?: Array<{ code?: string }> };
          if (devErr?.status === 404 || devErr?.errors?.[0]?.code === 'resource_not_found') {
            await userRef.set({ admin: false, updatedAt: Date.now() }, { merge: true });
            return false;
          }
          if (userDoc.exists) {
            const userData = userDoc.data();
            if (typeof userData?.admin === 'boolean') return userData.admin;
          }
          throw devError;
        }
      } else {
        if (userDoc.exists) {
          const userData = userDoc.data();
          if (typeof userData?.admin === 'boolean') return userData.admin;
        }
        throw prodError;
      }
    }

    if (!clerkUser) {
      await userRef.set({ admin: false, updatedAt: Date.now() }, { merge: true });
      return false;
    }

    const isAdmin = clerkUser.publicMetadata?.admin === true;
    await userRef.set({ admin: isAdmin, updatedAt: Date.now() }, { merge: true });
    return isAdmin;
  } catch (error: unknown) {
    logger.error(`Error syncing admin status for ${uid}:`, error);
    try {
      const userRef = firestore.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') return userData.admin;
      }
    } catch { /* noop */ }
    return false;
  }
}

// Enable deploy mode (admin only)
export const enableDeployMode = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const isAdmin = await syncAdminStatus(uid);
  if (!isAdmin) {
    throw new Error("Admin access required");
  }

  const { durationMinutes, reason } = request.data as {
    durationMinutes?: number;
    reason?: string;
  };

  const duration = Math.min(
    Math.max(1, durationMinutes || DEFAULT_DURATION_MINUTES),
    MAX_DURATION_MINUTES
  );

  const now = Date.now();
  const expiresAt = now + duration * 60 * 1000;

  const data: DeployModeData = {
    enabled: true,
    enabledAt: now,
    expiresAt,
    enabledBy: uid,
    ...(reason ? { reason } : {}),
  };

  await firestore.doc(DEPLOY_MODE_DOC).set(data);

  logger.info(`Deploy mode enabled by ${uid} for ${duration} minutes (expires ${new Date(expiresAt).toISOString()})${reason ? ` — reason: ${reason}` : ''}`);

  return { success: true, expiresAt };
});

// Disable deploy mode (admin only)
export const disableDeployMode = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  const isAdmin = await syncAdminStatus(uid);
  if (!isAdmin) {
    throw new Error("Admin access required");
  }

  await firestore.doc(DEPLOY_MODE_DOC).set({
    enabled: false,
    disabledAt: Date.now(),
    disabledBy: uid,
  }, { merge: true });

  logger.info(`Deploy mode disabled by ${uid}`);

  return { success: true };
});
