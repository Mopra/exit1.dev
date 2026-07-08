import React, { useState, useCallback, useEffect, useMemo, createContext, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import CheckCard from './CheckCard';
import ChecksTableShell from './ChecksTableShell';
import { FolderGroupHeaderRow } from './FolderGroupHeaderRow';
import { BulkEditModal, type BulkEditSettings } from './BulkEditModal';

import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';

import {
  Edit,
  Clock,
  ArrowUpDown,
  SortAsc,
  SortDesc,
  MoreVertical,
  Folder,
  ChevronDown,
  ChevronRight,
  Play,
  Power,
  PowerOff,
  Trash2,
  ExternalLink,
  Globe,
  Check,
  Plus,
  Loader2,
  GripVertical,
  Settings2,
  Wrench,
  CheckCircle,
  Minus,
  Repeat,
  CalendarX2,
  SquarePen,
  Sparkles,
  Copy,
  MapPin,
  Radio
} from 'lucide-react';
import { IconButton, Button, EmptyState, ConfirmationModal, StatusBadge, CHECK_INTERVALS, Table, TableHeader, TableBody, TableHead, TableRow, TableCell, SSLTooltip, glassClasses, Tooltip, TooltipTrigger, TooltipContent, BulkActionsBar, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Input, Label, Badge, Popover, PopoverTrigger, PopoverContent } from '../ui';
// NOTE: No tier-based enforcement. Keep table edit behavior tier-agnostic for now.
import type { Website } from '../../types';
import { formatLastChecked, formatResponseTime, highlightText } from '../../utils/formatters.tsx';
import { CheckCountdown } from './CheckCountdown';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useLazyRow } from '../../hooks/useLazyRow';
import { useMobile } from '../../hooks/useMobile';
import { useStableCallback } from '../../hooks/useStableCallback';
import { toast } from 'sonner';
import { normalizeFolder, getFolderBadgeClasses, buildFolderList, getFolderPathError } from '../../lib/folder-utils';
import { getRegionLabel, getTypeIcon, getTypeLabel, getSSLCertificateStatus, formatRecurringSummary, formatMaintenanceDuration, isDomainOnlyCheck } from '../../lib/check-utils';
import { getDomainStatusBadge } from '../../hooks/useDomainIntelligence';
import { SeverityBadge } from './SeverityBadge';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';

// Context to thread sortable drag listeners from the row wrapper to the grip handle
const DragHandleContext = createContext<{ listeners?: SyntheticListenerMap; attributes?: Record<string, any> }>({});

