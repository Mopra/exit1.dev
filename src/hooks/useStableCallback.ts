/**
 * useStableCallback — a callback whose identity never changes but which
 * always invokes the latest closure passed in.
 *
 * Use it to hand a stable function reference down to `React.memo`'d
 * children so an upstream parent re-render (which re-creates inline
 * handlers) doesn't bust the child's memo. The classic ref-swap pattern;
 * stand-in for the not-yet-stable `useEffectEvent`.
 *
 * Caveat: the returned function is stable from first render, so don't
 * call it during render of the same component — it's meant for event
 * handlers / effects that run after commit.
 */
import { useCallback, useRef } from 'react';

export function useStableCallback<TArgs extends unknown[], TReturn>(
  fn: ((...args: TArgs) => TReturn) | undefined,
): (...args: TArgs) => TReturn | undefined {
  const ref = useRef(fn);
  // Assign during render so the ref is current even before effects flush.
  ref.current = fn;
  return useCallback((...args: TArgs) => ref.current?.(...args), []);
}
