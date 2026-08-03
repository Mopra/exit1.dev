import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { usePlan } from './usePlan';

const functions = getFunctions();
const syncMyTierFn = httpsCallable(functions, 'syncMyTier');

/**
 * Ensures the Firestore tier cache matches the Clerk billing tier.
 *
 * Problem: Firestore caches the tier with a 2-hour TTL, but many Cloud Functions
 * (e.g. getEmailUsage) lack Clerk secrets and can never refresh it. This means
 * after a user subscribes, they can be stuck seeing free-tier quotas until a
 * function that HAS secrets happens to refresh the cache.
 *
 * Solution: The frontend knows the correct tier from Clerk. When the user is on
 * any paid tier, we proactively call syncMyTier to update Firestore. This runs
 * once per session as a background fire-and-forget call.
 */
export function useTierSync() {
  const { userId } = useAuth();
  const { paid, isLoading } = usePlan();
  const hasSynced = useRef(false);

  useEffect(() => {
    if (isLoading || !userId || hasSynced.current) return;

    // Sync on ANY paid tier, not just Nano-or-better — the most common mismatch
    // is Firestore stuck at 'free' after payment, and that hits Indie exactly as
    // hard. No need to sync free users.
    if (paid) {
      hasSynced.current = true;
      syncMyTierFn({}).catch(() => {
        // Best-effort — if it fails, the next page load will retry
      });
    }
  }, [userId, paid, isLoading]);
}
