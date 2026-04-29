import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAuthReady } from '../AuthReadyProvider';
import { auth } from '../firebase';
import { apiClient } from '@/api/client';

const CACHE_PREFIX = 'exit1_onboarding_complete_v2:';
const LEGACY_CACHE_KEY = 'exit1_onboarding_complete_v2';

// One-time migration: the pre-per-user global key leaked between accounts on
// shared devices. Drop it so we never read it again.
try {
  localStorage.removeItem(LEGACY_CACHE_KEY);
} catch {
  // ignore
}

function cacheKey(userId: string) {
  return `${CACHE_PREFIX}${userId}`;
}

function readCache(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(cacheKey(userId)) === 'true';
  } catch {
    return false;
  }
}

function writeCache(userId: string, completed: boolean) {
  try {
    if (completed) localStorage.setItem(cacheKey(userId), 'true');
    else localStorage.removeItem(cacheKey(userId));
  } catch {
    // ignore
  }
}

type Snapshot = { hydrated: boolean; completed: boolean };

const listeners = new Set<() => void>();
let snapshot: Snapshot = { hydrated: false, completed: false };
let currentUserId: string | null = null;

function notify() {
  for (const l of listeners) l();
}

function setSnapshot(next: Snapshot) {
  if (next.hydrated === snapshot.hydrated && next.completed === snapshot.completed) return;
  snapshot = next;
  notify();
}

export function isOnboardingCompleteFor(userId: string | null | undefined): boolean {
  return readCache(userId);
}

export function markOnboardingCompleteLocally(userId: string) {
  writeCache(userId, true);
  if (currentUserId === userId) {
    setSnapshot({ hydrated: true, completed: true });
  }
}

// Auth handlers run before `useAuth().userId` updates, so they can't consult
// the per-user cache synchronously. Route every post-auth redirect through
// /onboarding; the page hydrates server state and forwards to `next` (or
// /checks) if the user is already onboarded.
export function resolvePostAuthDestination(from?: string | null): string {
  if (!from) return '/onboarding';
  return `/onboarding?next=${encodeURIComponent(from)}`;
}

// Retry the server hydration aggressively before falling back to the per-user
// cache. On a fresh browser the cache is empty, so a single transient failure
// (cold start, token refresh, flaky network) used to drop the user straight
// into the onboarding flow even though their server-side marker was set. We
// burn ~16s of bounded retries first; if everything still fails we surface
// the cache so the page is at least interactive instead of stuck on a spinner.
async function hydrate(userId: string) {
  // For returning users with a cached Firebase session, the SDK may need to
  // refresh the ID token from the server before callables will accept it.
  // Awaiting getIdToken() here forces that refresh to complete first so the
  // first callable attempt doesn't hit a 401 from a stale/unvalidated token.
  try {
    await auth.currentUser?.getIdToken();
  } catch {
    // If the pre-warm itself fails we still proceed — the retry loop below
    // will handle it and surface a proper error if things stay broken.
  }
  if (currentUserId !== userId) return;

  const MAX_ATTEMPTS = 6;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delayMs = 125 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (currentUserId !== userId) return;
    }

    let res: Awaited<ReturnType<typeof apiClient.getOnboardingStatus>>;
    try {
      res = await apiClient.getOnboardingStatus();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (currentUserId !== userId) return;
      continue;
    }
    if (currentUserId !== userId) return;

    if (res.success && res.data) {
      const completed = res.data.completed;
      writeCache(userId, completed);
      setSnapshot({ hydrated: true, completed });
      return;
    }
    lastError = res.error ?? 'getOnboardingStatus returned success: false';
  }

  console.warn('[onboarding] hydration failed after retries, falling back to cache', lastError);
  if (currentUserId !== userId) return;
  setSnapshot({ hydrated: true, completed: readCache(userId) });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

export function useOnboardingStatus() {
  const { isSignedIn, isLoaded, userId } = useAuth();
  // Firebase callable functions require Firebase auth, which is synced from
  // Clerk asynchronously by AuthReadyProvider. Without this gate, hydrate()
  // fires before the Firebase custom token is set → 401 → retries exhaust →
  // falls back to empty cache → onboarding shows again incorrectly.
  const authReady = useAuthReady();
  const state = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!isLoaded || !authReady) return;
    if (!isSignedIn || !userId) {
      currentUserId = null;
      setSnapshot({ hydrated: false, completed: false });
      return;
    }
    if (currentUserId !== userId) {
      currentUserId = userId;
      setSnapshot({ hydrated: false, completed: readCache(userId) });
      void hydrate(userId);
    }
  }, [isLoaded, isSignedIn, userId, authReady]);

  return state;
}
