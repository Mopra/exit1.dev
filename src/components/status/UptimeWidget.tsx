import React from 'react';
import { TrendingUp } from 'lucide-react';
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

interface UptimeWidgetProps {
  widget: CustomLayoutWidget;
  checks: BadgeData[];
  heartbeats: HeartbeatDay[][];  // Array of heartbeat arrays, one per check
  editMode: boolean;
}

const calculateUptime = (heartbeat: HeartbeatDay[]): number | null => {
  const daysWithData = heartbeat.filter((d) => d.totalChecks > 0);
  if (daysWithData.length === 0) return null;

  const totalChecks = daysWithData.reduce((sum, d) => sum + d.totalChecks, 0);
  const onlineChecks = daysWithData.reduce((sum, d) => sum + d.onlineChecks, 0);
  if (totalChecks === 0) return null;

  return (onlineChecks / totalChecks) * 100;
};

const calculateAverageUptime = (heartbeats: HeartbeatDay[][]): number | null => {
  const uptimes = heartbeats
    .map((hb) => calculateUptime(hb))
    .filter((u): u is number => u !== null);

  if (uptimes.length === 0) return null;
  return uptimes.reduce((sum, u) => sum + u, 0) / uptimes.length;
};

const getUptimeColor = (uptime: number | null): string => {
  if (uptime === null) return 'text-muted-foreground';
  if (uptime >= 99.9) return 'text-success';
  if (uptime >= 99) return 'text-success/80';
  if (uptime >= 95) return 'text-warning';
  return 'text-destructive';
};

const getUptimeBg = (uptime: number | null): string => {
  if (uptime === null) return '';
  if (uptime >= 99) return '';
  if (uptime >= 95) return 'bg-warning/5 border-warning/20';
  return 'bg-destructive/5 border-destructive/20';
};

const formatUptime = (uptime: number | null): string => {
  if (uptime === null) return '--';
  if (uptime >= 100) return '100%';
  // Floor to 1 decimal so we never round up to 100.0% when uptime is actually < 100%
  const floored = Math.floor(uptime * 10) / 10;
  return `${floored.toFixed(1)}%`;
};

export const UptimeWidget: React.FC<UptimeWidgetProps> = ({
  widget,
  checks,
  heartbeats,
  editMode,
}) => {
  const isMultiCheck = checks.length > 1;
  const uptime = isMultiCheck
    ? calculateAverageUptime(heartbeats)
    : calculateUptime(heartbeats[0] || []);

  // Show check name only for single check and when enabled (default true for single, false for multi)
  const shouldShowCheckName = !isMultiCheck && (widget.showCheckName ?? true);

  if (checks.length === 0) {
    return (
      <GlowCard className="p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        <TrendingUp className="w-8 h-8 text-muted-foreground/50" />
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
    <GlowCard className={`p-5 h-full flex flex-col min-w-0 ${getUptimeBg(uptime)}`}>
      <div className="flex-1 flex flex-col items-center justify-center gap-1">
        <div className={`text-4xl font-bold tabular-nums ${getUptimeColor(uptime)}`}>
          {formatUptime(uptime)}
        </div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide font-medium">
          {isMultiCheck ? 'Avg Uptime' : 'Uptime'}
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
