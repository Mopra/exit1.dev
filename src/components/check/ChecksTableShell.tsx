import React, { useEffect, useRef, useState } from 'react';
import { GlowCard, ScrollArea } from '../ui';
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll';

interface ChecksTableShellProps {
  table: React.ReactNode;
  hasRows: boolean;
  emptyState?: React.ReactNode;
  mobile?: React.ReactNode;
  minWidthClassName?: string;
  toolbar?: React.ReactNode;
  containerClassName?: string;
}

const ChecksTableShell: React.FC<ChecksTableShellProps> = ({
  table,
  hasRows,
  emptyState,
  mobile,
  minWidthClassName = 'min-w-[1200px]',
  toolbar,
  containerClassName = '',
}) => {
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();
  const hasMobile = mobile !== undefined;
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);

  // The Radix horizontal scrollbar is overlay-style (h-5) and would cover the
  // last row. We only need bottom padding when overflow actually exists, so we
  // observe the viewport and inner content and toggle it on demand.
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    const viewport = root.querySelector('[data-slot="scroll-viewport"]') as HTMLElement | null;
    if (!viewport) return;

    const update = () => {
      setHasHorizontalOverflow(viewport.scrollWidth > viewport.clientWidth + 1);
    };
    update();

    const ro = new ResizeObserver(update);
    ro.observe(viewport);
    const inner = viewport.firstElementChild as HTMLElement | null;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      {hasMobile ? <div className="block sm:hidden">{mobile}</div> : null}
      <div className={`${hasMobile ? 'hidden sm:block' : 'block'} w-full min-w-0`}>
        <GlowCard className={`w-full min-w-0 overflow-hidden ${containerClassName}`}>
          {toolbar ? (
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-b bg-muted/40">
              {toolbar}
            </div>
          ) : null}
          <ScrollArea ref={scrollAreaRef} type="auto" className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
            <div className={`${minWidthClassName} w-full ${hasHorizontalOverflow ? 'pb-5' : ''}`}>
              {table}
            </div>
          </ScrollArea>
          {!hasRows && emptyState ? (
            <div className="px-8 py-8">{emptyState}</div>
          ) : null}
        </GlowCard>
      </div>
    </>
  );
};

export default ChecksTableShell;
