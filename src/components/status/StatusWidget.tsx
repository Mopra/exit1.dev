import React from 'react';
import { Activity } from 'lucide-react';
import type { CustomLayoutWidget } from '../../types';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  status?: string;
}

interface StatusWidgetProps {
  widget: CustomLayoutWidget;
  checks: BadgeData[];
  editMode: boolean;
}

const getAggregatedStatus = (checks: BadgeData[]) => {
  if (checks.length === 0) {
    return { label: 'Unknown', bg: 'bg-muted', textColor: 'text-muted-foreground' };
  }

  const isOnline = (c: BadgeData) => c.status === 'online' || c.status === 'UP' || c.status === 'REDIRECT';
  const isOffline = (c: BadgeData) => c.status === 'offline' || c.status === 'DOWN';
  const isDegraded = (c: BadgeData) => c.status === 'REACHABLE_WITH_ERROR';
  const onlineCount = checks.filter(isOnline).length;
  const offlineCount = checks.filter(isOffline).length;
  const degradedCount = checks.filter(isDegraded).length;

  if (checks.length === 1) {
    const check = checks[0];
    if (isOnline(check)) return { label: 'Online', bg: 'bg-success', textColor: 'text-success-foreground' };
    if (isOffline(check)) return { label: 'Offline', bg: 'bg-destructive', textColor: 'text-destructive-foreground' };
    if (isDegraded(check)) return { label: 'Degraded', bg: 'bg-warning', textColor: 'text-warning-foreground' };
    if (check.status === 'disabled') return { label: 'Paused', bg: 'bg-muted-foreground/80', textColor: 'text-white' };
    return { label: 'Unknown', bg: 'bg-muted-foreground/80', textColor: 'text-white' };
  }

  if (onlineCount === checks.length) {
    return { label: 'All Online', bg: 'bg-success', textColor: 'text-success-foreground' };
  } else if (offlineCount === checks.length) {
    return { label: 'All Offline', bg: 'bg-destructive', textColor: 'text-destructive-foreground' };
  } else if (offlineCount > 0) {
    return {
      label: `${onlineCount} of ${checks.length} Online`,
      bg: 'bg-warning',
      textColor: 'text-warning-foreground',
    };
  } else if (degradedCount > 0) {
    return {
      label: degradedCount === checks.length ? 'All Degraded' : `${degradedCount} Degraded`,
      bg: 'bg-warning',
      textColor: 'text-warning-foreground',
    };
  }
  return { label: 'Unknown', bg: 'bg-muted-foreground/80', textColor: 'text-white' };
};

export const StatusWidget: React.FC<StatusWidgetProps> = ({
  widget,
  checks,
  editMode,
}) => {
  const shouldShowCheckName = checks.length === 1 && (widget.showCheckName ?? true);

  if (checks.length === 0) {
    return (
      <div className="relative h-full rounded-xl bg-muted border border-border flex flex-col items-center justify-center gap-2 p-5">
        <Activity className="w-8 h-8 text-muted-foreground/50" />
        <div className="text-sm text-muted-foreground text-center">
          No check selected
        </div>
        {editMode && (
          <span className="text-xs text-primary">Click to choose checks</span>
        )}
      </div>
    );
  }

  const status = getAggregatedStatus(checks);

  return (
    <div className={`relative h-full rounded-xl ${status.bg} ${status.textColor} flex flex-col items-center justify-center p-5 transition-colors`}>
      <div className="text-3xl font-bold tracking-tight">{status.label}</div>
      {shouldShowCheckName && checks[0] && (
        <div className="text-sm opacity-80 mt-1 truncate max-w-full">
          {checks[0].name}
        </div>
      )}
    </div>
  );
};
