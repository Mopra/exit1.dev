import React, { useState, useCallback, useMemo } from 'react';
import { GridLayout, verticalCompactor } from 'react-grid-layout';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { WidgetToolbar } from './WidgetToolbar';
import { WidgetConfigSheet } from './WidgetConfigSheet';
import { TimelineWidget } from './TimelineWidget';
import { TextWidget } from './TextWidget';
import { UptimeWidget } from './UptimeWidget';
import { IncidentsWidget } from './IncidentsWidget';
import { DowntimeWidget } from './DowntimeWidget';
import { MapWidget } from './MapWidget';
import { StatusWidget } from './StatusWidget';
import type { CustomLayoutWidget, CustomLayoutConfig, WidgetType, TextWidgetSize, IncidentsMode, DowntimeMode, Website } from '../../types';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

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
}

interface CustomLayoutEditorProps {
  initialLayout: CustomLayoutConfig | null;
  checks: BadgeData[];
  fullChecks?: Website[];  // Full Website data for map widget
  heartbeatMap: Record<string, HeartbeatDay[]>;
  onSave: (layout: CustomLayoutConfig) => Promise<void>;
  onCancel: () => void;
}

const GRID_COLS = 12;
const ROW_HEIGHT = 120;
const MARGIN: readonly [number, number] = [16, 16];

