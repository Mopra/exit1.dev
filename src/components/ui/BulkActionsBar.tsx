"use client"

import React from 'react';
import { Button } from './button';
import { DeleteButton } from './DeleteButton';
import { glassClasses } from './glass';
import { X } from 'lucide-react';

export interface BulkAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
  className?: string;
  isDelete?: boolean; // Use DeleteButton component instead of regular Button
}

interface BulkActionsBarProps {
  selectedCount: number;
  totalCount: number;
  onClearSelection: () => void;
  actions: BulkAction[];
  itemLabel?: string; // e.g., "check", "webhook", "email"
}

export function BulkActionsBar({
  selectedCount,
  totalCount,
  onClearSelection,
  actions,
  itemLabel = 'item',
}: BulkActionsBarProps) {
  if (selectedCount === 0) return null;

  const percentage = Math.round((selectedCount / totalCount) * 100);

  return (
    <div className={`fixed bottom-0 left-0 right-0 z-[50] ${glassClasses} border-t rounded-t-lg`}>
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
                  className={`${glassClasses} flex items-center justify-center gap-2 cursor-pointer w-full hover:bg-sky-500/20 ${action.className || ''}`}
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
                  className={`${glassClasses} flex items-center gap-2 cursor-pointer hover:bg-sky-500/20 ${action.className || ''}`}
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

