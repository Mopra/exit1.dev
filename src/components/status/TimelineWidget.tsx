import React, { useRef, useState, useEffect } from 'react';
import { GripVertical, Settings } from 'lucide-react';
import { GlowCard } from '../ui';
import type { CustomLayoutWidget } from '../../types';
import { format } from 'date-fns';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  status?: string;
}

interface HeartbeatDay {
  day: number;
  status: 'online' | 'offline' | 'unknown';
}

interface TimelineWidgetProps {
  widget: CustomLayoutWidget;
  check: BadgeData | null;
  heartbeat: HeartbeatDay[];
  checks?: BadgeData[];            // Multi-check mode
  heartbeats?: HeartbeatDay[][];   // Multi-check mode
  editMode: boolean;
  onConfigure: (widgetId: string) => void;
}

const getHealthTone = (status?: string) => {
  switch (status) {
    case 'online':
    case 'UP':
      return 'bg-emerald-500';
    case 'offline':
    case 'DOWN':
      return 'bg-destructive';
    case 'REACHABLE_WITH_ERROR':
      return 'bg-amber-500';
    case 'REDIRECT':
      return 'bg-sky-500';
    case 'disabled':
      return 'bg-amber-400';
    case 'unknown':
    default:
      return 'bg-muted-foreground/40';
  }
};

const getHealthLabel = (status?: string) => {
  switch (status) {
    case 'online':
    case 'UP':
      return 'Online';
    case 'offline':
    case 'DOWN':
      return 'Offline';
    case 'REACHABLE_WITH_ERROR':
      return 'Degraded';
    case 'REDIRECT':
      return 'Redirect';
    case 'disabled':
      return 'Paused';
    case 'unknown':
    default:
      return 'Unknown';
  }
};

const getHealthSurface = (status?: string) => {
  switch (status) {
    case 'offline':
    case 'DOWN':
      return 'bg-destructive/5 border-destructive/20';
    case 'REACHABLE_WITH_ERROR':
      return 'bg-amber-500/5 border-amber-500/20';
    default:
      return '';
  }
};

const getHeartbeatTone = (status: string) => {
  switch (status) {
    case 'online':
      return 'bg-emerald-500';
    case 'offline':
      return 'bg-destructive';
    case 'unknown':
    default:
      return 'bg-muted-foreground/40';
  }
};

const getHeartbeatLabel = (status: string) => {
  switch (status) {
    case 'online':
      return 'No issues';
    case 'offline':
      return 'Issues detected';
    case 'unknown':
    default:
      return 'No data';
  }
};

// Aggregate multiple heartbeat arrays into one by day timestamp
const aggregateHeartbeats = (heartbeats: HeartbeatDay[][]): HeartbeatDay[] => {
  if (heartbeats.length === 0) return [];
  if (heartbeats.length === 1) return heartbeats[0];

  // Build a map of day -> statuses across all checks
  const dayMap = new Map<number, ('online' | 'offline' | 'unknown')[]>();
  for (const hb of heartbeats) {
    for (const day of hb) {
      const existing = dayMap.get(day.day) || [];
      existing.push(day.status);
      dayMap.set(day.day, existing);
    }
  }

  // Sort by day and aggregate
  return Array.from(dayMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([day, statuses]) => {
      let aggregatedStatus: 'online' | 'offline' | 'unknown';
      if (statuses.every((s) => s === 'online')) {
        aggregatedStatus = 'online';
      } else if (statuses.some((s) => s === 'offline')) {
        aggregatedStatus = 'offline';
      } else {
        aggregatedStatus = 'unknown';
      }
      return { day, status: aggregatedStatus };
    });
};

// Get aggregated current status from multiple checks
const getAggregatedCurrentStatus = (checks: BadgeData[]): { tone: string; label: string; surface: string } => {
  const onlineCount = checks.filter((c) => c.status === 'online' || c.status === 'UP').length;
  const offlineCount = checks.filter((c) => c.status === 'offline' || c.status === 'DOWN').length;

  if (onlineCount === checks.length) {
    return { tone: 'bg-emerald-500', label: 'All Online', surface: '' };
  } else if (offlineCount === checks.length) {
    return { tone: 'bg-destructive', label: 'All Offline', surface: 'bg-destructive/5 border-destructive/20' };
  } else if (offlineCount > 0) {
    return { tone: 'bg-amber-500', label: 'Some Issues', surface: 'bg-amber-500/5 border-amber-500/20' };
  }
  return { tone: 'bg-muted-foreground/40', label: 'Unknown', surface: '' };
};

// Configuration for bar sizing
const BAR_MIN_WIDTH = 4;
const BAR_GAP = 2;
const MAX_DAYS = 90;