// Wraps a table row to make it sortable via @dnd-kit
function SortableCheckRow({ id, disabled, children, className, rowRef, ...rest }: {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  /** Extra ref for the <tr> (lazy-render viewport tracking), composed with dnd-kit's node ref. */
  rowRef?: (el: Element | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const setRefs = useCallback((el: HTMLTableRowElement | null) => {
    setNodeRef(el);
    rowRef?.(el);
  }, [setNodeRef, rowRef]);
  return (
    <DragHandleContext.Provider value={{ listeners, attributes }}>
      <TableRow
        ref={setRefs}
        className={`${className ?? ''} ${isDragging ? 'opacity-30 shadow-lg relative z-10' : ''}`}
        style={{
          transform: CSS.Translate.toString(transform),
          transition,
        }}
        {...rest}
      >
        {children}
      </TableRow>
    </DragHandleContext.Provider>
  );
}

// Drag handle that receives sortable listeners from the row wrapper's context
function CheckRowDragHandle({ canDrag, disabled }: { checkId?: string; canDrag: boolean; disabled?: boolean }) {
  const { listeners, attributes } = useContext(DragHandleContext);
  return (
    <TableCell className={`px-4 py-4 ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-center">
        <div
          className={`p-2 rounded-lg transition-all duration-200 ease-out ${canDrag ? 'text-muted-foreground hover:text-foreground hover:bg-primary/10 cursor-grab active:cursor-grabbing' : 'text-muted-foreground cursor-not-allowed'}`}
          {...(canDrag ? listeners : {})}
          {...(canDrag ? attributes : {})}
          aria-label={canDrag ? `Drag to reorder` : 'Custom ordering disabled'}
          title={canDrag ? 'Drag to reorder' : 'Custom ordering disabled when sorting by other columns'}
        >
          <GripVertical className={`w-4 h-4 ${canDrag ? 'hover:scale-110' : 'opacity-50'}`} />
        </div>
      </div>
    </TableCell>
  );
}

const FOLDER_SORT_ID_PREFIX = 'folder:';

type FolderHeaderRowBaseProps = React.ComponentProps<typeof FolderGroupHeaderRow>;

function SortableFolderHeaderRow({ folderKey, ...rest }: FolderHeaderRowBaseProps & { folderKey: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: `${FOLDER_SORT_ID_PREFIX}${folderKey}`,
    data: { type: 'folder', folderKey, isFolderSource: true },
  });
  return (
    <FolderGroupHeaderRow
      {...rest}
      rowRef={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      isOver={isOver}
      isDragging={isDragging}
      dragListeners={listeners}
      dragAttributes={attributes}
    />
  );
}

function getDisplayUrl(check: Website): string {
  if (check.type === 'heartbeat' && check.heartbeatToken) {
    return `https://vps.exit1.dev/heartbeat/${check.heartbeatToken}`;
  }
  // Domain-only checks store a synthetic `domain://example.com` URL —
  // show the bare domain to the user.
  if (check.type === 'domain') {
    return check.domainExpiry?.domain ?? check.url.replace(/^domain:\/\//, '');
  }

  return check.url;
}

interface CheckTableProps {
  checks: Website[];
  /**
   * Tier 2b (firestore-write-reduction.md): IDs of checks whose live fields
   * render from Firestore (WS fallback) — timing data may be up to an hour
   * stale, so countdowns render a stale marker instead. From useCheckStream.
   */
  staleCheckIds?: Set<string>;
  onDelete: (id: string) => void;
  onBulkDelete: (ids: string[]) => void;
  onCheckNow: (id: string) => void;
  onRefreshMetadata?: (check: Website) => void | Promise<void>;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onBulkToggleStatus: (ids: string[], disabled: boolean) => void;
  onBulkUpdateSettings?: (ids: string[], settings: BulkEditSettings) => Promise<void>;
  onBulkMoveToFolder?: (ids: string[], folder: string | null) => Promise<void>;
  onToggleMaintenance?: (check: Website) => void;
  onCancelScheduledMaintenance?: (check: Website) => void;
  onEditRecurringMaintenance?: (check: Website) => void;
  onDeleteRecurringMaintenance?: (check: Website) => void;
  onBulkToggleMaintenance?: (checks: Website[], enabled: boolean) => void;
  /** Reorders two checks by ID and persists to Firestore in one atomic step. */
  onReorderAndCommit?: (activeId: string, overId: string) => Promise<void>;
  onEdit: (check: Website) => void;
  onDuplicate?: (check: Website) => void;
  isNano?: boolean;
  /** Minimum check interval (seconds) allowed for the user's tier. Used to filter intervals in BulkEditModal. */
  minIntervalSeconds?: number;
  groupBy?: 'none' | 'folder';
  onGroupByChange?: (next: 'none' | 'folder') => void;
  onSetFolder?: (id: string, folder: string | null) => void | Promise<void>;
  searchQuery?: string;
  onAddFirstCheck?: () => void;
  optimisticUpdates?: string[]; // IDs of checks being optimistically updated
  folderUpdates?: string[]; // IDs of checks being updated only for folder changes
  manualChecksInProgress?: string[]; // IDs of checks being manually checked
  sortBy?: string; // Persistent sort preference from Firestore
  onSortChange?: (sortOption: string) => void; // Callback to update sort preference
  pendingCheck?: { name: string; url: string } | null; // Check being auto-created from marketing site
}

type SortOption = 'custom' | 'name-asc' | 'name-desc' | 'url-asc' | 'url-desc' | 'status' | 'lastChecked' | 'createdAt' | 'responseTime' | 'type' | 'checkFrequency';

type CheckTableColumnKey =
  | 'order'
  | 'status'
  | 'nameUrl'
  | 'type'
  | 'responseTime'
  | 'lastChecked'
  | 'checkInterval'
  | 'quickActions';

type CheckTableColumnVisibility = Record<CheckTableColumnKey, boolean>;

// Bulk actions touching at least this many checks ask for confirmation first.
const BULK_CONFIRM_THRESHOLD = 10;

const DEFAULT_CHECKS_TABLE_COLUMN_VISIBILITY: CheckTableColumnVisibility = {
  order: true,
  status: true,
  nameUrl: true,
  type: true,
  responseTime: true,
  lastChecked: true,
  checkInterval: true,
  quickActions: true,
};

interface CheckTableRowProps {
  check: Website;
  /** True only in `custom` sort mode — gates the @dnd-kit useSortable hook. */
  draggable: boolean;
  /** Current visible column count — the lazy placeholder cell spans all of them. */
  colCount: number;
  /** Rows above the fold render content immediately instead of waiting for the observer. */
  initiallyVisible: boolean;
  isMobile: boolean;
  columnVisibility: CheckTableColumnVisibility;
  isSelected: boolean;
  isOptimistic: boolean;
  isFolderUpdating: boolean;
  isManuallyChecking: boolean;
  isNano: boolean;
  /**
   * Tier 2b: live fields render from Firestore (WS fallback), where timing
   * data can be up to an hour stale. Boolean (not the Set) so row memo
   * only busts for rows whose staleness actually flipped.
   */
  isStale: boolean;
  searchQuery: string;
  folderColor?: string;
  folderOptions: string[];
  onSelect: (id: string, event?: React.MouseEvent) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onToggleMaintenance?: (check: Website) => void;
  onCancelScheduledMaintenance?: (check: Website) => void;
  onEditRecurringMaintenance?: (check: Website) => void;
  onDeleteRecurringMaintenance?: (check: Website) => void;
  onRefreshMetadata?: (check: Website) => void | Promise<void>;
  onEdit: (check: Website) => void;
  onDuplicate?: (check: Website) => void;
  onDeleteClick: (check: Website) => void;
  onSetFolder?: (id: string, folder: string | null) => void | Promise<void>;
  onViewDetails: (id: string) => void;
  onOpenNewFolder: (check: Website) => void;
}

/**
 * One check row, memoized. Every prop is either a primitive or a stable
 * reference (callbacks are stabilized in CheckTable, the `check` object
 * keeps identity across WS ticks unless its data actually changed — see
 * `applyOverlay` in useCheckStream). That means selecting a row, a WS
 * overlay tick, or typing in search re-renders only the rows whose data
 * changed, not all 300+.
 *
 * The per-row dropdown menu (~15 items + submenu) is built lazily — its
 * content only mounts while open — so the initial render of a large table
 * doesn't construct thousands of menu elements up front.
 */
const CheckTableRow = React.memo(function CheckTableRow({
  check,
  draggable,
  colCount,
  initiallyVisible,
  isMobile,
  columnVisibility,
  isSelected,
  isOptimistic,
  isFolderUpdating,
  isManuallyChecking,
  isNano,
  isStale,
  searchQuery,
  folderColor,
  folderOptions,
  onSelect,
  onCheckNow,
  onToggleStatus,
  onToggleMaintenance,
  onCancelScheduledMaintenance,
  onEditRecurringMaintenance,
  onDeleteRecurringMaintenance,
  onRefreshMetadata,
  onEdit,
  onDuplicate,
  onDeleteClick,
  onSetFolder,
  onViewDetails,
  onOpenNewFolder,
}: CheckTableRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const domainOnly = isDomainOnlyCheck(check);
  const rowClassName = `hover:bg-muted/50 transition-colors group cursor-pointer ${isOptimistic && !isFolderUpdating ? 'animate-pulse bg-accent' : ''}`;

  // Rows far from the viewport keep their <tr> (dnd-kit registration and
  // table layout stay intact) but render one fixed-height placeholder cell
  // instead of the full cell tree — tooltips, dropdown, and the 1Hz
  // countdown only exist for the ~20 rows near the viewport.
  const { rowRef, isNear, placeholderHeight } = useLazyRow(initiallyVisible);

  const cells = !isNear ? (
    <TableCell colSpan={colCount} className="p-0" style={{ height: placeholderHeight }} />
  ) : (
    <>
      {!isMobile && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-center">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSelect(check.id, e);
              }}
              className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${isSelected ? `border bg-background` : 'border'} hover:border cursor-pointer flex items-center justify-center`}
              title={isSelected ? 'Deselect' : 'Select'}
            >
              {isSelected && (
                <Check className="w-2.5 h-2.5 text-white" />
              )}
            </button>
          </div>
        </TableCell>
      )}
      {columnVisibility.order && (
        <CheckRowDragHandle checkId={check.id} canDrag={draggable} disabled={check.disabled} />
      )}
      {columnVisibility.status && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2">
            {domainOnly ? (
              (() => {
                const di = check.domainExpiry;
                const badge = getDomainStatusBadge(
                  di?.status ?? 'unknown',
                  di?.daysUntilExpiry,
                  { lastCheckedAt: di?.lastCheckedAt, lastError: di?.lastError },
                );
                return <Badge variant={badge.variant}>{badge.label}</Badge>;
              })()
            ) : (
              <>
                {(() => {
                  const sslStatus = getSSLCertificateStatus(check);
                  return (
                    <SSLTooltip sslCertificate={check.sslCertificate} url={check.url}>
                      <div className="cursor-help">
                        <sslStatus.icon className={`w-4 h-4 ${sslStatus.color}`} />
                      </div>
                    </SSLTooltip>
                  );
                })()}
                <StatusBadge
                  status={check.maintenanceMode ? 'maintenance' : check.disabled ? 'disabled' : check.status}
                  tooltip={{
                    httpStatus: check.type === 'ping' || check.type === 'websocket' ? undefined : check.lastStatusCode,
                    latencyMsP50: check.responseTime,
                    lastCheckTs: check.lastChecked,
                    failureReason: check.maintenanceMode ? (check.maintenanceReason || 'In maintenance') : check.lastError,
                    ssl: check.sslCertificate ? { valid: check.sslCertificate.valid, daysUntilExpiry: check.sslCertificate.daysUntilExpiry } : undefined,
                  }}
                />
              </>
            )}
          </div>
        </TableCell>
      )}
      {columnVisibility.nameUrl && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
          {(() => {
            const regionLabel = getRegionLabel(check.checkRegion);
            const displayUrl = getDisplayUrl(check);
            return (
              <div className="flex flex-col min-w-0">
                <div className="font-medium font-sans text-foreground text-sm truncate">
                  {highlightText(check.name, searchQuery)}
                </div>
                <div className="text-sm font-mono text-muted-foreground truncate">
                  {highlightText(displayUrl, searchQuery)}
                </div>
                {check.type === 'redirect' && check.redirectLocation && (
                  <div className="text-xs font-mono text-muted-foreground/70 truncate">
                    → {check.redirectLocation}
                  </div>
                )}
                {(check.severity || ((check.folder ?? '').trim()) || regionLabel || (!check.maintenanceMode && check.maintenanceScheduledStart) || (!check.maintenanceMode && check.maintenanceRecurring)) && (
                  <div className="pt-1 flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={check.severity} />
                    {(check.folder ?? '').trim() && (
                      <Badge variant="secondary" className={`font-mono text-[11px] w-fit ${getFolderBadgeClasses(folderColor)}`}>
                        {(check.folder ?? '').trim()}
                      </Badge>
                    )}
                    {regionLabel && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="font-mono text-[11px] w-fit cursor-default">{regionLabel.short}</Badge>
                        </TooltipTrigger>
                        <TooltipContent className={glassClasses}>
                          <span className="text-xs font-mono">Region: {regionLabel.long}</span>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {!check.maintenanceMode && check.maintenanceScheduledStart && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="font-mono text-[11px] w-fit cursor-default border-warning/40 text-warning">
                            <Clock className="w-3 h-3 mr-1" />Scheduled
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className={glassClasses}>
                          <span className="text-xs font-mono">
                            {new Date(check.maintenanceScheduledStart).toLocaleString()} for {formatMaintenanceDuration(check.maintenanceScheduledDuration ?? 0)}
                          </span>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {!check.maintenanceMode && check.maintenanceRecurring && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="font-mono text-[11px] w-fit cursor-default border-warning/40 text-warning">
                            <Repeat className="w-3 h-3 mr-1" />Recurring
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent className={glassClasses}>
                          <span className="text-xs font-mono">{formatRecurringSummary(check.maintenanceRecurring)}</span>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </TableCell>
      )}
      {columnVisibility.type && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2">
            {getTypeIcon(check.type, 'w-5 h-5 text-primary')}
            <span className="text-sm font-mono text-muted-foreground">{getTypeLabel(check.type)}</span>
          </div>
        </TableCell>
      )}
      {columnVisibility.responseTime && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
          <div className="text-sm font-mono text-muted-foreground">
            {domainOnly ? '—' : formatResponseTime(check.responseTime)}
          </div>
        </TableCell>
      )}
      {columnVisibility.lastChecked && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''} relative`} style={{ width: '280px' }}>
          {domainOnly ? (
            <div className="flex items-center gap-2">
              <Clock className="w-3 h-3 text-muted-foreground" />
              <span className="text-sm font-mono text-muted-foreground">
                {check.domainExpiry?.lastCheckedAt
                  ? formatLastChecked(check.domainExpiry.lastCheckedAt)
                  : 'Never'}
              </span>
            </div>
          ) : !check.lastChecked && !check.disabled ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Clock className="w-3 h-3 text-muted-foreground" />
                <span className="text-sm font-mono text-muted-foreground">Never</span>
              </div>
              <div className={`${glassClasses} rounded-md p-2 flex items-center justify-between gap-2`}>
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                  </span>
                  <span className="text-xs font-medium text-primary">In Queue</span>
                </div>
                <Button onClick={(e) => { e.stopPropagation(); onCheckNow(check.id); }} size="sm" variant="ghost" className="text-xs h-7 px-2 cursor-pointer" aria-label="Check now">Check Now</Button>
              </div>
            </div>
          ) : (
            <CheckCountdown
              lastChecked={check.lastChecked}
              nextCheckAt={check.nextCheckAt}
              stale={isStale}
            />
          )}
        </TableCell>
      )}
      {columnVisibility.checkInterval && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
          <div className="flex items-center gap-2">
            <Clock className="w-3 h-3 text-muted-foreground" />
            <span className="text-sm font-mono text-muted-foreground">
              {domainOnly
                ? 'Adaptive'
                : (() => { const seconds = Math.round((check.checkFrequency ?? 10) * 60); const interval = CHECK_INTERVALS.find(i => i.value === seconds); return interval ? interval.label : seconds < 60 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`; })()}
            </span>
          </div>
        </TableCell>
      )}
      {columnVisibility.quickActions && (
        <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
          <div className="flex items-center justify-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  icon={<Radio className="w-4 h-4" />}
                  variant="outline"
                  aria-label="View details"
                  onClick={(e) => { e.stopPropagation(); onViewDetails(check.id); }}
                  className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/30 transition-colors cursor-pointer"
                />
              </TooltipTrigger>
              <TooltipContent className={glassClasses}><span className="text-xs font-mono">View details</span></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  icon={isManuallyChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  variant="outline"
                  aria-label="Check now"
                  disabled={check.disabled || isManuallyChecking || domainOnly}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!check.disabled && !isManuallyChecking && !domainOnly) {
                      onCheckNow(check.id);
                    }
                  }}
                  className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/30 transition-colors cursor-pointer disabled:cursor-not-allowed"
                />
              </TooltipTrigger>
              <TooltipContent className={glassClasses}>
                <span className="text-xs font-mono">
                  {domainOnly
                    ? 'Not available for domain checks'
                    : check.disabled
                      ? 'Enable check to run manually'
                      : isManuallyChecking
                        ? 'Check in progress…'
                        : 'Check now'}
                </span>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  icon={check.disabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                  variant="outline"
                  aria-label={check.disabled ? 'Enable' : 'Disable'}
                  onClick={(e) => { e.stopPropagation(); onToggleStatus(check.id, !check.disabled); }}
                  className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 hover:border-primary/30 transition-colors cursor-pointer"
                />
              </TooltipTrigger>
              <TooltipContent className={glassClasses}><span className="text-xs font-mono">{check.disabled ? 'Enable' : 'Disable'}</span></TooltipContent>
            </Tooltip>
          </div>
        </TableCell>
      )}
      <TableCell className="px-4 py-4">
        <div className="flex items-center justify-center">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <IconButton icon={<MoreVertical className="w-4 h-4" />} size="sm" variant="ghost" aria-label="More actions" aria-haspopup="menu" className="text-muted-foreground hover:text-primary hover:bg-primary/10 pointer-events-auto p-1 transition-colors cursor-pointer" />
            </DropdownMenuTrigger>
            {menuOpen && (
              <DropdownMenuContent align="end" className={`${glassClasses} z-[55]`}>
                <DropdownMenuItem onClick={() => onViewDetails(check.id)} className="cursor-pointer font-mono">
                  <Radio className="w-3 h-3" />
                  <span className="ml-2">View details</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {!domainOnly && (
                  <DropdownMenuItem onClick={() => { if (!check.disabled && !isManuallyChecking) onCheckNow(check.id); }} disabled={check.disabled || isManuallyChecking} className="cursor-pointer font-mono" title={check.disabled ? 'Cannot check disabled websites' : isManuallyChecking ? 'Check in progress...' : 'Check now'}>
                    {isManuallyChecking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    <span className="ml-2">{isManuallyChecking ? 'Checking...' : 'Check now'}</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onToggleStatus(check.id, !check.disabled)} className="cursor-pointer font-mono">
                  {check.disabled ? <Power className="w-3 h-3" /> : <PowerOff className="w-3 h-3" />}
                  <span className="ml-2">{check.disabled ? 'Enable' : 'Disable'}</span>
                </DropdownMenuItem>
                {!domainOnly && onToggleMaintenance && (
                  <DropdownMenuItem onClick={() => onToggleMaintenance(check)} className="cursor-pointer font-mono" disabled={check.disabled}>
                    {check.maintenanceMode ? <CheckCircle className="w-3 h-3 text-primary" /> : <Wrench className="w-3 h-3 text-warning" />}
                    <span className="ml-2">{check.maintenanceMode ? 'Exit Maintenance' : 'Enter Maintenance'}</span>
                    {!isNano && !check.maintenanceMode && <Sparkles className="w-3 h-3 text-tier-pro/90 ml-auto" />}
                  </DropdownMenuItem>
                )}
                {!domainOnly && onCancelScheduledMaintenance && check.maintenanceScheduledStart && (
                  <DropdownMenuItem onClick={() => onCancelScheduledMaintenance(check)} className="cursor-pointer font-mono">
                    <CalendarX2 className="w-3 h-3 text-warning" /><span className="ml-2">Cancel Scheduled</span>
                  </DropdownMenuItem>
                )}
                {!domainOnly && onEditRecurringMaintenance && check.maintenanceRecurring && (
                  <DropdownMenuItem onClick={() => onEditRecurringMaintenance(check)} className="cursor-pointer font-mono">
                    <SquarePen className="w-3 h-3 text-warning" /><span className="ml-2">Edit Recurring</span>
                  </DropdownMenuItem>
                )}
                {!domainOnly && onDeleteRecurringMaintenance && check.maintenanceRecurring && (
                  <DropdownMenuItem onClick={() => onDeleteRecurringMaintenance(check)} className="cursor-pointer font-mono text-destructive">
                    <Trash2 className="w-3 h-3" /><span className="ml-2">Delete Recurring</span>
                  </DropdownMenuItem>
                )}
                {!domainOnly && (
                  <DropdownMenuItem onClick={() => window.open(check.url, '_blank', 'noopener,noreferrer')} className="cursor-pointer font-mono">
                    <ExternalLink className="w-3 h-3" /><span className="ml-2">Open URL</span>
                  </DropdownMenuItem>
                )}
                {!domainOnly && onRefreshMetadata && (
                  <DropdownMenuItem onClick={() => onRefreshMetadata(check)} className="cursor-pointer font-mono">
                    <MapPin className="w-3 h-3" /><span className="ml-2">Refresh geo data</span>
                  </DropdownMenuItem>
                )}
                {onSetFolder && (<>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="cursor-pointer font-mono"><Folder className="w-3 h-3" /><span className="ml-2">Move to folder</span></DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className={glassClasses}>
                      <DropdownMenuItem onClick={() => onSetFolder(check.id, null)} className="cursor-pointer font-mono"><span>Unsorted</span></DropdownMenuItem>
                      {folderOptions.map((f) => (
                        <DropdownMenuItem key={f} onClick={() => onSetFolder(check.id, f)} className="cursor-pointer font-mono"><span className="truncate max-w-[220px]">{f}</span></DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => onOpenNewFolder(check)} className="cursor-pointer font-mono"><Plus className="w-3 h-3" /><span className="ml-2">New folder…</span></DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>)}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onEdit(check)} className="cursor-pointer font-mono"><Edit className="w-3 h-3" /><span className="ml-2">Edit</span></DropdownMenuItem>
                {!domainOnly && onDuplicate && (
                  <DropdownMenuItem onClick={() => onDuplicate(check)} className="cursor-pointer font-mono"><Copy className="w-3 h-3" /><span className="ml-2">Duplicate</span></DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onDeleteClick(check)} className="cursor-pointer font-mono text-destructive focus:text-destructive"><Trash2 className="w-3 h-3" /><span className="ml-2">Delete</span></DropdownMenuItem>
              </DropdownMenuContent>
            )}
          </DropdownMenu>
        </div>
      </TableCell>
    </>
  );

  if (draggable) {
    return (
      <SortableCheckRow id={check.id} disabled={false} className={rowClassName} rowRef={rowRef}>
        {cells}
      </SortableCheckRow>
    );
  }
  return <TableRow ref={rowRef} className={rowClassName}>{cells}</TableRow>;
});

const CheckTable: React.FC<CheckTableProps> = ({
  checks,
  staleCheckIds,
  onDelete,
  onBulkDelete,
  onCheckNow,
  onRefreshMetadata,
  onToggleStatus,
  onBulkToggleStatus,
  onBulkUpdateSettings,
  onBulkMoveToFolder,
  onToggleMaintenance,
  onCancelScheduledMaintenance,
  onEditRecurringMaintenance,
  onDeleteRecurringMaintenance,
  onBulkToggleMaintenance,
  onReorderAndCommit,
  onEdit,
  onDuplicate,
  isNano = false,
  minIntervalSeconds,
  groupBy = 'none',
  onGroupByChange,
  onSetFolder,
  searchQuery = '',
  onAddFirstCheck,
  optimisticUpdates = [],
  folderUpdates = [],
  manualChecksInProgress = [],
  sortBy: sortByProp,
  onSortChange,
  pendingCheck = null
}) => {
  // No user tier logic yet
  const isMobile = useMobile(640); // sm breakpoint - hide bulk select on mobile
  const navigate = useNavigate();

  // Use persistent sort preference from Firestore, fallback to 'custom'
  const sortBy = (sortByProp as SortOption) || 'custom';
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [deletingCheck, setDeletingCheck] = useState<Website | null>(null);

  // Multi-select state
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  // Mirror selection + ordered list into refs so the per-row select handler
  // can stay referentially stable (empty deps) — without this, toggling one
  // checkbox would re-create the handler and bust every row's React.memo.
  const selectedChecksRef = React.useRef(selectedChecks);
  selectedChecksRef.current = selectedChecks;
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  const [bulkEditModal, setBulkEditModal] = useState(false);
  const [selectAll, setSelectAll] = useState(false);
  const lastClickedIndexRef = React.useRef<number | null>(null);
  const [folderMoveOpen, setFolderMoveOpen] = useState(false);
  // Large bulk actions (move/enable/disable/maintenance) confirm before firing
  // so one mis-aimed select-all can't silently rewrite the whole fleet.
  const [bulkConfirm, setBulkConfirm] = useState<{
    title: string;
    message: string;
    confirmText: string;
    count: number;
    action: () => void;
  } | null>(null);
  // @dnd-kit sensors: pointer with 5px activation distance to avoid accidental drags
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const [columnVisibility, setColumnVisibility] = useLocalStorage<CheckTableColumnVisibility>(
    'checks-table-columns-v1',
    DEFAULT_CHECKS_TABLE_COLUMN_VISIBILITY
  );

  const COL_COUNT =
    (isMobile ? 1 : 2) + // selection (hidden on mobile) + actions (always visible)
    (columnVisibility.order ? 1 : 0) +
    (columnVisibility.status ? 1 : 0) +
    (columnVisibility.nameUrl ? 1 : 0) +
    (columnVisibility.type ? 1 : 0) +
    (columnVisibility.responseTime ? 1 : 0) +
    (columnVisibility.lastChecked ? 1 : 0) +
    (columnVisibility.checkInterval ? 1 : 0) +
    (columnVisibility.quickActions ? 1 : 0);

  const setColumnVisible = useCallback((key: CheckTableColumnKey, next: boolean) => {
    setColumnVisibility((prev) => ({
      ...prev,
      [key]: next,
    }));
  }, [setColumnVisibility]);

  const [collapsedFolders, setCollapsedFolders] = useLocalStorage<string[]>(
    'checks-folder-collapsed-v1',
    []
  );
  const collapsedSet = useMemo(() => new Set(collapsedFolders), [collapsedFolders]);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderCheck, setNewFolderCheck] = useState<Website | null>(null);

  const [folderColors] = useLocalStorage<Record<string, string>>(
    'checks-folder-view-colors-v1',
    {}
  );

  // Custom folders (shared with CheckFolderView). Includes empty folders that
  // have no checks yet, so a freshly created folder shows up in the move menus.
  const [customFolders, setCustomFolders] = useLocalStorage<string[]>(
    'checks-folder-view-custom-folders-v1',
    []
  );

  // Folder sort order (shared with CheckFolderView). Keys are folder paths; value is ordinal position.
  // Folders without an entry sort after ordered ones, alphabetically. __unsorted__ is always pinned first.
  const [folderOrder, setFolderOrder] = useLocalStorage<Record<string, number>>(
    'checks-folder-view-order-v1',
    {}
  );

  const getFolderColor = useCallback((folder?: string | null) => {
    const normalized = normalizeFolder(folder);
    if (!normalized) return undefined;
    const color = folderColors[normalized];
    return color && color !== 'default' ? color : undefined;
  }, [folderColors]);

  // Removed realtime countdowns in Last Checked column per UX update

  // O(1) Set-based lookups for optimistic/folder/manual-check state
  const optimisticUpdatesSet = useMemo(() => new Set(optimisticUpdates), [optimisticUpdates]);
  const folderUpdatesSet = useMemo(() => new Set(folderUpdates), [folderUpdates]);
  const manualChecksSet = useMemo(() => new Set(manualChecksInProgress), [manualChecksInProgress]);

  // Sort checks based on selected option
  const sortedChecks = React.useMemo(() => {
    const sorted = [...checks];

    switch (sortBy) {
      case 'custom':
        return sorted.sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
      case 'name-asc':
        return sorted.sort((a, b) => a.name.localeCompare(b.name));
      case 'name-desc':
        return sorted.sort((a, b) => b.name.localeCompare(a.name));
      case 'url-asc':
        return sorted.sort((a, b) => a.url.localeCompare(b.url));
      case 'url-desc':
        return sorted.sort((a, b) => b.url.localeCompare(a.url));
      case 'status':
        return sorted.sort((a, b) => {
          const statusOrder = {
            'online': 0, 'UP': 0,
            'offline': 1, 'DOWN': 1,
            'REDIRECT': 2,
            'REACHABLE_WITH_ERROR': 3,
            'unknown': 4
          };
          const aOrder = (statusOrder as Record<string, number>)[a.status || 'unknown'] ?? 4;
          const bOrder = (statusOrder as Record<string, number>)[b.status || 'unknown'] ?? 4;
          return aOrder - bOrder;
        });
      case 'lastChecked':
        return sorted.sort((a, b) => {
          const aTime = a.lastChecked || 0;
          const bTime = b.lastChecked || 0;
          return bTime - aTime;
        });
      case 'responseTime':
        return sorted.sort((a, b) => {
          const aTime = a.responseTime || 0;
          const bTime = b.responseTime || 0;
          return aTime - bTime;
        });
      case 'type':
        return sorted.sort((a, b) => {
          const aType = a.type || 'website';
          const bType = b.type || 'website';
          return aType.localeCompare(bType);
        });
      case 'createdAt':
        return sorted.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      case 'checkFrequency':
        return sorted.sort((a, b) => (a.checkFrequency || 0) - (b.checkFrequency || 0));
      default:
        return sorted;
    }
  }, [checks, sortBy]);

  const sortedChecksRef = React.useRef(sortedChecks);
  sortedChecksRef.current = sortedChecks;

  // Flat position of each check — rows above the fold (first ~25) mount
  // their content immediately; the rest wait for the viewport observer.
  const rowIndexById = useMemo(() => {
    const m = new Map<string, number>();
    sortedChecks.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [sortedChecks]);

  const handleSortChange = useCallback((newSortBy: SortOption) => {
    if (onSortChange) {
      onSortChange(newSortBy);
    }
  }, [onSortChange]);

  const canDragReorder = sortBy === 'custom';

  // Stable callbacks handed to the memoized rows. `onEdit` from the parent
  // is an inline arrow (new identity every render), so it's stabilized here
  // to keep row memos intact across parent re-renders (e.g. WS overlay ticks).
  const stableOnEdit = useStableCallback(onEdit);
  const handleViewDetails = useCallback((id: string) => {
    navigate(`/checks/${id}`);
  }, [navigate]);

  const activeCheck = activeDragId && !activeDragId.startsWith(FOLDER_SORT_ID_PREFIX)
    ? sortedChecks.find(c => c.id === activeDragId)
    : null;

  // Ref kept in sync with groupedByFolder so handleDragEnd can read the current order
  // without creating a forward-reference to the memo below.
  const groupedByFolderRef = React.useRef<{ key: string; label: string; checks: Website[] }[] | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over || active.id === over.id) return;

    const activeData = active.data.current as { type?: string; folderKey?: string; isFolderSource?: boolean } | undefined;
    const overData = over.data.current as { type?: string; folderKey?: string } | undefined;

    // Folder drag → reorder folders
    if (activeData?.isFolderSource && activeData.folderKey) {
      if (overData?.type !== 'folder' || !overData.folderKey) return;
      const fromKey = activeData.folderKey;
      const toKey = overData.folderKey;
      if (fromKey === toKey) return;
      const current = (groupedByFolderRef.current ?? []).map((g) => g.key);
      const fromIndex = current.indexOf(fromKey);
      const toIndex = current.indexOf(toKey);
      if (fromIndex === -1 || toIndex === -1) return;
      const next = arrayMove(current, fromIndex, toIndex);
      const nextOrder: Record<string, number> = {};
      next.forEach((key, idx) => { nextOrder[key] = idx; });
      setFolderOrder(nextOrder);
      return;
    }

    // From here: active is a check row.
    const activeCheck = checks.find(c => c.id === active.id);
    if (!activeCheck) return;

    // Drop onto a folder header (droppable)
    if (overData?.type === 'folder' && overData.folderKey) {
      if (!onSetFolder) return;
      const targetFolder = overData.folderKey === '__unsorted__' ? null : overData.folderKey;
      const currentFolder = normalizeFolder(activeCheck.folder ?? null);
      if (currentFolder === targetFolder) return;
      onSetFolder(active.id as string, targetFolder);
      return;
    }

    // Drop onto another check
    if (groupBy === 'folder') {
      const oc = checks.find(c => c.id === over.id);
      const activeFolder = normalizeFolder(activeCheck.folder ?? null);
      const overFolder = normalizeFolder(oc?.folder ?? null);
      if (activeFolder !== overFolder) {
        // Cross-folder drop: move to target folder instead of reordering
        if (onSetFolder) onSetFolder(active.id as string, overFolder);
        return;
      }
    }
    onReorderAndCommit?.(active.id as string, over.id as string);
  }, [checks, groupBy, onReorderAndCommit, onSetFolder, setFolderOrder]);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  // Folder paths offered in the "Move to folder" menus. Built from both the
  // checks' assigned folders AND the shared custom-folders list so that empty
  // folders (e.g. just created in CheckFolderView) are still selectable here.
  const folderOptions = useMemo(
    () => buildFolderList(checks, customFolders).map((f) => f.path),
    [checks, customFolders]
  );

  const groupedByFolder = useMemo(() => {
    if (groupBy !== 'folder') return null;
    const map = new Map<string, Website[]>();
    for (const c of sortedChecks) {
      const key = (c.folder ?? '').trim() || '__unsorted__';
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }

    const keys = Array.from(map.keys());
    keys.sort((a, b) => {
      const oa = folderOrder[a];
      const ob = folderOrder[b];
      const hasA = typeof oa === 'number';
      const hasB = typeof ob === 'number';
      if (hasA && hasB && oa !== ob) return oa - ob;
      if (hasA && !hasB) return -1;
      if (!hasA && hasB) return 1;
      // Default order when no explicit folderOrder is set: pin Unsorted first,
      // then alphabetical. Once the user drags, every folder gets an explicit
      // ordinal and this fallback no longer applies.
      if (a === '__unsorted__') return -1;
      if (b === '__unsorted__') return 1;
      return a.localeCompare(b);
    });

    return keys.map((key) => ({
      key,
      label: key === '__unsorted__' ? 'Unsorted' : key,
      checks: map.get(key) ?? [],
    }));
  }, [groupBy, sortedChecks, folderOrder]);

  useEffect(() => {
    groupedByFolderRef.current = groupedByFolder;
  }, [groupedByFolder]);

  // Ordered list of sortable folder drag ids (Unsorted included — it's a real folder).
  const sortableFolderIds = useMemo(() => {
    if (!groupedByFolder) return [] as string[];
    return groupedByFolder.map((g) => `${FOLDER_SORT_ID_PREFIX}${g.key}`);
  }, [groupedByFolder]);

  const activeFolderKey = activeDragId?.startsWith(FOLDER_SORT_ID_PREFIX)
    ? activeDragId.slice(FOLDER_SORT_ID_PREFIX.length)
    : null;
  const activeFolderGroup = activeFolderKey && groupedByFolder
    ? groupedByFolder.find(g => g.key === activeFolderKey) ?? null
    : null;

  const toggleFolderCollapsed = useCallback((folderKey: string) => {
    setCollapsedFolders((prev) => {
      const set = new Set(prev);
      if (set.has(folderKey)) set.delete(folderKey);
      else set.add(folderKey);
      return Array.from(set);
    });
  }, [setCollapsedFolders]);

  const normalizeFolderName = useCallback((name: string) => {
    return name.trim().replace(/\s+/g, ' ');
  }, []);

  const openNewFolderDialog = useCallback((check: Website) => {
    setNewFolderCheck(check);
    setNewFolderName('');
    setNewFolderOpen(true);
  }, []);

  const commitNewFolder = useCallback(async () => {
    if (!newFolderCheck || !onSetFolder) return;
    const normalized = normalizeFolderName(newFolderName);
    if (!normalized) return;
    const folderError = getFolderPathError(normalized);
    if (folderError) {
      toast.error(folderError);
      return;
    }
    // Register in the shared custom-folders list so the new folder persists and
    // stays visible in both views even if its only check is later moved out.
    setCustomFolders((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
    await onSetFolder(newFolderCheck.id, normalized);
    setNewFolderOpen(false);
    setNewFolderCheck(null);
    setNewFolderName('');
  }, [newFolderCheck, newFolderName, onSetFolder, normalizeFolderName, setCustomFolders]);

  // Delete confirmation handlers (stable so it doesn't bust row memos)
  const handleDeleteClick = useCallback((check: Website) => {
    setDeletingCheck(check);
  }, []);

  const handleDeleteConfirm = () => {
    if (deletingCheck) {
      onDelete(deletingCheck.id);
      setDeletingCheck(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeletingCheck(null);
  };

  // Multi-select handlers
  const handleSelectAll = useCallback(() => {
    if (selectAll) {
      setSelectedChecks(new Set());
      setSelectAll(false);
    } else {
      setSelectedChecks(new Set(sortedChecks.map(check => check.id)));
      setSelectAll(true);
    }
  }, [selectAll, sortedChecks]);

  // Stable (empty deps) so it never busts row memos. Reads the latest
  // selection + ordered list from refs instead of closing over them.
  const handleSelectCheck = useCallback((checkId: string, event?: React.MouseEvent) => {
    const list = sortedChecksRef.current;
    const newSelected = new Set(selectedChecksRef.current);
    const currentIndex = list.findIndex(c => c.id === checkId);

    if (event?.shiftKey && lastClickedIndexRef.current !== null && lastClickedIndexRef.current < list.length) {
      // Shift-click: select range (additive)
      const start = Math.min(lastClickedIndexRef.current, currentIndex);
      const end = Math.max(lastClickedIndexRef.current, currentIndex);
      for (let i = start; i <= end; i++) {
        newSelected.add(list[i].id);
      }
    } else {
      // Normal click: toggle single
      if (newSelected.has(checkId)) {
        newSelected.delete(checkId);
      } else {
        newSelected.add(checkId);
      }
    }

    setSelectedChecks(newSelected);
    setSelectAll(newSelected.size === list.length);
    lastClickedIndexRef.current = currentIndex;
  }, []);

  const handleSelectFolder = useCallback((folderCheckIds: string[]) => {
    const allSelected = folderCheckIds.every(id => selectedChecks.has(id));
    const newSelected = new Set(selectedChecks);
    if (allSelected) {
      folderCheckIds.forEach(id => newSelected.delete(id));
    } else {
      folderCheckIds.forEach(id => newSelected.add(id));
    }
    setSelectedChecks(newSelected);
    setSelectAll(newSelected.size === sortedChecks.length);
  }, [selectedChecks, sortedChecks.length]);

  const handleBulkDelete = useCallback(() => {
    setBulkDeleteModal(true);
  }, []);

  const handleBulkDeleteConfirm = useCallback(() => {
    onBulkDelete(Array.from(selectedChecks));
    setSelectedChecks(new Set());
    setSelectAll(false);
    setBulkDeleteModal(false);
  }, [onBulkDelete, selectedChecks]);

  const handleBulkDeleteCancel = useCallback(() => {
    setBulkDeleteModal(false);
  }, []);

  const handleBulkToggleStatus = useCallback((disabled: boolean) => {
    onBulkToggleStatus(Array.from(selectedChecks), disabled);
    setSelectedChecks(new Set());
    setSelectAll(false);
  }, [onBulkToggleStatus, selectedChecks]);

  // Runs a bulk action immediately below the threshold; above it, asks first
  // with the count and the first few affected names.
  const runOrConfirmBulk = useCallback((opts: { title: string; verb: string; suffix?: string; confirmText: string; action: () => void }) => {
    const selected = sortedChecksRef.current.filter(c => selectedChecksRef.current.has(c.id));
    if (selected.length < BULK_CONFIRM_THRESHOLD) {
      opts.action();
      return;
    }
    const names = selected.slice(0, 5).map(c => c.name);
    const rest = selected.length - names.length;
    const nameList = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
    setBulkConfirm({
      title: opts.title,
      message: `This will ${opts.verb} ${selected.length} checks${opts.suffix ?? ''}: ${nameList}.`,
      confirmText: opts.confirmText,
      count: selected.length,
      action: opts.action,
    });
  }, []);



  // Reset selection only when the set of check IDs changes (added/removed),
  // not when check data updates (status, lastChecked, etc.)
  const checkIds = useMemo(() => checks.map(c => c.id).join(','), [checks]);
  useEffect(() => {
    setSelectedChecks(new Set());
    setSelectAll(false);
    lastClickedIndexRef.current = null;
  }, [checkIds]);





  // Renders a mobile check card with all necessary props from the table context
  const renderMobileCard = (check: Website) => (
    <CheckCard
      key={check.id}
      check={check}
      isSelected={isMobile ? false : selectedChecks.has(check.id)}
      onSelect={isMobile ? undefined : handleSelectCheck}
      hideCheckbox={isMobile}
      onCheckNow={onCheckNow}
      onToggleStatus={onToggleStatus}
      onToggleMaintenance={onToggleMaintenance}
      onCancelScheduledMaintenance={onCancelScheduledMaintenance}
      onEditRecurringMaintenance={onEditRecurringMaintenance}
      onDeleteRecurringMaintenance={onDeleteRecurringMaintenance}
      onEdit={stableOnEdit}
      onDuplicate={onDuplicate}
      onDelete={handleDeleteClick}
      onSetFolder={onSetFolder}
      openNewFolderDialog={openNewFolderDialog}
      isNano={isNano}
      isOptimisticallyUpdating={optimisticUpdatesSet.has(check.id)}
      isFolderUpdating={folderUpdatesSet.has(check.id)}
      isManuallyChecking={manualChecksSet.has(check.id)}
      isStale={staleCheckIds?.has(check.id) ?? false}
      searchQuery={searchQuery}
      folderOptions={folderOptions}
      folderColor={getFolderColor(check.folder)}
    />
  );

  // Thin element factory for a check row. All the heavy JSX lives in the
  // memoized CheckTableRow, which skips re-rendering when its (primitive /
  // referentially-stable) props are unchanged — so a WS overlay tick, a
  // selection toggle, or a search keystroke only re-renders the rows whose
  // data actually changed instead of all 300+.
  const renderRow = (check: Website) => (
    <CheckTableRow
      key={check.id}
      check={check}
      draggable={canDragReorder}
      colCount={COL_COUNT}
      initiallyVisible={(rowIndexById.get(check.id) ?? 0) < 25}
      isMobile={isMobile}
      columnVisibility={columnVisibility}
      isSelected={selectedChecks.has(check.id)}
      isOptimistic={optimisticUpdatesSet.has(check.id)}
      isFolderUpdating={folderUpdatesSet.has(check.id)}
      isManuallyChecking={manualChecksSet.has(check.id)}
      isNano={isNano}
      isStale={staleCheckIds?.has(check.id) ?? false}
      searchQuery={searchQuery}
      folderColor={getFolderColor(check.folder)}
      folderOptions={folderOptions}
      onSelect={handleSelectCheck}
      onCheckNow={onCheckNow}
      onToggleStatus={onToggleStatus}
      onToggleMaintenance={onToggleMaintenance}
      onCancelScheduledMaintenance={onCancelScheduledMaintenance}
      onEditRecurringMaintenance={onEditRecurringMaintenance}
      onDeleteRecurringMaintenance={onDeleteRecurringMaintenance}
      onRefreshMetadata={onRefreshMetadata}
      onEdit={stableOnEdit}
      onDuplicate={onDuplicate}
      onDeleteClick={handleDeleteClick}
      onSetFolder={onSetFolder}
      onViewDetails={handleViewDetails}
      onOpenNewFolder={openNewFolderDialog}
    />
  );

  return (
    <>
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <ChecksTableShell
        mobile={(
          <>
            <div className="space-y-3">
              {groupBy === 'folder' && groupedByFolder
                ? groupedByFolder.map((group) => {
                  const folderCheckIds = group.checks.map(c => c.id);
                  const allSelected = folderCheckIds.length > 0 && folderCheckIds.every(id => selectedChecks.has(id));
                  const someSelected = !allSelected && folderCheckIds.some(id => selectedChecks.has(id));
                  return (
                  <div key={group.key} className="space-y-3">
                    <div className="w-full flex items-center gap-2 px-2 py-1 text-sm font-medium text-muted-foreground">
                      {!isMobile && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSelectFolder(folderCheckIds); }}
                        className={`w-4 h-4 shrink-0 border-2 rounded transition-colors duration-150 ${allSelected || someSelected ? 'border bg-background' : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                        title={allSelected ? 'Deselect folder' : 'Select folder'}
                      >
                        {allSelected && <Check className="w-2.5 h-2.5 text-white" />}
                        {someSelected && <Minus className="w-2.5 h-2.5 text-white" />}
                      </button>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleFolderCollapsed(group.key)}
                        className="flex-1 flex items-center justify-between cursor-pointer"
                        aria-label={`Toggle ${group.label}`}
                      >
                        <span className="flex items-center gap-2">
                          {collapsedSet.has(group.key) ? (
                            <ChevronRight className="w-4 h-4" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                          <span className="font-sans">{group.label}</span>
                        </span>
                        <span className="text-xs font-mono">{group.checks.length}</span>
                      </button>
                    </div>
                    {!collapsedSet.has(group.key) &&
                      group.checks.map((check) =>
                        renderMobileCard(check)
                      )}
                  </div>
                  );
                })
                : sortedChecks.map((check) =>
                  renderMobileCard(check)
                )}
            </div>

            {checks.length === 0 && (
              <div className="">
                {searchQuery ? (
                  <EmptyState
                    variant="search"
                    title="No checks found"
                    description={`No checks match your search for "${searchQuery}". Try adjusting your search terms.`}
                  />
                ) : (
                  <EmptyState
                    variant="empty"
                    icon={Globe}
                    title="No checks configured yet"
                    description="Start monitoring your websites and API endpoints to get real-time status updates and alerts when they go down."
                    prominent
                    action={onAddFirstCheck ? {
                      label: "Add Your First Check",
                      onClick: onAddFirstCheck,
                      icon: Plus
                    } : undefined}
                  />
                )}
              </div>
            )}
          </>
        )}
        toolbar={(
          <>
            <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => onGroupByChange?.('none')}
                disabled={!onGroupByChange}
                className={`px-3 py-1 text-xs font-mono rounded-sm transition-all duration-150 cursor-pointer border ${
                  groupBy === 'none'
                    ? 'bg-primary/15 text-primary shadow-sm border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                }`}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => onGroupByChange?.('folder')}
                disabled={!onGroupByChange}
                className={`px-3 py-1 text-xs font-mono rounded-sm transition-all duration-150 cursor-pointer flex items-center gap-1.5 border ${
                  groupBy === 'folder'
                    ? 'bg-primary/15 text-primary shadow-sm border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                }`}
              >
                <Folder className="w-3 h-3" />
                Folders
              </button>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="font-mono text-xs cursor-pointer"
                >
                  Columns
                  <ChevronDown className="ml-2 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={`${glassClasses} w-56`}>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.order}
                  onCheckedChange={(checked) => setColumnVisible('order', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Order
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.status}
                  onCheckedChange={(checked) => setColumnVisible('status', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Status
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.nameUrl}
                  onCheckedChange={(checked) => setColumnVisible('nameUrl', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Name &amp; URL
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.type}
                  onCheckedChange={(checked) => setColumnVisible('type', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Type
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.responseTime}
                  onCheckedChange={(checked) => setColumnVisible('responseTime', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Response Time
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.lastChecked}
                  onCheckedChange={(checked) => setColumnVisible('lastChecked', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Last Checked
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.checkInterval}
                  onCheckedChange={(checked) => setColumnVisible('checkInterval', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Check Interval
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.quickActions}
                  onCheckedChange={(checked) => setColumnVisible('quickActions', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Quick Actions
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        table={(
          <Table
            style={{ tableLayout: 'fixed' }}
          >
                <TableHeader className="bg-muted border-b">
                  <TableRow>
                    {!isMobile && (
                    <TableHead className="px-3 py-4 text-left w-12">
                      <div className="flex items-center justify-center">
                        <button
                          onClick={handleSelectAll}
                          className={`w-4 h-4 border border-muted-foreground rounded transition-colors duration-150 ${selectAll ? 'bg-muted-foreground' : ''} hover:border-foreground cursor-pointer flex items-center justify-center`}
                          title={selectAll ? 'Deselect all' : 'Select all'}
                        >
                          {selectAll && (
                            <Check className="w-2.5 h-2.5 text-background" />
                          )}
                        </button>
                      </div>
                    </TableHead>
                    )}

                    {columnVisibility.order && (
                      <TableHead className="px-3 py-4 text-left w-12">
                        <div className={`text-xs font-medium uppercase tracking-wider font-mono ${sortBy === 'custom' ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
                          {sortBy === 'custom' ? 'Order' : 'Order'}
                        </div>
                      </TableHead>
                    )}
                    {columnVisibility.status && (
                      <TableHead className="px-4 py-4 text-left w-40">
                        <button
                          onClick={() => handleSortChange(sortBy === 'status' ? 'custom' : 'status')}
                          className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                        >
                          Status
                          {sortBy === 'status' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                        </button>
                      </TableHead>
                    )}
                    {columnVisibility.nameUrl && (
                      <TableHead className="px-4 py-4 text-left w-80">
                        <button
                          onClick={() => handleSortChange(sortBy === 'name-asc' ? 'name-desc' : 'name-asc')}
                          className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                        >
                          Name & URL
                          {sortBy === 'name-asc' ? <SortDesc className="w-3 h-3" /> : sortBy === 'name-desc' ? <SortAsc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                        </button>
                      </TableHead>
                    )}
                    {columnVisibility.type && (
                      <TableHead className="px-4 py-4 text-left w-50">
                        <button
                          onClick={() => handleSortChange(sortBy === 'type' ? 'custom' : 'type')}
                          className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                        >
                          Type
                          {sortBy === 'type' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                        </button>
                      </TableHead>
                    )}
                    {columnVisibility.responseTime && (
                      <TableHead className="px-4 py-4 text-left w-50">
                        <button
                          onClick={() => handleSortChange(sortBy === 'responseTime' ? 'custom' : 'responseTime')}
                          className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                        >
                          Response Time
                          {sortBy === 'responseTime' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                        </button>
                      </TableHead>
                    )}
                    {columnVisibility.lastChecked && (
                      <TableHead className="px-4 py-4 text-left w-50">
                        <button
                          onClick={() => handleSortChange(sortBy === 'lastChecked' ? 'custom' : 'lastChecked')}
                          className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                        >
                          Last Checked
                          {sortBy === 'lastChecked' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                        </button>
                      </TableHead>
                    )}
                    {columnVisibility.checkInterval && (
                      <TableHead className="px-4 py-4 text-left w-40">
                        <button
                          onClick={() => handleSortChange(sortBy === 'checkFrequency' ? 'custom' : 'checkFrequency')}
                          className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                        >
                          Check Interval
                          {sortBy === 'checkFrequency' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                        </button>
                      </TableHead>
                    )}
                    {columnVisibility.quickActions && (
                      <TableHead className="px-4 py-4 text-center w-36">
                        <div className={`text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground`}>
                          Quick Actions
                        </div>
                      </TableHead>
                    )}
                    <TableHead className="px-4 py-4 text-center w-28">
                      <div className={`text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground`}>
                        Actions
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="divide-y divide-border">
                  {pendingCheck && (
                    <TableRow className="animate-pulse bg-accent/50">
                      <TableCell className="px-4 py-4"><div className="w-4 h-4" /></TableCell>
                      {columnVisibility.order && (<TableCell className="px-4 py-4"><div className="flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div></TableCell>)}
                      {columnVisibility.status && (<TableCell className="px-4 py-4"><div className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-primary" /><span className="text-xs font-medium text-muted-foreground">Adding...</span></div></TableCell>)}
                      {columnVisibility.nameUrl && (<TableCell className="px-4 py-4"><div className="flex flex-col gap-0.5"><span className="text-sm font-medium text-foreground">{pendingCheck.name}</span><span className="text-xs text-muted-foreground truncate max-w-[300px]">{pendingCheck.url}</span></div></TableCell>)}
                      {columnVisibility.type && (<TableCell className="px-4 py-4"><span className="text-xs text-muted-foreground">website</span></TableCell>)}
                      {columnVisibility.responseTime && (<TableCell className="px-4 py-4"><span className="text-xs text-muted-foreground">&mdash;</span></TableCell>)}
                      {columnVisibility.lastChecked && (<TableCell className="px-4 py-4"><span className="text-xs text-muted-foreground">&mdash;</span></TableCell>)}
                      {columnVisibility.checkInterval && (<TableCell className="px-4 py-4"><span className="text-xs text-muted-foreground">&mdash;</span></TableCell>)}
                      {columnVisibility.quickActions && (<TableCell className="px-4 py-4" />)}
                      <TableCell className="px-4 py-4" />
                    </TableRow>
                  )}
                  {groupBy === 'folder' && groupedByFolder
                    ? (
                      <SortableContext items={sortableFolderIds} strategy={verticalListSortingStrategy}>
                        {groupedByFolder.map((group) => {
                          const isCollapsed = collapsedSet.has(group.key);
                          const groupColor = group.key === '__unsorted__' ? undefined : getFolderColor(group.key);
                          const folderCheckIds = group.checks.map(c => c.id);
                          const allSelected = folderCheckIds.length > 0 && folderCheckIds.every(id => selectedChecks.has(id));
                          const someSelected = !allSelected && folderCheckIds.some(id => selectedChecks.has(id));
                          const headerProps = {
                            colSpan: COL_COUNT,
                            label: group.label,
                            count: group.checks.length,
                            isCollapsed,
                            onToggle: () => toggleFolderCollapsed(group.key),
                            color: groupColor,
                            selected: allSelected,
                            indeterminate: someSelected,
                            onSelect: isMobile ? undefined : () => handleSelectFolder(folderCheckIds),
                          };
                          return (
                            <React.Fragment key={`group-${group.key}`}>
                              <SortableFolderHeaderRow folderKey={group.key} {...headerProps} />
                              {!isCollapsed && (
                                canDragReorder ? (
                                  <SortableContext items={group.checks.map(c => c.id)} strategy={verticalListSortingStrategy}>
                                    {group.checks.map(renderRow)}
                                  </SortableContext>
                                ) : (
                                  group.checks.map(renderRow)
                                )
                              )}
                            </React.Fragment>
                          );
                        })}
                      </SortableContext>
                    )
                    : canDragReorder ? (
                      <SortableContext items={sortedChecks.map(c => c.id)} strategy={verticalListSortingStrategy}>
                        {sortedChecks.map(renderRow)}
                      </SortableContext>
                    ) : (
                      sortedChecks.map(renderRow)
                    )
                  }
                </TableBody>
          </Table>
        )}
        hasRows={checks.length > 0}
        emptyState={searchQuery ? (
          <EmptyState
            variant="search"
            title="No checks found"
            description={`No checks match your search for "${searchQuery}". Try adjusting your search terms.`}
          />
        ) : (
          <EmptyState
            variant="empty"
            icon={Globe}
            title="No checks configured yet"
            description="Start monitoring your websites and API endpoints to get real-time status updates and alerts when they go down."
            prominent
            action={onAddFirstCheck ? {
              label: "Add Your First Check",
              onClick: onAddFirstCheck,
              icon: Plus
            } : undefined}
          />
        )}
        containerClassName={`transition-all duration-300 ${activeDragId ? 'ring-2 ring-primary/20 shadow-xl' : ''}`}
      />

      <DragOverlay dropAnimation={null}>
        {activeCheck && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-background/95 backdrop-blur shadow-xl border border-primary/30 ring-2 ring-primary/20 max-w-md">
            <GripVertical className="w-4 h-4 text-primary shrink-0" />
            <StatusBadge status={activeCheck.maintenanceMode ? 'maintenance' : activeCheck.disabled ? 'disabled' : activeCheck.status} />
            <div className="flex flex-col min-w-0">
              <span className="font-medium text-sm text-foreground truncate">{activeCheck.name}</span>
              <span className="text-xs font-mono text-muted-foreground truncate">{getDisplayUrl(activeCheck)}</span>
            </div>
          </div>
        )}
        {activeFolderGroup && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-background/95 backdrop-blur shadow-xl border border-primary/30 ring-2 ring-primary/20 max-w-md">
            <GripVertical className="w-4 h-4 text-primary shrink-0" />
            <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="font-medium text-sm text-foreground truncate">{activeFolderGroup.label}</span>
            <span className="text-xs font-mono text-muted-foreground ml-auto">{activeFolderGroup.checks.length}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>

      {/* Spacer to prevent bulk actions bar from covering bottom checks */}
      {!isMobile && selectedChecks.size > 0 && <div className="h-24 sm:h-20" />}

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!deletingCheck}
        onClose={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        title={`Delete "${deletingCheck?.name}"?`}
        message="This action cannot be undone. The check will be permanently removed from your monitoring list."
        confirmText="Delete Check"
        variant="destructive"
      />

      {/* Bulk Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={bulkDeleteModal}
        onClose={handleBulkDeleteCancel}
        onConfirm={handleBulkDeleteConfirm}
        title={`Delete ${selectedChecks.size} check${selectedChecks.size !== 1 ? 's' : ''}?`}
        message="This action cannot be undone. All selected checks will be permanently removed from your monitoring list."
        confirmText="Delete"
        variant="destructive"
        itemCount={selectedChecks.size}
        itemName="check"
      />

      {/* Large bulk-action confirmation (move/enable/disable/maintenance) */}
      <ConfirmationModal
        isOpen={bulkConfirm !== null}
        onClose={() => setBulkConfirm(null)}
        onConfirm={() => {
          bulkConfirm?.action();
          setBulkConfirm(null);
        }}
        title={bulkConfirm?.title ?? ''}
        message={bulkConfirm?.message ?? ''}
        confirmText={bulkConfirm?.confirmText}
        variant="warning"
        itemCount={bulkConfirm?.count}
        itemName="check"
      />

      {!isMobile && <BulkActionsBar
        selectedCount={selectedChecks.size}
        totalCount={sortedChecks.length}
        onClearSelection={() => {
          setSelectedChecks(new Set());
          setSelectAll(false);
          lastClickedIndexRef.current = null;
        }}
        itemLabel="check"
        actions={[
          ...(onBulkUpdateSettings ? [{
            label: 'Edit Settings',
            icon: <Settings2 className="w-3 h-3" />,
            onClick: () => setBulkEditModal(true),
            variant: 'ghost' as const,
          }] : []),
          {
            label: 'Enable',
            icon: <Power className="w-3 h-3" />,
            onClick: () => runOrConfirmBulk({
              title: 'Enable checks?',
              verb: 'enable',
              confirmText: 'Enable',
              action: () => handleBulkToggleStatus(false),
            }),
            variant: 'ghost',
          },
          {
            label: 'Disable',
            icon: <PowerOff className="w-3 h-3" />,
            onClick: () => runOrConfirmBulk({
              title: 'Disable checks?',
              verb: 'disable monitoring for',
              confirmText: 'Disable',
              action: () => handleBulkToggleStatus(true),
            }),
            variant: 'ghost',
          },
          ...(onBulkToggleMaintenance ? [{
            label: 'Enter Maintenance',
            icon: isNano ? <Wrench className="w-3 h-3" /> : <><Wrench className="w-3 h-3" /><Sparkles className="w-3 h-3 text-tier-pro/90" /></>,
            onClick: () => runOrConfirmBulk({
              title: 'Enter maintenance?',
              verb: 'put into maintenance mode',
              confirmText: 'Enter Maintenance for',
              action: () => {
                const selected = sortedChecks.filter(c => selectedChecks.has(c.id));
                onBulkToggleMaintenance(selected, true);
              },
            }),
            variant: 'ghost' as const,
          },
          {
            label: 'Exit Maintenance',
            icon: <CheckCircle className="w-3 h-3" />,
            onClick: () => runOrConfirmBulk({
              title: 'Exit maintenance?',
              verb: 'take out of maintenance mode',
              confirmText: 'Exit Maintenance for',
              action: () => {
                const selected = sortedChecks.filter(c => selectedChecks.has(c.id));
                onBulkToggleMaintenance(selected, false);
              },
            }),
            variant: 'ghost' as const,
          }] : []),
          ...(onBulkMoveToFolder ? [{
            label: 'Move to Folder',
            icon: <Folder className="w-3 h-3" />,
            onClick: () => setFolderMoveOpen(true),
            variant: 'ghost' as const,
          }] : []),
          {
            label: 'Delete',
            onClick: handleBulkDelete,
            isDelete: true,
          },
        ]}
      />}

      {/* Bulk Move to Folder Popover */}
      {onBulkMoveToFolder && (
        <Popover open={folderMoveOpen} onOpenChange={setFolderMoveOpen}>
          <PopoverTrigger asChild>
            <span className="fixed bottom-20 left-1/2 -translate-x-1/2 pointer-events-none" />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className="w-64 p-2 max-h-64 overflow-y-auto"
          >
            <div className="space-y-1">
              <button
                className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground"
                onClick={() => {
                  const ids = Array.from(selectedChecks);
                  setFolderMoveOpen(false);
                  runOrConfirmBulk({
                    title: 'Move checks?',
                    verb: 'move',
                    suffix: ' out of their folders',
                    confirmText: 'Move',
                    action: async () => {
                      await onBulkMoveToFolder(ids, null);
                      setSelectedChecks(new Set());
                      setSelectAll(false);
                      lastClickedIndexRef.current = null;
                    },
                  });
                }}
              >
                <Minus className="w-3.5 h-3.5" />
                No folder
              </button>
              {folderOptions.length > 0 && (
                <div className="h-px bg-border my-1" />
              )}
              {folderOptions.map((folder) => (
                <button
                  key={folder}
                  className="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted transition-colors flex items-center gap-2"
                  onClick={() => {
                    const ids = Array.from(selectedChecks);
                    setFolderMoveOpen(false);
                    runOrConfirmBulk({
                      title: 'Move checks?',
                      verb: 'move',
                      suffix: ` to "${folder}"`,
                      confirmText: 'Move',
                      action: async () => {
                        await onBulkMoveToFolder(ids, folder);
                        setSelectedChecks(new Set());
                        setSelectAll(false);
                        lastClickedIndexRef.current = null;
                      },
                    });
                  }}
                >
                  <Folder className="w-3.5 h-3.5" />
                  {folder}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {/* Bulk Edit Modal */}
      {onBulkUpdateSettings && (
        <BulkEditModal
          open={bulkEditModal}
          onOpenChange={setBulkEditModal}
          selectedCount={selectedChecks.size}
          minIntervalSeconds={minIntervalSeconds ?? (isNano ? 120 : 300)}
          isNano={isNano}
          onApply={async (settings) => {
            await onBulkUpdateSettings(Array.from(selectedChecks), settings);
            setSelectedChecks(new Set());
            setSelectAll(false);
          }}
        />
      )}

      {/* New Folder Dialog */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className={`${glassClasses} sm:max-w-[420px]`}>
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
            <DialogDescription>
              Pick a name for this folder. You can move checks between folders anytime.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-folder-name">Folder name</Label>
            <Input
              id="new-folder-name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="e.g. Marketing, APIs, Prod"
              className="cursor-text"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitNewFolder();
                }
              }}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setNewFolderOpen(false)}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void commitNewFolder()}
              className="cursor-pointer"
              disabled={!normalizeFolderName(newFolderName)}
            >
              Create & Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
};

export default CheckTable; 
