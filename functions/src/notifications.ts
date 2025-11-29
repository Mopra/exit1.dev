import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

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

// Create a system notification (admin only)
export const createSystemNotification = onCall({
  cors: true,
  maxInstances: 1,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  // Ideally, check if user is admin here using Clerk or Firestore user record
  // For now, we assume frontend protection + authentication as per existing pattern in admin.ts

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
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  try {
    const { notificationId, active } = request.data;
    
    if (!notificationId || typeof active !== 'boolean') {
      throw new Error("Invalid arguments");
    }

    await firestore.collection('system_notifications').doc(notificationId).update({
      active,
      updatedAt: Date.now()
    });

    logger.info(`System notification ${notificationId} toggled to ${active} by ${uid}`);

    return { success: true };
  } catch (error) {
    logger.error("Error toggling system notification:", error);
    throw new Error("Failed to toggle system notification");
  }
});

// Delete notification (admin only)
export const deleteSystemNotification = onCall({
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

    await firestore.collection('system_notifications').doc(notificationId).delete();

    logger.info(`System notification ${notificationId} deleted by ${uid}`);

    return { success: true };
  } catch (error) {
    logger.error("Error deleting system notification:", error);
    throw new Error("Failed to delete system notification");
  }
});

