import React from 'react';
import EmptyState from '../ui/EmptyState';
import { Button } from '../ui/button';
import { Badge, CHECK_INTERVALS, GlowCard, StatusBadge } from '../ui';
import { formatDistanceToNow } from 'date-fns';
import { Info, List, Plus, Search, Settings } from 'lucide-react';
import type { Website } from '../../types';
import { formatLastChecked, formatNextRun, formatResponseTime } from '../../utils/formatters.tsx';

interface LogsEmptyStateProps {
  variant: 'no-website' | 'no-logs' | 'no-results' | 'no-checks';
  onSelectWebsite?: () => void;
  onClearFilters?: () => void;
  onAddWebsite?: () => void;
  check?: Website | null;
  onOpenChecks?: () => void;
  lastEventAt?: number | null;
  lastEventStatus?: 'ok' | 'error';
}

export const LogsEmptyState: React.FC<LogsEmptyStateProps> = ({
  variant,
  onSelectWebsite,
  onClearFilters,
  onAddWebsite,
  check,
  onOpenChecks,
  lastEventAt,
  lastEventStatus
}) => {
  const getIntervalLabel = (checkFrequency?: number) => {
    if (!checkFrequency) return 'Unknown';
    const seconds = checkFrequency * 60;
    const interval = CHECK_INTERVALS.find((item) => item.value === seconds);
    return interval ? interval.label : `${checkFrequency} minutes`;
  };

  const getNextCheckLabel = (target: Website) => {
    if (target.disabled) return 'Paused';
    if (typeof target.nextCheckAt === 'number' && target.nextCheckAt > 0) {
      return formatNextRun(target.nextCheckAt);
    }
    if (target.lastChecked && target.checkFrequency) {
      const nextCheckAt = target.lastChecked + target.checkFrequency * 60 * 1000;
      return formatNextRun(nextCheckAt);
    }
    if (!target.lastChecked) return 'Queued';
    return 'Unknown';
  };

  const getLastEventLabel = (timestamp?: number | null, status?: 'ok' | 'error') => {
    if (status === 'error') return 'Unavailable';
    if (timestamp === undefined) return 'Loading...';
    if (!timestamp) return 'No events yet';
    return formatDistanceToNow(timestamp, { addSuffix: true });
  };

  switch (variant) {
    case 'no-website':
      return (
        <div className="flex flex-col items-center justify-center h-64 space-y-6">
          <EmptyState
            variant="empty"
            icon={List}
            title="Select a Website"
            description="Choose a website from the dropdown above to view its logs from BigQuery"
          />
          <div className="flex flex-col sm:flex-row gap-3">
            {onSelectWebsite && (
              <Button onClick={onSelectWebsite} variant="outline">
                <Search className="w-4 h-4 mr-2" />
                Browse Websites
              </Button>
            )}
            {onAddWebsite && (
              <Button onClick={onAddWebsite}>
                <Plus className="w-4 h-4 mr-2" />
                Add Website
              </Button>
            )}
          </div>
        </div>
      );

    case 'no-logs':
      return (
        <div className="flex w-full flex-col items-center justify-center space-y-6">
          <EmptyState
            variant="empty"
            icon={List}
            title="No Logs Found"
            description="No events in the selected time range."
            className="w-full max-w-2xl"
          />
          {check && (
            <GlowCard className="w-full max-w-3xl">
              <div className="p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-mono">
                      Monitoring snapshot
                    </div>
                    <div className="text-base font-medium text-foreground truncate">{check.name}</div>
                    <div className="text-xs font-mono text-muted-foreground truncate">{check.url}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {check.disabled && (
                      <Badge variant="outline" className="text-xs">
                        Paused
                      </Badge>
                    )}
                    <StatusBadge
                      status={check.detailedStatus ?? check.status ?? 'unknown'}
                      tooltip={{
                        httpStatus: check.lastStatusCode,
                        latencyMsP50: check.responseTime,
                        lastCheckTs: check.lastChecked,
                        failureReason: check.lastError
                      }}
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs sm:text-sm">
                    <span className="text-muted-foreground">Last checked</span>
                    <span className="font-mono">{formatLastChecked(check.lastChecked)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs sm:text-sm">
                    <span className="text-muted-foreground">Last event</span>
                    <span
                      className="font-mono"
                      title={lastEventAt ? new Date(lastEventAt).toLocaleString() : undefined}
                    >
                      {getLastEventLabel(lastEventAt, lastEventStatus)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs sm:text-sm">
                    <span className="text-muted-foreground">Next check</span>
                    <span className="font-mono">{getNextCheckLabel(check)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs sm:text-sm">
                    <span className="text-muted-foreground">Check interval</span>
                    <span className="font-mono">{getIntervalLabel(check.checkFrequency)}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs sm:text-sm">
                    <span className="text-muted-foreground">Last response</span>
                    <span className="font-mono">{formatResponseTime(check.responseTime)}</span>
                  </div>
                </div>

                {check.lastError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <span className="font-medium">Last error:</span>{' '}
                    <span className="font-mono break-words">{check.lastError}</span>
                  </div>
                )}

                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Info className="h-3.5 w-3.5 mt-0.5" />
                  <span>
                    Logs are stored only when a check changes state or errors. If everything is stable,
                    this view stays quiet.
                  </span>
                </div>
              </div>
            </GlowCard>
          )}
          <div className="flex flex-col sm:flex-row gap-3">
            {onClearFilters && (
              <Button onClick={onClearFilters} variant="outline">
                <Settings className="w-4 h-4 mr-2" />
                Adjust Filters
              </Button>
            )}
            {onOpenChecks && (
              <Button onClick={onOpenChecks} variant="outline">
                <Search className="w-4 h-4 mr-2" />
                Open Checks
              </Button>
            )}
          </div>
        </div>
      );

    case 'no-results':
      return (
        <div className="flex flex-col items-center justify-center h-64 space-y-6">
          <EmptyState
            variant="empty"
            icon={Search}
            title="No Results Found"
            description="Try adjusting your search terms or filters to find what you're looking for"
          />
          <div className="flex flex-col sm:flex-row gap-3">
            {onClearFilters && (
              <Button onClick={onClearFilters} variant="outline">
                <Settings className="w-4 h-4 mr-2" />
                Adjust Filters
              </Button>
            )}
          </div>
        </div>
      );

    case 'no-checks':
      return (
        <div className="flex flex-col items-center justify-center h-64 space-y-6">
          <EmptyState
            variant="empty"
            icon={List}
            title="No Checks Found"
            description="You need to create at least one check to view logs. Get started by adding your first website or endpoint to monitor."
          />
          <div className="flex flex-col sm:flex-row gap-3">
            {onOpenChecks && (
              <Button onClick={onOpenChecks} className="cursor-pointer">
                <Plus className="w-4 h-4 mr-2" />
                Create Your First Check
              </Button>
            )}
          </div>
        </div>
      );

    default:
      return null;
  }
};
