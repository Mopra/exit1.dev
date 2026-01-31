import React from 'react';
import { GripVertical, Settings, AlertTriangle } from 'lucide-react';
import { GlowCard } from '../ui';
import type { CustomLayoutWidget } from '../../types';

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

interface IncidentsWidgetProps {
  widget: CustomLayoutWidget;
  checks: BadgeData[];
  heartbeats: HeartbeatDay[][];  // Array of heartbeat arrays, one per check
  editMode: boolean;
  onConfigure: (widgetId: string) => void;
}

const countIncidents = (heartbeat: HeartbeatDay[]): number => {
  return heartbeat.filter((d) => d.status === 'offline').length;
};

const countTotalIncidents = (heartbeats: HeartbeatDay[][]): number => {
  return heartbeats.reduce((total, hb) => total + countIncidents(hb), 0);
};

const calculateAverageIncidents = (heartbeats: HeartbeatDay[][]): number => {
  if (heartbeats.length === 0) return 0;
  const total = countTotalIncidents(heartbeats);
  return total / heartbeats.length;
};

const getIncidentColor = (count: number): string => {
  if (count === 0) return 'text-emerald-500';
  if (count <= 2) return 'text-amber-500';
  return 'text-destructive';
};

const getIncidentBg = (count: number): string => {
  if (count === 0) return '';
  if (count <= 2) return 'bg-amber-500/5 border-amber-500/20';
  return 'bg-destructive/5 border-destructive/20';
};

const formatIncidentCount = (count: number, isAverage: boolean): string => {
  if (isAverage && count % 1 !== 0) {
    return count.toFixed(1);
  }
  return Math.round(count).toString();
};

export const IncidentsWidget: React.FC<IncidentsWidgetProps> = ({
  widget,
  checks,
  heartbeats,
  editMode,
  onConfigure,
}) => {
  const isMultiCheck = checks.length > 1;
  const mode = widget.incidentsMode ?? 'total';
  const isAverage = mode === 'average';
  const incidentCount = isAverage
    ? calculateAverageIncidents(heartbeats)
    : countTotalIncidents(heartbeats);

  // Show check name only for single check and when enabled (default true for single, false for multi)
  const shouldShowCheckName = !isMultiCheck && (widget.showCheckName ?? true);

  if (checks.length === 0) {
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
        <AlertTriangle className="w-8 h-8 text-muted-foreground/50" />
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
    <GlowCard className={`group p-5 h-full flex flex-col min-w-0 ${getIncidentBg(incidentCount)}`}>
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

      <div className="flex-1 flex flex-col items-center justify-center gap-1">
        <div className={`text-4xl font-bold tabular-nums ${getIncidentColor(incidentCount)}`}>
          {formatIncidentCount(incidentCount, isAverage)}
        </div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
          {isAverage ? 'Avg Incidents' : incidentCount === 1 ? 'Incident' : 'Incidents'}
        </div>
      </div>

      {shouldShowCheckName && checks[0] && (
        <div className="text-sm font-semibold text-foreground truncate text-center mt-auto">
          {checks[0].name}
        </div>
      )}
    </GlowCard>
  );
};
