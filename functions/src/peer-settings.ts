// Phase 2 multi-region peer confirmation: feature-flag accessor.
//
// Single source of truth: system_settings/peer_confirmation.enabled.
// Runner-side caching with PEER_SETTINGS_CACHE_TTL_MS so each probe doesn't
// hit Firestore. Mirrors the deploy_mode pattern.
//
// Rollback shape: flipping the flag to false in Firestore makes processOneCheck
// stop calling the peer within ~one cache TTL. The /admin/refresh-flags
// endpoint on the runner exists for emergencies where waiting out the TTL
// is unacceptable.
//
// Fail-open semantics: if Firestore read fails, we keep using the last good
// value rather than erroring. If we have no last-good value, we default to
// false (peer-confirmation off) — same effect as the flag being unset, which
// is the safer state because it preserves today's temporal-only logic.

import { logger } from 'firebase-functions/v2';
import { firestore } from './init.js';
import { CONFIG } from './config.js';

export interface PeerSettings {
  enabled: boolean;
  checkedAt: number; // when *we* last refreshed from Firestore
}

const PEER_SETTINGS_DOC = 'system_settings/peer_confirmation';

let cached: PeerSettings | null = null;
let inFlight: Promise<PeerSettings> | null = null;
// Bumped on every cache invalidation. Any in-flight fetch that started
// before the bump must NOT write its (now-stale) result to `cached`.
let invalidationGeneration = 0;

async function fetchPeerSettings(): Promise<PeerSettings> {
  try {
    const doc = await firestore.doc(PEER_SETTINGS_DOC).get();
    const data = doc.exists ? doc.data() : null;
    return {
      enabled: data?.enabled === true,
      checkedAt: Date.now(),
    };
  } catch (err) {
    logger.debug(`[peer-settings] Firestore read failed: ${String(err)}`);
    // Fail-open to last cached value, or { enabled: false } if none.
    return cached ?? { enabled: false, checkedAt: Date.now() };
  }
}

export async function getPeerSettings(): Promise<PeerSettings> {
  const now = Date.now();
  if (cached && now - cached.checkedAt < CONFIG.PEER_SETTINGS_CACHE_TTL_MS) {
    return cached;
  }
  // Coalesce concurrent refreshes — without this, a burst of 200 in-flight
  // probes after the TTL expires would each fire a Firestore read.
  if (inFlight) return inFlight;
  const startedAtGen = invalidationGeneration;
  inFlight = fetchPeerSettings()
    .then((next) => {
      // Drop the result if invalidate*() ran between fetch start and now —
      // the read may have observed pre-invalidation state, so caching it
      // would defeat the cache-bust.
      if (startedAtGen !== invalidationGeneration) {
        return next;
      }
      const wasEnabled = cached?.enabled === true;
      cached = next;
      if (wasEnabled !== next.enabled) {
        logger.info(`[peer-settings] enabled: ${wasEnabled} -> ${next.enabled}`);
      }
      return next;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// Force the next getPeerSettings() to bypass the cache. Used by the runner's
// /admin/refresh-flags endpoint for emergency rollback without waiting out
// the 30s TTL.
//
// Bumps the generation counter so any in-flight fetch (which may have read
// pre-invalidation state) drops its result instead of repopulating `cached`.
export function invalidatePeerSettingsCache(): void {
  cached = null;
  invalidationGeneration++;
}

// Snapshot for /health surfacing. Returns last cached value without
// triggering a refresh.
export function peekPeerSettings(): PeerSettings | null {
  return cached;
}
