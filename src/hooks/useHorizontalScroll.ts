import { useCallback, useRef } from 'react';

export const useHorizontalScroll = () => {
  const isDraggingRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    // Only enable horizontal scrolling if not clicking on interactive elements
    const target = e.target as HTMLElement;
    const isInteractive = target.closest('button, input, select, textarea, [draggable="true"], .action-menu, .drag-handle');
    if (!isInteractive) {
      const container = e.currentTarget;
      const startX = e.clientX;
      const startScrollLeft = container.scrollLeft;
      let isDragging = false;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = Math.abs(moveEvent.clientX - startX);
        
        // Only start dragging if we've moved more than 5px (prevents accidental drags)
        if (!isDragging && deltaX > 5) {
          isDragging = true;
          isDraggingRef.current = true;
          container.classList.add('dragging');
          container.style.cursor = 'grabbing';
        }
        
        if (isDragging) {
          const scrollDeltaX = moveEvent.clientX - startX;
          container.scrollLeft = startScrollLeft - scrollDeltaX;
        }
      };

      const handleMouseUp = () => {
        container.classList.remove('dragging');
        container.style.cursor = 'grab';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        
        // Reset dragging state after a short delay to allow click events to check it
        setTimeout(() => {
          isDraggingRef.current = false;
        }, 10);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
  }, []);

  const wasDragging = useCallback(() => {
    return isDraggingRef.current;
  }, []);

  return { handleMouseDown, wasDragging };
}; 