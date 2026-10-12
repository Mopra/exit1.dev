import { useCallback, useSyncExternalStore } from 'react';

/**
 * Live `window.matchMedia(query).matches`. Use it to mount only the layout
 * that is actually shown, instead of rendering both and hiding one with
 * Tailwind's `sm:hidden` / `hidden sm:block`: a CSS-hidden subtree still
 * renders, re-renders and runs its timers.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
