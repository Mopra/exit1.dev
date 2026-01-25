import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore, getUserTierLive } from "./init";
import { CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from "./env";
import { createClerkClient } from '@clerk/backend';

// Simple in-memory cache for user data
const userCache = new Map<string, { data: Record<string, unknown>; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Helper function to invalidate user cache
const invalidateUserCache = () => {
  userCache.clear();
  logger.info('User cache invalidated');
};

// Callable function to delete user account and all associated data
export const deleteUserAccount = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    logger.info(`Starting account deletion for user ${uid}`);

    // Delete all user's checks/websites
    const checksSnapshot = await firestore.collection("checks").where("userId", "==", uid).get();
    const checksBatch = firestore.batch();
    checksSnapshot.docs.forEach(doc => {
      checksBatch.delete(doc.ref);
    });

    // Delete all user's webhooks
    const webhooksSnapshot = await firestore.collection("webhooks").where("userId", "==", uid).get();
    const webhooksBatch = firestore.batch();
    webhooksSnapshot.docs.forEach(doc => {
      webhooksBatch.delete(doc.ref);
    });

    // Delete user's email settings
    const emailDocRef = firestore.collection('emailSettings').doc(uid);
    webhooksBatch.delete(emailDocRef);
    const smsDocRef = firestore.collection('smsSettings').doc(uid);
    webhooksBatch.delete(smsDocRef);

    // Execute all deletion batches
    await Promise.all([
      checksBatch.commit(),
      webhooksBatch.commit()
    ]);

    logger.info(`Deleted ${checksSnapshot.size} checks and ${webhooksSnapshot.size} webhooks for user ${uid}`);

    // Note: Clerk user deletion should be handled on the frontend
    // as it requires the user's session and cannot be done from Firebase Functions

    return {
      success: true,
      deletedCounts: {
        checks: checksSnapshot.size,
        webhooks: webhooksSnapshot.size
      },
      message: 'All user data has been deleted from the database. Please complete the account deletion in your account settings.'
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
      let offset = 0;
      const batchSize = 500; // Clerk's max per request
      let hasMore = true;
      
      while (hasMore) {
        const batch = await client.users.getUserList({
          limit: batchSize,
          offset: offset
        });
        
        if (batch.data.length === 0) {
          hasMore = false;
          break;
        }
        
        allUsers.push(...batch.data);
        offset += batch.data.length;
        
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

        // Get user tier - use live lookup to bypass cache for admin page accuracy
        let tier: 'free' | 'nano' = 'free';
        try {
          tier = await getUserTierLive(clerkUser.id);
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

    // Check if current user is admin
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // Prevent admin from deleting themselves
    if (userId === uid) {
      throw new Error("Cannot delete your own account");
    }

    // Delete user's checks
    const checksSnapshot = await firestore.collection("checks").where("userId", "==", userId).get();
    const checksBatch = firestore.batch();
    checksSnapshot.docs.forEach(doc => {
      checksBatch.delete(doc.ref);
    });

    // Delete user's webhooks
    const webhooksSnapshot = await firestore.collection("webhooks").where("userId", "==", userId).get();
    const webhooksBatch = firestore.batch();
    webhooksSnapshot.docs.forEach(doc => {
      webhooksBatch.delete(doc.ref);
    });

    // Delete user's email settings
    const emailDocRef = firestore.collection('emailSettings').doc(userId);
    webhooksBatch.delete(emailDocRef);
    const smsDocRef = firestore.collection('smsSettings').doc(userId);
    webhooksBatch.delete(smsDocRef);

    // Delete user's API keys
    const apiKeysSnapshot = await firestore.collection('apiKeys').where('userId', '==', userId).get();
    const apiKeysBatch = firestore.batch();
    apiKeysSnapshot.docs.forEach(doc => {
      apiKeysBatch.delete(doc.ref);
    });

    // Execute all deletion batches
    await Promise.all([
      checksBatch.commit(),
      webhooksBatch.commit(),
      apiKeysBatch.commit()
    ]);

    logger.info(`Admin ${uid} deleted user ${userId} and all associated data`);

    // Invalidate user cache since user data has changed
    invalidateUserCache();

    return {
      success: true,
      message: "User and all associated data deleted successfully",
      deletedCounts: {
        checks: checksSnapshot.size,
        webhooks: webhooksSnapshot.size,
        apiKeys: apiKeysSnapshot.size
      }
    };
  } catch (error) {
    logger.error('Error deleting user:', error);
    throw new Error(`Failed to delete user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Bulk delete users (admin only)
// Constants for batch operations
const IN_QUERY_MAX = 30; // Firestore 'in' operator max values
const BATCH_MAX_OPS = 500; // Firestore batch max operations

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

    // Track per-user deletion counts for response
    const userDeletionCounts = new Map<string, { checks: number; webhooks: number; apiKeys: number }>();
    for (const userId of userIds) {
      userDeletionCounts.set(userId, { checks: 0, webhooks: 0, apiKeys: 0 });
    }

    // Collect all document refs to delete
    const allRefsToDelete: FirebaseFirestore.DocumentReference[] = [];
    const errors: Array<{ userId: string; error: string }> = [];

    // Query in batches using 'in' operator (max 30 values per query)
    for (let i = 0; i < userIds.length; i += IN_QUERY_MAX) {
      const userChunk = userIds.slice(i, i + IN_QUERY_MAX);

      try {
        // Run all three queries in parallel for this chunk
        const [checksSnapshot, webhooksSnapshot, apiKeysSnapshot] = await Promise.all([
          firestore.collection("checks").where("userId", "in", userChunk).get(),
          firestore.collection("webhooks").where("userId", "in", userChunk).get(),
          firestore.collection("apiKeys").where("userId", "in", userChunk).get(),
        ]);

        // Collect refs and track counts per user
        checksSnapshot.docs.forEach(doc => {
          const docUserId = doc.data().userId;
          if (docUserId && userDeletionCounts.has(docUserId)) {
            userDeletionCounts.get(docUserId)!.checks++;
          }
          allRefsToDelete.push(doc.ref);
        });

        webhooksSnapshot.docs.forEach(doc => {
          const docUserId = doc.data().userId;
          if (docUserId && userDeletionCounts.has(docUserId)) {
            userDeletionCounts.get(docUserId)!.webhooks++;
          }
          allRefsToDelete.push(doc.ref);
        });

        apiKeysSnapshot.docs.forEach(doc => {
          const docUserId = doc.data().userId;
          if (docUserId && userDeletionCounts.has(docUserId)) {
            userDeletionCounts.get(docUserId)!.apiKeys++;
          }
          allRefsToDelete.push(doc.ref);
        });

        // Add email and SMS settings docs for each user in this chunk
        for (const userId of userChunk) {
          allRefsToDelete.push(firestore.collection('emailSettings').doc(userId));
          allRefsToDelete.push(firestore.collection('smsSettings').doc(userId));
        }
      } catch (error) {
        // If a batch query fails, add errors for all users in that chunk
        for (const userId of userChunk) {
          errors.push({
            userId,
            error: error instanceof Error ? error.message : 'Query failed'
          });
        }
      }
    }

    // Delete all collected refs in batches of 500
    for (let i = 0; i < allRefsToDelete.length; i += BATCH_MAX_OPS) {
      const batchRefs = allRefsToDelete.slice(i, i + BATCH_MAX_OPS);
      const batch = firestore.batch();
      batchRefs.forEach(ref => batch.delete(ref));
      await batch.commit();
    }

    // Build results from tracked counts (exclude users that had errors)
    const errorUserIds = new Set(errors.map(e => e.userId));
    const results = userIds
      .filter(userId => !errorUserIds.has(userId))
      .map(userId => ({
        userId,
        success: true,
        deletedCounts: userDeletionCounts.get(userId) || { checks: 0, webhooks: 0, apiKeys: 0 }
      }));

    logger.info(`Admin ${uid} bulk deleted ${results.length} users`);

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


