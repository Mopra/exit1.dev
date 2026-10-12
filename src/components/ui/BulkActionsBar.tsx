"use client"

import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { DeleteButton } from './DeleteButton';
import { glassClasses } from './glass';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

export interface BulkAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  className?: string;
  isDelete?: boolean; // Use DeleteButton component instead of regular Button
  disabled?: boolean;
}

interface BulkActionsBarProps {
  selectedCount: number;
  totalCount: number;
  onClearSelection: () => void;
  actions: BulkAction[];
  itemLabel?: string; // e.g., "check", "webhook", "email"
}

// How long the bar takes to slide away after the selection is cleared.
const EXIT_MS = 200;

export function BulkActionsBar({
  selectedCount: liveCount,
  totalCount,
  onClearSelection,
  actions,
  itemLabel = 'item',
}: BulkActionsBarProps) {
  // The bar slides up when something is selected and back down when the
  // selection clears. While sliding away it keeps showing the last count
  // (not "0 selected") and ignores clicks.
  const [present, setPresent] = useState(liveCount > 0);
  const lastCount = useRef(liveCount);
  if (liveCount > 0) lastCount.current = liveCount;
  const leaving = liveCount === 0;

  useEffect(() => {
    if (liveCount > 0) {
      setPresent(true);
      return;
    }
    const t = setTimeout(() => setPresent(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [liveCount]);

  if (!present && leaving) return null;

  const selectedCount = lastCount.current;
  const percentage = Math.round((selectedCount / totalCount) * 100);

  return (
    <div
      className={cn(
        `fixed bottom-0 left-0 right-0 z-[50] ${glassClasses} border-t [animation-duration:200ms] [animation-timing-function:cubic-bezier(0.22,1,0.36,1)]`,
        leaving
          ? 'animate-out fade-out-0 slide-out-to-bottom [animation-fill-mode:forwards] pointer-events-none'
          : 'animate-in fade-in-0 slide-in-from-bottom',
      )}
    >
      <div className="px-4 py-4 sm:px-6 sm:py-6 max-w-screen-xl mx-auto">
        {/* Mobile Layout - Stacked */}
        <div className="sm:hidden space-y-4">
          {/* Selection Info */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full bg-background border border flex items-center justify-center`}>
                <span className={`text-sm font-semibold font-mono text-foreground`}>
                  {selectedCount}
                </span>
              </div>
              <div className="flex flex-col">
                <span className={`text-sm font-medium font-mono text-foreground`}>
                  {selectedCount} {itemLabel}{selectedCount !== 1 ? 's' : ''} selected
                </span>
                <span className={`text-xs text-muted-foreground`}>
                  {percentage}% of total
                </span>
              </div>
            </div>
            
            {/* Close Selection */}
            <button
              onClick={onClearSelection}
              className={`w-8 h-8 rounded-full hover:bg-accent border border flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-neutral/20 hover:scale-105`}
              title="Clear selection"
            >
              <X className={`w-4 h-4 text-muted-foreground hover:text-foreground transition-colors duration-200`} />
            </button>
          </div>

          {/* Action Buttons - Full Width Grid */}
          <div className={`grid gap-2 ${actions.length === 1 ? 'grid-cols-1' : actions.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {actions.map((action, index) => {
              if (action.isDelete) {
                return (
                  <DeleteButton key={index} onClick={action.onClick} size="sm" className="justify-center w-full">
                    {action.label}
                  </DeleteButton>
                );
              }
              return (
                <Button
                  key={index}
                  onClick={action.onClick}
                  variant={action.variant || 'ghost'}
                  size="sm"
                  disabled={action.disabled}
                  className={cn(
                    'flex items-center justify-center gap-2 cursor-pointer w-full',
                    action.className,
                  )}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </Button>
              );
            })}
          </div>
        </div>

        {/* Desktop Layout - Horizontal */}
        <div className="hidden sm:flex items-center justify-between gap-6">
          {/* Selection Info */}
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full bg-background border border flex items-center justify-center`}>
              <span className={`text-sm font-semibold font-mono text-foreground`}>
                {selectedCount}
              </span>
            </div>
            <div className="flex flex-col">
              <span className={`text-sm font-medium font-mono text-foreground`}>
                {selectedCount} {itemLabel}{selectedCount !== 1 ? 's' : ''} selected
              </span>
              <span className={`text-xs text-muted-foreground`}>
                {percentage}% of total
              </span>
            </div>
          </div>

          {/* Divider */}
          {actions.length > 0 && (
            <div className={`w-px h-8 border`} />
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-3">
            {actions.map((action, index) => {
              if (action.isDelete) {
                return (
                  <DeleteButton key={index} onClick={action.onClick} size="sm">
                    {action.label}
                  </DeleteButton>
                );
              }
              return (
                <Button
                  key={index}
                  onClick={action.onClick}
                  variant={action.variant || 'ghost'}
                  size="sm"
                  disabled={action.disabled}
                  className={cn(
                    'flex items-center gap-2 cursor-pointer',
                    action.className,
                  )}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </Button>
              );
            })}
          </div>

          {/* Close Selection */}
          <button
            onClick={onClearSelection}
            className={`w-8 h-8 rounded-full hover:bg-accent border border flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-neutral/20 hover:scale-105`}
            title="Clear selection"
          >
            <X className={`w-4 h-4 text-muted-foreground hover:text-foreground transition-colors duration-200`} />
          </button>
        </div>
      </div>
    </div>
  );
}

