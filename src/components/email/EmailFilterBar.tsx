import { memo } from 'react';
import { Search, Folder } from 'lucide-react';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { ALL_NOTIFICATION_EVENTS } from '../../lib/notification-shared';
import { toast } from 'sonner';
import type { WebhookEvent } from '../../api/types';

interface EmailFilterBarProps {
  checkFilterMode: 'all' | 'include';
  onCheckFilterModeChange: (mode: 'all' | 'include') => void;
  search: string;
  onSearchChange: (value: string) => void;
  checkCount: number;
  groupBy: 'none' | 'folder';
  onGroupByChange: (value: 'none' | 'folder') => void;
  hasFolders: boolean;
  defaultEvents: WebhookEvent[];
  onDefaultEventsChange: (events: WebhookEvent[]) => void;
  onExpandSettings: () => void;
}

export const EmailFilterBar = memo(function EmailFilterBar({
  checkFilterMode,
  onCheckFilterModeChange,
  search,
  onSearchChange,
  checkCount,
  groupBy,
  onGroupByChange,
  hasFolders,
  defaultEvents,
  onDefaultEventsChange,
  onExpandSettings,
}: EmailFilterBarProps) {
  const defaultEventLabels = ALL_NOTIFICATION_EVENTS
    .filter((e) => defaultEvents.includes(e.value))
    .map((e) => e.label)
    .join(', ');

  return (
    <div className="space-y-2">
      {/* Desktop: single row. Mobile: two rows */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        {/* Row 1 (mobile top / desktop left): search */}
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search checks..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Row 2 (mobile bottom / desktop right): toggles + count */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* All checks / Selected only segmented control */}
          <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 p-0.5">
            <button
              type="button"
              onClick={() => onCheckFilterModeChange('all')}
              className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors cursor-pointer ${
                checkFilterMode === 'all'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              All checks
            </button>
            <button
              type="button"
              onClick={() => onCheckFilterModeChange('include')}
              className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors cursor-pointer ${
                checkFilterMode === 'include'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Selected only
            </button>
          </div>

          {/* Check count */}
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {checkCount} {checkCount === 1 ? 'check' : 'checks'}
          </span>

          {/* List / Folders segmented control — only shown when there are folders */}
          {hasFolders && (
            <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => onGroupByChange('none')}
                className={`px-3 py-1 text-xs font-mono rounded-sm transition-all duration-150 cursor-pointer border ${
                  groupBy === 'none'
                    ? 'bg-primary/15 text-primary shadow-sm border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                }`}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => onGroupByChange('folder')}
                className={`px-3 py-1 text-xs font-mono rounded-sm transition-all duration-150 cursor-pointer flex items-center gap-1.5 border ${
                  groupBy === 'folder'
                    ? 'bg-primary/15 text-primary shadow-sm border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                }`}
              >
                <Folder className="w-3 h-3" />
                Folders
              </button>
            </div>
          )}
        </div>
      </div>

      {/* "All checks" info line with default events and edit link */}
      {checkFilterMode === 'all' && (
        <p className="text-xs text-muted-foreground">
          New checks are automatically included. Default alerts:{' '}
          {defaultEventLabels || 'none'}.{' '}
          <button
            type="button"
            onClick={onExpandSettings}
            className="underline underline-offset-2 hover:text-foreground transition-colors cursor-pointer"
          >
            Edit defaults
          </button>
        </p>
      )}

      {/* Default event badges (inline editing when "all" mode is active) */}
      {checkFilterMode === 'all' && (
        <div className="flex flex-wrap gap-1.5">
          {ALL_NOTIFICATION_EVENTS.map((e) => {
            const isOn = defaultEvents.includes(e.value);
            const Icon = e.icon;
            return (
              <Badge
                key={e.value}
                variant={isOn ? 'default' : 'outline'}
                className={`text-xs px-2 py-0.5 cursor-pointer transition-all ${!isOn ? 'opacity-50' : ''} hover:opacity-80`}
                onClick={() => {
                  const next = isOn
                    ? defaultEvents.filter((v) => v !== e.value)
                    : [...defaultEvents, e.value];
                  if (next.length === 0) {
                    toast.error('At least one default alert type is required');
                    return;
                  }
                  onDefaultEventsChange(next as WebhookEvent[]);
                }}
                title={`Click to ${isOn ? 'disable' : 'enable'} ${e.label} for auto-included checks`}
              >
                <Icon className="w-3 h-3 mr-1" />
                {e.label}
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
});
