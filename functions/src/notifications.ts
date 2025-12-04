import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { createClerkClient } from '@clerk/backend';
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV } from "./env";

// Interface for notification
interface SystemNotification {
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  createdAt: number;
  active: boolean;
  createdBy: string;
  expiresAt?: number;
  updatedAt?: number;
}

// Helper function to sync admin status from Clerk to Firestore
async function syncAdminStatus(uid: string): Promise<boolean> {
  try {
    // First, check if we have a recent admin status in Firestore (cache for 1 hour)
    const userRef = firestore.collection('users').doc(uid);
    const userDoc = await userRef.get();
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      const updatedAt = userData?.updatedAt || 0;
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      
      // If we have cached admin status from within the last hour, use it
      if (updatedAt > oneHourAgo && typeof userData?.admin === 'boolean') {
        logger.info(`Using cached admin status for ${uid}: ${userData.admin}`);
        return userData.admin;
      }
    }

    // If no cache or cache is stale, fetch from Clerk
    let prodSecretKey: string | undefined;
    try {
      prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    } catch (secretError: unknown) {
      logger.error(`Error accessing CLERK_SECRET_KEY_PROD:`, secretError);
      // If we have cached data, use it even if stale
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') {
          logger.warn(`Using stale cached admin status for ${uid} due to secret access error: ${userData.admin}`);
          return userData.admin;
        }
      }
      throw new Error("Cannot access Clerk secret key");
    }
    
    if (!prodSecretKey) {
      logger.warn(`Cannot sync admin status for ${uid}: CLERK_SECRET_KEY_PROD not found`);
      // If we have cached data, use it even if stale
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') {
          logger.warn(`Using stale cached admin status for ${uid}: ${userData.admin}`);
          return userData.admin;
        }
      }
      return false;
    }

    // Try to get user from both prod and dev Clerk instances
    // The Firebase Auth UID should match the Clerk user ID, but we check both instances
    let clerkUser;
    
    // First try prod instance
    try {
      const prodClient = createClerkClient({ secretKey: prodSecretKey });
      clerkUser = await prodClient.users.getUser(uid);
      logger.info(`Found user ${uid} in Clerk prod instance`);
    } catch (prodError: unknown) {
      const error = prodError as { status?: number; errors?: Array<{ code?: string }> };
      logger.info(`User ${uid} not found in Clerk prod instance, trying dev...`);
      
      // If not found in prod, try dev instance
      if (error?.status === 404 || error?.errors?.[0]?.code === 'resource_not_found') {
        try {
          let devSecretKey: string | undefined;
          try {
            devSecretKey = CLERK_SECRET_KEY_DEV.value();
          } catch (secretError: unknown) {
            logger.warn(`Cannot access CLERK_SECRET_KEY_DEV:`, secretError);
          }
          
          if (devSecretKey) {
            const devClient = createClerkClient({ secretKey: devSecretKey });
            clerkUser = await devClient.users.getUser(uid);
            logger.info(`Found user ${uid} in Clerk dev instance`);
          } else {
            logger.warn(`CLERK_SECRET_KEY_DEV not available, cannot check dev instance`);
            // User not found in prod and can't check dev
            logger.warn(`User ${uid} not found in Clerk prod and dev check unavailable, assuming not admin`);
            await userRef.set({
              admin: false,
              updatedAt: Date.now()
            }, { merge: true });
            return false;
          }
        } catch (devError: unknown) {
          logger.error(`Failed to get Clerk user ${uid} from dev instance:`, devError);
          const devErr = devError as { status?: number; errors?: Array<{ code?: string }> };
          // If also 404 in dev, user doesn't exist
          if (devErr?.status === 404 || devErr?.errors?.[0]?.code === 'resource_not_found') {
            logger.warn(`User ${uid} not found in Clerk (checked both prod and dev), assuming not admin`);
            await userRef.set({
              admin: false,
              updatedAt: Date.now()
            }, { merge: true });
            return false;
          }
          // For other dev errors, if we have cached data, use it
          if (userDoc.exists) {
            const userData = userDoc.data();
            if (typeof userData?.admin === 'boolean') {
              logger.warn(`Clerk lookup failed in both instances, using cached admin status for ${uid}: ${userData.admin}`);
              return userData.admin;
            }
          }
          throw devError; // Re-throw other errors
        }
      } else {
        // For other errors, if we have cached data, use it
        if (userDoc.exists) {
          const userData = userDoc.data();
          if (typeof userData?.admin === 'boolean') {
            logger.warn(`Clerk lookup failed, using cached admin status for ${uid}: ${userData.admin}`);
            return userData.admin;
          }
        }
        throw prodError; // Re-throw other errors
      }
    }
    
    if (!clerkUser) {
      logger.warn(`User ${uid} not found in Clerk (checked both prod and dev), assuming not admin`);
      await userRef.set({
        admin: false,
        updatedAt: Date.now()
      }, { merge: true });
      return false;
    }
    
    const isAdmin = clerkUser.publicMetadata?.admin === true;

    // Update or create user document in Firestore
    await userRef.set({
      admin: isAdmin,
      updatedAt: Date.now()
    }, { merge: true });

    logger.info(`Synced admin status for ${uid}: ${isAdmin}`);
    return isAdmin;
  } catch (error: unknown) {
    logger.error(`Error syncing admin status for ${uid}:`, error);
    // Log more details for debugging
    const err = error as { message?: string; stack?: string };
    if (err?.message) {
      logger.error(`Error message: ${err.message}`);
    }
    if (err?.stack) {
      logger.error(`Error stack: ${err.stack}`);
    }
    // As a last resort, check if we have any cached data
    try {
      const userRef = firestore.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (typeof userData?.admin === 'boolean') {
          logger.warn(`Using cached admin status after error for ${uid}: ${userData.admin}`);
          return userData.admin;
        }
      }
    } catch (cacheError) {
      logger.error(`Failed to check cache after error:`, cacheError);
    }
    return false;
  }
}

