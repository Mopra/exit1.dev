import React from 'react';
import { TimelineWidget } from './TimelineWidget';
import { TextWidget } from './TextWidget';
import { UptimeWidget } from './UptimeWidget';
import { IncidentsWidget } from './IncidentsWidget';
import { DowntimeWidget } from './DowntimeWidget';
import { MapWidget } from './MapWidget';
import type { CustomLayoutWidget, Website } from '../../types';

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

interface WidgetGridProps {
  widgets: CustomLayoutWidget[];
  checks: BadgeData[];
  fullChecks?: Website[];  // Full Website data for map widget
  heartbeatMap: Record<string, HeartbeatDay[]>;
  editMode: boolean;
  onConfigureWidget: (widgetId: string) => void;
  columns?: number;
  rowHeight?: number;
}

export const WidgetGrid: React.FC<WidgetGridProps> = ({
  widgets,
  checks,
  fullChecks = [],
  heartbeatMap,
  editMode,
  onConfigureWidget,
  columns = 12,
  rowHeight = 120,
}) => {
  // Calculate the number of rows needed based on widgets
  const maxRow = widgets.reduce((max, widget) => {
    const widgetEnd = widget.gridPosition.row + widget.gridPosition.rowSpan - 1;
    return Math.max(max, widgetEnd);
  }, 3); // Minimum 3 rows

  const getCheckForWidget = (widget: CustomLayoutWidget): BadgeData | null => {
    const badgeCheck = checks.find((check) => check.checkId === widget.checkId) || null;
    if (!badgeCheck) return null;

    // Use real-time status from fullChecks when available (has Firebase listeners)
    const fullCheck = fullChecks.find((c) => c.id === widget.checkId);
    if (fullCheck?.status) {
      return { ...badgeCheck, status: fullCheck.status };
    }
    return badgeCheck;
  };

  const getChecksForWidget = (widget: CustomLayoutWidget): BadgeData[] => {
    const ids = widget.checkIds?.length ? widget.checkIds : widget.checkId ? [widget.checkId] : [];
    return ids
      .map((id) => {
        const badgeCheck = checks.find((c) => c.checkId === id);
        if (!badgeCheck) return null;
        // Use real-time status from fullChecks when available
        const fullCheck = fullChecks.find((c) => c.id === id);
        if (fullCheck?.status) {
          return { ...badgeCheck, status: fullCheck.status };
        }
        return badgeCheck;
      })
      .filter((c): c is BadgeData => !!c);
  };

  const getHeartbeatForWidget = (widget: CustomLayoutWidget): HeartbeatDay[] => {
    return heartbeatMap[widget.checkId ?? ''] || [];
  };

  const getHeartbeatsForWidget = (widget: CustomLayoutWidget): HeartbeatDay[][] => {
    const ids = widget.checkIds?.length ? widget.checkIds : widget.checkId ? [widget.checkId] : [];
    return ids.map((id) => heartbeatMap[id] || []);
  };

  return (
    <div
      className="relative min-h-[400px]"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gridAutoRows: `${rowHeight}px`,
        gap: '16px',
        padding: '16px',
        minHeight: `${maxRow * rowHeight + (maxRow - 1) * 16 + 32}px`,
      }}
    >
      {widgets.length === 0 && (
        <div
          className="col-span-full row-span-3 flex items-center justify-center border-2 border-dashed border-muted-foreground/20 rounded-lg"
        >
          <div className="text-center text-muted-foreground">
            <p className="text-sm font-medium">No widgets configured</p>
          </div>
        </div>
      )}

      {widgets.map((widget) => (
        <div
          key={widget.id}
          style={{
            gridColumn: `${widget.gridPosition.col} / span ${widget.gridPosition.colSpan}`,
            gridRow: `${widget.gridPosition.row} / span ${widget.gridPosition.rowSpan}`,
          }}
        >
          {widget.type === 'text' ? (
            <TextWidget
              widget={widget}
              editMode={editMode}
              onConfigure={onConfigureWidget}
            />
          ) : widget.type === 'uptime' ? (
            <UptimeWidget
              widget={widget}
              checks={getChecksForWidget(widget)}
              heartbeats={getHeartbeatsForWidget(widget)}
              editMode={editMode}
              onConfigure={onConfigureWidget}
            />
          ) : widget.type === 'incidents' ? (
            <IncidentsWidget
              widget={widget}
              checks={getChecksForWidget(widget)}
              heartbeats={getHeartbeatsForWidget(widget)}
              editMode={editMode}
              onConfigure={onConfigureWidget}
            />
          ) : widget.type === 'downtime' ? (
            <DowntimeWidget
              widget={widget}
              checks={getChecksForWidget(widget)}
              heartbeats={getHeartbeatsForWidget(widget)}
              editMode={editMode}
              onConfigure={onConfigureWidget}
            />
          ) : widget.type === 'map' ? (
            <MapWidget
              widget={widget}
              checks={fullChecks}
              editMode={editMode}
              onConfigure={onConfigureWidget}
            />
          ) : (
            <TimelineWidget
              widget={widget}
              check={getCheckForWidget(widget)}
              heartbeat={getHeartbeatForWidget(widget)}
              editMode={editMode}
              onConfigure={onConfigureWidget}
            />
          )}
        </div>
      ))}
    </div>
  );
};