export const TimelineWidget: React.FC<TimelineWidgetProps> = ({
  widget,
  check,
  heartbeat,
  checks,
  heartbeats,
  editMode,
  onConfigure,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleDays, setVisibleDays] = useState(30);

  // Determine if this is multi-check mode
  const isMultiCheck = (checks?.length ?? 0) > 1;
  const effectiveHeartbeat = isMultiCheck
    ? aggregateHeartbeats(heartbeats ?? [])
    : heartbeat;
  const effectiveCheck = isMultiCheck ? null : check;
  const shouldShowCheckName = isMultiCheck
    ? false
    : (widget.showCheckName ?? true);

  // Calculate how many days to show based on container width
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const availableWidth = entry.contentRect.width;

      // Calculate how many bars can fit with minimum width + gap
      const maxBarsAtMinWidth = Math.floor(
        (availableWidth + BAR_GAP) / (BAR_MIN_WIDTH + BAR_GAP)
      );

      // Cap at MAX_DAYS and available heartbeat data
      const targetDays = Math.min(maxBarsAtMinWidth, MAX_DAYS, effectiveHeartbeat.length || 30);

      setVisibleDays(Math.max(7, targetDays)); // Minimum 7 days
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [effectiveHeartbeat.length]);

  // Generate display data - take the most recent N days
  const displayHeartbeat = React.useMemo(() => {
    if (effectiveHeartbeat.length > 0) {
      // Take the last N days (most recent)
      return effectiveHeartbeat.slice(-visibleDays);
    }
    // Fallback: generate placeholder data
    return Array.from({ length: visibleDays }, (_, i) => ({
      day: Date.now() - (visibleDays - 1 - i) * 86400000,
      status: 'unknown' as const,
    }));
  }, [effectiveHeartbeat, visibleDays]);

  // Empty state - no checks configured
  const isEmpty = isMultiCheck
    ? (!checks || checks.length === 0)
    : !check;

  if (isEmpty) {
    return (
      <GlowCard className="group p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        {editMode && (
          <>
            <div className="drag-handle absolute top-1 left-1 p-2 cursor-grab active:cursor-grabbing rounded hover:bg-muted/50 opacity-0 group-hover:opacity-100 transition-opacity">
              <GripVertical className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="absolute bottom-2 right-2 pointer-events-none">
              <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/50">
                <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          </>
        )}
        <div className="text-sm text-muted-foreground text-center">
          No check selected
        </div>
        {editMode && (
          <button
            type="button"
            onClick={() => onConfigure(widget.id)}
            className="text-xs text-primary hover:underline cursor-pointer"
          >
            Configure widget
          </button>
        )}
      </GlowCard>
    );
  }

  // Determine surface styling
  const surface = isMultiCheck
    ? getAggregatedCurrentStatus(checks!).surface
    : getHealthSurface(check?.status);

  return (
    <GlowCard className={`group p-5 h-full flex flex-col gap-3 min-w-0 ${surface}`}>
      {editMode && (
        <>
          <div className="drag-handle absolute top-2 left-2 p-1.5 cursor-grab active:cursor-grabbing rounded-md bg-background/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-background z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical className="w-4 h-4 text-muted-foreground" />
          </div>
          <button
            type="button"
            onClick={() => onConfigure(widget.id)}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-background z-10 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Configure widget"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </button>
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/60">
              <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </>
      )}

      {/* Header - multi-check aggregated or single check */}
      {isMultiCheck ? (
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-semibold text-foreground truncate">
              {checks!.length} checks
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`h-2.5 w-2.5 rounded-full ${getAggregatedCurrentStatus(checks!).tone}`} />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {getAggregatedCurrentStatus(checks!).label}
            </span>
          </div>
        </div>
      ) : shouldShowCheckName && effectiveCheck && (
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-semibold text-foreground truncate">
              {effectiveCheck.name}
            </div>
            <div className="text-xs text-muted-foreground break-all line-clamp-1">
              {effectiveCheck.url}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`h-2.5 w-2.5 rounded-full ${getHealthTone(effectiveCheck.status)}`} />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {getHealthLabel(effectiveCheck.status)}
            </span>
          </div>
        </div>
      )}

      {/* Scalable bar timeline - bars flex to fill available width */}
      <div
        ref={containerRef}
        className="flex-1 flex items-end gap-[2px] min-h-[24px] w-full"
      >
        {displayHeartbeat.map((day, index) => (
          <div
            key={`${widget.id}-${day.day}-${index}`}
            className={`flex-1 min-w-[3px] h-full min-h-[24px] rounded-sm transition-all hover:opacity-80 ${getHeartbeatTone(day.status)}`}
            title={`${format(new Date(day.day), 'MMM d, yyyy')} - ${getHeartbeatLabel(day.status)}`}
          />
        ))}
      </div>

          </GlowCard>
  );
};
