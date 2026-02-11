import React from 'react';
import { GripVertical, Settings, TrendingUp } from 'lucide-react';
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

interface UptimeWidgetProps {
  widget: CustomLayoutWidget;
  checks: BadgeData[];
  heartbeats: HeartbeatDay[][];  // Array of heartbeat arrays, one per check
  editMode: boolean;
  onConfigure: (widgetId: string) => void;
}

const calculateUptime = (heartbeat: HeartbeatDay[]): number | null => {
  const knownDays = heartbeat.filter((d) => d.status !== 'unknown');
  if (knownDays.length === 0) return null;

  const onlineDays = knownDays.filter((d) => d.status === 'online').length;
  return (onlineDays / knownDays.length) * 100;
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
  if (uptime >= 99.9) return 'text-emerald-500';
  if (uptime >= 99) return 'text-emerald-400';
  if (uptime >= 95) return 'text-amber-500';
  return 'text-destructive';
};

const getUptimeBg = (uptime: number | null): string => {
  if (uptime === null) return '';
  if (uptime >= 99) return '';
  if (uptime >= 95) return 'bg-amber-500/5 border-amber-500/20';
  return 'bg-destructive/5 border-destructive/20';
};

const formatUptime = (uptime: number | null): string => {
  if (uptime === null) return '--';
  return `${Math.round(uptime)}%`;
};

export const UptimeWidget: React.FC<UptimeWidgetProps> = ({
  widget,
  checks,
  heartbeats,
  editMode,
  onConfigure,
}) => {
  const isMultiCheck = checks.length > 1;
  const uptime = isMultiCheck
    ? calculateAverageUptime(heartbeats)
    : calculateUptime(heartbeats[0] || []);

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
        <TrendingUp className="w-8 h-8 text-muted-foreground/50" />
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
    <GlowCard className={`group p-5 h-full flex flex-col min-w-0 ${getUptimeBg(uptime)}`}>
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
