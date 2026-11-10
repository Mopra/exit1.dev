import React, { useMemo } from 'react';
import { TimelineWidget } from './TimelineWidget';
import { TextWidget } from './TextWidget';
import { UptimeWidget } from './UptimeWidget';
import { IncidentsWidget } from './IncidentsWidget';
import { DowntimeWidget } from './DowntimeWidget';
import { MapWidget } from './MapWidget';
import { StatusWidget } from './StatusWidget';
import type { CustomLayoutWidget, Website } from '../../types';
import { WidgetEditChrome, isWidgetConfigured, resolveWidgetCheckIds } from './WidgetEditChrome';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  status?: string;
  folder?: string | null;
}

interface HeartbeatDay {
  day: number;
  status: 'online' | 'offline' | 'unknown';
  totalChecks: number;
  issueCount: number;
  onlineChecks: number;
  offlineChecks: number;
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

// Pull every widget up as far as it goes without overlapping another one,
// the same way the editor's grid compacts.
const compactVertically = (widgets: CustomLayoutWidget[]): CustomLayoutWidget[] => {
  const sorted = [...widgets].sort(
    (a, b) => a.gridPosition.row - b.gridPosition.row || a.gridPosition.col - b.gridPosition.col
  );
  const placed: CustomLayoutWidget[] = [];
  const collides = (pos: CustomLayoutWidget['gridPosition']) =>
    placed.some((p) => {
      const q = p.gridPosition;
      return (
        pos.col < q.col + q.colSpan &&
        q.col < pos.col + pos.colSpan &&
        pos.row < q.row + q.rowSpan &&
        q.row < pos.row + pos.rowSpan
      );
    });
  for (const widget of sorted) {
    const pos = { ...widget.gridPosition };
    while (pos.row > 1 && !collides({ ...pos, row: pos.row - 1 })) pos.row -= 1;
    placed.push({ ...widget, gridPosition: pos });
  }
  return placed;
};

interface WidgetBodyProps {
  widget: CustomLayoutWidget;
  /** Every check on the page; the widget's own checks are resolved from these. */
  checks: BadgeData[];
  fullChecks: Website[];
  heartbeatMap: Record<string, HeartbeatDay[]>;
  editMode: boolean;
}

/** Renders one widget of any type. Shared by the public grid and the editor. */
export const WidgetBody: React.FC<WidgetBodyProps> = ({ widget, checks, fullChecks, heartbeatMap, editMode }) => {
  const ids = resolveWidgetCheckIds(widget, checks);
  const widgetChecks = ids
    .map((id) => checks.find((c) => c.checkId === id))
    .filter((c): c is BadgeData => !!c)
    .map((badgeCheck) => {
      // Use real-time status from fullChecks when available (has Firebase listeners)
      const fullCheck = fullChecks.find((c) => c.id === badgeCheck.checkId);
      return fullCheck?.status ? { ...badgeCheck, status: fullCheck.status } : badgeCheck;
    });
  const heartbeats = widgetChecks.map((c) => heartbeatMap[c.checkId] || []);

  switch (widget.type) {
    case 'text':
      return <TextWidget widget={widget} editMode={editMode} />;
    case 'uptime':
      return <UptimeWidget widget={widget} checks={widgetChecks} heartbeats={heartbeats} editMode={editMode} />;
    case 'incidents':
      return <IncidentsWidget widget={widget} checks={widgetChecks} heartbeats={heartbeats} editMode={editMode} />;
    case 'downtime':
      return <DowntimeWidget widget={widget} checks={widgetChecks} heartbeats={heartbeats} editMode={editMode} />;
    case 'status':
      return <StatusWidget widget={widget} checks={widgetChecks} editMode={editMode} />;
    case 'map':
      return <MapWidget widget={widget} checks={fullChecks} editMode={editMode} />;
    default:
      // The single check comes from the resolved list, so a folder-only
      // selection still renders.
      return (
        <TimelineWidget
          widget={widget}
          check={widgetChecks[0] ?? null}
          heartbeat={heartbeats[0] ?? []}
          checks={widgetChecks}
          heartbeats={heartbeats}
          editMode={editMode}
        />
      );
  }
};

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
  // Visitors never see unfinished widgets. Hiding them leaves holes, so the
  // remaining widgets are pulled up to close the gaps.
  const visibleWidgets = useMemo(() => {
    // Until check data has arrived (or when a refresh failed) every check
    // widget would look unconfigured. Keep the saved shape instead.
    if (editMode || checks.length === 0) return widgets;
    const configured = widgets.filter((w) => isWidgetConfigured(w, checks));
    return configured.length === widgets.length ? widgets : compactVertically(configured);
  }, [widgets, checks, editMode]);

  // Calculate the number of rows needed based on widgets
  const maxRow = visibleWidgets.reduce((max, widget) => {
    const widgetEnd = widget.gridPosition.row + widget.gridPosition.rowSpan - 1;
    return Math.max(max, widgetEnd);
  }, 3); // Minimum 3 rows

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
      {visibleWidgets.length === 0 && (
        <div
          className="col-span-full row-span-3 flex items-center justify-center border-2 border-dashed border-muted-foreground/20 rounded-lg"
        >
          <div className="text-center text-muted-foreground">
            <p className="text-sm font-medium">No widgets configured</p>
          </div>
        </div>
      )}

      {visibleWidgets.map((widget) => (
        <div
          key={widget.id}
          style={{
            gridColumn: `${widget.gridPosition.col} / span ${widget.gridPosition.colSpan}`,
            gridRow: `${widget.gridPosition.row} / span ${widget.gridPosition.rowSpan}`,
          }}
        >
          <WidgetEditChrome
            widgetId={widget.id}
            editMode={editMode}
            configured={isWidgetConfigured(widget, checks)}
            onConfigure={onConfigureWidget}
          >
            <WidgetBody
              widget={widget}
              checks={checks}
              fullChecks={fullChecks}
              heartbeatMap={heartbeatMap}
              editMode={editMode}
            />
          </WidgetEditChrome>
        </div>
      ))}
    </div>
  );
};
