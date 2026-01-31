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

// Configuration for bar sizing
const BAR_MIN_WIDTH = 4;
const BAR_GAP = 2;
const MAX_DAYS = 90;

export const TimelineWidget: React.FC<TimelineWidgetProps> = ({
  widget,
  check,
  heartbeat,
  editMode,
  onConfigure,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleDays, setVisibleDays] = useState(30);

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
      const targetDays = Math.min(maxBarsAtMinWidth, MAX_DAYS, heartbeat.length || 30);

      setVisibleDays(Math.max(7, targetDays)); // Minimum 7 days
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [heartbeat.length]);

  // Generate display data - take the most recent N days
  const displayHeartbeat = React.useMemo(() => {
    if (heartbeat.length > 0) {
      // Take the last N days (most recent)
      return heartbeat.slice(-visibleDays);
    }
    // Fallback: generate placeholder data
    return Array.from({ length: visibleDays }, (_, i) => ({
      day: Date.now() - (visibleDays - 1 - i) * 86400000,
      status: 'unknown' as const,
    }));
  }, [heartbeat, visibleDays]);

  if (!check) {
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

  return (
    <GlowCard className={`group p-5 h-full flex flex-col gap-3 min-w-0 ${getHealthSurface(check.status)}`}>
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

      {/* Header with name and status */}
      <div className="flex items-start justify-between gap-4 shrink-0">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-semibold text-foreground truncate">
            {check.name}
          </div>
          <div className="text-xs text-muted-foreground break-all line-clamp-1">
            {check.url}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`h-2.5 w-2.5 rounded-full ${getHealthTone(check.status)}`} />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {getHealthLabel(check.status)}
          </span>
        </div>
      </div>

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
