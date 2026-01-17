import React from 'react';
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
          <ScrollArea className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
            <div className={`${minWidthClassName} w-full`}>
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
