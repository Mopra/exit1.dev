import React from 'react';
import { Clock } from 'lucide-react';
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
  totalChecks: number;
  issueCount: number;
  onlineChecks: number;
  offlineChecks: number;
}

interface DowntimeWidgetProps {
  widget: CustomLayoutWidget;
  checks: BadgeData[];
  heartbeats: HeartbeatDay[][];  // Array of heartbeat arrays, one per check
  editMode: boolean;
}

// Estimate downtime hours for a single check using per-day issue ratios
const calculateDowntimeHours = (heartbeat: HeartbeatDay[]): number => {
  let totalHours = 0;
  for (const day of heartbeat) {
    if (day.totalChecks > 0 && day.offlineChecks > 0) {
      totalHours += (day.offlineChecks / day.totalChecks) * 24;
    }
  }
  return totalHours;
};

const countTotalDowntimeHours = (heartbeats: HeartbeatDay[][]): number => {
  return heartbeats.reduce((total, hb) => total + calculateDowntimeHours(hb), 0);
};

const calculateAverageDowntimeHours = (heartbeats: HeartbeatDay[][]): number => {
  if (heartbeats.length === 0) return 0;
  const total = countTotalDowntimeHours(heartbeats);
  return total / heartbeats.length;
};

const getDowntimeColor = (hours: number): string => {
  if (hours === 0) return 'text-success';
  if (hours <= 48) return 'text-warning'; // Up to 2 days
  return 'text-destructive';
};

const getDowntimeBg = (hours: number): string => {
  if (hours === 0) return '';
  if (hours <= 48) return 'bg-warning/5 border-warning/20';
  return 'bg-destructive/5 border-destructive/20';
};

const formatDowntime = (hours: number): string => {
  if (hours === 0) return '0h';

  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const remainingAfterDays = totalMinutes % (24 * 60);
  const hoursLeft = Math.floor(remainingAfterDays / 60);
  const minutes = remainingAfterDays % 60;

  if (days > 0) {
    // Show as "Xd Yh"
    return `${days}d ${hoursLeft}h`;
  }
  // Show as "Xh Ym"
  return `${hoursLeft}h ${minutes}m`;
};

export const DowntimeWidget: React.FC<DowntimeWidgetProps> = ({
  widget,
  checks,
  heartbeats,
  editMode,
}) => {
  const isMultiCheck = checks.length > 1;
  const mode = widget.downtimeMode ?? 'total';
  const isAverage = mode === 'average';
  const downtimeHours = isAverage
    ? calculateAverageDowntimeHours(heartbeats)
    : countTotalDowntimeHours(heartbeats);

  // Show check name only for single check and when enabled (default true for single, false for multi)
  const shouldShowCheckName = !isMultiCheck && (widget.showCheckName ?? true);

  if (checks.length === 0) {
    return (
      <GlowCard className="p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        <Clock className="w-8 h-8 text-muted-foreground/50" />
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
    <GlowCard className={`p-5 h-full flex flex-col min-w-0 ${getDowntimeBg(downtimeHours)}`}>
      <div className="flex-1 flex flex-col items-center justify-center gap-1">
        <div className={`text-4xl font-bold tabular-nums ${getDowntimeColor(downtimeHours)}`}>
          {formatDowntime(downtimeHours)}
        </div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
          {isAverage ? 'Avg Downtime' : 'Downtime'}
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
