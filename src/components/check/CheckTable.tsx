import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import CheckCard from './CheckCard';
import ChecksTableShell from './ChecksTableShell';
import { FolderGroupHeaderRow } from './FolderGroupHeaderRow';
import { BulkEditModal, type BulkEditSettings } from './BulkEditModal';

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
  Pause,
  Trash2,
  ExternalLink,
  Globe,
  Code,
  Server,
  Radio,
  Check,
  ShieldCheck,
  AlertTriangle,
  Plus,
  Loader2,
  GripVertical,
  Settings2
} from 'lucide-react';
import { IconButton, Button, EmptyState, ConfirmationModal, StatusBadge, CHECK_INTERVALS, Table, TableHeader, TableBody, TableHead, TableRow, TableCell, SSLTooltip, glassClasses, Tooltip, TooltipTrigger, TooltipContent, BulkActionsBar, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Input, Label, Badge } from '../ui';
// NOTE: No tier-based enforcement. Keep table edit behavior tier-agnostic for now.
import type { Website } from '../../types';
import { formatLastChecked, formatResponseTime, formatNextRun, highlightText } from '../../utils/formatters.tsx';
import { getDefaultExpectedStatusCodes } from '../../lib/check-defaults';
import { getTableHoverColor } from '../../lib/utils';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { normalizeFolder } from '../../lib/folder-utils';

const getRegionLabel = (region?: Website['checkRegion']): { short: string; long: string } | null => {
  if (!region) return null;
  switch (region) {
    case 'us-central1':
      return { short: 'US', long: 'us-central1' };
    case 'europe-west1':
      return { short: 'EU', long: 'europe-west1' };
    case 'asia-southeast1':
      return { short: 'APAC', long: 'asia-southeast1' };
    default:
      return { short: String(region), long: String(region) };
  }
};

interface CheckTableProps {
  checks: Website[];
  onDelete: (id: string) => void;
  onBulkDelete: (ids: string[]) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onBulkToggleStatus: (ids: string[], disabled: boolean) => void;
  onBulkUpdateSettings?: (ids: string[], settings: BulkEditSettings) => Promise<void>;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onEdit: (check: Website) => void;
  isNano?: boolean;
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
}

type SortOption = 'custom' | 'name-asc' | 'name-desc' | 'url-asc' | 'url-desc' | 'status' | 'lastChecked' | 'createdAt' | 'responseTime' | 'type' | 'checkFrequency';

type CheckTableColumnKey =
  | 'order'
  | 'status'
  | 'nameUrl'
  | 'type'
  | 'responseTime'
  | 'lastChecked'
  | 'checkInterval';

type CheckTableColumnVisibility = Record<CheckTableColumnKey, boolean>;

const DEFAULT_CHECKS_TABLE_COLUMN_VISIBILITY: CheckTableColumnVisibility = {
  order: true,
  status: true,
  nameUrl: true,
  type: true,
  responseTime: true,
  lastChecked: true,
  checkInterval: true,
};

