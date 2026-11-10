import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { GridLayout, verticalCompactor } from 'react-grid-layout';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { WidgetToolbar } from './WidgetToolbar';
import { WidgetConfigSheet } from './WidgetConfigSheet';
import { WidgetBody } from './WidgetGrid';
import { WidgetEditChrome, WIDGET_TYPES, isWidgetConfigured } from './WidgetEditChrome';
import { ConfirmationModal } from '../ui';
import type { CustomLayoutWidget, CustomLayoutConfig, WidgetType, Website } from '../../types';
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
  onlineChecks: number;
  offlineChecks: number;
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
      ...(existing ?? { type: 'timeline' as const }),
      id: item.i,
      gridPosition: {
        col: item.x + 1, // Convert back to 1-indexed
        row: item.y + 1,
        colSpan: item.w,
        rowSpan: item.h,
      },
    };
  });
};

const samePositions = (a: CustomLayoutWidget[], b: CustomLayoutWidget[]) =>
  a.length === b.length &&
  a.every((w) => {
    const other = b.find((o) => o.id === w.id);
    if (!other) return false;
    const p = w.gridPosition;
    const q = other.gridPosition;
    return p.col === q.col && p.row === q.row && p.colSpan === q.colSpan && p.rowSpan === q.rowSpan;
  });

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
  const [deleteWidgetId, setDeleteWidgetId] = useState<string | null>(null);
  const [scrollToId, setScrollToId] = useState<string | null>(null);
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
  const layoutSettledRef = useRef(widgets.length === 0);

  const handleLayoutChange = (newLayout: Layout) => {
    const updatedWidgets = layoutToWidgets(newLayout, widgets);
    // react-grid-layout also reports the layout on mount; only real moves count.
    if (samePositions(updatedWidgets, widgets)) return;
    setWidgets(updatedWidgets);
    // The first report is the grid compacting a saved layout with gaps. That is
    // not an edit, so it must not raise "unsaved changes".
    if (!layoutSettledRef.current) {
      layoutSettledRef.current = true;
      return;
    }
    setHasChanges(true);
  };

  // Bring a freshly added widget into view once the grid has placed it.
  useEffect(() => {
    if (!scrollToId) return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-widget-id="${scrollToId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setScrollToId(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollToId, widgets]);

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
    setScrollToId(newWidget.id);
    // Go straight to picking checks. The map needs no setup.
    if (!isMapWidget) setConfigWidgetId(newWidget.id);
  };

  const handleConfigureWidget = (widgetId: string) => {
    setConfigWidgetId(widgetId);
  };

  const handleWidgetSave = (widgetId: string, patch: Partial<CustomLayoutWidget>) => {
    setWidgets((prev) => prev.map((w) => (w.id === widgetId ? { ...w, ...patch } : w)));
    setHasChanges(true);
    setConfigWidgetId(null);
  };

  const handleWidgetDelete = (widgetId: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
    setHasChanges(true);
    setConfigWidgetId(null);
    setDeleteWidgetId(null);
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
        if (widget.checkId) clean.checkId = widget.checkId;
        if (widget.checkIds !== undefined && widget.checkIds.length > 0) clean.checkIds = widget.checkIds;
        if (widget.folderPaths !== undefined && widget.folderPaths.length > 0) clean.folderPaths = widget.folderPaths;
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

  const configWidget = configWidgetId
    ? widgets.find((w) => w.id === configWidgetId) ?? null
    : null;

  return (
    <div className="pb-24">
      <div ref={containerRef} className="relative min-h-[400px]">
        {widgets.length === 0 ? (
          <div className="flex items-center justify-center min-h-[400px] border-2 border-dashed border-muted-foreground/20 rounded-lg m-4 p-6">
            <div className="w-full max-w-2xl text-center">
              <p className="text-sm font-medium">No widgets yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Pick a widget to start your layout.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4 text-left">
                {WIDGET_TYPES.map(({ type, label, description, icon: Icon }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleAddWidget(type)}
                    className="flex items-start gap-3 text-left rounded-md border border-border/30 bg-card px-3 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer"
                  >
                    <Icon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{label}</span>
                      <span className="block text-xs text-muted-foreground">{description}</span>
                    </span>
                  </button>
                ))}
              </div>
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
              <div key={widget.id} data-widget-id={widget.id}>
                <WidgetEditChrome
                  widgetId={widget.id}
                  editMode
                  configured={isWidgetConfigured(widget, checks)}
                  onConfigure={handleConfigureWidget}
                  onDelete={setDeleteWidgetId}
                >
                  <WidgetBody
                    widget={widget}
                    checks={checks}
                    fullChecks={fullChecks}
                    heartbeatMap={heartbeatMap}
                    editMode
                  />
                </WidgetEditChrome>
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
        onSave={handleWidgetSave}
        onClose={() => setConfigWidgetId(null)}
        onDelete={setDeleteWidgetId}
      />

      <ConfirmationModal
        isOpen={!!deleteWidgetId}
        onClose={() => setDeleteWidgetId(null)}
        onConfirm={() => {
          if (deleteWidgetId) handleWidgetDelete(deleteWidgetId);
        }}
        title="Delete widget?"
        message="This removes the widget from the layout. Visitors see the change once you save the layout."
        confirmText="Delete"
      />
    </div>
  );
};
