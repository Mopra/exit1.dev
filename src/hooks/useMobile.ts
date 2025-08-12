import { useState, useEffect } from 'react';

/**
 * Hook to detect viewport width below a breakpoint (in px).
 * Defaults to Tailwind's lg breakpoint (1024px).
 *
 * Example usages:
 *  - useMobile()            // < 1024px
 *  - useMobile(768)         // < 768px (md and down)
 *  - useMobile(500)         // < 500px (very small screens)
 */
export const useMobile = (breakpoint: number = 1024) => {
  const [isBelowBreakpoint, setIsBelowBreakpoint] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    const checkIsBelow = () => {
      setIsBelowBreakpoint(window.innerWidth < breakpoint);
    };

    window.addEventListener('resize', checkIsBelow);
    checkIsBelow();
    return () => window.removeEventListener('resize', checkIsBelow);
  }, [breakpoint]);

  return isBelowBreakpoint;
};