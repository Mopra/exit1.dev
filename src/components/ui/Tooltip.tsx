import React, { useState, useRef, useEffect } from 'react';
import { theme, typography } from '../../config/theme';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

const Tooltip: React.FC<TooltipProps> = React.memo(({
  content,
  children,
  position = 'top',
  delay = 200
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const showTooltip = () => {
    const id = setTimeout(() => setIsVisible(true), delay);
    setTimeoutId(id);
  };

  const hideTooltip = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      setTimeoutId(null);
    }
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [timeoutId]);

  const positionClasses = {
    top: 'bottom-full left-1/2 transform -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 transform -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 transform -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 transform -translate-y-1/2 ml-2'
  };

  const arrowClasses = {
    top: 'top-full left-1/2 transform -translate-x-1/2 border-t-white',
    bottom: 'bottom-full left-1/2 transform -translate-x-1/2 border-b-white',
    left: 'left-full top-1/2 transform -translate-y-1/2 border-l-white',
    right: 'right-full top-1/2 transform -translate-y-1/2 border-r-white'
  };

  return (
    <div
      ref={triggerRef}
      className="relative inline-block"
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      
      {isVisible && (
        <div
          ref={tooltipRef}
          className={`absolute z-50 px-2 py-1 text-xs ${typography.fontFamily.mono} ${theme.colors.badge.success} rounded-sm whitespace-nowrap ${positionClasses[position]}`}
          role="tooltip"
          aria-hidden="true"
        >
          {content}
          <div className={`absolute w-0 h-0 border-4 border-transparent ${arrowClasses[position]}`} />
        </div>
      )}
    </div>
  );
});

Tooltip.displayName = 'Tooltip';

export default Tooltip; 