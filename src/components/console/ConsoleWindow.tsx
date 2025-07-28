import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { IconButton } from '../ui';
import { useMobile } from '../../hooks/useMobile';
import { theme } from '../../config/theme';

interface Position {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface ConsoleWindowProps {
  position: Position;
  size: Size;
  isMinimized: boolean;
  isMaximized: boolean;
  onPositionChange: (position: Position) => void;
  onSizeChange: (size: Size) => void;
  onMaximizeToggle: () => void;
  onMinimize: () => void;
  children: React.ReactNode;
  inputArea?: React.ReactNode;
  logCount: number;
}

const ConsoleWindow: React.FC<ConsoleWindowProps> = React.memo(({
  position,
  size,
  isMinimized,
  isMaximized,
  onPositionChange,
  onSizeChange,
  onMaximizeToggle,
  onMinimize,
  children,
  inputArea,
  logCount
}) => {
  const [isResizing, setIsResizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  
  const consoleRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  
  const isMobile = useMobile();

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isMaximized || isMobile) return; // Disable dragging on mobile
    
    const rect = consoleRef.current?.getBoundingClientRect();
    if (rect) {
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
      setIsDragging(true);
    }
  }, [isMaximized, isMobile]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (isMobile) return; // Disable resizing on mobile
    e.stopPropagation();
    setIsResizing(true);
  }, [isMobile]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      onMinimize();
    }
  }, [onMinimize]);

  // Handle mouse events for dragging and resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging && !isMaximized && !isMobile) {
        onPositionChange({
          x: e.clientX - dragOffset.x,
          y: e.clientY - dragOffset.y
        });
      }
      
      if (isResizing && !isMaximized && !isMobile) {
        const newWidth = e.clientX - position.x;
        const newHeight = e.clientY - position.y;
        
        onSizeChange({
          width: Math.max(500, newWidth),
          height: Math.max(300, newHeight)
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if ((isDragging || isResizing) && !isMobile) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, dragOffset, position, isMaximized, isMobile, onPositionChange, onSizeChange]);

  const consoleContent = isMinimized ? (
    <div 
      className="fixed bottom-24 right-4 z-40 lg:bottom-4 lg:z-40 cursor-pointer"
      onClick={onMinimize}
      role="button"
      tabIndex={0}
      aria-label="Restore console window"
      onKeyDown={handleKeyDown}
    >
      <div className={`bg-black/80 backdrop-blur-xl border-2 border-white/20 p-4 ${theme.typography.fontFamily.mono} ${theme.colors.text.console} text-sm ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]} ${theme.borderRadius.lg}`}>
        <div className="flex items-center gap-3">
          <span className="cli-cursor">_</span>
          <span>Console ({logCount})</span>
        </div>
      </div>
    </div>
  ) : (
    <div
      ref={consoleRef}
      className={`fixed z-40 ${theme.typography.fontFamily.mono} ${theme.colors.text.console} text-sm ${theme.borderRadius.xl} ${theme.shadows.lg} border-2 border-white/20 flex flex-col`}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        minWidth: 500,
        minHeight: 300,
        maxWidth: isMaximized ? '94vw' : '90vw',
        maxHeight: isMaximized ? (isMobile ? 'calc(90vh - 130px)' : '90vh') : '80vh'
      }}
      role="dialog"
      aria-label="Console window"
    >
      {/* Window Header */}
      <div 
        className={`bg-black/80 backdrop-blur-xl flex items-center justify-between p-3 ${theme.borderRadius.xl} ${theme.borderRadius.xl === 'rounded-xl' ? 'rounded-b-none' : ''} select-none ${
          isMobile || isMaximized ? '' : 'cursor-move'
        }`}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-3">
        <span className="cli-cursor">_</span>
          <span className={`uppercase tracking-widest ${theme.colors.text.console} text-sm font-medium`}>Console</span>
          <span className="text-sm opacity-70">({logCount} logs)</span>
          <span className="text-sm opacity-50 ml-2" title="Text is selectable">📋</span>
        </div>
        
        {/* Window Controls */}
        <div className="flex items-center gap-2">
          <IconButton
            icon={<FontAwesomeIcon icon={['far', isMaximized ? 'window-restore' : 'window-maximize']} />}
            variant="ghost"
            size="sm"
            onClick={onMaximizeToggle}
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            className={`w-7 h-7 mr-1 ${theme.colors.border.console}`}
          />
          <IconButton
            icon={<FontAwesomeIcon icon={['far', 'window-minimize']} />}
            variant="ghost"
            size="sm"
            onClick={onMinimize}
            title="Minimize"
            aria-label="Minimize window"
            className={`w-7 h-7 ${theme.colors.border.console} ${theme.colors.background.hover} ${theme.animation.transition.colors} ${theme.animation.duration[200]}`}
          />
        </div>
      </div>

      {/* Console Content */}
      <div className={`bg-black/80 backdrop-blur-xl flex-1 flex flex-col border-t border-white/10 ${theme.borderRadius.xl === 'rounded-xl' ? 'rounded-t-none' : ''} overflow-hidden`}>
        {children}
      </div>
      
      {/* Console Input Area */}
      {inputArea && (
        <div className={`bg-black/80 backdrop-blur-xl border-t border-white/10 ${theme.borderRadius.xl === 'rounded-xl' ? 'rounded-b-xl' : ''} p-3`}>
          {inputArea}
        </div>
      )}
      
      {/* Resize Handle */}
      {!isMaximized && !isMobile && (
        <div
          ref={resizeHandleRef}
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
          onMouseDown={handleResizeMouseDown}
          role="button"
          tabIndex={0}
          aria-label="Resize window"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
            }
          }}
        >
          <div className="w-full h-full flex items-end justify-end">
            <div className={`w-2 h-2 border-r-2 border-b-2 ${theme.colors.border.console}`}></div>
          </div>
        </div>
      )}
    </div>
  );

  // Use portal to render console directly in document body
  return createPortal(consoleContent, document.body);
});

ConsoleWindow.displayName = 'ConsoleWindow';

export default ConsoleWindow; 