import { useCallback, useEffect, useRef } from 'react';

export const useVerticalDragScroll = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Find the scrollable viewport inside shadcn ScrollArea
    const scroller = (container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement)
      || (container.querySelector('[data-slot="scroll-viewport"]') as HTMLElement)
      || container;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const isInteractive = target.closest('button, input, select, textarea, [draggable="true"], .action-menu, .drag-handle, [role="button"], a');
      if (isInteractive) return;

      // Check if clicking on scrollbar area
      const scrollerRect = scroller.getBoundingClientRect();
      const clickX = e.clientX - scrollerRect.left;
      const scrollbarThickness = 24;
      const hasVerticalScroll = scroller.scrollHeight > scroller.clientHeight;
      if (hasVerticalScroll && clickX > scrollerRect.width - scrollbarThickness) return;

      e.preventDefault();

      const startY = e.clientY;
      const startScrollTop = scroller.scrollTop;
      let isDragging = false;

      scroller.style.cursor = 'grabbing';
      scroller.style.userSelect = 'none';

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaY = Math.abs(moveEvent.clientY - startY);

        if (!isDragging && deltaY > 3) {
          isDragging = true;
          isDraggingRef.current = true;
        }

        if (isDragging) {
          moveEvent.preventDefault();
          scroller.scrollTop = startScrollTop - (moveEvent.clientY - startY);
        }
      };

      const handleEnd = () => {
        scroller.style.cursor = '';
        scroller.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleEnd);
        document.removeEventListener('mouseleave', handleEnd);

        setTimeout(() => {
          isDraggingRef.current = false;
        }, 10);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleEnd);
      document.addEventListener('mouseleave', handleEnd);
    };

    container.addEventListener('mousedown', handleMouseDown);
    return () => container.removeEventListener('mousedown', handleMouseDown);
  }, []);

  const wasDragging = useCallback(() => {
    return isDraggingRef.current;
  }, []);

  return { containerRef, wasDragging };
};
