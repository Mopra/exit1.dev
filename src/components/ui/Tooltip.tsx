import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { typography } from '../../config/theme';

interface TooltipState {
  show: boolean;
  content: string;
  x: number;
  y: number;
  position: 'top' | 'bottom';
  targetId?: string;
}

interface TooltipContextType {
  tooltipState: TooltipState;
  showTooltip: (event: React.MouseEvent | React.TouchEvent, content: string) => void;
  hideTooltip: () => void;
  toggleTooltip: (event: React.MouseEvent | React.TouchEvent, content: string, targetId: string) => void;
}

const TooltipContext = React.createContext<TooltipContextType | null>(null);

export const useTooltip = () => {
  const context = React.useContext(TooltipContext);
  if (!context) {
    throw new Error('useTooltip must be used within a TooltipProvider');
  }
  return context;
};

interface TooltipProviderProps {
  children: React.ReactNode;
}

export const TooltipProvider: React.FC<TooltipProviderProps> = ({ children }) => {
  const [tooltipState, setTooltipState] = useState<TooltipState>({
    show: false,
    content: '',
    x: 0,
    y: 0,
    position: 'top',
    targetId: undefined
  });

  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);

  // Handle click outside to close tooltip
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (!tooltipState.show) return;
      
      const target = event.target as Node;
      
      // Don't close if clicking on the tooltip itself
      if (tooltipRef.current?.contains(target)) return;
      
      // Don't close if clicking on the active target (this will be handled by toggle)
      if (activeTargetRef.current?.contains(target)) return;
      
      // Close the tooltip
      setTooltipState(prev => ({ ...prev, show: false }));
    };

    if (tooltipState.show) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [tooltipState.show]);

  const showTooltip = useCallback((event: React.MouseEvent | React.TouchEvent, content: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const tooltipHeight = 80; // Approximate tooltip height
    const gap = 8;
    
    let position: 'top' | 'bottom' = 'bottom';
    if (rect.bottom + tooltipHeight + gap > viewportHeight) {
      position = 'top';
    }
    
    setTooltipState({
      show: true,
      content,
      x: rect.left + rect.width / 2,
      y: position === 'bottom' ? rect.bottom + gap : rect.top - gap,
      position
    });
  }, []);

  const hideTooltip = useCallback(() => {
    setTooltipState(prev => ({ ...prev, show: false }));
    activeTargetRef.current = null;
  }, []);

  const toggleTooltip = useCallback((event: React.MouseEvent | React.TouchEvent, content: string, targetId: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const tooltipHeight = 80;
    const gap = 8;
    
    let position: 'top' | 'bottom' = 'bottom';
    if (rect.bottom + tooltipHeight + gap > viewportHeight) {
      position = 'top';
    }

    setTooltipState(prev => {
      // If tooltip is already showing for this target, hide it
      if (prev.show && prev.targetId === targetId) {
        activeTargetRef.current = null;
        return { ...prev, show: false };
      }
      
      // Otherwise show it
      activeTargetRef.current = event.currentTarget as HTMLElement;
      return {
        show: true,
        content,
        x: rect.left + rect.width / 2,
        y: position === 'bottom' ? rect.bottom + gap : rect.top - gap,
        position,
        targetId
      };
    });
  }, []);

  return (
    <TooltipContext.Provider value={{ tooltipState, showTooltip, hideTooltip, toggleTooltip }}>
      {children}
      
      {/* Portal-based Tooltip */}
      {tooltipState.show && createPortal(
        <div
          ref={tooltipRef}
          className={`fixed z-[60] px-3 py-2 text-sm bg-green-600 text-white rounded-lg shadow-lg max-w-xs ${typography.fontFamily.mono}`}
          style={{
            left: `${tooltipState.x}px`,
            top: `${tooltipState.y}px`,
            transform: `translateX(-50%) ${tooltipState.position === 'top' ? 'translateY(-100%)' : ''}`,
          }}
        >
          <div className="whitespace-pre-line">
            {tooltipState.content}
          </div>
          {/* Arrow */}
          <div
            className={`absolute w-2 h-2 bg-green-600 transform rotate-45 ${
              tooltipState.position === 'top' 
                ? 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2' 
                : 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2'
            }`}
          />
        </div>,
        document.body
      )}
    </TooltipContext.Provider>
  );
};

// Legacy Tooltip component for backward compatibility
interface LegacyTooltipProps {
  content: string;
  children: React.ReactNode;
}

export const Tooltip: React.FC<LegacyTooltipProps> = ({ content, children }) => {
  const { showTooltip, hideTooltip } = useTooltip();
  
  return (
    <div
      onMouseEnter={(e) => showTooltip(e, content)}
      onMouseLeave={hideTooltip}
      className="cursor-pointer"
    >
      {children}
    </div>
  );
};

export default Tooltip; 