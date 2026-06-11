import { HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

export type AdminChecker = (uid: string) => Promise<boolean>;

// Pure gating logic with an injectable checker so tests don't have to pull in
// firebase-admin via deploy-mode -> init.
export function makeRequireAdmin(checkAdmin: AdminChecker) {
  return async (uid: string): Promise<void> => {
    let isAdmin: boolean;
    try {
      isAdmin = await checkAdmin(uid);
    } catch (error) {
      logger.error(`Admin verification errored for ${uid}; denying access`, error);
      throw new HttpsError("permission-denied", "Admin access required");
    }
    if (!isAdmin) {
      logger.warn(`Admin-only function called by non-admin user: ${uid}`);
      throw new HttpsError("permission-denied", "Admin access required");
    }
  };
}

// Server-side admin gate for callable functions. Resolves admin status via
// syncAdminStatus (Firestore-cached, Clerk-authoritative, fail-closed) and
// throws permission-denied unless the caller is a verified admin.
//
// Callables using this must bind CLERK_SECRET_KEY_PROD and CLERK_SECRET_KEY_DEV
// in their secrets so the Clerk fallback is reachable when the Firestore cache
// is stale; without them the check still fails closed.
export async function requireAdmin(uid: string): Promise<void> {
  const { syncAdminStatus } = await import("./deploy-mode.js");
  return makeRequireAdmin(syncAdminStatus)(uid);
}
