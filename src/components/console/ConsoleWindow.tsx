import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { IconButton } from '../ui';
import { useMobile } from '../../hooks/useMobile';

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
          width: Math.max(400, newWidth),
          height: Math.max(150, newHeight)
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
      className="fixed bottom-24 right-4 z-50 lg:bottom-4 lg:z-[9999] cursor-pointer"
      onClick={onMinimize}
      role="button"
      tabIndex={0}
      aria-label="Restore console window"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-black/95 border border-slate-300 p-3 font-mono text-slate-300 text-sm hover:bg-slate-300/10 transition-colors">
        <div className="flex items-center gap-2">
          <span className="cli-cursor">_</span>
          <span>Console ({logCount})</span>
        </div>
      </div>
    </div>
  ) : (
    <div
      ref={consoleRef}
      className="fixed z-50 font-mono text-slate-300 text-sm rounded-lg"
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        minWidth: 320,
        minHeight: 150,
        maxWidth: isMaximized ? '94vw' : '90vw',
        maxHeight: isMaximized ? (isMobile ? 'calc(90vh - 130px)' : '90vh') : '80vh'
      }}
      role="dialog"
      aria-label="Console window"
    >
      {/* Window Header */}
      <div 
        className={`bg-black/95 border border-slate-300 flex items-center justify-between p-2 rounded-t-lg select-none ${
          isMobile || isMaximized ? '' : 'cursor-move'
        }`}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
        <span className="cli-cursor">_</span>
          <span className="uppercase tracking-widest text-slate-300 text-xs">Console</span>
          <span className="text-xs opacity-60">({logCount} logs)</span>
          <span className="text-xs opacity-40 ml-2" title="Text is selectable">📋</span>
        </div>
        
        {/* Window Controls */}
        <div className="flex items-center gap-1">
          <IconButton
            icon={<FontAwesomeIcon icon={['far', isMaximized ? 'window-restore' : 'window-maximize']} />}
            variant="ghost"
            size="sm"
            onClick={onMaximizeToggle}
            title={isMaximized ? "Restore" : "Maximize"}
            aria-label={isMaximized ? "Restore window" : "Maximize window"}
            className="w-6 h-6 mr-2 border border-slate-300"
          />
          <IconButton
            icon={<FontAwesomeIcon icon={['far', 'window-minimize']} />}
            variant="ghost"
            size="sm"
            onClick={onMinimize}
            title="Minimize"
            aria-label="Minimize window"
            className="w-6 h-6 border border-slate-300 hover:bg-slate-500 hover:text-black"
          />
        </div>
      </div>

      {/* Console Content */}
              <div className="bg-black/95 border-l border-r border-b border-slate-300 h-full flex flex-col rounded-b-lg">
        {children}
        
        {/* Resize Handle */}
        {!isMaximized && !isMobile && (
          <div
            ref={resizeHandleRef}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize cursor-pointer"
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
              <div className="w-2 h-2 border-r-2 border-b-2 border-slate-300"></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Use portal to render console directly in document body
  return createPortal(consoleContent, document.body);
});

ConsoleWindow.displayName = 'ConsoleWindow';

export default ConsoleWindow; 