const generateWidgetId = () => {
  return `widget-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
};

// Convert our widget format to react-grid-layout format
const widgetsToLayout = (widgets: CustomLayoutWidget[]): LayoutItem[] => {
  return widgets.map((widget) => {
    let minW = 4;
    let minH = 1;
    if (widget.type === 'uptime' || widget.type === 'incidents' || widget.type === 'downtime' || widget.type === 'text' || widget.type === 'status') {
      minW = 2;
    } else if (widget.type === 'map') {
      minW = 6;
      minH = 3;
    }
    return {
      i: widget.id,
      x: widget.gridPosition.col - 1, // Our format is 1-indexed, RGL is 0-indexed
      y: widget.gridPosition.row - 1,
      w: widget.gridPosition.colSpan,
      h: widget.gridPosition.rowSpan,
      minW,
      minH,
    };
  });
};

// Convert react-grid-layout format back to our widget format
const layoutToWidgets = (
  layout: Layout,
  existingWidgets: CustomLayoutWidget[]
): CustomLayoutWidget[] => {
  return layout.map((item) => {
    const existing = existingWidgets.find((w) => w.id === item.i);
    return {
      id: item.i,
      type: existing?.type ?? 'timeline',
      checkId: existing?.checkId,
      checkIds: existing?.checkIds,
      textContent: existing?.textContent,
      textSize: existing?.textSize,
      showCheckName: existing?.showCheckName,
      showCheckCount: existing?.showCheckCount,
      showStatus: existing?.showStatus,
      gridPosition: {
        col: item.x + 1, // Convert back to 1-indexed
        row: item.y + 1,
        colSpan: item.w,
        rowSpan: item.h,
      },
    };
  });
};

export const CustomLayoutEditor: React.FC<CustomLayoutEditorProps> = ({
  initialLayout,
  checks,
  fullChecks = [],
  heartbeatMap,
  onSave,
  onCancel,
}) => {
  const [widgets, setWidgets] = useState<CustomLayoutWidget[]>(
    initialLayout?.widgets ?? []
  );
  const [configWidgetId, setConfigWidgetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [containerWidth, setContainerWidth] = useState(1200);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      const updateWidth = () => setContainerWidth(node.offsetWidth);
      updateWidth();
      const resizeObserver = new ResizeObserver(updateWidth);
      resizeObserver.observe(node);
      return () => resizeObserver.disconnect();
    }
  }, []);

  const layout = useMemo(() => widgetsToLayout(widgets), [widgets]);

  const handleLayoutChange = (newLayout: Layout) => {
    const updatedWidgets = layoutToWidgets(newLayout, widgets);
    setWidgets(updatedWidgets);
    setHasChanges(true);
  };

  const handleAddWidget = (type: WidgetType) => {
    // Find the next available position
    let maxY = 0;
    for (const widget of widgets) {
      const bottom = widget.gridPosition.row - 1 + widget.gridPosition.rowSpan;
      if (bottom > maxY) maxY = bottom;
    }

    const isTextWidget = type === 'text';
    const isCompactWidget = type === 'uptime' || type === 'incidents' || type === 'downtime' || type === 'status';
    const isMapWidget = type === 'map';

    const newWidget: CustomLayoutWidget = {
      id: generateWidgetId(),
      type,
      checkId: isTextWidget || isMapWidget ? undefined : '',
      textContent: isTextWidget ? '' : undefined,
      gridPosition: {
        col: 1,
        row: maxY + 1,
        colSpan: isMapWidget ? 12 : isTextWidget ? 4 : isCompactWidget ? 2 : 4,
        rowSpan: isMapWidget ? 4 : isTextWidget ? 1 : 2,
      },
    };

    setWidgets((prev) => [...prev, newWidget]);
    setHasChanges(true);
  };

  const handleConfigureWidget = (widgetId: string) => {
    setConfigWidgetId(widgetId);
  };

  const handleWidgetConfigSave = (widgetId: string, checkId: string, showCheckName?: boolean) => {
    setWidgets((prev) =>
      prev.map((w) => (w.id === widgetId ? { ...w, checkId, showCheckName } : w))
    );
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetUptimeSave = (widgetId: string, checkIds: string[], showCheckName?: boolean) => {
    setWidgets((prev) =>
      prev.map((w) =>
        w.id === widgetId
          ? { ...w, checkIds, checkId: checkIds[0], showCheckName }
          : w
      )
    );
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetIncidentsSave = (widgetId: string, checkIds: string[], showCheckName?: boolean, incidentsMode?: IncidentsMode) => {
    setWidgets((prev) =>
      prev.map((w) =>
        w.id === widgetId
          ? { ...w, checkIds, checkId: checkIds[0], showCheckName, incidentsMode }
          : w
      )
    );
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetDowntimeSave = (widgetId: string, checkIds: string[], showCheckName?: boolean, downtimeMode?: DowntimeMode) => {
    setWidgets((prev) =>
      prev.map((w) =>
        w.id === widgetId
          ? { ...w, checkIds, checkId: checkIds[0], showCheckName, downtimeMode }
          : w
      )
    );
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetTimelineSave = (widgetId: string, checkIds: string[], showCheckName?: boolean, showCheckCount?: boolean, showStatus?: boolean) => {
    setWidgets((prev) =>
      prev.map((w) =>
        w.id === widgetId
          ? { ...w, checkIds, checkId: checkIds[0], showCheckName, showCheckCount, showStatus }
          : w
      )
    );
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetStatusSave = (widgetId: string, checkIds: string[], showCheckName?: boolean) => {
    setWidgets((prev) =>
      prev.map((w) =>
        w.id === widgetId
          ? { ...w, checkIds, checkId: checkIds[0], showCheckName }
          : w
      )
    );
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetTextSave = (widgetId: string, textContent: string, textSize: TextWidgetSize) => {
    setWidgets((prev) =>
      prev.map((w) => (w.id === widgetId ? { ...w, textContent, textSize } : w))
    );
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetDelete = (widgetId: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Strip undefined values from widgets (Firebase doesn't accept undefined)
      const cleanWidgets = widgets.map((widget) => {
        const clean: CustomLayoutWidget = {
          id: widget.id,
          type: widget.type,
          gridPosition: widget.gridPosition,
        };
        if (widget.checkId !== undefined) clean.checkId = widget.checkId;
        if (widget.checkIds !== undefined && widget.checkIds.length > 0) clean.checkIds = widget.checkIds;
        if (widget.textContent !== undefined) clean.textContent = widget.textContent;
        if (widget.textSize !== undefined) clean.textSize = widget.textSize;
        if (widget.showCheckName !== undefined) clean.showCheckName = widget.showCheckName;
        if (widget.showCheckCount !== undefined) clean.showCheckCount = widget.showCheckCount;
        if (widget.showStatus !== undefined) clean.showStatus = widget.showStatus;
        if (widget.incidentsMode !== undefined) clean.incidentsMode = widget.incidentsMode;
        if (widget.downtimeMode !== undefined) clean.downtimeMode = widget.downtimeMode;
        return clean;
      });

      await onSave({
        widgets: cleanWidgets,
        gridColumns: GRID_COLS,
        rowHeight: ROW_HEIGHT,
      });
      setHasChanges(false);
    } finally {
      setSaving(false);
    }
  };

  const getCheckForWidget = (widget: CustomLayoutWidget): BadgeData | null => {
    return checks.find((check) => check.checkId === widget.checkId) || null;
  };

  const getChecksForWidget = (widget: CustomLayoutWidget): BadgeData[] => {
    const ids = widget.checkIds?.length ? widget.checkIds : widget.checkId ? [widget.checkId] : [];
    return ids.map((id) => checks.find((c) => c.checkId === id)).filter((c): c is BadgeData => !!c);
  };

  const getHeartbeatForWidget = (widget: CustomLayoutWidget): HeartbeatDay[] => {
    return heartbeatMap[widget.checkId ?? ''] || [];
  };

  const getHeartbeatsForWidget = (widget: CustomLayoutWidget): HeartbeatDay[][] => {
    const ids = widget.checkIds?.length ? widget.checkIds : widget.checkId ? [widget.checkId] : [];
    return ids.map((id) => heartbeatMap[id] || []);
  };

  const configWidget = configWidgetId
    ? widgets.find((w) => w.id === configWidgetId) ?? null
    : null;

  return (
    <div className="pb-24">
      <div ref={containerRef} className="relative min-h-[400px]">
        {widgets.length === 0 ? (
          <div className="flex items-center justify-center min-h-[400px] border-2 border-dashed border-muted-foreground/20 rounded-lg m-4">
            <div className="text-center text-muted-foreground">
              <p className="text-sm font-medium">No widgets yet</p>
              <p className="text-xs mt-1">
                Click "Add Widget" in the toolbar below to get started
              </p>
            </div>
          </div>
        ) : (
          <GridLayout
            className="layout"
            layout={layout}
            width={containerWidth}
            gridConfig={{
              cols: GRID_COLS,
              rowHeight: ROW_HEIGHT,
              margin: MARGIN,
            }}
            dragConfig={{
              enabled: true,
              handle: '.drag-handle',
            }}
            resizeConfig={{
              enabled: true,
            }}
            compactor={verticalCompactor}
            onLayoutChange={handleLayoutChange}
          >
            {widgets.map((widget) => (
              <div key={widget.id}>
                {widget.type === 'text' ? (
                  <TextWidget
                    widget={widget}
                    editMode={true}
                    onConfigure={handleConfigureWidget}
                  />
                ) : widget.type === 'uptime' ? (
                  <UptimeWidget
                    widget={widget}
                    checks={getChecksForWidget(widget)}
                    heartbeats={getHeartbeatsForWidget(widget)}
                    editMode={true}
                    onConfigure={handleConfigureWidget}
                  />
                ) : widget.type === 'incidents' ? (
                  <IncidentsWidget
                    widget={widget}
                    checks={getChecksForWidget(widget)}
                    heartbeats={getHeartbeatsForWidget(widget)}
                    editMode={true}
                    onConfigure={handleConfigureWidget}
                  />
                ) : widget.type === 'downtime' ? (
                  <DowntimeWidget
                    widget={widget}
                    checks={getChecksForWidget(widget)}
                    heartbeats={getHeartbeatsForWidget(widget)}
                    editMode={true}
                    onConfigure={handleConfigureWidget}
                  />
                ) : widget.type === 'status' ? (
                  <StatusWidget
                    widget={widget}
                    checks={getChecksForWidget(widget)}
                    editMode={true}
                    onConfigure={handleConfigureWidget}
                  />
                ) : widget.type === 'map' ? (
                  <MapWidget
                    widget={widget}
                    checks={fullChecks}
                    editMode={true}
                    onConfigure={handleConfigureWidget}
                  />
                ) : (
                  <TimelineWidget
                    widget={widget}
                    check={getCheckForWidget(widget)}
                    heartbeat={getHeartbeatForWidget(widget)}
                    checks={getChecksForWidget(widget)}
                    heartbeats={getHeartbeatsForWidget(widget)}
                    editMode={true}
                    onConfigure={handleConfigureWidget}
                  />
                )}
              </div>
            ))}
          </GridLayout>
        )}
      </div>

      <WidgetToolbar
        onAddWidget={handleAddWidget}
        onSave={handleSave}
        onCancel={onCancel}
        saving={saving}
        hasUnsavedChanges={hasChanges}
      />

      <WidgetConfigSheet
        isOpen={!!configWidgetId}
        widget={configWidget}
        checks={checks}
        onSave={handleWidgetConfigSave}
        onSaveTimeline={handleWidgetTimelineSave}
        onSaveUptime={handleWidgetUptimeSave}
        onSaveIncidents={handleWidgetIncidentsSave}
        onSaveDowntime={handleWidgetDowntimeSave}
        onSaveStatus={handleWidgetStatusSave}
        onSaveText={handleWidgetTextSave}
        onClose={() => setConfigWidgetId(null)}
        onDelete={handleWidgetDelete}
      />
    </div>
  );
};
