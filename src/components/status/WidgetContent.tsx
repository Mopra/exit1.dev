import React from 'react';
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

interface WidgetContentProps {
  widget: CustomLayoutWidget;
  check: BadgeData | null;
  heartbeat: HeartbeatDay[];
  editMode: boolean;
  onConfigure: (widgetId: string) => void;
}

const getHealthTone = (status?: string) => {
  switch (status) {
    case 'UP':
      return 'bg-emerald-500';
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
    case 'UP':
      return 'Operational';
    case 'DOWN':
      return 'Down';
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

export const WidgetContent: React.FC<WidgetContentProps> = ({
  widget,
  check,
  heartbeat,
  editMode,
  onConfigure,
}) => {
  // Fallback heartbeat if none provided
  const displayHeartbeat = heartbeat.length > 0
    ? heartbeat
    : Array.from({ length: 30 }, (_, i) => ({
        day: Date.now() - i * 86400000,
        status: 'unknown' as const,
      })).reverse();

  if (!check) {
    return (
      <GlowCard className="p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        {editMode && (
          <>
            <div className="drag-handle absolute top-1 left-1 p-2 cursor-grab active:cursor-grabbing rounded hover:bg-muted/50">
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
    <GlowCard className={`p-5 h-full flex flex-col min-w-0 ${getHealthSurface(check.status)}`}>
      {editMode && (
        <>
          <div className="drag-handle absolute top-1 left-1 p-2 cursor-grab active:cursor-grabbing rounded hover:bg-muted/50 z-10">
            <GripVertical className="w-5 h-5 text-muted-foreground" />
          </div>
          <button
            type="button"
            onClick={() => onConfigure(widget.id)}
            className="absolute top-2 right-2 p-1 rounded hover:bg-muted/50 z-10 cursor-pointer"
            aria-label="Configure widget"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </button>
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/50">
              <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </>
      )}

      <div className="flex items-start justify-between gap-4 mb-auto">
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

      <div className="grid grid-cols-[repeat(30,minmax(0,1fr))] gap-0.5 w-full mt-4 overflow-hidden">
        {displayHeartbeat.map((day, index) => (
          <span
            key={`${widget.id}-${day.day}-${index}`}
            className={`aspect-square w-full rounded-full ${getHeartbeatTone(day.status)}`}
            title={`${format(new Date(day.day), 'MMM d')} - ${getHeartbeatLabel(day.status)}`}
          />
        ))}
      </div>
    </GlowCard>
  );
};
