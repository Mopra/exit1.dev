import React, { useState, useMemo } from 'react';
import { Search, Trash2, Check, Map } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Button,
  Input,
  Label,
  Textarea,
  Switch,
} from '../ui';
import type { CustomLayoutWidget, TextWidgetSize, IncidentsMode, DowntimeMode } from '../../types';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  status?: string;
}

interface WidgetConfigSheetProps {
  isOpen: boolean;
  widget: CustomLayoutWidget | null;
  checks: BadgeData[];
  onSave: (widgetId: string, checkId: string, showCheckName?: boolean) => void;
  onSaveUptime: (widgetId: string, checkIds: string[], showCheckName?: boolean) => void;
  onSaveIncidents: (widgetId: string, checkIds: string[], showCheckName?: boolean, incidentsMode?: IncidentsMode) => void;
  onSaveDowntime: (widgetId: string, checkIds: string[], showCheckName?: boolean, downtimeMode?: DowntimeMode) => void;
  onSaveText: (widgetId: string, textContent: string, textSize: TextWidgetSize) => void;
  onClose: () => void;
  onDelete: (widgetId: string) => void;
}

export const WidgetConfigSheet: React.FC<WidgetConfigSheetProps> = ({
  isOpen,
  widget,
  checks,
  onSave,
  onSaveUptime,
  onSaveIncidents,
  onSaveDowntime,
  onSaveText,
  onClose,
  onDelete,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);
  const [selectedCheckIds, setSelectedCheckIds] = useState<string[]>([]);
  const [textContent, setTextContent] = useState('');
  const [textSize, setTextSize] = useState<TextWidgetSize>('medium');
  const [showCheckName, setShowCheckName] = useState(true);
  const [incidentsMode, setIncidentsMode] = useState<IncidentsMode>('total');
  const [downtimeMode, setDowntimeMode] = useState<DowntimeMode>('total');

  const isTextWidget = widget?.type === 'text';
  const isUptimeWidget = widget?.type === 'uptime';
  const isIncidentsWidget = widget?.type === 'incidents';
  const isDowntimeWidget = widget?.type === 'downtime';
  const isMapWidget = widget?.type === 'map';
  const isMultiSelect = isUptimeWidget || isIncidentsWidget || isDowntimeWidget;

  // Reset state when widget changes
  React.useEffect(() => {
    if (widget) {
      setSelectedCheckId(widget.checkId || null);
      // For uptime widgets, use checkIds if available, fallback to checkId
      const ids = widget.checkIds?.length
        ? widget.checkIds
        : widget.checkId
          ? [widget.checkId]
          : [];
      setSelectedCheckIds(ids);
      setTextContent(widget.textContent || '');
      setTextSize(widget.textSize || 'medium');
      // Default showCheckName to false for multi-check, true for single
      setShowCheckName(widget.showCheckName ?? (ids.length <= 1));
      setIncidentsMode(widget.incidentsMode ?? 'total');
      setDowntimeMode(widget.downtimeMode ?? 'total');
      setSearchQuery('');
    }
  }, [widget]);

  const filteredChecks = useMemo(() => {
    if (!searchQuery.trim()) return checks;
    const query = searchQuery.toLowerCase().trim();
    return checks.filter(
      (check) =>
        check.name.toLowerCase().includes(query) ||
        check.url.toLowerCase().includes(query)
    );
  }, [checks, searchQuery]);

  const handleCheckClick = (checkId: string) => {
    if (isMultiSelect) {
      setSelectedCheckIds((prev) => {
        const newIds = prev.includes(checkId)
          ? prev.filter((id) => id !== checkId)
          : [...prev, checkId];
        // Auto-disable showCheckName when selecting multiple checks
        if (newIds.length > 1) {
          setShowCheckName(false);
        }
        return newIds;
      });
    } else {
      setSelectedCheckId(checkId);
    }
  };

  const handleSave = () => {
    if (!widget) return;

    if (isTextWidget) {
      onSaveText(widget.id, textContent, textSize);
      onClose();
    } else if (isMapWidget) {
      // Map widget doesn't need any configuration, just close
      onClose();
    } else if (isIncidentsWidget && selectedCheckIds.length > 0) {
      onSaveIncidents(widget.id, selectedCheckIds, showCheckName, incidentsMode);
      onClose();
    } else if (isDowntimeWidget && selectedCheckIds.length > 0) {
      onSaveDowntime(widget.id, selectedCheckIds, showCheckName, downtimeMode);
      onClose();
    } else if (isUptimeWidget && selectedCheckIds.length > 0) {
      onSaveUptime(widget.id, selectedCheckIds, showCheckName);
      onClose();
    } else if (selectedCheckId) {
      onSave(widget.id, selectedCheckId);
      onClose();
    }
  };

  const handleDelete = () => {
    if (widget) {
      onDelete(widget.id);
      onClose();
    }
  };

  const canSave = isTextWidget || isMapWidget
    ? true
    : isUptimeWidget || isIncidentsWidget || isDowntimeWidget
      ? selectedCheckIds.length > 0
      : !!selectedCheckId;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full max-w-md p-0 overflow-hidden">
        <div className="flex flex-col h-full overflow-hidden">
          <SheetHeader className="p-6 pb-4">
            <SheetTitle>Configure {isTextWidget ? 'Text ' : isUptimeWidget ? 'Uptime ' : isIncidentsWidget ? 'Incidents ' : isDowntimeWidget ? 'Downtime ' : isMapWidget ? 'Map ' : ''}Widget</SheetTitle>
            <SheetDescription>
              {isTextWidget
                ? 'Enter the text to display in this widget.'
                : isUptimeWidget
                  ? 'Select one or more checks to display average uptime.'
                  : isIncidentsWidget
                    ? 'Select one or more checks to display total incidents.'
                    : isDowntimeWidget
                      ? 'Select one or more checks to display total downtime days.'
                      : isMapWidget
                        ? 'The map displays all checks with geographic data.'
                        : 'Select which check to display in this widget.'}
            </SheetDescription>
          </SheetHeader>

          {isTextWidget ? (
            <div className="flex-1 min-h-0 px-6 pb-4 space-y-4">
              <div>
                <Label className="text-sm mb-2 block">Text content</Label>
                <Textarea
                  placeholder="Enter your text here..."
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  className="min-h-[160px] resize-none"
                />
              </div>
              <div>
                <Label className="text-sm mb-2 block">Text size</Label>
                <div className="flex gap-2">
                  {(['small', 'medium', 'large'] as const).map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setTextSize(size)}
                      className={`flex-1 px-3 py-2 rounded-md border text-sm capitalize transition-colors cursor-pointer ${
                        textSize === size
                          ? 'border-primary/60 bg-primary/5 font-medium'
                          : 'hover:bg-muted/40'
                      }`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Use for headlines, notes, section labels, or any custom text.
              </p>
            </div>
          ) : isMapWidget ? (
            <div className="flex-1 min-h-0 px-6 pb-4 space-y-4">
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                  <Map className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-sm font-medium mb-2">Global Infrastructure Map</h3>
                <p className="text-xs text-muted-foreground max-w-[280px]">
                  This widget automatically displays all your checks with geographic location data on an interactive world map.
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  <strong className="text-foreground">No configuration needed.</strong> The map will show:
                </p>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                  <li>All checks with resolved IP locations</li>
                  <li>Real-time status indicators</li>
                  <li>Ping flow animations from check regions</li>
                </ul>
              </div>
            </div>
          ) : (
            <>
              <div className="px-6 pb-4">
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm">
                    {isUptimeWidget ? 'Select checks' : 'Select a check'}
                  </Label>
                  {isUptimeWidget && selectedCheckIds.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {selectedCheckIds.length} selected
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <Input
                    type="text"
                    placeholder="Search checks..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-6">
                <div className="space-y-2 pb-4">
                  {filteredChecks.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4 text-center">
                      No checks found.
                    </div>
                  ) : (
                    filteredChecks.map((check) => {
                      const isSelected = isMultiSelect
                        ? selectedCheckIds.includes(check.checkId)
                        : selectedCheckId === check.checkId;

                      return (
                        <button
                          key={check.checkId}
                          type="button"
                          onClick={() => handleCheckClick(check.checkId)}
                          className={`w-full max-w-full text-left rounded-md border px-3 py-2 transition-colors cursor-pointer overflow-hidden ${
                            isSelected
                              ? 'border-primary/60 bg-primary/5'
                              : 'hover:bg-muted/40'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {isMultiSelect && (
                              <div
                                className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                  isSelected
                                    ? 'bg-primary border-primary'
                                    : 'border-muted-foreground/40'
                                }`}
                              >
                                {isSelected && (
                                  <Check className="w-3 h-3 text-primary-foreground" />
                                )}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-foreground truncate max-w-full">
                                {check.name}
                              </div>
                              <div className="text-xs text-muted-foreground truncate max-w-full">
                                {check.url}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {(isUptimeWidget || isIncidentsWidget || isDowntimeWidget) && (
                <div className="px-6 pb-4 border-t pt-4 space-y-4">
                  {isIncidentsWidget && (
                    <div>
                      <Label className="text-sm mb-2 block">Display mode</Label>
                      <div className="flex gap-2">
                        {(['total', 'average'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setIncidentsMode(mode)}
                            className={`flex-1 px-3 py-2 rounded-md border text-sm capitalize transition-colors cursor-pointer ${
                              incidentsMode === mode
                                ? 'border-primary/60 bg-primary/5 font-medium'
                                : 'hover:bg-muted/40'
                            }`}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1.5">
                        {incidentsMode === 'total'
                          ? 'Sum of incidents across all selected checks'
                          : 'Average incidents per check'}
                      </p>
                    </div>
                  )}
                  {isDowntimeWidget && (
                    <div>
                      <Label className="text-sm mb-2 block">Display mode</Label>
                      <div className="flex gap-2">
                        {(['total', 'average'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setDowntimeMode(mode)}
                            className={`flex-1 px-3 py-2 rounded-md border text-sm capitalize transition-colors cursor-pointer ${
                              downtimeMode === mode
                                ? 'border-primary/60 bg-primary/5 font-medium'
                                : 'hover:bg-muted/40'
                            }`}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1.5">
                        {downtimeMode === 'total'
                          ? 'Sum of downtime days across all selected checks'
                          : 'Average downtime days per check'}
                      </p>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="show-check-name" className="text-sm">
                        Show check name
                      </Label>
                      {selectedCheckIds.length > 1 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Disabled for multiple checks
                        </p>
                      )}
                    </div>
                    <Switch
                      id="show-check-name"
                      checked={showCheckName}
                      onCheckedChange={setShowCheckName}
                      disabled={selectedCheckIds.length > 1}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <div className="p-6 pt-4 border-t flex items-center justify-between gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              className="gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              Delete Widget
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={!canSave}>
                Save
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};