const CheckTable: React.FC<CheckTableProps> = ({
  checks,
  onDelete,
  onBulkDelete,
  onCheckNow,
  onToggleStatus,
  onBulkToggleStatus,
  onBulkUpdateSettings,
  onReorder,
  onEdit,
  isNano = false,
  groupBy = 'none',
  onGroupByChange,
  onSetFolder,
  searchQuery = '',
  onAddFirstCheck,
  optimisticUpdates = [],
  folderUpdates = [],
  manualChecksInProgress = [],
  sortBy: sortByProp,
  onSortChange
}) => {
  // No user tier logic yet

  // Use persistent sort preference from Firestore, fallback to 'custom'
  const sortBy = (sortByProp as SortOption) || 'custom';
  const [expandedRow] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [deletingCheck, setDeletingCheck] = useState<Website | null>(null);

  // Multi-select state
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  const [bulkEditModal, setBulkEditModal] = useState(false);
  const [selectAll, setSelectAll] = useState(false);

  const dragPreviewRef = useRef<HTMLElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const [columnVisibility, setColumnVisibility] = useLocalStorage<CheckTableColumnVisibility>(
    'checks-table-columns-v1',
    DEFAULT_CHECKS_TABLE_COLUMN_VISIBILITY
  );

  const COL_COUNT =
    2 + // selection + actions (always visible)
    (columnVisibility.order ? 1 : 0) +
    (columnVisibility.status ? 1 : 0) +
    (columnVisibility.nameUrl ? 1 : 0) +
    (columnVisibility.type ? 1 : 0) +
    (columnVisibility.responseTime ? 1 : 0) +
    (columnVisibility.lastChecked ? 1 : 0) +
    (columnVisibility.checkInterval ? 1 : 0);

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

  const getFolderColor = useCallback((folder?: string | null) => {
    const normalized = normalizeFolder(folder);
    if (!normalized) return undefined;
    const color = folderColors[normalized];
    return color && color !== 'default' ? color : undefined;
  }, [folderColors]);

  // Removed realtime countdowns in Last Checked column per UX update

  // Helper function to check if a check is being optimistically updated
  const isOptimisticallyUpdating = useCallback((checkId: string) => {
    return optimisticUpdates.includes(checkId);
  }, [optimisticUpdates]);

  const isFolderUpdating = useCallback((checkId: string) => {
    return folderUpdates.includes(checkId);
  }, [folderUpdates]);

  // Helper function to check if a check is being manually checked
  const isManuallyChecking = useCallback((checkId: string) => {
    return manualChecksInProgress.includes(checkId);
  }, [manualChecksInProgress]);

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
          const aOrder = statusOrder[a.status || 'unknown'] ?? 4;
          const bOrder = statusOrder[b.status || 'unknown'] ?? 4;
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

  const handleSortChange = useCallback((newSortBy: SortOption) => {
    if (onSortChange) {
      onSortChange(newSortBy);
    }
  }, [onSortChange]);

  const canDragReorder = sortBy === 'custom' && groupBy === 'none';

  const folderOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of checks) {
      const f = (c.folder ?? '').trim();
      if (f) set.add(f);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [checks]);

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
      if (a === '__unsorted__') return -1;
      if (b === '__unsorted__') return 1;
      return a.localeCompare(b);
    });

    return keys.map((key) => ({
      key,
      label: key === '__unsorted__' ? 'Unsorted' : key,
      checks: map.get(key) ?? [],
    }));
  }, [groupBy, sortedChecks]);

  const toggleFolderCollapsed = useCallback((folderKey: string) => {
    setCollapsedFolders((prev) => {
      const set = new Set(prev);
      if (set.has(folderKey)) set.delete(folderKey);
      else set.add(folderKey);
      return Array.from(set);
    });
  }, [setCollapsedFolders]);

  const normalizeFolderName = useCallback((name: string) => {
    const v = name.trim().replace(/\s+/g, ' ');
    return v ? v.slice(0, 48) : '';
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
    await onSetFolder(newFolderCheck.id, normalized);
    setNewFolderOpen(false);
    setNewFolderCheck(null);
    setNewFolderName('');
  }, [newFolderCheck, newFolderName, onSetFolder, normalizeFolderName]);

  // Enhanced Drag & Drop handlers with smooth animations
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    if (!canDragReorder) return;

    e.stopPropagation();
    setDraggedIndex(index);
    setIsDragging(true);

    // Create a custom drag preview
    const dragPreview = e.currentTarget.cloneNode(true) as HTMLElement;
    const targetElement = e.currentTarget as HTMLElement;
    dragPreview.style.position = 'absolute';
    dragPreview.style.top = '-1000px';
    dragPreview.style.left = '-1000px';
    dragPreview.style.width = `${targetElement.offsetWidth}px`;
    dragPreview.style.height = `${targetElement.offsetHeight}px`;
    dragPreview.style.opacity = '0.8';
    dragPreview.style.transform = 'rotate(2deg) scale(1.02)';
    dragPreview.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.15)';
    dragPreview.style.zIndex = '1000';
    dragPreview.style.pointerEvents = 'none';
    dragPreview.style.transition = 'none';

    document.body.appendChild(dragPreview);

    // Set the drag image
    e.dataTransfer.setDragImage(dragPreview, 0, 0);
    e.dataTransfer.effectAllowed = 'move';

    // Store reference to remove later
    if (dragPreviewRef.current) {
      document.body.removeChild(dragPreviewRef.current);
    }
    dragPreviewRef.current = dragPreview;

    // Calculate offset for smooth positioning
    // const rect = targetElement.getBoundingClientRect();
    // setDragOffset({
    //   x: e.clientX - rect.left,
    //   y: e.clientY - rect.top
    // });
  }, [canDragReorder]);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (!canDragReorder || draggedIndex === null) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (draggedIndex !== index) {
      setDragOverIndex(index);

      // Immediate reordering for better responsiveness
      onReorder(draggedIndex, index);
      setDraggedIndex(index);
    }
  }, [canDragReorder, draggedIndex, onReorder]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!canDragReorder) return;

    e.preventDefault();
    // Only clear dragOverIndex if we're leaving the table area
    const rect = e.currentTarget.getBoundingClientRect();
    const { clientX, clientY } = e;

    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      setDragOverIndex(null);
    }
  }, [canDragReorder]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!canDragReorder) return;

    e.preventDefault();
    // Reordering already happened in dragOver, just clean up
    setDraggedIndex(null);
    setDragOverIndex(null);
    setIsDragging(false);
  }, [canDragReorder]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    setIsDragging(false);

    // Clean up drag preview
    if (dragPreviewRef.current) {
      document.body.removeChild(dragPreviewRef.current);
      dragPreviewRef.current = null;
    }
  }, []);

  // Delete confirmation handlers
  const handleDeleteClick = (check: Website) => {
    setDeletingCheck(check);
  };

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

  const handleSelectCheck = useCallback((checkId: string) => {
    const newSelected = new Set(selectedChecks);
    if (newSelected.has(checkId)) {
      newSelected.delete(checkId);
    } else {
      newSelected.add(checkId);
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



  // Reset selection when checks change
  useEffect(() => {
    setSelectedChecks(new Set());
    setSelectAll(false);
  }, [checks]);





  const getTypeIcon = (type?: string) => {
    switch (type) {
      case 'rest_endpoint':
        return <Code className="text-primary" />;
      case 'tcp':
        return <Server className="text-primary" />;
      case 'udp':
        return <Radio className="text-primary" />;
      default:
        return <Globe className="text-primary" />;
    }
  };

  const getTypeLabel = (type?: string) => {
    switch (type) {
      case 'rest_endpoint':
        return 'API';
      case 'tcp':
        return 'TCP';
      case 'udp':
        return 'UDP';
      default:
        return 'Website';
    }
  };

  const getSSLCertificateStatus = (check: Website) => {
    if (check.url.startsWith('tcp://')) {
      return { valid: true, icon: Server, color: 'text-muted-foreground', text: 'TCP' };
    }
    if (check.url.startsWith('udp://')) {
      return { valid: true, icon: Radio, color: 'text-muted-foreground', text: 'UDP' };
    }
    if (!check.url.startsWith('https://')) {
      return { valid: true, icon: ShieldCheck, color: 'text-muted-foreground', text: 'HTTP' };
    }

    if (!check.sslCertificate) {
      return { valid: false, icon: AlertTriangle, color: 'text-muted-foreground', text: 'Unknown' };
    }

    if (check.sslCertificate.valid) {
      const daysUntilExpiry = check.sslCertificate.daysUntilExpiry || 0;
      if (daysUntilExpiry <= 30) {
        return {
          valid: true,
          icon: AlertTriangle,
          color: 'text-primary',
          text: `${daysUntilExpiry} days`
        };
      }
      return {
        valid: true,
        icon: ShieldCheck,
        color: 'text-primary',
        text: 'Valid'
      };
    } else {
      return {
        valid: false,
        icon: AlertTriangle,
        color: 'text-destructive',
        text: 'Invalid'
      };
    }
  };

  // Mobile Card Component
  const MobileCheckCard = ({ check }: { check: Website; index: number }) => {
    return (
      <CheckCard
        check={check}
        isSelected={selectedChecks.has(check.id)}
        onSelect={handleSelectCheck}
        onCheckNow={onCheckNow}
        onToggleStatus={onToggleStatus}
        onEdit={onEdit}
        onDelete={handleDeleteClick}
        onSetFolder={onSetFolder}
        openNewFolderDialog={openNewFolderDialog}
        isNano={isNano}
        isOptimisticallyUpdating={isOptimisticallyUpdating(check.id)}
        isFolderUpdating={isFolderUpdating(check.id)}
        isManuallyChecking={isManuallyChecking(check.id)}
        searchQuery={searchQuery}
        folderOptions={folderOptions}
        folderColor={getFolderColor(check.folder)}
      />
    );
  };

  return (
    <>
      <ChecksTableShell
        mobile={(
          <>
            <div className="space-y-3">
              {groupBy === 'folder' && groupedByFolder
                ? groupedByFolder.map((group) => (
                  <div key={group.key} className="space-y-3">
                    <button
                      type="button"
                      onClick={() => toggleFolderCollapsed(group.key)}
                      className="w-full flex items-center justify-between px-2 py-1 text-sm font-medium text-muted-foreground cursor-pointer"
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
                    {!collapsedSet.has(group.key) &&
                      group.checks.map((check, index) => (
                        <MobileCheckCard key={check.id} check={check} index={index} />
                      ))}
                  </div>
                ))
                : sortedChecks.map((check, index) => (
                  <MobileCheckCard key={check.id} check={check} index={index} />
                ))}
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
                    action={onAddFirstCheck ? {
                      label: "ADD YOUR FIRST CHECK",
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="font-mono text-xs cursor-pointer"
                  disabled={!onGroupByChange}
                >
                  Group by
                  <ChevronDown className="ml-2 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={`${glassClasses} w-56`}>
                <DropdownMenuRadioGroup
                  value={groupBy}
                  onValueChange={(v) => onGroupByChange?.(v as 'none' | 'folder')}
                >
                  <DropdownMenuRadioItem value="none" className="cursor-pointer font-mono">
                    No grouping
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="folder" className="cursor-pointer font-mono">
                    Group by folder
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

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
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        table={(
          <Table
            ref={tableRef}
            style={{
              tableLayout: 'fixed',
              transition: isDragging ? 'all 0.2s ease-out' : 'none'
            }}
            className={isDragging ? 'transform-gpu' : ''}
          >
                <TableHeader className="bg-muted border-b">
                  <TableRow>
                    <TableHead className="px-3 py-4 text-left w-12">
                      <div className="flex items-center justify-center">
                        <button
                          onClick={handleSelectAll}
                          className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectAll ? `border bg-background` : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                          title={selectAll ? 'Deselect all' : 'Select all'}
                        >
                          {selectAll && (
                            <Check className="w-2.5 h-2.5 text-white" />
                          )}
                        </button>
                      </div>
                    </TableHead>
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
                    <TableHead className="px-4 py-4 text-center w-28">
                      <div className={`text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground`}>
                        Actions
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className={`divide-y divide-border transition-all duration-300 ${isDragging ? 'transform-gpu' : ''}`}>
                  {(groupBy === 'folder' && groupedByFolder
                    ? groupedByFolder.flatMap((group) => {
                      const isCollapsed = collapsedSet.has(group.key);
                      const groupColor = group.key === '__unsorted__' ? undefined : getFolderColor(group.key);
                      const header = (
                        <React.Fragment key={`group-${group.key}`}>
                          <FolderGroupHeaderRow
                            colSpan={COL_COUNT}
                            label={group.label}
                            count={group.checks.length}
                            isCollapsed={isCollapsed}
                            onToggle={() => toggleFolderCollapsed(group.key)}
                            color={groupColor}
                          />
                        </React.Fragment>
                      );

                      if (isCollapsed) return [header];
                      const rows = group.checks.map((check, index) => ({ check, index }));
                      return [header, ...rows];
                    })
                    : sortedChecks.map((check, index) => ({ check, index }))
                  ).map((item: any) => {
                    if (!('check' in item)) return item as React.ReactNode;
                    const check: Website = item.check;
                    const index: number = item.index;
                    return (
                      <React.Fragment key={check.id}>
                        {/* Drop zone indicator */}
                        {isDragging && draggedIndex !== null && draggedIndex !== index && dragOverIndex === index && (
                          <TableRow className="h-2 bg-primary/20 border-l-4 border-l-primary animate-pulse">
                            <TableCell colSpan={COL_COUNT} className="p-0"></TableCell>
                          </TableRow>
                        )}
                        <TableRow
                          className={`hover:bg-muted/50 transition-all duration-300 ease-out ${draggedIndex === index ? 'opacity-30 shadow-lg' : ''} ${dragOverIndex === index ? 'bg-primary/10 border-l-4 border-l-primary shadow-inner' : ''} ${isOptimisticallyUpdating(check.id) && !isFolderUpdating(check.id) ? 'animate-pulse bg-accent' : ''} group cursor-pointer ${isDragging ? 'transform-gpu' : ''}`}
                          style={{
                            transform: draggedIndex === index ? 'scale(0.98)' : 'none',
                            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                            zIndex: draggedIndex === index ? 10 : 'auto'
                          }}
                        >
                          <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                            <div className="flex items-center justify-center">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSelectCheck(check.id);
                                }}
                                className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectedChecks.has(check.id) ? `border bg-background` : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                                title={selectedChecks.has(check.id) ? 'Deselect' : 'Select'}
                              >
                                {selectedChecks.has(check.id) && (
                                  <Check className="w-2.5 h-2.5 text-white" />
                                )}
                              </button>
                            </div>
                          </TableCell>
                          {columnVisibility.order && (
                            <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                              <div className="flex items-center justify-center">
                                <div
                                  className={`p-2 rounded-lg drag-handle transition-all duration-200 ease-out ${canDragReorder ? `text-muted-foreground hover:text-foreground hover:bg-primary/10 cursor-grab active:cursor-grabbing` : 'text-muted-foreground cursor-not-allowed'} ${draggedIndex === index ? 'bg-primary/20 text-primary scale-110' : ''}`}
                                  draggable={canDragReorder}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => e.stopPropagation()}
                                  onDragStart={(e) => {
                                    if (canDragReorder) {
                                      e.dataTransfer.effectAllowed = 'move';
                                      e.stopPropagation();
                                      handleDragStart(e, index);
                                    }
                                  }}
                                  onDragOver={(e) => {
                                    if (canDragReorder) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleDragOver(e, index);
                                    }
                                  }}
                                  onDragLeave={(e) => {
                                    if (canDragReorder) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleDragLeave(e);
                                    }
                                  }}
                                  onDrop={(e) => {
                                    if (canDragReorder) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleDrop(e);
                                    }
                                  }}
                                  onDragEnd={(e) => {
                                    if (canDragReorder) {
                                      e.stopPropagation();
                                      handleDragEnd();
                                    }
                                  }}
                                  aria-label={canDragReorder ? `Drag to reorder ${check.name}` : 'Custom ordering disabled'}
                                  title={canDragReorder ? 'Drag to reorder' : (groupBy === 'folder' ? 'Custom ordering disabled in grouped view' : 'Custom ordering disabled when sorting by other columns')}
                                  style={{
                                    transform: draggedIndex === index ? 'scale(1.1)' : 'none',
                                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
                                  }}
                                >
                                  <GripVertical className={`w-4 h-4 transition-all duration-200 ${draggedIndex === index ? 'rotate-12' : ''} ${canDragReorder ? 'hover:scale-110' : 'opacity-50'}`} />
                                </div>
                              </div>
                            </TableCell>
                          )}
                          {columnVisibility.status && (
                            <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                              <div className="flex items-center gap-2">
                                {(() => {
                                  const sslStatus = getSSLCertificateStatus(check);
                                  return (
                                    <SSLTooltip sslCertificate={check.sslCertificate} url={check.url}>
                                      <div className="cursor-help">
                                        <sslStatus.icon
                                          className={`w-4 h-4 ${sslStatus.color}`}
                                        />
                                      </div>
                                    </SSLTooltip>
                                  );
                                })()}
                                <StatusBadge
                                  status={check.status}
                                  tooltip={{
                                    httpStatus: check.lastStatusCode,
                                    latencyMsP50: check.responseTime,
                                    lastCheckTs: check.lastChecked,
                                    failureReason: check.lastError,
                                    ssl: check.sslCertificate
                                      ? {
                                        valid: check.sslCertificate.valid,
                                        daysUntilExpiry: check.sslCertificate.daysUntilExpiry,
                                      }
                                      : undefined,
                                  }}
                                />
                              </div>
                            </TableCell>
                          )}
                          {columnVisibility.nameUrl && (
                            <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                              {(() => {
                                const regionLabel = isNano ? getRegionLabel(check.checkRegion) : null;
                                const folderColor = getFolderColor(check.folder);
                                return (
                                  <div className="flex flex-col">
                                    <div className={`font-medium font-sans text-foreground flex items-center gap-2 text-sm`}>
                                      {highlightText(check.name, searchQuery)}
                                    </div>
                                    <div className={`text-sm font-mono text-muted-foreground truncate max-w-xs`}>
                                      {highlightText(check.url, searchQuery)}
                                    </div>
                                    {(groupBy !== 'folder' && (((check.folder ?? '').trim()) || regionLabel)) && (
                                      <div className="pt-1 flex flex-wrap items-center gap-2">
                                        {(check.folder ?? '').trim() && (
                                          <Badge
                                            variant="secondary"
                                            className={`font-mono text-[11px] w-fit ${folderColor ? `bg-${folderColor}-500/20 text-${folderColor}-400 border-${folderColor}-400/30` : ''}`}
                                          >
                                            {(check.folder ?? '').trim()}
                                          </Badge>
                                        )}
                                        {regionLabel && (
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <Badge variant="outline" className="font-mono text-[11px] w-fit cursor-default">
                                                {regionLabel.short}
                                              </Badge>
                                            </TooltipTrigger>
                                            <TooltipContent className={`${glassClasses}`}>
                                              <span className="text-xs font-mono">Region: {regionLabel.long}</span>
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
                                {getTypeIcon(check.type)}
                                <span className={`text-sm font-mono text-muted-foreground`}>
                                  {getTypeLabel(check.type)}
                                </span>
                              </div>
                            </TableCell>
                          )}
                          {columnVisibility.responseTime && (
                            <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                              <div className={`text-sm font-mono text-muted-foreground`}>
                                {formatResponseTime(check.responseTime)}
                              </div>
                            </TableCell>
                          )}
                          {columnVisibility.lastChecked && (
                            <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''} relative`} style={{ width: '280px' }}>
                              {!check.lastChecked && !check.disabled ? (
                                <div className="flex flex-col gap-2">
                                  <div className="flex items-center gap-2">
                                    <Clock className={`w-3 h-3 text-muted-foreground`} />
                                    <span className={`text-sm font-mono text-muted-foreground`}>Never</span>
                                  </div>
                                  <div className={`${glassClasses} rounded-md p-2 flex items-center justify-between gap-2`}>
                                    <div className="flex items-center gap-2">
                                      <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                                      </span>
                                      <span className="text-xs font-medium text-primary">In Queue</span>
                                    </div>
                                    <Button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onCheckNow(check.id);
                                      }}
                                      size="sm"
                                      variant="ghost"
                                      className="text-xs h-7 px-2 cursor-pointer"
                                      aria-label="Check now"
                                    >
                                      Check Now
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-2">
                                    <Clock className={`w-3 h-3 text-muted-foreground`} />
                                    <span className={`text-sm font-mono text-muted-foreground`}>
                                      {formatLastChecked(check.lastChecked)}
                                    </span>
                                  </div>
                                  {check.lastChecked && (
                                    <div className="pl-5">
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="text-xs font-mono text-muted-foreground cursor-default">
                                            {(() => {
                                              const nextText = formatNextRun(check.nextCheckAt);
                                              return nextText === 'Due' ? 'In Queue' : `Next ${nextText}`;
                                            })()}
                                          </span>
                                        </TooltipTrigger>
                                        <TooltipContent className={`${glassClasses}`}>
                                          <span className="text-xs font-mono">
                                            {check.nextCheckAt ? new Date(check.nextCheckAt).toLocaleString() : 'Unknown'}
                                          </span>
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  )}
                                </div>
                              )}
                            </TableCell>
                          )}
                          {columnVisibility.checkInterval && (
                            <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                              <div className="flex items-center gap-2">
                                <Clock className={`w-3 h-3 text-muted-foreground`} />
                                <span className={`text-sm font-mono text-muted-foreground`}>
                                  {(() => {
                                    const seconds = check.checkFrequency ?? 600; // Already in seconds
                                    const interval = CHECK_INTERVALS.find(i => i.value === seconds);
                                    return interval ? interval.label : `${Math.round(seconds / 60)} minutes`;
                                  })()}
                                </span>
                              </div>
                            </TableCell>
                          )}
                          <TableCell className="px-4 py-4">
                            <div className="flex items-center justify-center">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <IconButton
                                    icon={<MoreVertical className="w-4 h-4" />}
                                    size="sm"
                                    variant="ghost"
                                    aria-label="More actions"
                                    aria-haspopup="menu"
                                    className={`text-muted-foreground hover:text-primary hover:bg-primary/10 pointer-events-auto p-1 transition-colors cursor-pointer`}
                                  />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className={`${glassClasses} z-[55]`}>
                                  <DropdownMenuItem
                                    onClick={() => {
                                      if (!check.disabled && !isManuallyChecking(check.id)) {
                                        onCheckNow(check.id);
                                      }
                                    }}
                                    disabled={check.disabled || isManuallyChecking(check.id)}
                                    className="cursor-pointer font-mono"
                                    title={check.disabled ? 'Cannot check disabled websites' : isManuallyChecking(check.id) ? 'Check in progress...' : 'Check now'}
                                  >
                                    {isManuallyChecking(check.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                                    <span className="ml-2">{isManuallyChecking(check.id) ? 'Checking...' : 'Check now'}</span>
                                  </DropdownMenuItem>

                                  <DropdownMenuItem
                                    onClick={() => {
                                      onToggleStatus(check.id, !check.disabled);
                                    }}
                                    className="cursor-pointer font-mono"
                                  >
                                    {check.disabled ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                                    <span className="ml-2">{check.disabled ? 'Enable' : 'Disable'}</span>
                                  </DropdownMenuItem>

                                  <DropdownMenuItem
                                    onClick={() => {
                                      window.open(check.url, '_blank', 'noopener,noreferrer');
                                    }}
                                    className="cursor-pointer font-mono"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                    <span className="ml-2">Open URL</span>
                                  </DropdownMenuItem>

                                  {onSetFolder && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuSub>
                                        <DropdownMenuSubTrigger className="cursor-pointer font-mono">
                                          <Folder className="w-3 h-3" />
                                          <span className="ml-2">Move to folder</span>
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent className={`${glassClasses}`}>
                                          <DropdownMenuItem
                                            onClick={() => {
                                              onSetFolder(check.id, null);
                                            }}
                                            className="cursor-pointer font-mono"
                                          >
                                            <span>Unsorted</span>
                                          </DropdownMenuItem>
                                          {folderOptions.map((f) => (
                                            <DropdownMenuItem
                                              key={f}
                                              onClick={() => {
                                                onSetFolder(check.id, f);
                                              }}
                                              className="cursor-pointer font-mono"
                                            >
                                              <span className="truncate max-w-[220px]">{f}</span>
                                            </DropdownMenuItem>
                                          ))}
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem
                                            onClick={() => {
                                              openNewFolderDialog(check);
                                            }}
                                            className="cursor-pointer font-mono"
                                          >
                                            <Plus className="w-3 h-3" />
                                            <span className="ml-2">New folder…</span>
                                          </DropdownMenuItem>
                                        </DropdownMenuSubContent>
                                      </DropdownMenuSub>
                                    </>
                                  )}

                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => {
                                      onEdit(check);
                                    }}
                                    className="cursor-pointer font-mono"
                                  >
                                    <Edit className="w-3 h-3" />
                                    <span className="ml-2">Edit</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => {
                                      handleDeleteClick(check);
                                    }}
                                    className="cursor-pointer font-mono text-destructive focus:text-destructive"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    <span className="ml-2">Delete</span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        </TableRow>
                        {expandedRow === check.id && (
                          <TableRow className={`${getTableHoverColor('neutral')} border-t border-border`}>
                            <TableCell colSpan={COL_COUNT} className="px-4 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                                <div>
                                  <div className={`font-medium text-foreground mb-1`}>Details</div>
                                  <div className={`font-mono text-muted-foreground space-y-1`}>
                                    <div>ID: {check.id}</div>
                                    <div>Created: {check.createdAt ? new Date(check.createdAt).toLocaleDateString() : 'Unknown'}</div>
                                    {check.lastStatusCode && <div>Last Status: {check.lastStatusCode}</div>}
                                  </div>
                                </div>
                                {check.type === 'rest_endpoint' && (
                                  <div>
                                    <div className={`font-medium text-foreground mb-1`}>API Details</div>
                                    <div className={`font-mono text-muted-foreground space-y-1`}>
                                      <div>Method: {check.httpMethod || 'GET'}</div>
                                      <div>
                                        Expected: {(check.expectedStatusCodes?.length
                                          ? check.expectedStatusCodes
                                          : getDefaultExpectedStatusCodes(check.type)
                                        ).join(', ')}
                                      </div>
                                    </div>
                                  </div>
                                )}
                                {check.sslCertificate && check.url.startsWith('https://') && (
                                  <div>
                                    <div className={`font-medium text-foreground mb-1`}>SSL Certificate</div>
                                    <div className={`font-mono text-muted-foreground space-y-1`}>
                                      <div>Status: {check.sslCertificate.valid ? 'Valid' : 'Invalid'}</div>
                                      {check.sslCertificate.issuer && <div>Issuer: {check.sslCertificate.issuer}</div>}
                                      {check.sslCertificate.subject && <div>Subject: {check.sslCertificate.subject}</div>}
                                      {check.sslCertificate.daysUntilExpiry !== undefined && (
                                        <div>Expires: {check.sslCertificate.daysUntilExpiry > 0 ? `${check.sslCertificate.daysUntilExpiry} days` : `${Math.abs(check.sslCertificate.daysUntilExpiry)} days ago`}</div>
                                      )}
                                      {check.sslCertificate.validFrom && (
                                        <div>Valid From: {new Date(check.sslCertificate.validFrom).toLocaleDateString()}</div>
                                      )}
                                      {check.sslCertificate.validTo && (
                                        <div>Valid To: {new Date(check.sslCertificate.validTo).toLocaleDateString()}</div>
                                      )}
                                      {check.sslCertificate.error && (
                                        <div className="text-destructive">Error: {check.sslCertificate.error}</div>
                                      )}
                                    </div>
                                  </div>
                                )}
                                {check.lastError && (
                                  <div>
                                    <div className={`font-medium text-foreground mb-1`}>Last Error</div>
                                    <div className={`font-mono text-muted-foreground text-xs`}>
                                      {check.lastError}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
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
            action={onAddFirstCheck ? {
              label: "ADD YOUR FIRST CHECK",
              onClick: onAddFirstCheck,
              icon: Plus
            } : undefined}
          />
        )}
        containerClassName={`transition-all duration-300 ${isDragging ? 'ring-2 ring-primary/20 shadow-xl' : ''}`}
      />

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

      <BulkActionsBar
        selectedCount={selectedChecks.size}
        totalCount={sortedChecks.length}
        onClearSelection={() => {
          setSelectedChecks(new Set());
          setSelectAll(false);
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
            icon: <Play className="w-3 h-3" />,
            onClick: () => handleBulkToggleStatus(false),
            variant: 'ghost',
          },
          {
            label: 'Disable',
            icon: <Pause className="w-3 h-3" />,
            onClick: () => handleBulkToggleStatus(true),
            variant: 'ghost',
          },
          {
            label: 'Delete',
            onClick: handleBulkDelete,
            isDelete: true,
          },
        ]}
      />

      {/* Bulk Edit Modal */}
      {onBulkUpdateSettings && (
        <BulkEditModal
          open={bulkEditModal}
          onOpenChange={setBulkEditModal}
          selectedCount={selectedChecks.size}
          minIntervalSeconds={isNano ? 120 : 300}
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
