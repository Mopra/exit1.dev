import React from 'react';
import { GripVertical, Settings, Activity } from 'lucide-react';
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
  onConfigure: (widgetId: string) => void;
}

const getAggregatedStatus = (checks: BadgeData[]) => {
  if (checks.length === 0) {
    return { label: 'Unknown', bg: 'bg-muted', textColor: 'text-muted-foreground' };
  }

  const onlineCount = checks.filter(
    (c) => c.status === 'online' || c.status === 'UP'
  ).length;
  const offlineCount = checks.filter(
    (c) => c.status === 'offline' || c.status === 'DOWN'
  ).length;

  if (checks.length === 1) {
    const isOnline = onlineCount === 1;
    const isOffline = offlineCount === 1;
    return {
      label: isOnline ? 'Online' : isOffline ? 'Offline' : 'Unknown',
      bg: isOnline ? 'bg-emerald-500' : isOffline ? 'bg-red-500' : 'bg-muted-foreground/80',
      textColor: 'text-white',
    };
  }

  if (onlineCount === checks.length) {
    return { label: 'All Online', bg: 'bg-emerald-500', textColor: 'text-white' };
  } else if (offlineCount === checks.length) {
    return { label: 'All Offline', bg: 'bg-red-500', textColor: 'text-white' };
  } else if (offlineCount > 0) {
    return {
      label: `${onlineCount} of ${checks.length} Online`,
      bg: 'bg-amber-500',
      textColor: 'text-white',
    };
  }
  return { label: 'Unknown', bg: 'bg-muted-foreground/80', textColor: 'text-white' };
};

export const StatusWidget: React.FC<StatusWidgetProps> = ({
  widget,
  checks,
  editMode,
  onConfigure,
}) => {
  const shouldShowCheckName = checks.length === 1 && (widget.showCheckName ?? true);

  if (checks.length === 0) {
    return (
      <div className="group relative h-full rounded-xl bg-muted border border-border flex flex-col items-center justify-center gap-2 p-5">
        {editMode && (
          <>
            <div className="drag-handle absolute top-1 left-1 p-2 cursor-grab active:cursor-grabbing rounded hover:bg-muted-foreground/10 opacity-0 group-hover:opacity-100 transition-opacity">
              <GripVertical className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="absolute bottom-2 right-2 pointer-events-none">
              <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/50">
                <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          </>
        )}
        <Activity className="w-8 h-8 text-muted-foreground/50" />
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
      </div>
    );
  }

  const status = getAggregatedStatus(checks);

  return (
    <div className={`group relative h-full rounded-xl ${status.bg} ${status.textColor} flex flex-col items-center justify-center p-5 transition-colors`}>
      {editMode && (
        <>
          <div className="drag-handle absolute top-2 left-2 p-1.5 cursor-grab active:cursor-grabbing rounded-md bg-white/20 backdrop-blur-sm border border-white/30 shadow-sm hover:bg-white/30 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical className="w-4 h-4 text-white" />
          </div>
          <button
            type="button"
            onClick={() => onConfigure(widget.id)}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-white/20 backdrop-blur-sm border border-white/30 shadow-sm hover:bg-white/30 z-10 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Configure widget"
          >
            <Settings className="w-4 h-4 text-white" />
          </button>
          <div className="absolute bottom-2 right-2 pointer-events-none z-10">
            <svg width="14" height="14" viewBox="0 0 14 14" className="text-white/60">
              <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </>
      )}

      <div className="text-3xl font-bold tracking-tight">{status.label}</div>
      {shouldShowCheckName && checks[0] && (
        <div className="text-sm opacity-80 mt-1 truncate max-w-full">
          {checks[0].name}
        </div>
      )}
    </div>
  );
};
