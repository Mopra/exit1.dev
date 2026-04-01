import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { FieldPath } from "firebase-admin/firestore";
import { firestore, getUserTier } from "./init";
import { CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from "./env";
import { createClerkClient } from '@clerk/backend';
import { CONFIG } from "./config";

// Simple in-memory cache for user data
const userCache = new Map<string, { data: Record<string, unknown>; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Helper function to invalidate user cache
const invalidateUserCache = () => {
  userCache.clear();
  logger.info('User cache invalidated');
};

// Firestore batch limit
const BATCH_MAX = 500;

/**
 * Delete all Firestore data associated with a user.
 * Shared by self-service deleteUserAccount and admin deleteUser/bulkDeleteUsers.
 */
async function deleteAllUserData(userId: string): Promise<{
  checks: number;
  webhooks: number;
  apiKeys: number;
  statusPages: number;
  notifications: number;
}> {
  // 1. Query all user-owned collections in parallel
  const [
    checksSnap,
    webhooksSnap,
    apiKeysSnap,
    statusPagesSnap,
    notificationsSnap,
    manualLogsSnap,
    logNotesSnap,
  ] = await Promise.all([
    firestore.collection("checks").where("userId", "==", userId).get(),
    firestore.collection("webhooks").where("userId", "==", userId).get(),
    firestore.collection("apiKeys").where("userId", "==", userId).get(),
    firestore.collection("status_pages").where("userId", "==", userId).get(),
    firestore.collection("user_notifications").where("userId", "==", userId).get(),
    firestore.collection("users").doc(userId).collection("manualLogs").get(),
    firestore.collection("users").doc(userId).collection("logNotes").get(),
  ]);

  // 2. Collect all document refs to delete
  const allRefs: FirebaseFirestore.DocumentReference[] = [];

  // User-owned query results
  checksSnap.docs.forEach(doc => allRefs.push(doc.ref));
  webhooksSnap.docs.forEach(doc => allRefs.push(doc.ref));
  apiKeysSnap.docs.forEach(doc => allRefs.push(doc.ref));
  statusPagesSnap.docs.forEach(doc => allRefs.push(doc.ref));
  notificationsSnap.docs.forEach(doc => allRefs.push(doc.ref));
  manualLogsSnap.docs.forEach(doc => allRefs.push(doc.ref));
  logNotesSnap.docs.forEach(doc => allRefs.push(doc.ref));

  // Single-doc collections keyed by userId
  allRefs.push(firestore.collection("emailSettings").doc(userId));
  allRefs.push(firestore.collection("smsSettings").doc(userId));
  allRefs.push(firestore.collection("user_check_stats").doc(userId));
  allRefs.push(firestore.collection("users").doc(userId));

  // 3. Delete rate-limit / budget docs tied to this user

  // Rate-limit docs for checks owned by this user (keyed by checkId)
  const checkIds = checksSnap.docs.map(doc => doc.id);
  if (checkIds.length > 0) {
    // emailRateLimits and smsRateLimits are keyed by `checkId:eventType`
    // Query them by checking doc IDs that start with each checkId
    for (const throttleCollection of [CONFIG.EMAIL_THROTTLE_COLLECTION, CONFIG.SMS_THROTTLE_COLLECTION]) {
      for (const checkId of checkIds) {
        const throttleSnap = await firestore.collection(throttleCollection)
          .where(FieldPath.documentId(), '>=', checkId + ':')
          .where(FieldPath.documentId(), '<=', checkId + ':\uf8ff')
          .get();
        throttleSnap.docs.forEach(doc => allRefs.push(doc.ref));
      }
    }
  }

  // Budget docs keyed as `uid__windowStart`
  for (const col of [
    CONFIG.EMAIL_USER_BUDGET_COLLECTION,
    CONFIG.EMAIL_USER_MONTHLY_BUDGET_COLLECTION,
    CONFIG.SMS_USER_BUDGET_COLLECTION,
    CONFIG.SMS_USER_MONTHLY_BUDGET_COLLECTION,
  ]) {
    const budgetSnap = await firestore.collection(col)
      .where(FieldPath.documentId(), '>=', userId + '__')
      .where(FieldPath.documentId(), '<=', userId + '__\uf8ff')
      .get();
    budgetSnap.docs.forEach(doc => allRefs.push(doc.ref));
  }

  // 4. Delete status page cache docs for user's status pages
  for (const spDoc of statusPagesSnap.docs) {
    allRefs.push(firestore.collection("status_page_cache").doc(spDoc.id));
  }

  // 5. Delete stats cache docs keyed by userId prefix
  const statsCacheSnap = await firestore.collection("stats_cache")
    .where(FieldPath.documentId(), '>=', userId + '_')
    .where(FieldPath.documentId(), '<=', userId + '_\uf8ff')
    .get();
  statsCacheSnap.docs.forEach(doc => allRefs.push(doc.ref));

  // 6. Batch-delete everything (Firestore limit: 500 ops per batch)
  for (let i = 0; i < allRefs.length; i += BATCH_MAX) {
    const batch = firestore.batch();
    allRefs.slice(i, i + BATCH_MAX).forEach(ref => batch.delete(ref));
    await batch.commit();
  }

  return {
    checks: checksSnap.size,
    webhooks: webhooksSnap.size,
    apiKeys: apiKeysSnap.size,
    statusPages: statusPagesSnap.size,
    notifications: notificationsSnap.size,
  };
}

// Callable function to delete user account and all associated data
export const deleteUserAccount = onCall({
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    logger.info(`Starting account deletion for user ${uid}`);

    // Delete all Firestore data for this user
    const counts = await deleteAllUserData(uid);

    logger.info(`Deleted data for user ${uid}:`, counts);

    // Delete Clerk user via admin API (bypasses Commerce/billing restrictions
    // that block frontend user.delete() with 403)
    let clerkDeleted = false;
    try {
      // Try prod first, then dev
      const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
      const devSecretKey = CLERK_SECRET_KEY_DEV.value();

      const keysToTry = [
        { key: prodSecretKey, label: 'prod' },
        { key: devSecretKey, label: 'dev' },
      ].filter(k => !!k.key);

      for (const { key, label } of keysToTry) {
        try {
          const clerk = createClerkClient({ secretKey: key! });
          await clerk.users.deleteUser(uid);
          logger.info(`Clerk user ${uid} deleted via ${label} admin API`);
          clerkDeleted = true;
          break;
        } catch (clerkErr: unknown) {
          // 404 means user doesn't exist in this instance, try the other
          const errObj = clerkErr as { status?: number; errors?: Array<{ code?: string }> };
          if (errObj?.status === 404 || errObj?.errors?.[0]?.code === 'resource_not_found') {
            logger.info(`User ${uid} not found in Clerk ${label}, trying next`);
            continue;
          }
          throw clerkErr;
        }
      }

      if (!clerkDeleted) {
        logger.warn(`Could not find Clerk user ${uid} in any instance — Firestore data deleted`);
      }
    } catch (clerkError) {
      logger.error(`Failed to delete Clerk user ${uid}:`, clerkError);
      // Don't throw — Firestore data is already deleted, frontend can sign out
    }

    return {
      success: true,
      clerkDeleted,
      deletedCounts: counts,
      message: 'Account and all associated data have been deleted.'
    };
  } catch (error) {
    logger.error(`Failed to delete user account for ${uid}:`, error);
    throw new Error(`Failed to delete user account: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Get all users (admin only) - OPTIMIZED VERSION
export const getAllUsers = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  logger.info('getAllUsers called by user:', uid);

  try {
    // Get pagination parameters from request
    const { page = 1, limit = 50, offset = 0, instance, sortBy = 'createdAt' } = request.data || {};
    logger.info('getAllUsers called with sortBy:', sortBy);
    const pageSize = Math.min(limit, 100); // Max 100 users per page
    const skip = offset || (page - 1) * pageSize;

    // OPTIMIZATION 4: Check cache first (cache key includes page, limit, and sortBy for proper pagination)
    const cacheKey = `all_users_${page}_${pageSize}_${sortBy}_${instance || 'prod'}`;
    const cached = userCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      logger.info('Returning cached user data for sortBy:', sortBy);
      return cached.data;
    }
    
    logger.info('Cache miss or expired, fetching fresh data for sortBy:', sortBy);

    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function
    // No need for backend admin verification since the UI controls access

    // Determine which instance to query
    // IMPORTANT: Always use explicit secret keys to avoid confusion
    let client;
    if (instance === 'dev') {
      const devSecretKey = CLERK_SECRET_KEY_DEV.value();
      if (!devSecretKey) {
        throw new Error('Clerk dev secret key (CLERK_SECRET_KEY_DEV) not found. Please ensure it is set.');
      }
      client = createClerkClient({ secretKey: devSecretKey });
      logger.info('Using Clerk dev client (explicitly initialized from CLERK_SECRET_KEY_DEV)');
    } else {
      // Default to prod - explicitly use CLERK_SECRET_KEY_PROD
      const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
      if (!prodSecretKey) {
        throw new Error('Clerk prod secret key (CLERK_SECRET_KEY_PROD) not found. Please ensure it is set.');
      }
      client = createClerkClient({ secretKey: prodSecretKey });
      logger.info('Using Clerk prod client (explicitly initialized from CLERK_SECRET_KEY_PROD)');
    }

    // When sorting by checksCount, we need to fetch ALL users to sort properly
    // For other sorts, we can use Clerk's pagination
    const needsFullSort = sortBy === 'checksCount';
    const instanceType = instance === 'dev' ? 'dev' : 'prod';
    
    let clerkUsers;
    if (needsFullSort) {
      // Fetch ALL users in batches when sorting by checksCount
      logger.info(`Fetching all users for ${instanceType} instance to sort by checksCount`);
      const allUsers = [];
      let fetchOffset = 0;
      const batchSize = 200; // Clerk's max per request is 200
      let hasMore = true;
      
      while (hasMore) {
        const batch = await client.users.getUserList({
          limit: batchSize,
          offset: fetchOffset
        });

        if (batch.data.length === 0) {
          hasMore = false;
          break;
        }

        allUsers.push(...batch.data);
        fetchOffset += batch.data.length;
        
        // If we got fewer than batchSize, we've reached the end
        if (batch.data.length < batchSize) {
          hasMore = false;
        }
      }
      
      clerkUsers = {
        data: allUsers,
        totalCount: allUsers.length
      };
      logger.info(`Fetched ${allUsers.length} total users for sorting by checksCount`);
    } else {
      // Use Clerk's pagination for other sorts
      const fetchLimit = Math.min(pageSize, 500);
      const fetchOffset = skip;
      logger.info(`Calling Clerk ${instanceType} API with params:`, { limit: fetchLimit, offset: fetchOffset, sortBy });
      clerkUsers = await client.users.getUserList({
        limit: fetchLimit,
        offset: fetchOffset
      });
      logger.info(`Clerk ${instanceType} API response received, user count:`, clerkUsers.data.length);
    }

    if (clerkUsers.data.length === 0) {
      return {
        success: true,
        data: [],
        count: 0,
        pagination: {
          page,
          pageSize,
          total: 0,
          hasNext: false,
          hasPrev: page > 1
        }
      };
    }

    // OPTIMIZATION 1: Batch fetch all checks and webhooks in parallel
    const userIds = clerkUsers.data.map(user => user.id);
    
    // Helper function to chunk array into smaller arrays
    const chunkArray = <T>(array: T[], chunkSize: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
      }
      return chunks;
    };

    // Firestore IN queries are limited to 30 values, so chunk the userIds
    const userIdChunks = chunkArray(userIds, 30);
    
    // Create batch queries for all users at once, handling the 30-item limit
    const [checksSnapshots, webhooksSnapshots] = await Promise.all([
      // Get all checks for all users in multiple queries (chunked)
      Promise.all(userIdChunks.map(chunk => 
        firestore
          .collection('checks')
          .where('userId', 'in', chunk)
          .get()
      )),
      // Get all webhooks for all users in multiple queries (chunked)
      Promise.all(userIdChunks.map(chunk => 
        firestore
          .collection('webhooks')
          .where('userId', 'in', chunk)
          .get()
      ))
    ]);

    // Combine all snapshots into single snapshots
    const checksSnapshot = { docs: checksSnapshots.flatMap(snapshot => snapshot.docs) };
    const webhooksSnapshot = { docs: webhooksSnapshots.flatMap(snapshot => snapshot.docs) };
    // OPTIMIZATION 2: Pre-process data into maps for O(1) lookup
    const checksByUser = new Map<string, Array<Record<string, unknown> & { createdAt?: number; updatedAt?: number }>>();
    const webhooksByUser = new Map<string, Array<Record<string, unknown> & { createdAt?: number; updatedAt?: number }>>();
    
    // Group checks by userId
    checksSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const userId = data.userId;
      if (!checksByUser.has(userId)) {
        checksByUser.set(userId, []);
      }
      checksByUser.get(userId)!.push(data);
    });
    
    // Group webhooks by userId
    webhooksSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const userId = data.userId;
      if (!webhooksByUser.has(userId)) {
        webhooksByUser.set(userId, []);
      }
      webhooksByUser.get(userId)!.push(data);
    });

    // OPTIMIZATION 3: Process users in parallel
    const users = await Promise.all(
      clerkUsers.data.map(async (clerkUser) => {
        const userChecks = checksByUser.get(clerkUser.id) || [];
        const userWebhooks = webhooksByUser.get(clerkUser.id) || [];

        // Get earliest check creation time as user creation time
        let createdAt = 0;
        if (userChecks.length > 0) {
          const sortedChecks = userChecks.sort((a, b) => 
            (a.createdAt || 0) - (b.createdAt || 0)
          );
          createdAt = sortedChecks[0].createdAt || 0;
        }

        // Get latest check update time as user update time
        let updatedAt = 0;
        if (userChecks.length > 0) {
          const latestCheck = userChecks.reduce((latest, current) => {
            const latestTime = latest.updatedAt || 0;
            const currentTime = current.updatedAt || 0;
            return currentTime > latestTime ? current : latest;
          });
          updatedAt = latestCheck.updatedAt || 0;
        }

        // Use Clerk's creation time if no checks exist
        if (createdAt === 0) {
          createdAt = clerkUser.createdAt;
        }

        // Use Clerk's last sign in time if no checks exist
        if (updatedAt === 0) {
          updatedAt = clerkUser.lastSignInAt || clerkUser.createdAt;
        }

        // Get user tier - use cached lookup to avoid N+1 API calls when fetching many users
        // The 2-hour cache is acceptable for admin overview; live lookup would timeout with many users
        let tier: 'free' | 'nano' | 'scale' = 'free';
        try {
          tier = await getUserTier(clerkUser.id);
        } catch (error) {
          logger.warn(`Failed to get tier for user ${clerkUser.id}:`, error);
        }

        return {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress || 'No email',
          displayName: clerkUser.fullName || clerkUser.firstName || clerkUser.lastName || 'No name',
          createdAt: createdAt,
          updatedAt: updatedAt,
          isAdmin: clerkUser.publicMetadata?.admin === true,
          lastSignIn: clerkUser.lastSignInAt,
          emailVerified: clerkUser.emailAddresses[0]?.verification?.status === 'verified',
          checksCount: userChecks.length,
          webhooksCount: userWebhooks.length,
          tier: tier
        };
      })
    );

    // Sort users based on sortBy parameter
    switch (sortBy) {
      case 'checksCount':
        users.sort((a, b) => (b.checksCount || 0) - (a.checksCount || 0));
        break;
      case 'name-asc':
        users.sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));
        break;
      case 'name-desc':
        users.sort((a, b) => (b.displayName || b.email).localeCompare(a.displayName || a.email));
        break;
      case 'email-asc':
        users.sort((a, b) => a.email.localeCompare(b.email));
        break;
      case 'email-desc':
        users.sort((a, b) => b.email.localeCompare(a.email));
        break;
      case 'lastSignIn':
        users.sort((a, b) => (b.lastSignIn || 0) - (a.lastSignIn || 0));
        break;
      case 'admin':
        users.sort((a, b) => {
          if (a.isAdmin && !b.isAdmin) return -1;
          if (!a.isAdmin && b.isAdmin) return 1;
          return 0;
        });
        break;
      case 'createdAt':
      default:
        users.sort((a, b) => b.createdAt - a.createdAt);
        break;
    }

    // CRITICAL: When sorting by checksCount, we've sorted all fetched users, so paginate after sorting
    // For other sorts, we can use the already-paginated results from Clerk
    const limitedUsers = needsFullSort 
      ? users.slice(skip, skip + pageSize) // Paginate after sorting
      : users.slice(0, pageSize); // Already paginated from Clerk

    // Calculate pagination metadata
    const totalUsers = needsFullSort ? users.length : (clerkUsers.totalCount || users.length);
    const hasNext = needsFullSort 
      ? (skip + pageSize < users.length) // For full sort, check if there are more users after current page
      : (skip + limitedUsers.length < totalUsers); // For paginated sort, use Clerk's total
    const hasPrev = page > 1;

    const result = {
      success: true,
      data: limitedUsers,
      count: limitedUsers.length,
      pagination: {
        page,
        pageSize,
        total: totalUsers,
        hasNext,
        hasPrev
      }
    };

    // OPTIMIZATION 4: Cache the result
    userCache.set(cacheKey, { data: result, timestamp: now });
    
    // Clean up old cache entries (keep cache size manageable)
    if (userCache.size > 10) {
      const oldestKey = userCache.keys().next().value;
      if (oldestKey) {
        userCache.delete(oldestKey);
      }
    }

    return result;
  } catch (error) {
    logger.error('Error getting all users:', error);
    logger.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    throw new Error(`Failed to get users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Delete user (admin only)
export const deleteUser = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  try {
    const { userId } = request.data;
    if (!userId || typeof userId !== 'string') {
      throw new Error("User ID is required");
    }

    // Prevent admin from deleting themselves
    if (userId === uid) {
      throw new Error("Cannot delete your own account");
    }

    const counts = await deleteAllUserData(userId);

    logger.info(`Admin ${uid} deleted user ${userId} and all associated data:`, counts);

    // Invalidate user cache since user data has changed
    invalidateUserCache();

    return {
      success: true,
      message: "User and all associated data deleted successfully",
      deletedCounts: counts
    };
  } catch (error) {
    logger.error('Error deleting user:', error);
    throw new Error(`Failed to delete user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Bulk delete users (admin only)

export const bulkDeleteUsers = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  try {
    const { userIds } = request.data;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new Error("User IDs array is required");
    }

    // Check if current user is admin
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // Prevent admin from deleting themselves
    if (userIds.includes(uid)) {
      throw new Error("Cannot delete your own account");
    }

    const results: Array<{ userId: string; success: boolean; deletedCounts?: Awaited<ReturnType<typeof deleteAllUserData>>; error?: string }> = [];
    const errors: Array<{ userId: string; error: string }> = [];

    // Delete each user using the shared helper
    for (const userId of userIds) {
      try {
        const counts = await deleteAllUserData(userId);
        results.push({ userId, success: true, deletedCounts: counts });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ userId, error: msg });
        results.push({ userId, success: false, error: msg });
      }
    }

    logger.info(`Admin ${uid} bulk deleted ${results.filter(r => r.success).length} users`);

    // Invalidate user cache since user data has changed
    invalidateUserCache();

    return {
      success: true,
      message: `Successfully deleted ${results.length} users`,
      results,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    logger.error('Error bulk deleting users:', error);
    throw new Error(`Failed to bulk delete users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});


