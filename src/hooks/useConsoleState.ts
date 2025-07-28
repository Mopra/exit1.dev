import { useState, useEffect } from 'react';

// Mobile detection helper (inline to avoid circular dependency)
const isMobileDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 1024;
};

interface ConsoleState {
  position: { x: number; y: number };
  size: { width: number; height: number };
  isMinimized: boolean;
  isMaximized: boolean;
}

const STORAGE_KEY = 'console-state';

const getDefaultState = (): ConsoleState => {
  const isMobile = isMobileDevice();
  return {
    position: { x: window.innerWidth - 840, y: window.innerHeight - 440 },
    size: { width: 800, height: 400 },
    isMinimized: isMobile, // Always start minimized on mobile
    isMaximized: false,
  };
};

const loadStateFromStorage = (): ConsoleState => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Validate the stored data has the expected structure
      if (parsed && typeof parsed === 'object') {
        const isMobile = isMobileDevice();
        return {
          position: parsed.position || getDefaultState().position,
          size: parsed.size || getDefaultState().size,
          // On mobile, always start minimized regardless of stored state
          isMinimized: isMobile ? true : (parsed.isMinimized ?? false),
          isMaximized: parsed.isMaximized ?? false,
        };
      }
    }
  } catch (error) {
    console.warn('Failed to load console state from localStorage:', error);
  }
  return getDefaultState();
};

const saveStateToStorage = (state: ConsoleState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save console state to localStorage:', error);
  }
};

export const useConsoleState = () => {
  const [state, setState] = useState<ConsoleState>(() => loadStateFromStorage());

  // Save state to localStorage whenever it changes
  useEffect(() => {
    saveStateToStorage(state);
  }, [state]);

  // Handle viewport changes (mobile ↔ desktop)
  useEffect(() => {
    const handleResize = () => {
      const isMobile = isMobileDevice();
      const wasMobile = state.isMinimized && !state.isMaximized && window.innerWidth >= 1024;
      const isNowMobile = isMobile && !state.isMinimized;
      
      // If switching to mobile and console is not minimized, minimize it
      if (isNowMobile) {
        setState(prev => ({ ...prev, isMinimized: true, isMaximized: false }));
      }
      // If switching from mobile to desktop and console was minimized due to mobile, 
      // keep the stored state or default to windowed
      else if (wasMobile && !isMobile) {
        // Don't automatically change state - let user decide
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [state.isMinimized, state.isMaximized]);

  const updateState = (updates: Partial<ConsoleState>) => {
    setState(prev => ({ ...prev, ...updates }));
  };

  const resetState = () => {
    const defaultState = getDefaultState();
    setState(defaultState);
    saveStateToStorage(defaultState);
  };

  return {
    ...state,
    updateState,
    resetState,
  };
}; 