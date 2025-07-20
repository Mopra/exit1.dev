import { useState, useEffect } from 'react';

/**
 * Hook to detect mobile devices based on the same breakpoint used in Tailwind CSS.
 * Follows the pattern used throughout the app where lg: classes apply to >= 1024px.
 * Mobile is considered < 1024px (matching Tailwind's lg breakpoint).
 */
export const useMobile = () => {
  const [isMobile, setIsMobile] = useState(() => {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 1024;
  });

  useEffect(() => {
    const checkIsMobile = () => {
      setIsMobile(window.innerWidth < 1024);
    };

    // Listen for window resize events
    window.addEventListener('resize', checkIsMobile);
    
    // Check on mount
    checkIsMobile();

    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);

  return isMobile;
}; 