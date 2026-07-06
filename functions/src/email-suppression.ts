// ============================================================================
// EMAIL SUPPRESSION STORE (Firestore: emailSuppressions)
//
// Durable per-address bounce state, written by the Resend webhook and read at
// send time by every alert-email sender. This module is imported by
// alert-email.ts which also runs inside the VPS runner, so it must stay free
// of Cloud Function definitions (onCall/onRequest live in email.ts and
// resend-webhook.ts).
// ============================================================================

import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import {
  applyBounceEvent,
  isSuppressed,
  normalizeEmail,
  type BounceKind,
  type BounceTransition,
  type EmailSuppressionState,
} from "./email-suppression-policy";

const COLLECTION = "emailSuppressions";

// Firestore doc IDs cannot contain '/', so encode the normalized address.
export const suppressionDocId = (email: string): string =>
  encodeURIComponent(normalizeEmail(email));

const suppressionDoc = (email: string) =>
  firestore.collection(COLLECTION).doc(suppressionDocId(email));

// ----------------------------------------------------------------------------
// Send-time cache. Alert storms hit the same recipient repeatedly, so cache
// both suppressed and clear verdicts briefly. TTL is short enough that a
// freshly-recorded bounce takes effect within minutes on every instance.
// ----------------------------------------------------------------------------

const SUPPRESSION_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  state: EmailSuppressionState | null;
  expiresAt: number;
}

const suppressionCache = new Map<string, CacheEntry>();

export const clearSuppressionCacheForTests = (): void => {
  suppressionCache.clear();
};

/**
 * True if alert emails to this address should be skipped right now.
 * Fails open: a Firestore read error never blocks an alert.
 */
export const isEmailSuppressedCached = async (email: string): Promise<boolean> => {
  const key = normalizeEmail(email);
  const now = Date.now();

  const cached = suppressionCache.get(key);
  if (cached && cached.expiresAt > now) {
    return isSuppressed(cached.state, now);
  }

  try {
    const snap = await suppressionDoc(key).get();
    const state = snap.exists ? (snap.data() as EmailSuppressionState) : null;
    suppressionCache.set(key, { state, expiresAt: now + SUPPRESSION_CACHE_TTL_MS });
    return isSuppressed(state, now);
  } catch (error) {
    logger.warn("Email suppression lookup failed — sending anyway", {
      email: key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

// ----------------------------------------------------------------------------
// Webhook-side writes
// ----------------------------------------------------------------------------

/**
 * Apply a bounce/complaint event to the address's durable state.
 * Transactional so concurrent webhook deliveries can't lose counts.
 */
export const recordEmailBounce = async (
  email: string,
  kind: BounceKind,
  reason?: string | null,
  at?: number
): Promise<BounceTransition> => {
  const key = normalizeEmail(email);
  const now = at ?? Date.now();
  const docRef = suppressionDoc(key);

  const transition = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const prev = snap.exists ? (snap.data() as EmailSuppressionState) : null;
    const result = applyBounceEvent(prev, key, kind, now, reason);
    tx.set(docRef, result.state);
    return result;
  });

  // Keep this instance's send-time cache coherent immediately.
  suppressionCache.set(key, {
    state: transition.state,
    expiresAt: Date.now() + SUPPRESSION_CACHE_TTL_MS,
  });

  return transition;
};

/**
 * Manual resume from the Emails settings page: wipe the address's state so
 * sends flow again (a fresh bounce will re-suppress it).
 */
export const clearEmailSuppression = async (email: string): Promise<void> => {
  const key = normalizeEmail(email);
  await suppressionDoc(key).delete();
  suppressionCache.delete(key);
};

/**
 * Batch lookup for the settings UI. Returns only addresses that are
 * currently suppressed.
 */
export const getActiveSuppressions = async (
  emails: string[]
): Promise<EmailSuppressionState[]> => {
  const keys = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (keys.length === 0) return [];

  const refs = keys.map((k) => suppressionDoc(k));
  const snaps = await firestore.getAll(...refs);
  const now = Date.now();

  return snaps
    .filter((s) => s.exists)
    .map((s) => s.data() as EmailSuppressionState)
    .filter((state) => isSuppressed(state, now));
};
