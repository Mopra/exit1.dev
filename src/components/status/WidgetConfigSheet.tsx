import React, { useState, useMemo } from 'react';
import { Search, Trash2, Check, Map, FolderOpen } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  Button,
  Input,
  Label,
  Textarea,
  Switch,
  ConfirmationModal,
} from '../ui';
import type { CustomLayoutWidget, TextWidgetSize, IncidentsMode, DowntimeMode } from '../../types';
import { buildFolderList, normalizeFolder } from '../../lib/folder-utils';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  status?: string;
  folder?: string | null;
}

interface WidgetConfigSheetProps {
  isOpen: boolean;
  widget: CustomLayoutWidget | null;
  checks: BadgeData[];
  onSave: (widgetId: string, patch: Partial<CustomLayoutWidget>) => void;
  onClose: () => void;
  /** Asks to delete the widget. The caller confirms before removing it. */
  onDelete: (widgetId: string) => void;
}

const WIDGET_COPY: Record<CustomLayoutWidget['type'], { title: string; subtitle: string }> = {
  text: { title: 'Text', subtitle: 'Enter the text to display in this widget.' },
  timeline: { title: 'Timeline', subtitle: 'Select one or more checks to display on the timeline.' },
  status: { title: 'Status', subtitle: 'Select one or more checks to show real-time status.' },
  uptime: { title: 'Uptime', subtitle: 'Select one or more checks to display average uptime.' },
  incidents: { title: 'Incidents', subtitle: 'Select one or more checks to display total incidents.' },
  downtime: { title: 'Downtime', subtitle: 'Select one or more checks to display total downtime.' },
  map: { title: 'Map', subtitle: 'Shows the checks on this status page on a world map.' },
};

const isDescendantOrSelf = (path: string, ancestor: string) =>
  path === ancestor || path.startsWith(`${ancestor}/`);

