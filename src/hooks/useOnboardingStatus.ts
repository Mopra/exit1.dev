import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@clerk/clerk-react';
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

async function hydrate(userId: string) {
  try {
    const res = await apiClient.getOnboardingStatus();
    if (currentUserId !== userId) return;
    const completed = res.success && res.data ? res.data.completed : readCache(userId);
    writeCache(userId, completed);
    setSnapshot({ hydrated: true, completed });
  } catch {
    if (currentUserId !== userId) return;
    setSnapshot({ hydrated: true, completed: readCache(userId) });
  }
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
  const state = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn || !userId) {
      currentUserId = null;
      setSnapshot({ hydrated: false, completed: false });
      return;
    }
    if (currentUserId !== userId) {
      currentUserId = userId;
      // Seed with per-user cache optimistically but mark unhydrated so
      // consumers can gate redirects on the server fetch if they care.
      setSnapshot({ hydrated: false, completed: readCache(userId) });
      void hydrate(userId);
    }
  }, [isLoaded, isSignedIn, userId]);

  return state;
}
