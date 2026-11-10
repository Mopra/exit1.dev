import React from 'react';
import { Activity, AlertTriangle, BarChart3, Clock, GripVertical, Map as MapIcon, Settings, Trash2, TrendingUp, Type } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CustomLayoutWidget, WidgetType } from '../../types';
import { normalizeFolder } from '../../lib/folder-utils';

interface CheckRef {
  checkId: string;
  folder?: string | null;
}

export interface WidgetTypeInfo {
  type: WidgetType;
  label: string;
  description: string;
  icon: LucideIcon;
}

// One catalog for the toolbar menu and the empty editor state, so labels and
// descriptions never drift between the two.
export const WIDGET_TYPES: WidgetTypeInfo[] = [
  { type: 'timeline', label: 'Timeline', description: 'Daily up and down bars for the last 90 days', icon: BarChart3 },
  { type: 'status', label: 'Status', description: 'Live status of one check or a group', icon: Activity },
  { type: 'uptime', label: 'Uptime', description: 'Uptime percentage over the last 90 days', icon: TrendingUp },
  { type: 'incidents', label: 'Incidents', description: 'Days with incidents in the last 90 days', icon: AlertTriangle },
  { type: 'downtime', label: 'Downtime', description: 'Estimated downtime in the last 90 days', icon: Clock },
  { type: 'text', label: 'Text', description: 'A headline, note or section label', icon: Type },
  { type: 'map', label: 'Map', description: 'World map of the checks on this page', icon: MapIcon },
];

/**
 * Resolve the check ids a widget shows: its individual picks plus every check
 * in its selected folders, limited to checks that exist on this page.
 */
export const resolveWidgetCheckIds = (widget: CustomLayoutWidget, checks: CheckRef[]): string[] => {
  const ids = widget.checkIds?.length ? widget.checkIds : widget.checkId ? [widget.checkId] : [];
  const idSet = new Set(ids);
  if (widget.folderPaths?.length) {
    const folderSet = new Set(widget.folderPaths);
    for (const c of checks) {
      const f = normalizeFolder(c.folder);
      if (f && folderSet.has(f)) idSet.add(c.checkId);
    }
  }
  const known = new Set(checks.map((c) => c.checkId));
  return Array.from(idSet).filter((id) => known.has(id));
};

/** A widget is configured when it has something to show visitors. */
export const isWidgetConfigured = (widget: CustomLayoutWidget, checks: CheckRef[]): boolean => {
  if (widget.type === 'map') return true;
  if (widget.type === 'text') return !!widget.textContent?.trim();
  return resolveWidgetCheckIds(widget, checks).length > 0;
};

interface WidgetEditChromeProps {
  widgetId: string;
  editMode: boolean;
  /** Unconfigured widgets open their settings when the body is clicked. */
  configured: boolean;
  onConfigure: (widgetId: string) => void;
  onDelete?: (widgetId: string) => void;
  children: React.ReactNode;
}

// The controls straddle the tile's top edge (half in the grid gap) so they
// never cover the widget's own title or status badge.
const chipClass =
  'p-1 rounded-md bg-background border border-border/60 shadow-sm hover:bg-muted transition-colors';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/**
 * Edit controls shared by every widget in the layout editor. They stay visible
 * the whole time edit mode is on, so they work on touch screens too.
 */
export const WidgetEditChrome: React.FC<WidgetEditChromeProps> = ({
  widgetId,
  editMode,
  configured,
  onConfigure,
  onDelete,
  children,
}) => {
  if (!editMode) return <>{children}</>;

  const openOnBody = !configured;

  return (
    <div
      className={`relative h-full ${openOnBody ? 'cursor-pointer' : ''}`}
      onClick={openOnBody ? () => onConfigure(widgetId) : undefined}
      onKeyDown={
        openOnBody
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onConfigure(widgetId);
              }
            }
          : undefined
      }
      role={openOnBody ? 'button' : undefined}
      tabIndex={openOnBody ? 0 : undefined}
      aria-label={openOnBody ? 'Configure widget' : undefined}
    >
      {/* isolate keeps map panes and other stacked content below the controls */}
      <div className="relative h-full isolate">{children}</div>

      <div
        className={`drag-handle absolute -top-3 left-3 z-20 cursor-grab active:cursor-grabbing touch-none ${chipClass}`}
        onClick={stop}
        title="Drag to move"
        aria-label="Drag to move"
      >
        <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
      </div>

      <div className="absolute -top-3 right-3 z-20 flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onConfigure(widgetId);
          }}
          className={`cursor-pointer ${chipClass}`}
          title="Configure widget"
          aria-label="Configure widget"
        >
          <Settings className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(widgetId);
            }}
            className={`group/trash cursor-pointer ${chipClass}`}
            title="Delete widget"
            aria-label="Delete widget"
          >
            <Trash2 className="w-3.5 h-3.5 text-muted-foreground group-hover/trash:text-destructive" />
          </button>
        )}
      </div>

      {/* Resize hint; the real handle is react-grid-layout's corner */}
      <div className="absolute bottom-2 right-2 pointer-events-none z-20">
        <svg width="14" height="14" viewBox="0 0 14 14" className="text-muted-foreground/60">
          <path d="M12 2L2 12M12 7L7 12M12 12L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
};
