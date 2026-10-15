import { useSyncExternalStore } from "react";
import { useUser } from "@clerk/clerk-react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/firebase";
import { useAuthReady } from "@/AuthReadyProvider";

/**
 * The reverse trial: every new account gets Nano for 7 days with no card, then
 * drops to Free. It lives on `users/{uid}` (reverseTrialEndsAt and friends),
 * not in Clerk, so `useSubscription()` cannot see it. The backend
 * (functions/src/reverse-trial-policy.ts) is authoritative; this mirrors it so
 * the app shows Nano and the banner while the trial runs.
 */
export interface ReverseTrialInfo {
  /** True while the account is inside its trial week and has not subscribed. */
  active: boolean;
  /** End of the trial in ms, or null when the account never had one. */
  endsAt: number | null;
  /** Whole days left, rounded up. 0 when not active. */
  daysLeft: number;
  /** True for any account that has had a trial, running or over. */
  hadTrial: boolean;
}

type Fields = {
  startedAt: number;
  endsAt: number;
  convertedAt: number;
  expiredAt: number;
};

const EMPTY: Fields = { startedAt: 0, endsAt: 0, convertedAt: 0, expiredAt: 0 };
const DAY_MS = 24 * 60 * 60 * 1000;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// One Firestore listener per uid, shared by every usePlan() caller.
type Entry = { fields: Fields; listeners: Set<() => void>; unsub: (() => void) | null };
const entries = new Map<string, Entry>();

function entryFor(uid: string): Entry {
  let e = entries.get(uid);
  if (!e) {
    e = { fields: EMPTY, listeners: new Set(), unsub: null };
    entries.set(uid, e);
  }
  return e;
}

function subscribeTo(uid: string | null, listener: () => void): () => void {
  if (!uid) return () => {};
  const e = entryFor(uid);
  e.listeners.add(listener);
  if (!e.unsub) {
    e.unsub = onSnapshot(
      doc(db, "users", uid),
      (snap) => {
        const d = (snap.exists() ? snap.data() : {}) as Record<string, unknown>;
        const next: Fields = {
          startedAt: num(d.reverseTrialStartedAt),
          endsAt: num(d.reverseTrialEndsAt),
          convertedAt: num(d.reverseTrialConvertedAt),
          expiredAt: num(d.reverseTrialExpiredAt),
        };
        const prev = e.fields;
        if (
          prev.startedAt !== next.startedAt || prev.endsAt !== next.endsAt
          || prev.convertedAt !== next.convertedAt || prev.expiredAt !== next.expiredAt
        ) {
          e.fields = next;
          e.listeners.forEach((l) => l());
        }
      },
      () => {
        // Non-critical: without the doc the app simply shows the Clerk tier.
      },
    );
  }
  return () => {
    e.listeners.delete(listener);
    if (e.listeners.size === 0 && e.unsub) {
      e.unsub();
      e.unsub = null;
    }
  };
}

/** Pure: the trial as of `now`. Mirrors isReverseTrialActive on the backend. */
export function reverseTrialInfo(f: Fields, now: number): ReverseTrialInfo {
  const hadTrial = f.startedAt > 0;
  const active = hadTrial && f.endsAt > now && f.convertedAt === 0 && f.expiredAt === 0;
  return {
    active,
    endsAt: hadTrial ? f.endsAt : null,
    daysLeft: active ? Math.max(1, Math.ceil((f.endsAt - now) / DAY_MS)) : 0,
    hadTrial,
  };
}

export function useReverseTrial(): ReverseTrialInfo {
  const { user } = useUser();
  const authReady = useAuthReady();
  const uid = authReady && user?.id ? user.id : null;
  const fields = useSyncExternalStore(
    (l) => subscribeTo(uid, l),
    () => (uid ? entryFor(uid).fields : EMPTY),
    () => EMPTY,
  );
  return reverseTrialInfo(fields, Date.now());
}
