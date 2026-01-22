import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";

const NOTE_MESSAGE_MAX = 2000;

const getLogKey = (websiteId: string, logId: string) => `${websiteId}:${logId}`;

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

export const getLogNotes = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, logId } = request.data || {};
  if (!websiteId || !logId) {
    throw new HttpsError("invalid-argument", "Website ID and log ID are required");
  }

  await assertWebsiteOwnership(uid, websiteId);

  try {
    const logKey = getLogKey(String(websiteId), String(logId));
    const notesRef = firestore.collection("users").doc(uid).collection("logNotes");
    const snapshot = await notesRef.where("logKey", "==", logKey).get();
    const notes = snapshot.docs.map((doc) => {
      const data = doc.data() as {
        logId: string;
        websiteId: string;
        message: string;
        createdAt: number;
        updatedAt: number;
      };
      return {
        id: doc.id,
        logId: data.logId,
        websiteId: data.websiteId,
        message: data.message,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    }).sort((a, b) => b.createdAt - a.createdAt);

    return { success: true, data: notes };
  } catch (error) {
    logger.error("Failed to load log notes:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to load log notes");
  }
});

export const addLogNote = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, logId, message } = request.data || {};
  if (!websiteId || !logId) {
    throw new HttpsError("invalid-argument", "Website ID and log ID are required");
  }

  const trimmed = normalizeMessage(message);
  if (!trimmed) {
    throw new HttpsError("invalid-argument", "Message is required");
  }
  if (trimmed.length > NOTE_MESSAGE_MAX) {
    throw new HttpsError("invalid-argument", `Message must be ${NOTE_MESSAGE_MAX} characters or fewer`);
  }

  await assertWebsiteOwnership(uid, websiteId);

  try {
    const now = Date.now();
    const logKey = getLogKey(String(websiteId), String(logId));
    const notesRef = firestore.collection("users").doc(uid).collection("logNotes");
    const docRef = notesRef.doc();
    const payload = {
      userId: uid,
      websiteId: String(websiteId),
      logId: String(logId),
      logKey,
      message: trimmed,
      createdAt: now,
      updatedAt: now,
    };
    await docRef.set(payload);

    return {
      success: true,
      data: {
        id: docRef.id,
        logId: payload.logId,
        websiteId: payload.websiteId,
        message: payload.message,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      }
    };
  } catch (error) {
    logger.error("Failed to add log note:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to add log note");
  }
});

export const updateLogNote = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, logId, noteId, message } = request.data || {};
  if (!websiteId || !logId || !noteId) {
    throw new HttpsError("invalid-argument", "Website ID, log ID, and note ID are required");
  }

  const trimmed = normalizeMessage(message);
  if (!trimmed) {
    throw new HttpsError("invalid-argument", "Message is required");
  }
  if (trimmed.length > NOTE_MESSAGE_MAX) {
    throw new HttpsError("invalid-argument", `Message must be ${NOTE_MESSAGE_MAX} characters or fewer`);
  }

  await assertWebsiteOwnership(uid, websiteId);

  try {
    const logKey = getLogKey(String(websiteId), String(logId));
    const notesRef = firestore.collection("users").doc(uid).collection("logNotes");
    const docRef = notesRef.doc(String(noteId));
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Log note not found");
    }

    const data = snapshot.data() as {
      userId: string;
      websiteId: string;
      logId: string;
      logKey: string;
      createdAt: number;
      updatedAt: number;
    };
    if (data.userId !== uid || data.logKey !== logKey) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    const updatedAt = Date.now();
    await docRef.update({ message: trimmed, updatedAt });

    return {
      success: true,
      data: {
        id: docRef.id,
        logId: data.logId,
        websiteId: data.websiteId,
        message: trimmed,
        createdAt: data.createdAt,
        updatedAt,
      }
    };
  } catch (error) {
    logger.error("Failed to update log note:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to update log note");
  }
});

export const deleteLogNote = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const { websiteId, logId, noteId } = request.data || {};
  if (!websiteId || !logId || !noteId) {
    throw new HttpsError("invalid-argument", "Website ID, log ID, and note ID are required");
  }

  await assertWebsiteOwnership(uid, websiteId);

  try {
    const logKey = getLogKey(String(websiteId), String(logId));
    const notesRef = firestore.collection("users").doc(uid).collection("logNotes");
    const docRef = notesRef.doc(String(noteId));
    const snapshot = await docRef.get();
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Log note not found");
    }

    const data = snapshot.data() as { userId: string; logKey: string };
    if (data.userId !== uid || data.logKey !== logKey) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    await docRef.delete();
    return { success: true };
  } catch (error) {
    logger.error("Failed to delete log note:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Failed to delete log note");
  }
});
