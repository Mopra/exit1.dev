import { useRef } from 'react';

/**
 * How many times `value` has changed since this component mounted. Starts at
 * 0, so nothing animates on mount (or when a lazy row scrolls back into
 * view); only real changes after that count.
 *
 * Use the parity to restart a CSS animation without remounting anything:
 * `n ? (n % 2 ? 'x-a' : 'x-b') : ''`, where x-a and x-b run the same
 * keyframes under two names. Swapping the name is what makes the browser
 * play it again.
 *
 * Tracked in a ref during render rather than state in an effect, so a table
 * of 100 ticking rows doesn't pay a second render per update.
 */
export function useChangeCount<T>(value: T): number {
  const ref = useRef({ value, count: 0 });
  if (!Object.is(ref.current.value, value)) {
    ref.current = { value, count: ref.current.count + 1 };
  }
  return ref.current.count;
}

/** The class to put on an element so it replays `name` on every change. */
export function replayClass(name: string, count: number): string {
  if (!count) return '';
  return count % 2 ? `${name}-a` : `${name}-b`;
}
