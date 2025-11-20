import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

export const getSystemStatus = onCall(async () => {
  try {
    logger.info("Getting system status", { structuredData: true });

    // Single query to get recent errors
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const errorsSnapshot = await firestore
      .collection("checks")
      .where("lastError", "!=", null)
      .where("lastChecked", ">", oneDayAgo)
      .orderBy("lastChecked", "desc")
      .limit(10)
      .get();

    const recentErrors = errorsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        website: data.url || 'Unknown',
        error: data.lastError,
        timestamp: data.lastChecked,
        status: data.status
      };
    });

    // Get system uptime and performance metrics
    const systemInfo = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: Date.now(),
      version: process.version,
      platform: process.platform
    };

    return {
      success: true,
      data: {
        recentErrors,
        systemInfo,
        services: {
          firestore: true, // If we got here, Firestore is working
          functions: true, // If we got here, Functions is working
        }
      }
    };
  } catch (error) {
    logger.error("Error getting system status:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      data: {
        recentErrors: [],
        systemInfo: null,
        services: {
          firestore: false,
          functions: false,
        }
      }
    };
  }
});

