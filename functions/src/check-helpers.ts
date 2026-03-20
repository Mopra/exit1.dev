/**
 * Shared helper utilities for check operations.
 * Used by both callable functions (checks.ts) and public API (public-api.ts).
 */
import * as crypto from "crypto";
import { firestore } from "./init";

// Sparse orderIndex gap - consistent with client-side for reduced Firestore writes
export const ORDER_INDEX_GAP = 1000;

export type CheckType = "website" | "rest_endpoint" | "tcp" | "udp" | "ping" | "websocket";

export const normalizeCheckType = (value: unknown): CheckType =>
  value === "rest_endpoint" || value === "tcp" || value === "udp" || value === "ping" || value === "websocket" ? value : "website";

export const getCanonicalUrlKey = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  const protocol = url.protocol.toLowerCase();
  let hostname = url.hostname.toLowerCase();
  hostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;

  let port = url.port;
  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    port = "";
  }

  let pathname = url.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  return `${protocol}//${hostname}${port ? `:${port}` : ""}${pathname}${url.search}`;
};

export const getCanonicalUrlKeySafe = (rawUrl: string): string | null => {
  try {
    return getCanonicalUrlKey(rawUrl);
  } catch {
    return null;
  }
};

// Generate a short hash for URL indexing (used for duplicate detection)
export const hashCanonicalUrl = (canonicalUrl: string): string => {
  return crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
};

// --- Firestore retry helper ---

export interface RetryOptions {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const retryWithBackoff = async <T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> => {
  let attempt = 0;
  let delay = options.initialDelayMs;

  while (attempt < options.attempts) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= options.attempts) {
        throw error;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, options.maxDelayMs);
    }
  }

  throw new Error("retryWithBackoff exhausted attempts");
};

const FIRESTORE_RETRY_OPTIONS: RetryOptions = {
  attempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 5_000,
};

export const withFirestoreRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  return retryWithBackoff(operation, FIRESTORE_RETRY_OPTIONS);
};

// --- User check stats for rate limiting ---

export interface UserCheckStats {
  checkCount: number;
  maxOrderIndex: number;
  lastCheckAddedAt: number;
  checksAddedLastMinute: number;
  checksAddedLastHour: number;
  checksAddedLastDay: number;
  lastMinuteWindowStart: number;
  lastHourWindowStart: number;
  lastDayWindowStart: number;
  // URL hash index for O(1) duplicate detection - maps hash -> checkId
  urlHashes?: Record<string, string>;
}

export const getUserCheckStats = async (uid: string): Promise<UserCheckStats | null> => {
  const doc = await firestore.collection("user_check_stats").doc(uid).get();
  if (!doc.exists) return null;
  return doc.data() as UserCheckStats;
};

export const initializeUserCheckStats = async (uid: string): Promise<UserCheckStats> => {
  const checksSnapshot = await firestore.collection("checks")
    .where("userId", "==", uid)
    .select("orderIndex", "createdAt", "url")
    .get();

  const now = Date.now();
  const oneMinuteAgo = now - (60 * 1000);
  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  let maxOrderIndex = 0;
  let checksLastMinute = 0;
  let checksLastHour = 0;
  let checksLastDay = 0;
  const urlHashes: Record<string, string> = {};

  checksSnapshot.docs.forEach(doc => {
    const data = doc.data();
    if (typeof data.orderIndex === 'number' && data.orderIndex > maxOrderIndex) {
      maxOrderIndex = data.orderIndex;
    }
    const createdAt = data.createdAt || 0;
    if (createdAt >= oneMinuteAgo) checksLastMinute++;
    if (createdAt >= oneHourAgo) checksLastHour++;
    if (createdAt >= oneDayAgo) checksLastDay++;

    if (data.url) {
      const canonical = getCanonicalUrlKeySafe(data.url);
      if (canonical) {
        const hash = hashCanonicalUrl(canonical);
        urlHashes[hash] = doc.id;
      }
    }
  });

  const stats: UserCheckStats = {
    checkCount: checksSnapshot.size,
    maxOrderIndex,
    lastCheckAddedAt: now,
    checksAddedLastMinute: checksLastMinute,
    checksAddedLastHour: checksLastHour,
    checksAddedLastDay: checksLastDay,
    lastMinuteWindowStart: Math.floor(now / 60000) * 60000,
    lastHourWindowStart: Math.floor(now / 3600000) * 3600000,
    lastDayWindowStart: Math.floor(now / 86400000) * 86400000,
    urlHashes,
  };

  await firestore.collection("user_check_stats").doc(uid).set(stats);
  return stats;
};

export const refreshRateLimitWindows = (stats: UserCheckStats, now: number): UserCheckStats => {
  const currentMinuteWindow = Math.floor(now / 60000) * 60000;
  const currentHourWindow = Math.floor(now / 3600000) * 3600000;
  const currentDayWindow = Math.floor(now / 86400000) * 86400000;

  if (currentMinuteWindow > stats.lastMinuteWindowStart) {
    stats.checksAddedLastMinute = 0;
    stats.lastMinuteWindowStart = currentMinuteWindow;
  }
  if (currentHourWindow > stats.lastHourWindowStart) {
    stats.checksAddedLastHour = 0;
    stats.lastHourWindowStart = currentHourWindow;
  }
  if (currentDayWindow > stats.lastDayWindowStart) {
    stats.checksAddedLastDay = 0;
    stats.lastDayWindowStart = currentDayWindow;
  }

  return stats;
};
