import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";

const MANUAL_LOG_MESSAGE_MAX = 2000;
const MANUAL_LOG_LIMIT = 500;
const ALLOWED_STATUSES = new Set(["online", "offline", "unknown", "disabled"]);

async function assertWebsiteOwnership(uid: string, websiteId: string): Promise<void> {
  const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
  if (!websiteDoc.exists) {
    throw new HttpsError("not-found", "Website not found");
  }

  const websiteData = websiteDoc.data() as Website | undefined;
  if (!websiteData) {
    logger.error(`Website document exists but data is null for ${websiteId}`);
    throw new HttpsError("not-found", "Website data not found");
  }

  if (websiteData.userId !== uid) {
    throw new HttpsError("permission-denied", "Access denied");
  }
}

function normalizeMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeStatus(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  if (!ALLOWED_STATUSES.has(trimmed)) return "unknown";
  return trimmed;
}

function normalizeTimestamp(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return Date.now();
}

export const getManualLogs = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, startDate, endDate, limit } = request.data || {};
  if (!websiteId) {
    throw new HttpsError("invalid-argument", "Website ID is required");
  }

  await assertWebsiteOwnership(uid, String(websiteId));

  const start = Number.isFinite(startDate) ? Number(startDate) : undefined;
  const end = Number.isFinite(endDate) ? Number(endDate) : undefined;
  if (typeof start === "number" && typeof end === "number" && end < start) {
    throw new HttpsError("invalid-argument", "End date must be after start date");
  }

  const cappedLimit = Math.min(Number(limit) || MANUAL_LOG_LIMIT, MANUAL_LOG_LIMIT);

  try {
    let query = firestore
      .collection("users")
      .doc(uid)
      .collection("manualLogs")
      .where("websiteId", "==", String(websiteId));

    if (typeof start === "number") {
      query = query.where("timestamp", ">=", start);
    }
    if (typeof end === "number") {
      query = query.where("timestamp", "<=", end);
    }

    const snapshot = await query
      .orderBy("timestamp", "desc")
      .limit(cappedLimit)
      .get();

    const logs = snapshot.docs.map((doc) => {
      const data = doc.data() as {
        websiteId: string;
        message: string;
        status?: string;
        timestamp: number;
        createdAt: number;
        updatedAt: number;
      };
      return {
        id: doc.id,
        websiteId: data.websiteId,
        message: data.message,
        status: data.status || "unknown",
        timestamp: data.timestamp,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    });

    return { success: true, data: logs };
  } catch (error) {
    logger.error("Failed to load manual logs:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to load manual logs");
  }
});

export const addManualLog = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, message, timestamp, status } = request.data || {};
  if (!websiteId) {
    throw new HttpsError("invalid-argument", "Website ID is required");
  }

  const trimmed = normalizeMessage(message);
  if (!trimmed) {
    throw new HttpsError("invalid-argument", "Message is required");
  }
  if (trimmed.length > MANUAL_LOG_MESSAGE_MAX) {
    throw new HttpsError(
      "invalid-argument",
      `Message must be ${MANUAL_LOG_MESSAGE_MAX} characters or fewer`
    );
  }

  await assertWebsiteOwnership(uid, String(websiteId));

  try {
    const now = Date.now();
    const logTimestamp = normalizeTimestamp(timestamp);
    const normalizedStatus = normalizeStatus(status);
    const logsRef = firestore.collection("users").doc(uid).collection("manualLogs");
    const docRef = logsRef.doc();
    const payload = {
      userId: uid,
      websiteId: String(websiteId),
      message: trimmed,
      status: normalizedStatus,
      timestamp: logTimestamp,
      createdAt: now,
      updatedAt: now,
    };
    await docRef.set(payload);

    return {
      success: true,
      data: {
        id: docRef.id,
        websiteId: payload.websiteId,
        message: payload.message,
        status: payload.status,
        timestamp: payload.timestamp,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      },
    };
  } catch (error) {
    logger.error("Failed to add manual log:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to add manual log");
  }
});