// Create a system notification (admin only)
export const createSystemNotification = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  // Sync admin status to Firestore
  const isAdmin = await syncAdminStatus(uid);
  if (!isAdmin) {
    throw new Error("Admin access required");
  }

  try {
    const { title, message, type, expiresAt } = request.data;

    if (!title || !message || !type) {
      throw new Error("Missing required fields");
    }

    const notification: SystemNotification = {
      title,
      message,
      type,
      createdAt: Date.now(),
      active: true,
      createdBy: uid,
      ...(expiresAt ? { expiresAt } : {}),
    };

    const docRef = await firestore.collection('system_notifications').add(notification);
    
    logger.info(`System notification created by ${uid}: ${docRef.id}`);

    return {
      success: true,
      id: docRef.id
    };
  } catch (error) {
    logger.error("Error creating system notification:", error);
    throw new Error("Failed to create system notification");
  }
});

// Toggle notification status (admin only)
export const toggleSystemNotification = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  try {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new Error("Authentication required");
    }

    // Sync admin status to Firestore
    let isAdmin: boolean;
    try {
      isAdmin = await syncAdminStatus(uid);
    } catch (adminError: unknown) {
      logger.error(`Error checking admin status for ${uid}:`, adminError);
      // If admin check fails, deny access for security
      throw new Error("Admin verification failed");
    }
    
    if (!isAdmin) {
      logger.warn(`Toggle notification attempted by non-admin user: ${uid}`);
      throw new Error("Admin access required");
    }

    const { notificationId, active } = request.data;
    
    if (!notificationId || typeof active !== 'boolean') {
      throw new Error("Invalid arguments: notificationId and active (boolean) are required");
    }

    // Check if notification exists before updating
    const notificationRef = firestore.collection('system_notifications').doc(notificationId);
    const notificationDoc = await notificationRef.get();
    
    if (!notificationDoc.exists) {
      throw new Error("Notification not found");
    }

    await notificationRef.update({
      active,
      updatedAt: Date.now()
    });

    logger.info(`System notification ${notificationId} toggled to ${active} by ${uid}`);

    return { success: true };
  } catch (error: unknown) {
    const err = error as { message?: string };
    logger.error("Error toggling system notification:", error);
    // Re-throw if it's already a proper Error with message
    if (err?.message && error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to toggle system notification: ${err?.message || 'Unknown error'}`);
  }
});

// Delete notification (admin only)
export const deleteSystemNotification = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  try {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new Error("Authentication required");
    }

    // Sync admin status to Firestore
    let isAdmin: boolean;
    try {
      isAdmin = await syncAdminStatus(uid);
    } catch (adminError: unknown) {
      logger.error(`Error checking admin status for ${uid}:`, adminError);
      // If admin check fails, deny access for security
      throw new Error("Admin verification failed");
    }
    
    if (!isAdmin) {
      logger.warn(`Delete notification attempted by non-admin user: ${uid}`);
      throw new Error("Admin access required");
    }

    const { notificationId } = request.data;
    
    if (!notificationId) {
      throw new Error("Missing notification ID");
    }

    // Check if notification exists before deleting
    const notificationRef = firestore.collection('system_notifications').doc(notificationId);
    const notificationDoc = await notificationRef.get();
    
    if (!notificationDoc.exists) {
      throw new Error("Notification not found");
    }

    await notificationRef.delete();

    logger.info(`System notification ${notificationId} deleted by ${uid}`);

    return { success: true };
  } catch (error: unknown) {
    const err = error as { message?: string };
    logger.error("Error deleting system notification:", error);
    // Re-throw if it's already a proper Error with message
    if (err?.message && error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to delete notification: ${err?.message || 'Unknown error'}`);
  }
});