export const WidgetConfigSheet: React.FC<WidgetConfigSheetProps> = ({
  isOpen,
  widget,
  checks,
  onSave,
  onClose,
  onDelete,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCheckIds, setSelectedCheckIds] = useState<string[]>([]);
  const [textContent, setTextContent] = useState('');
  const [textSize, setTextSize] = useState<TextWidgetSize>('medium');
  const [showCheckName, setShowCheckName] = useState(true);
  const [showCheckCount, setShowCheckCount] = useState(true);
  const [showStatus, setShowStatus] = useState(true);
  const [incidentsMode, setIncidentsMode] = useState<IncidentsMode>('total');
  const [downtimeMode, setDowntimeMode] = useState<DowntimeMode>('total');
  const [selectedFolderPaths, setSelectedFolderPaths] = useState<Set<string>>(new Set());
  const [initialSnapshot, setInitialSnapshot] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const isTextWidget = widget?.type === 'text';
  const isTimelineWidget = widget?.type === 'timeline';
  const isIncidentsWidget = widget?.type === 'incidents';
  const isDowntimeWidget = widget?.type === 'downtime';
  const isMapWidget = widget?.type === 'map';
  const picksChecks = !!widget && !isTextWidget && !isMapWidget;

  const folderList = useMemo(() => {
    // Sorting by path puts every folder directly above its subfolders.
    return buildFolderList(checks.map((c) => ({ folder: c.folder }))).sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
    );
  }, [checks]);

  const getFolderCheckCount = (folderPath: string) =>
    checks.filter((c) => normalizeFolder(c.folder) === folderPath).length;

  const isCheckIncludedViaFolder = (check: BadgeData) => {
    const f = normalizeFolder(check.folder);
    return !!f && selectedFolderPaths.has(f);
  };

  // Selecting a folder also selects everything below it.
  const toggleFolder = (folderPath: string) => {
    setSelectedFolderPaths((prev) => {
      const next = new Set(prev);
      const selecting = !next.has(folderPath);
      for (const f of folderList) {
        if (!isDescendantOrSelf(f.path, folderPath)) continue;
        if (selecting) next.add(f.path);
        else next.delete(f.path);
      }
      return next;
    });
  };

  // Every check the widget will show: individual picks plus folder members.
  const resolvedCount = useMemo(() => {
    const ids = new Set(selectedCheckIds);
    for (const c of checks) {
      const f = normalizeFolder(c.folder);
      if (f && selectedFolderPaths.has(f)) ids.add(c.checkId);
    }
    return checks.filter((c) => ids.has(c.checkId)).length;
  }, [selectedCheckIds, selectedFolderPaths, checks]);
  const hasAnyChecks = resolvedCount > 0;

  const snapshot = () =>
    JSON.stringify({
      ids: [...selectedCheckIds].sort(),
      folders: Array.from(selectedFolderPaths).sort(),
      textContent,
      textSize,
      showCheckName,
      showCheckCount,
      showStatus,
      incidentsMode,
      downtimeMode,
    });

  // Reset state when the widget changes
  React.useEffect(() => {
    if (!widget) return;
    const ids = widget.checkIds?.length ? widget.checkIds : widget.checkId ? [widget.checkId] : [];
    const folders = widget.folderPaths ?? [];
    setSelectedCheckIds(ids);
    setTextContent(widget.textContent || '');
    setTextSize(widget.textSize || 'medium');
    setShowCheckName(widget.showCheckName ?? true);
    setShowCheckCount(widget.showCheckCount ?? true);
    setShowStatus(widget.showStatus ?? true);
    setIncidentsMode(widget.incidentsMode ?? 'total');
    setDowntimeMode(widget.downtimeMode ?? 'total');
    setSelectedFolderPaths(new Set(folders));
    setSearchQuery('');
    setConfirmDiscard(false);
    setInitialSnapshot(
      JSON.stringify({
        ids: [...ids].sort(),
        folders: [...folders].sort(),
        textContent: widget.textContent || '',
        textSize: widget.textSize || 'medium',
        showCheckName: widget.showCheckName ?? true,
        showCheckCount: widget.showCheckCount ?? true,
        showStatus: widget.showStatus ?? true,
        incidentsMode: widget.incidentsMode ?? 'total',
        downtimeMode: widget.downtimeMode ?? 'total',
      })
    );
  }, [widget]);

  const isDirty = !!widget && !isMapWidget && snapshot() !== initialSnapshot;

  const requestClose = () => {
    if (isDirty) setConfirmDiscard(true);
    else onClose();
  };

  const query = searchQuery.toLowerCase().trim();

  const filteredChecks = useMemo(() => {
    if (!query) return checks;
    return checks.filter(
      (check) => check.name.toLowerCase().includes(query) || check.url.toLowerCase().includes(query)
    );
  }, [checks, query]);

  const filteredFolders = useMemo(() => {
    if (!query) return folderList;
    return folderList.filter((f) => f.path.toLowerCase().includes(query));
  }, [folderList, query]);

  const handleCheckClick = (checkId: string) => {
    setSelectedCheckIds((prev) =>
      prev.includes(checkId) ? prev.filter((id) => id !== checkId) : [...prev, checkId]
    );
  };

  const handleSave = () => {
    if (!widget) return;
    if (isMapWidget) {
      onClose();
      return;
    }
    if (isTextWidget) {
      onSave(widget.id, { textContent, textSize });
      return;
    }
    if (!hasAnyChecks) return;

    // Only keep ids that are still on this page.
    const known = new Set(checks.map((c) => c.checkId));
    const checkIds = selectedCheckIds.filter((id) => known.has(id));
    const patch: Partial<CustomLayoutWidget> = {
      checkIds,
      folderPaths: Array.from(selectedFolderPaths),
      // Legacy single-check field. Rendering resolves checks from checkIds and
      // folderPaths, so a folder-only widget leaves this empty.
      checkId: checkIds[0],
      showCheckName,
    };
    if (isTimelineWidget) {
      patch.showCheckCount = showCheckCount;
      patch.showStatus = showStatus;
    }
    if (isIncidentsWidget) patch.incidentsMode = incidentsMode;
    if (isDowntimeWidget) patch.downtimeMode = downtimeMode;
    onSave(widget.id, patch);
  };

  const canSave = isTextWidget || isMapWidget ? true : hasAnyChecks;
  const copy = widget ? WIDGET_COPY[widget.type] : null;
  // The name only renders when the widget shows exactly one check.
  const showNameToggle = resolvedCount === 1;
  const showCountToggle = isTimelineWidget && resolvedCount > 1;

  const renderModeToggle = <T extends string>(
    value: T,
    onChange: (value: T) => void,
    descriptions: Record<'total' | 'average', string>
  ) => (
    <div>
      <Label className="text-sm mb-2 block">Display mode</Label>
      <div className="flex gap-2">
        {(['total', 'average'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode as T)}
            className={`flex-1 px-3 py-2 rounded-md border text-sm capitalize transition-colors cursor-pointer ${
              value === mode ? 'border-primary/60 bg-primary/5 font-medium' : 'hover:bg-muted/40'
            }`}
          >
            {mode}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-1.5">
        {descriptions[value as 'total' | 'average']}
      </p>
    </div>
  );

  return (
    <>
      <Sheet open={isOpen} onOpenChange={(open) => !open && requestClose()}>
        <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0 overflow-hidden">
          <SheetTitle className="sr-only">Widget configuration</SheetTitle>
          <div className="flex flex-col h-full overflow-hidden">
            <div className="p-7 sm:p-8 pb-4">
              <h2 className="text-lg font-semibold tracking-tight">
                Configure {copy ? `${copy.title} ` : ''}Widget
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">{copy?.subtitle}</p>
            </div>

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
                  Use for headlines, notes, section labels, or any custom text. Empty text widgets are hidden from visitors.
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
                    This widget places the checks on this status page on an interactive world map, using each check's resolved location.
                  </p>
                </div>
                <div className="rounded-xl border border-border/30 bg-muted/20 p-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    <strong className="text-foreground">No configuration needed.</strong> The map shows:
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                    <li>Checks on this page with a resolved IP location</li>
                    <li>Real-time status indicators</li>
                    <li>Ping flow animations from check regions</li>
                  </ul>
                </div>
              </div>
            ) : picksChecks && checks.length === 0 ? (
              <div className="flex-1 min-h-0 px-6 pb-4">
                <div className="rounded-xl border border-border/30 bg-muted/20 p-4 text-center">
                  <p className="text-sm font-medium text-foreground">No checks on this page yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Only checks on this status page can go in widgets. Add checks in the page settings.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="px-6 pb-4">
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-sm">Select checks</Label>
                    {hasAnyChecks && (
                      <span className="text-xs text-muted-foreground">{resolvedCount} selected</span>
                    )}
                  </div>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    <Input
                      type="text"
                      placeholder={folderList.length > 0 ? 'Search checks and folders...' : 'Search checks...'}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Only checks on this status page are listed.
                  </p>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-6">
                  <div className="space-y-2 pb-4">
                    {filteredFolders.length > 0 && (
                      <>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                          Folders
                        </div>
                        {filteredFolders.map((folder) => {
                          const isSelected = selectedFolderPaths.has(folder.path);
                          const checkCount = getFolderCheckCount(folder.path);
                          // Indent by depth, but not when search shows a flat list
                          const indent = query ? 0 : Math.max(0, folder.depth - 1) * 20;
                          return (
                            <button
                              key={`folder-${folder.path}`}
                              type="button"
                              onClick={() => toggleFolder(folder.path)}
                              style={indent ? { paddingLeft: 12 + indent } : undefined}
                              className={`w-full max-w-full text-left rounded-md border px-3 py-2 transition-colors cursor-pointer overflow-hidden ${
                                isSelected ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/40'
                              }`}
                            >
                              <div className="flex items-start gap-2">
                                <div
                                  className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                    isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                                  }`}
                                >
                                  {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                                </div>
                                <div className="flex-1 min-w-0 flex items-center gap-2">
                                  <FolderOpen className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                                  <span className="text-sm font-medium text-foreground truncate">
                                    {query ? folder.path : folder.name}
                                  </span>
                                  <span className="text-xs text-muted-foreground flex-shrink-0">
                                    {checkCount} {checkCount === 1 ? 'check' : 'checks'}
                                  </span>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                        {filteredChecks.length > 0 && (
                          <>
                            <div className="border-t my-3" />
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                              Individual checks
                            </div>
                          </>
                        )}
                      </>
                    )}

                    {filteredChecks.length === 0 && filteredFolders.length === 0 ? (
                      <div className="text-sm text-muted-foreground py-4 text-center">
                        Nothing matches "{searchQuery.trim()}".
                      </div>
                    ) : (
                      filteredChecks.map((check) => {
                        const isSelected = selectedCheckIds.includes(check.checkId);
                        const includedViaFolder = isCheckIncludedViaFolder(check);
                        const effectivelySelected = isSelected || includedViaFolder;

                        return (
                          <button
                            key={check.checkId}
                            type="button"
                            onClick={() => handleCheckClick(check.checkId)}
                            disabled={includedViaFolder}
                            title={includedViaFolder ? 'Included via folder selection' : undefined}
                            className={`w-full max-w-full text-left rounded-md border px-3 py-2 transition-colors overflow-hidden ${
                              includedViaFolder
                                ? 'border-primary/40 bg-primary/5 cursor-not-allowed'
                                : effectivelySelected
                                  ? 'border-primary/60 bg-primary/5 cursor-pointer'
                                  : 'hover:bg-muted/40 cursor-pointer'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <div
                                className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                  effectivelySelected
                                    ? includedViaFolder
                                      ? 'bg-primary/60 border-primary/60'
                                      : 'bg-primary border-primary'
                                    : 'border-muted-foreground/40'
                                }`}
                              >
                                {effectivelySelected && <Check className="w-3 h-3 text-primary-foreground" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 max-w-full">
                                  <span className="text-sm font-medium text-foreground truncate">
                                    {check.name}
                                  </span>
                                  {includedViaFolder && (
                                    <span className="text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded flex-shrink-0">
                                      via folder
                                    </span>
                                  )}
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

                {(isIncidentsWidget || isDowntimeWidget || isTimelineWidget || showNameToggle) && (
                  <div className="px-6 pb-4 border-t pt-4 space-y-4">
                    {isIncidentsWidget &&
                      renderModeToggle(incidentsMode, setIncidentsMode, {
                        total: 'Sum of incidents across all selected checks',
                        average: 'Average incidents per check',
                      })}
                    {isDowntimeWidget &&
                      renderModeToggle(downtimeMode, setDowntimeMode, {
                        total: 'Sum of downtime across all selected checks',
                        average: 'Average downtime per check',
                      })}
                    {showNameToggle && (
                      <div className="flex items-center justify-between">
                        <Label htmlFor="show-check-name" className="text-sm">
                          Show check name
                        </Label>
                        <Switch
                          id="show-check-name"
                          checked={showCheckName}
                          onCheckedChange={setShowCheckName}
                        />
                      </div>
                    )}
                    {showCountToggle && (
                      <div className="flex items-center justify-between">
                        <Label htmlFor="show-check-count" className="text-sm">
                          Show check count
                        </Label>
                        <Switch
                          id="show-check-count"
                          checked={showCheckCount}
                          onCheckedChange={setShowCheckCount}
                        />
                      </div>
                    )}
                    {isTimelineWidget && (
                      <div className="flex items-center justify-between">
                        <Label htmlFor="show-status" className="text-sm">
                          Show status badge
                        </Label>
                        <Switch
                          id="show-status"
                          checked={showStatus}
                          onCheckedChange={setShowStatus}
                        />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="p-6 pt-4 border-t flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => widget && onDelete(widget.id)}
                className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="w-4 h-4" />
                Delete Widget
              </Button>
              {isMapWidget ? (
                <Button onClick={onClose}>Close</Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={requestClose}>
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={!canSave}>
                    Save
                  </Button>
                </div>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmationModal
        isOpen={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        title="Discard changes?"
        message="Your changes to this widget have not been saved."
        confirmText="Discard"
        cancelText="Keep editing"
        variant="warning"
      />
    </>
  );
};
