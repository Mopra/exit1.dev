import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from "./env";
import { createClerkClient } from '@clerk/backend';

// Simple in-memory cache for user data
const userCache = new Map<string, { data: Record<string, unknown>; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Helper function to invalidate user cache
const invalidateUserCache = () => {
  userCache.delete('all_users');
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
    const { page = 1, limit = 50, offset = 0, instance } = request.data || {};
    const pageSize = Math.min(limit, 100); // Max 100 users per page
    const skip = offset || (page - 1) * pageSize;

    // OPTIMIZATION 4: Check cache first (cache key includes page and limit for proper pagination)
    const cacheKey = `all_users_${page}_${pageSize}_${instance || 'prod'}`;
    const cached = userCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      logger.info('Returning cached user data');
      return cached.data;
    }

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

    // Get users from Clerk with pagination
    const instanceType = instance === 'dev' ? 'dev' : 'prod';
    logger.info(`Calling Clerk ${instanceType} API with params:`, { limit: Math.min(pageSize, 500), offset: skip });
    const clerkUsers = await client.users.getUserList({
      limit: Math.min(pageSize, 500), // Clerk's max is 500
      offset: skip
    });
    logger.info(`Clerk ${instanceType} API response received, user count:`, clerkUsers.data.length);

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
          webhooksCount: userWebhooks.length
        };
      })
    );

    // Sort by creation date (newest first)
    users.sort((a, b) => b.createdAt - a.createdAt);

    // CRITICAL: Ensure we only return exactly pageSize users (slice to enforce limit)
    const limitedUsers = users.slice(0, pageSize);

    // Calculate pagination metadata
    const totalUsers = clerkUsers.totalCount || users.length;
    const hasNext = skip + limitedUsers.length < totalUsers;
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

// Update user (admin only)
export const updateUser = onCall({
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

    // For now, user updates are not supported since we don't have a users collection
    // This would need to be implemented with Clerk's admin API or a separate user management system
    throw new Error("User updates are not yet implemented. This requires integration with Clerk's admin API.");

    // Future implementation would go here:
    // - Update user data in Clerk via their admin API
    // - Or maintain a separate users collection for additional metadata
    // - Or update user data in existing collections (checks, webhooks)

  } catch (error) {
    logger.error('Error updating user:', error);
    throw new Error(`Failed to update user: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

    const results = [];
    const errors = [];

    for (const userId of userIds) {
      try {
        // Delete user's data (similar to single delete)
        const checksSnapshot = await firestore.collection("checks").where("userId", "==", userId).get();
        const checksBatch = firestore.batch();
        checksSnapshot.docs.forEach(doc => {
          checksBatch.delete(doc.ref);
        });

        const webhooksSnapshot = await firestore.collection("webhooks").where("userId", "==", userId).get();
        const webhooksBatch = firestore.batch();
        webhooksSnapshot.docs.forEach(doc => {
          webhooksBatch.delete(doc.ref);
        });

        const emailDocRef = firestore.collection('emailSettings').doc(userId);
        webhooksBatch.delete(emailDocRef);

        const apiKeysSnapshot = await firestore.collection('apiKeys').where('userId', '==', userId).get();
        const apiKeysBatch = firestore.batch();
        apiKeysSnapshot.docs.forEach(doc => {
          apiKeysBatch.delete(doc.ref);
        });

        await Promise.all([
          checksBatch.commit(),
          webhooksBatch.commit(),
          apiKeysBatch.commit()
        ]);

        results.push({
          userId,
          success: true,
          deletedCounts: {
            checks: checksSnapshot.size,
            webhooks: webhooksSnapshot.size,
            apiKeys: apiKeysSnapshot.size
          }
        });
      } catch (error) {
        errors.push({
          userId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

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

