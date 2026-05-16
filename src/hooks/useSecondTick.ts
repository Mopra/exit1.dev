/**
 * Shared 1Hz tick for live "X seconds ago" / "Next in X" displays.
 *
 * One module-level `setInterval` drives every subscriber so adding more
 * countdown components doesn't add timers — only one entry to the shared
 * Set. The hook returns a timestamp rounded to the nearest second; React
 * bails out on same-value setState so consumers only re-render when the
 * displayed second actually changes.
 *
 * Pauses while the tab is hidden — there's no point burning CPU on
 * offscreen countdowns, and the values snap back to current on the next
 * tick when the tab regains focus.
 *
 * Phase 6 of vps-live-primary uses this to drive `CheckCountdown`. Plan
 * called out a single rAF loop; switched to setInterval(1000) because the
 * display is second-precision text — 60Hz rAF would waste cycles. The
 * visual smoothness of the progress bar comes from CSS transitions, not
 * from a JS tick.
 */
import { useEffect, useState } from 'react';

const subscribers = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let visibilityListenerAttached = false;

function fire(): void {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  for (const cb of subscribers) cb();
}

function startLoop(): void {
  if (intervalId !== null) return;
  intervalId = setInterval(fire, 1000);
  if (typeof document !== 'undefined' && !visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', () => {
      // Fire immediately on regaining focus so users don't see stale text
      // while the next tick is queued.
      if (document.visibilityState === 'visible') fire();
    });
  }
}

function stopLoop(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Returns a timestamp rounded to the nearest second. Re-renders the
 * subscriber once per second while the tab is visible.
 */
export function useSecondTick(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000) * 1000);
  useEffect(() => {
    const cb = (): void => {
      const t = Math.floor(Date.now() / 1000) * 1000;
      setNow(prev => (prev === t ? prev : t));
    };
    subscribers.add(cb);
    startLoop();
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0) stopLoop();
    };
  }, []);
  return now;
}
