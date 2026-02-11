import React from 'react';
import { Activity, AlertTriangle, BarChart3, Clock, Map, Plus, Type, TrendingUp } from 'lucide-react';
import { Button, glassClasses } from '../ui';
import type { WidgetType } from '../../types';

interface WidgetToolbarProps {
  onAddWidget: (type: WidgetType) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  hasUnsavedChanges?: boolean;
}

export const WidgetToolbar: React.FC<WidgetToolbarProps> = ({
  onAddWidget,
  onSave,
  onCancel,
  saving = false,
  hasUnsavedChanges = false,
}) => {
  return (
    <div className={`fixed bottom-0 left-0 right-0 z-[50] ${glassClasses} border-t`}>
      <div className="px-4 py-4 sm:px-6 max-w-screen-xl mx-auto">
        <div className="flex items-center justify-between gap-4">
          {/* Widget palette */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddWidget('timeline')}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <BarChart3 className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Timeline</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddWidget('text')}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <Type className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Text</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddWidget('uptime')}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <TrendingUp className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Uptime</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddWidget('incidents')}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <AlertTriangle className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Incidents</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddWidget('downtime')}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <Clock className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Downtime</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddWidget('status')}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <Activity className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Status</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddWidget('map')}
              className="gap-2"
            >
              <Plus className="w-4 h-4" />
              <Map className="w-4 h-4 text-primary" />
              <span className="hidden sm:inline">Map</span>
            </Button>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {hasUnsavedChanges && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                Unsaved changes
              </span>
            )}
            <Button variant="ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Layout'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