// Interface for user notification
interface UserNotification {
  userId: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  createdAt: number;
  read: boolean;
  readAt?: number;
  link?: string;
}

// Create a user notification (admin only, or system)
export const createUserNotification = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  // Sync admin status to Firestore
  const isAdmin = await syncAdminStatus(uid);
  if (!isAdmin) {
    throw new Error("Admin access required");
  }

  try {
    const { userId, title, message, type, link } = request.data;

    if (!userId || !title || !message || !type) {
      throw new Error("Missing required fields: userId, title, message, type");
    }

    const notification: UserNotification = {
      userId,
      title,
      message,
      type,
      createdAt: Date.now(),
      read: false,
      ...(link ? { link } : {}),
    };

    const docRef = await firestore.collection('user_notifications').add(notification);
    
    logger.info(`User notification created by ${uid} for user ${userId}: ${docRef.id}`);

    return {
      success: true,
      id: docRef.id
    };
  } catch (error) {
    logger.error("Error creating user notification:", error);
    throw new Error("Failed to create user notification");
  }
});

// Mark notification as read or unread
export const markNotificationAsRead = onCall({
  cors: true,
  maxInstances: 1,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    const { notificationId, read } = request.data;
    
    if (!notificationId) {
      throw new Error("Missing notification ID");
    }

    const readStatus = read !== undefined ? read : true; // Default to true for backward compatibility

    const notificationRef = firestore.collection('user_notifications').doc(notificationId);
    const notificationDoc = await notificationRef.get();
    
    if (!notificationDoc.exists) {
      throw new Error("Notification not found");
    }

    const notificationData = notificationDoc.data() as UserNotification;
    
    // Ensure user can only mark their own notifications as read/unread
    if (notificationData.userId !== uid) {
      throw new Error("Unauthorized: Cannot modify another user's notification");
    }

    const updateData: { read: boolean; readAt?: number } = {
      read: readStatus
    };

    if (readStatus) {
      updateData.readAt = Date.now();
    } else {
      // When marking as unread, we can keep the readAt timestamp or remove it
      // Keeping it for history purposes
    }

    await notificationRef.update(updateData);

    logger.info(`Notification ${notificationId} marked as ${readStatus ? 'read' : 'unread'} by ${uid}`);

    return { success: true };
  } catch (error: unknown) {
    const err = error as { message?: string };
    logger.error("Error marking notification as read/unread:", error);
    if (err?.message && error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to mark notification: ${err?.message || 'Unknown error'}`);
  }
});

// Mark all notifications as read for a user
export const markAllNotificationsAsRead = onCall({
  cors: true,
  maxInstances: 1,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    const unreadNotifications = await firestore
      .collection('user_notifications')
      .where('userId', '==', uid)
      .where('read', '==', false)
      .get();

    const batch = firestore.batch();
    const now = Date.now();

    unreadNotifications.docs.forEach(doc => {
      batch.update(doc.ref, {
        read: true,
        readAt: now
      });
    });

    await batch.commit();

    logger.info(`Marked ${unreadNotifications.docs.length} notifications as read for ${uid}`);

    return { 
      success: true,
      count: unreadNotifications.docs.length
    };
  } catch (error: unknown) {
    const err = error as { message?: string };
    logger.error("Error marking all notifications as read:", error);
    throw new Error(`Failed to mark all notifications as read: ${err?.message || 'Unknown error'}`);
  }
});

// Delete a user notification
export const deleteUserNotification = onCall({
  cors: true,
  maxInstances: 1,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    const { notificationId } = request.data;
    
    if (!notificationId) {
      throw new Error("Missing notification ID");
    }

    const notificationRef = firestore.collection('user_notifications').doc(notificationId);
    const notificationDoc = await notificationRef.get();
    
    if (!notificationDoc.exists) {
      throw new Error("Notification not found");
    }

    const notificationData = notificationDoc.data() as UserNotification;
    
    // Ensure user can only delete their own notifications
    if (notificationData.userId !== uid) {
      throw new Error("Unauthorized: Cannot delete another user's notification");
    }

    await notificationRef.delete();

    logger.info(`Notification ${notificationId} deleted by ${uid}`);

    return { success: true };
  } catch (error: unknown) {
    const err = error as { message?: string };
    logger.error("Error deleting user notification:", error);
    if (err?.message && error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to delete notification: ${err?.message || 'Unknown error'}`);
  }
});

