import React from 'react';
import { GripVertical, Settings, Map as MapIcon } from 'lucide-react';
import { GlowCard } from '../ui';
import type { CustomLayoutWidget, Website } from '../../types';
import CheckMapView from '../check/CheckMapView';

interface MapWidgetProps {
  widget: CustomLayoutWidget;
  checks: Website[];
  editMode: boolean;
  onConfigure: (widgetId: string) => void;
}

export const MapWidget: React.FC<MapWidgetProps> = ({
  widget,
  checks,
  editMode,
  onConfigure,
}) => {
  // Filter to only checks with geo data
  const geoChecks = checks.filter(
    (c) =>
      typeof c.targetLatitude === 'number' &&
      typeof c.targetLongitude === 'number' &&
      Number.isFinite(c.targetLatitude) &&
      Number.isFinite(c.targetLongitude)
  );

  if (geoChecks.length === 0) {
    return (
      <GlowCard className="group p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        {editMode && (
          <>
            <div className="drag-handle absolute top-1 left-1 p-2 cursor-grab active:cursor-grabbing rounded hover:bg-muted/50 opacity-0 group-hover:opacity-100 transition-opacity">
              <GripVertical className="w-5 h-5 text-muted-foreground" />
            </div>
            <button
              type="button"
              onClick={() => onConfigure(widget.id)}
              className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-background z-10 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Configure widget"
            >
              <Settings className="w-4 h-4 text-muted-foreground" />
            </button>
            <div className="absolute bottom-2 right-2 pointer-events-none">
              <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/50">
                <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          </>
        )}
        <MapIcon className="w-8 h-8 text-muted-foreground/50" />
        <div className="text-sm text-muted-foreground text-center">
          No geo data available
        </div>
        <p className="text-xs text-muted-foreground/70 text-center max-w-[200px]">
          Geographic locations will appear once checks have run and resolved their targets.
        </p>
      </GlowCard>
    );
  }

  return (
    <GlowCard className="group h-full flex flex-col min-w-0 overflow-hidden p-0">
      {editMode && (
        <>
          <div className="drag-handle absolute top-2 left-2 p-1.5 cursor-grab active:cursor-grabbing rounded-md bg-background/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-background z-20 opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical className="w-4 h-4 text-muted-foreground" />
          </div>
          <button
            type="button"
            onClick={() => onConfigure(widget.id)}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border/50 shadow-sm hover:bg-background z-20 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Configure widget"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </button>
          <div className="absolute bottom-2 right-2 pointer-events-none z-20">
            <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/60">
              <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
        </>
      )}

      <div className="flex-1 min-h-0 [&_.flex-col]:h-full [&_.flex-col]:min-h-0 [&>div]:h-full">
        <CheckMapView checks={checks} hideHeader />
      </div>
    </GlowCard>
  );
};
