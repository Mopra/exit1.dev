import React from 'react';
import { AlertTriangle } from 'lucide-react';
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
  if (count === 0) return 'text-success';
  if (count <= 2) return 'text-warning';
  return 'text-destructive';
};

const getIncidentBg = (count: number): string => {
  if (count === 0) return '';
  if (count <= 2) return 'bg-warning/5 border-warning/20';
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
      <GlowCard className="p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        <AlertTriangle className="w-8 h-8 text-muted-foreground/50" />
        <div className="text-sm text-muted-foreground text-center">
          No check selected
        </div>
        {editMode && (
          <span className="text-xs text-primary">Click to choose checks</span>
        )}
      </GlowCard>
    );
  }

  return (
    <GlowCard className={`p-5 h-full flex flex-col min-w-0 ${getIncidentBg(incidentCount)}`}>
      <div className="flex-1 flex flex-col items-center justify-center gap-1">
        <div className={`text-4xl font-bold tabular-nums ${getIncidentColor(incidentCount)}`}>
          {formatIncidentCount(incidentCount, isAverage)}
        </div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
          {isAverage ? 'Avg Incidents' : incidentCount === 1 ? 'Incident' : 'Incidents'}
        </div>
        <div className="text-[10px] text-muted-foreground/70">Last 90 days</div>
      </div>

      {shouldShowCheckName && checks[0] && (
        <div className="text-sm font-semibold text-foreground truncate text-center mt-auto">
          {checks[0].name}
        </div>
      )}
    </GlowCard>
  );
};
