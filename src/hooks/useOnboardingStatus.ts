import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { apiClient } from '@/api/client';

const ONBOARDING_COMPLETE_KEY = 'exit1_onboarding_complete_v2';

type Snapshot = { hydrated: boolean; completed: boolean };

const listeners = new Set<() => void>();
let snapshot: Snapshot = {
  hydrated: false,
  completed: localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true',
};
let inFlight: Promise<void> | null = null;

function notify() {
  for (const l of listeners) l();
}

function setSnapshot(next: Snapshot) {
  if (next.hydrated === snapshot.hydrated && next.completed === snapshot.completed) return;
  snapshot = next;
  notify();
}

export function markOnboardingCompleteLocally() {
  localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
  setSnapshot({ hydrated: true, completed: true });
}

async function hydrate() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await apiClient.getOnboardingStatus();
      const completed = res.success && res.data ? res.data.completed : snapshot.completed;
      if (completed) localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
      else localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
      setSnapshot({ hydrated: true, completed });
    } catch {
      setSnapshot({ hydrated: true, completed: snapshot.completed });
    }
  })();
  return inFlight;
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
  const { isSignedIn, isLoaded } = useAuth();
  const state = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      // Reset hydration so the next signed-in user re-fetches from the server,
      // but keep the localStorage cache as a best-effort fallback.
      inFlight = null;
      setSnapshot({ hydrated: false, completed: snapshot.completed });
      return;
    }
    if (!snapshot.hydrated) {
      void hydrate();
    }
  }, [isLoaded, isSignedIn]);

  return state;
}
