import { useCallback, useRef } from 'react';

export const useHorizontalScroll = () => {
  const isDraggingRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    // Only enable horizontal scrolling if not clicking on interactive elements
    const target = e.target as HTMLElement;
    const isInteractive = target.closest('button, input, select, textarea, [draggable="true"], .action-menu, .drag-handle, [role="button"], a');
    if (isInteractive) return;

    const container = e.currentTarget as HTMLElement;
    
    // Prefer shadcn ScrollArea viewport if present
    const scroller = (container.querySelector('[data-slot="scroll-viewport"]') as HTMLElement)
      || (container.querySelector('[data-slot="table-container"]') as HTMLElement)
      || container;
    
    // Check if clicking on scrollbar - allow default scrollbar behavior
    const scrollerRect = scroller.getBoundingClientRect();
    const clickX = e.clientX - scrollerRect.left;
    const clickY = e.clientY - scrollerRect.top;
    const scrollerWidth = scrollerRect.width;
    const scrollerHeight = scrollerRect.height;
    
    // Check if click is on horizontal scrollbar (bottom area)
    // Scrollbar thickness is 24px based on CSS (scrollbar-width: thick)
    const scrollbarThickness = 24;
    const hasHorizontalScroll = scroller.scrollWidth > scroller.clientWidth;
    const isOnHorizontalScrollbar = hasHorizontalScroll && clickY > scrollerHeight - scrollbarThickness;
    
    // Check if click is on vertical scrollbar (right edge)
    const hasVerticalScroll = scroller.scrollHeight > scroller.clientHeight;
    const isOnVerticalScrollbar = hasVerticalScroll && clickX > scrollerWidth - scrollbarThickness;
    
    // Also check if target is a scrollbar pseudo-element or within scrollbar area
    // For webkit, scrollbar elements might be detected by their position
    const isScrollbarClick = isOnHorizontalScrollbar || isOnVerticalScrollbar;
    
    if (isScrollbarClick) {
      return; // Let the scrollbar handle the click
    }

    e.preventDefault(); // Prevent text selection while dragging

    const startX = e.clientX;
    const startScrollLeft = scroller.scrollLeft;
    let isDragging = false;

    // Visual feedback and selection handling
    container.classList.add('dragging');
    scroller.style.cursor = 'grabbing';
    scroller.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = Math.abs(moveEvent.clientX - startX);

      // Only start dragging if we've moved more than 3px (prevents accidental drags)
      if (!isDragging && deltaX > 3) {
        isDragging = true;
        isDraggingRef.current = true;
      }

      if (isDragging || deltaX > 3) {
        moveEvent.preventDefault();
        const scrollDeltaX = moveEvent.clientX - startX;
        scroller.scrollLeft = startScrollLeft - scrollDeltaX;
      }
    };

    const handleEnd = () => {
      container.classList.remove('dragging');
      scroller.style.cursor = 'grab';
      scroller.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('mouseleave', handleEnd);

      // Reset dragging state after a short delay to allow click events to check it
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 10);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('mouseleave', handleEnd);
  }, []);

  const wasDragging = useCallback(() => {
    return isDraggingRef.current;
  }, []);

  return { handleMouseDown, wasDragging };
};