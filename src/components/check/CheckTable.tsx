import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { 
  Edit,
  Clock,
  ArrowUpDown,
  SortAsc,
  SortDesc,
  MoreVertical,
  Play,
  Pause,
  Trash2,
  ExternalLink,
  Globe,
  Code,
  Check,
  ShieldCheck,
  AlertTriangle,
  Plus,
  Loader2,
  GripVertical,
  Info
} from 'lucide-react';
import { IconButton, Button, Input, Label, EmptyState, ConfirmationModal, StatusBadge, CheckIntervalSelector, CHECK_INTERVALS, Dialog, DialogContent, DialogHeader, DialogTitle, Checkbox, Table, TableHeader, TableBody, TableHead, TableRow, TableCell, GlowCard, ScrollArea, SSLTooltip, glassClasses, Tooltip, TooltipTrigger, TooltipContent, BulkActionsBar } from '../ui';
// NOTE: No tier-based enforcement. Keep table edit behavior tier-agnostic for now.
import type { Website } from '../../types';
import { formatLastChecked, formatResponseTime, formatNextRun, highlightText } from '../../utils/formatters.tsx';
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll';
import { getTableHoverColor } from '../../lib/utils';
import { copyToClipboard } from '../../utils/clipboard';
import DomainExpiryTooltip from '../ui/DomainExpiryTooltip';

// Overlay/banner for checks that have never been checked
interface NeverCheckedOverlayProps {
  onCheckNow: () => void;
  variant?: 'overlay' | 'inline';
}

const NeverCheckedOverlay: React.FC<NeverCheckedOverlayProps> = ({ onCheckNow, variant = 'overlay' }) => {
  if (variant === 'inline') {
    return (
      <div className={`mt-1 ${glassClasses} rounded-md p-2 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          <Clock className="w-3 h-3 text-primary" />
          <span className={`text-xs font-medium`}>In Queue</span>
        </div>
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onCheckNow();
          }}
          size="sm"
          variant="ghost"
          className="text-xs h-7 px-2 cursor-pointer"
          aria-label="Check now"
        >
          Check Now
        </Button>
      </div>
    );
  }

  // Full-card overlay (used in table view)
  return (
    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center" style={{ right: '16px', zIndex: -1 }}>
      <div className="flex items-center gap-4 p-2 w-full max-w-xs">
        <div className="flex items-center gap-2 flex-1">
          <Clock className="w-3 h-3 text-primary" />
          <div className="text-left">
            <div className={`text-xs font-medium text-foreground`}>
              In Queue
            </div>
          </div>
        </div>
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onCheckNow();
          }}
          size="sm"
          variant="default"
          className="text-xs px-1.5 py-0.5 h-6 cursor-pointer"
        >
          Check Now
        </Button>
      </div>
    </div>
  );
};

interface CheckTableProps {
  checks: Website[];
  onUpdate: (id: string, name: string, url: string, checkFrequency?: number) => void; // Add checkFrequency parameter
  onDelete: (id: string) => void;
  onBulkDelete: (ids: string[]) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onBulkToggleStatus: (ids: string[], disabled: boolean) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  searchQuery?: string;
  onAddFirstCheck?: () => void;
  optimisticUpdates?: string[]; // IDs of checks being optimistically updated
  manualChecksInProgress?: string[]; // IDs of checks being manually checked
}

type SortOption = 'custom' | 'name-asc' | 'name-desc' | 'url-asc' | 'url-desc' | 'status' | 'lastChecked' | 'createdAt' | 'responseTime' | 'type' | 'checkFrequency';

const CheckTable: React.FC<CheckTableProps> = ({ 
  checks, 
  onUpdate, 
  onDelete, 
  onBulkDelete,
  onCheckNow, 
  onToggleStatus,
  onBulkToggleStatus,
  onReorder,
  searchQuery = '',
  onAddFirstCheck,
  optimisticUpdates = [],
  manualChecksInProgress = []
}) => {
  // No user tier logic yet

  const [sortBy, setSortBy] = useState<SortOption>('custom');
  const [expandedRow] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuCoords, setMenuCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editingCheck, setEditingCheck] = useState<Website | null>(null);
  const [editForm, setEditForm] = useState({ name: '', url: '', checkFrequency: 10 });
  const [deletingCheck, setDeletingCheck] = useState<Website | null>(null);
  const [copiedCheckId, setCopiedCheckId] = useState(false);
  
  // Multi-select state
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  const [selectAll, setSelectAll] = useState(false);

  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();
  const dragPreviewRef = useRef<HTMLElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  // Removed realtime countdowns in Last Checked column per UX update

  // Helper function to check if a check is being optimistically updated
  const isOptimisticallyUpdating = useCallback((checkId: string) => {
    return optimisticUpdates.includes(checkId);
  }, [optimisticUpdates]);

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
    setSortBy(newSortBy);
  }, []);

  // Enhanced Drag & Drop handlers with smooth animations
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    if (sortBy !== 'custom') return;
    
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
  }, [sortBy]);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (sortBy !== 'custom' || draggedIndex === null) return;
    
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    if (draggedIndex !== index) {
      setDragOverIndex(index);
      
      // Immediate reordering for better responsiveness
      onReorder(draggedIndex, index);
      setDraggedIndex(index);
    }
  }, [draggedIndex, onReorder, sortBy]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (sortBy !== 'custom') return;
    
    e.preventDefault();
    // Only clear dragOverIndex if we're leaving the table area
    const rect = e.currentTarget.getBoundingClientRect();
    const { clientX, clientY } = e;
    
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      setDragOverIndex(null);
    }
  }, [sortBy]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (sortBy !== 'custom') return;
    
    e.preventDefault();
    // Reordering already happened in dragOver, just clean up
    setDraggedIndex(null);
    setDragOverIndex(null);
    setIsDragging(false);
  }, [sortBy]);

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

  // Calculate menu position to avoid overflow
  const calculateMenuPosition = useCallback((buttonElement: HTMLElement) => {
    const rect = buttonElement.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const menuHeight = 200; // Approximate menu height
    const menuWidth = 160; // Approximate menu width
    const gap = 4; // Gap between button and menu
    
    // Calculate available space in all directions
    const spaceBelow = viewportHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const spaceRight = viewportWidth - rect.right - gap;
    const spaceLeft = rect.left - gap;
    
    let verticalPosition: 'top' | 'bottom' = 'bottom';
    let horizontalPosition: 'left' | 'right' = 'left';
    
    // Vertical positioning - prefer bottom, but use top if not enough space
    if (spaceBelow < menuHeight && spaceAbove >= menuHeight) {
      verticalPosition = 'top';
    } else if (spaceBelow < menuHeight && spaceAbove < menuHeight) {
      // If neither direction has enough space, use the one with more space
      verticalPosition = spaceAbove > spaceBelow ? 'top' : 'bottom';
    }
    
    // Horizontal positioning - prefer left, but use right if not enough space
    if (spaceLeft < menuWidth && spaceRight >= menuWidth) {
      horizontalPosition = 'right';
    } else if (spaceLeft < menuWidth && spaceRight < menuWidth) {
      // If neither direction has enough space, use the one with more space
      horizontalPosition = spaceRight > spaceLeft ? 'right' : 'left';
    }
    
    // Calculate exact coordinates for fixed positioning
    let x: number;
    let y: number;
    
    if (horizontalPosition === 'right') {
      x = rect.right + gap;
    } else {
      x = rect.left - menuWidth - gap;
    }
    
    if (verticalPosition === 'bottom') {
      y = rect.bottom + gap;
    } else {
      y = rect.top - menuHeight - gap;
    }
    
    // Ensure menu stays within viewport bounds with padding
    const padding = 16;
    x = Math.max(padding, Math.min(x, viewportWidth - menuWidth - padding));
    y = Math.max(padding, Math.min(y, viewportHeight - menuHeight - padding));
    
    return { 
      position: { vertical: verticalPosition, horizontal: horizontalPosition },
      coords: { x, y }
    };
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (openMenuId) {
        const target = event.target as Element;
        const isWithinActionMenu = target.closest('.action-menu');
        const isWithinMenu = target.closest('[data-menu="true"]');
        
        if (!isWithinActionMenu && !isWithinMenu) {
          setOpenMenuId(null);
        }
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openMenuId]);

  // Edit modal handlers
  const handleEditClick = (check: Website) => {
    setEditingCheck(check);
    setEditForm({ 
      name: check.name, 
      url: check.url, 
      checkFrequency: check.checkFrequency || 10 
    });
    setOpenMenuId(null);
  };

  useEffect(() => {
    // Reset copied state when dialog opens/closes or editing target changes
    setCopiedCheckId(false);
  }, [editingCheck]);

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingCheck) {
      onUpdate(editingCheck.id, editForm.name, editForm.url, editForm.checkFrequency);
      setEditingCheck(null);
      setEditForm({ name: '', url: '', checkFrequency: 10 });
    }
  };

  const handleEditCancel = () => {
    setEditingCheck(null);
    setEditForm({ name: '', url: '', checkFrequency: 10 });
  };



  // Delete confirmation handlers
  const handleDeleteClick = (check: Website) => {
    setDeletingCheck(check);
    setOpenMenuId(null);
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
      default:
        return <Globe className="text-primary" />;
    }
  };

  const getSSLCertificateStatus = (check: Website) => {
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
    const sslStatus = getSSLCertificateStatus(check);
    
    return (
      <div 
        key={check.id}
        className={`relative rounded-lg border border hover:bg-muted/50 p-4 space-y-3 cursor-pointer transition-all duration-200 ${check.disabled ? 'opacity-50' : ''} ${isOptimisticallyUpdating(check.id) ? 'animate-pulse bg-primary/5' : ''} group`}

      >
        {/* Header Row */}
        <div className="flex items-start justify-between gap-3">
          {/* Selection Checkbox */}
          <Checkbox
            checked={selectedChecks.has(check.id)}
            onCheckedChange={() => handleSelectCheck(check.id)}
            onClick={(e) => e.stopPropagation()}
            className="mt-1"
            title={selectedChecks.has(check.id) ? 'Deselect' : 'Select'}
          />

          {/* Status, SSL, and Domain Expiry */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <SSLTooltip sslCertificate={check.sslCertificate} url={check.url}>
              <div className="cursor-help">
                <sslStatus.icon 
                  className={`w-4 h-4 ${sslStatus.color}`} 
                />
              </div>
            </SSLTooltip>
            <DomainExpiryTooltip domainExpiry={check.domainExpiry} url={check.url}>
              <div className="cursor-help">
                <Globe className={`w-4 h-4 ${check.domainExpiry?.valid === true ? 'text-green-500' : check.domainExpiry?.valid === false ? 'text-red-500' : check.domainExpiry?.daysUntilExpiry && check.domainExpiry.daysUntilExpiry <= 30 ? 'text-yellow-500' : 'text-gray-400'}`} />
                {check.domainExpiry && (
                  <div className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full border border-white"></div>
                )}
              </div>
            </DomainExpiryTooltip>
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
                domainExpiry: check.domainExpiry
                  ? {
                      valid: check.domainExpiry.valid,
                      daysUntilExpiry: check.domainExpiry.daysUntilExpiry,
                    }
                  : undefined,
              }}
            />
          </div>
        </div>



        {/* Name and URL */}
        <div className="space-y-1">
          <div className={`font-medium font-sans text-foreground flex items-center gap-2`}>
            {highlightText(check.name, searchQuery)}
          </div>
          <div className={`text-sm font-mono text-muted-foreground break-all`}>
            {highlightText(check.url, searchQuery)}
          </div>
        </div>

        {/* Details Grid */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          {/* Type */}
          <div className="flex items-center gap-2">
            {getTypeIcon(check.type)}
            <span className={`font-mono text-muted-foreground`}>
              {check.type === 'rest_endpoint' ? 'API' : 'Website'}
            </span>
          </div>

          {/* Response Time */}
          <div className={`font-mono text-muted-foreground`}>
            {formatResponseTime(check.responseTime)}
          </div>

          {/* Last Checked */}
          <div className="flex items-center gap-2 col-span-2">
            <Clock className={`w-3 h-3 text-muted-foreground`} />
            <span className={`font-mono text-muted-foreground`}>
              {formatLastChecked(check.lastChecked)}
            </span>
          </div>

          {/* Check Interval */}
          <div className="flex items-center gap-2 col-span-2">
            <Clock className={`w-3 h-3 text-muted-foreground`} />
            <span className={`font-mono text-muted-foreground`}>
              {(() => {
                const seconds = (check.checkFrequency ?? 10) * 60;
                const interval = CHECK_INTERVALS.find(i => i.value === seconds);
                return interval ? interval.label : `${check.checkFrequency ?? 10} minutes`;
              })()}
            </span>
          </div>
        </div>

        {/* Never Checked - Mobile inline banner (improves UX on small screens) */}
        {!check.lastChecked && !check.disabled && (
          <NeverCheckedOverlay variant="inline" onCheckNow={() => onCheckNow(check.id)} />
        )}
      </div>
    );
  };

    return (
    <>
      {/* Mobile Card Layout (640px and below) */}
      <div className="block sm:hidden">
        <div className="space-y-3">
          {sortedChecks.map((check, index) => (
            <GlowCard key={check.id} className="p-0">
              <MobileCheckCard check={check} index={index} />
            </GlowCard>
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
      </div>

      {/* Desktop Table Layout (640px and above) */}
      <div className="hidden sm:block w-full min-w-0">
        {/* Table */}
        <GlowCard className={`w-full min-w-0 overflow-hidden transition-all duration-300 ${isDragging ? 'ring-2 ring-primary/20 shadow-xl' : ''}`}>
          <ScrollArea className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
            <div className="min-w-[1200px] w-full">
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
                  <TableHead className="px-3 py-4 text-left w-12">
                    <div className={`text-xs font-medium uppercase tracking-wider font-mono ${sortBy === 'custom' ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
                      {sortBy === 'custom' ? 'Order' : 'Order'}
                    </div>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-40">
                    <button
                      onClick={() => handleSortChange(sortBy === 'status' ? 'custom' : 'status')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Status
                      {sortBy === 'status' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-80">
                    <button
                      onClick={() => handleSortChange(sortBy === 'name-asc' ? 'name-desc' : 'name-asc')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Name & URL
                      {sortBy === 'name-asc' ? <SortDesc className="w-3 h-3" /> : sortBy === 'name-desc' ? <SortAsc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-50">
                    <button
                      onClick={() => handleSortChange(sortBy === 'type' ? 'custom' : 'type')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Type
                      {sortBy === 'type' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-50">
                    <button
                      onClick={() => handleSortChange(sortBy === 'responseTime' ? 'custom' : 'responseTime')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Response Time
                      {sortBy === 'responseTime' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-50">
                    <button
                      onClick={() => handleSortChange(sortBy === 'lastChecked' ? 'custom' : 'lastChecked')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Last Checked
                      {sortBy === 'lastChecked' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-40">
                    <button
                      onClick={() => handleSortChange(sortBy === 'checkFrequency' ? 'custom' : 'checkFrequency')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Check Interval
                      {sortBy === 'checkFrequency' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-center w-28">
                    <div className={`text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground`}>
                      Actions
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={`divide-y divide-border transition-all duration-300 ${isDragging ? 'transform-gpu' : ''}`}>
                {sortedChecks.map((check, index) => (
                  <React.Fragment key={check.id}>
                    {/* Drop zone indicator */}
                    {isDragging && draggedIndex !== null && draggedIndex !== index && dragOverIndex === index && (
                      <TableRow className="h-2 bg-primary/20 border-l-4 border-l-primary animate-pulse">
                        <TableCell colSpan={8} className="p-0"></TableCell>
                      </TableRow>
                    )}
                    <TableRow 
                      className={`hover:bg-muted/50 transition-all duration-300 ease-out ${draggedIndex === index ? 'opacity-30 shadow-lg' : ''} ${dragOverIndex === index ? 'bg-primary/10 border-l-4 border-l-primary shadow-inner' : ''} ${isOptimisticallyUpdating(check.id) ? 'animate-pulse bg-accent' : ''} group cursor-pointer ${isDragging ? 'transform-gpu' : ''}`}
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
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className="flex items-center justify-center">
                          <div 
                            className={`p-2 rounded-lg drag-handle transition-all duration-200 ease-out ${sortBy === 'custom' ? `text-muted-foreground hover:text-foreground hover:bg-primary/10 cursor-grab active:cursor-grabbing` : 'text-muted-foreground cursor-not-allowed'} ${draggedIndex === index ? 'bg-primary/20 text-primary scale-110' : ''}`}
                            draggable={sortBy === 'custom'}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            onDragStart={(e) => {
                              if (sortBy === 'custom') {
                                e.dataTransfer.effectAllowed = 'move';
                                e.stopPropagation();
                                handleDragStart(e, index);
                              }
                            }}
                            onDragOver={(e) => {
                              if (sortBy === 'custom') {
                                e.preventDefault();
                                e.stopPropagation();
                                handleDragOver(e, index);
                              }
                            }}
                            onDragLeave={(e) => {
                              if (sortBy === 'custom') {
                                e.preventDefault();
                                e.stopPropagation();
                                handleDragLeave(e);
                              }
                            }}
                            onDrop={(e) => {
                              if (sortBy === 'custom') {
                                e.preventDefault();
                                e.stopPropagation();
                                handleDrop(e);
                              }
                            }}
                            onDragEnd={(e) => {
                              if (sortBy === 'custom') {
                                e.stopPropagation();
                                handleDragEnd();
                              }
                            }}
                            aria-label={sortBy === 'custom' ? `Drag to reorder ${check.name}` : 'Custom ordering disabled'}
                            title={sortBy === 'custom' ? 'Drag to reorder' : 'Custom ordering disabled when sorting by other columns'}
                            style={{
                              transform: draggedIndex === index ? 'scale(1.1)' : 'none',
                              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
                            }}
                          >
                            <GripVertical className={`w-4 h-4 transition-all duration-200 ${draggedIndex === index ? 'rotate-12' : ''} ${sortBy === 'custom' ? 'hover:scale-110' : 'opacity-50'}`} />
                          </div>
                        </div>
                      </TableCell>
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
                          <DomainExpiryTooltip domainExpiry={check.domainExpiry} url={check.url}>
                            <div className="cursor-help">
                              <Globe className={`w-4 h-4 ${check.domainExpiry?.valid === true ? 'text-green-500' : check.domainExpiry?.valid === false ? 'text-red-500' : check.domainExpiry?.daysUntilExpiry && check.domainExpiry.daysUntilExpiry <= 30 ? 'text-yellow-500' : 'text-gray-400'}`} />
                              {check.domainExpiry && (
                                <div className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full border border-white"></div>
                              )}
                            </div>
                          </DomainExpiryTooltip>
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
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className="flex flex-col">
                          <div className={`font-medium font-sans text-foreground flex items-center gap-2 text-sm`}>
                            {highlightText(check.name, searchQuery)}
                          </div>
                          <div className={`text-sm font-mono text-muted-foreground truncate max-w-xs`}>
                            {highlightText(check.url, searchQuery)}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-2">
                          {getTypeIcon(check.type)}
                          <span className={`text-sm font-mono text-muted-foreground`}>
                            {check.type === 'rest_endpoint' ? 'API' : 'Website'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className={`text-sm font-mono text-muted-foreground`}>
                          {formatResponseTime(check.responseTime)}
                        </div>
                      </TableCell>
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
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-2">
                          <Clock className={`w-3 h-3 text-muted-foreground`} />
                          <span className={`text-sm font-mono text-muted-foreground`}>
                            {(() => {
                              const seconds = (check.checkFrequency ?? 10) * 60;
                              const interval = CHECK_INTERVALS.find(i => i.value === seconds);
                              return interval ? interval.label : `${check.checkFrequency ?? 10} minutes`;
                            })()}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        <div className="flex items-center justify-center">
                          <div className="relative action-menu pointer-events-auto">
                            <IconButton
                              icon={<MoreVertical className="w-4 h-4" />}
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e?.stopPropagation();
                                const newMenuId = openMenuId === check.id ? null : check.id;
                                if (newMenuId) {
                                  const result = calculateMenuPosition(e?.currentTarget as HTMLElement);
                                  setMenuCoords(result.coords);
                                }
                                setOpenMenuId(newMenuId);
                              }}
                              aria-label="More actions"
                              aria-expanded={openMenuId === check.id}
                              aria-haspopup="menu"
                              className={`text-muted-foreground hover:text-primary hover:bg-primary/10 pointer-events-auto p-1 transition-colors`}
                            />
                            
                            {/* Menu will be rendered via portal */}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedRow === check.id && (
                      <TableRow className={`${getTableHoverColor('neutral')} border-t border-border`}>
                        <TableCell colSpan={8} className="px-4 py-4">
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
                                  <div>Expected: {check.expectedStatusCodes?.join(', ') || '200'}</div>
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
                            {check.domainExpiry && (
                              <div>
                                <div className={`font-medium text-foreground mb-1`}>Domain Expiry</div>
                                <div className={`font-mono text-muted-foreground space-y-1`}>
                                  <div>Status: {check.domainExpiry.valid ? 'Valid' : 'Expired'}</div>
                                  {check.domainExpiry.registrar && <div>Registrar: {check.domainExpiry.registrar}</div>}
                                  {check.domainExpiry.domainName && <div>Domain: {check.domainExpiry.domainName}</div>}
                                  {check.domainExpiry.expiryDate && (
                                    <div>Expires: {new Date(check.domainExpiry.expiryDate).toLocaleDateString()}</div>
                                  )}
                                  {check.domainExpiry.daysUntilExpiry !== undefined && (
                                    <div>Days Until Expiry: {check.domainExpiry.daysUntilExpiry} days</div>
                                  )}
                                  {check.domainExpiry.error && (
                                    <div className="text-destructive">Error: {check.domainExpiry.error}</div>
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
                ))}
              </TableBody>
            </Table>
            </div>
          </ScrollArea>
          
          {checks.length === 0 && (
            <div className="px-8 py-8">
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
        </GlowCard>
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editingCheck} onOpenChange={(open) => !open && handleEditCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Edit Check
              {editingCheck && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!editingCheck) return;
                        const ok = await copyToClipboard(editingCheck.id);
                        if (ok) {
                          setCopiedCheckId(true);
                          window.setTimeout(() => setCopiedCheckId(false), 1200);
                        }
                      }}
                      aria-label="Copy Check ID"
                      className="w-5 h-5 inline-flex items-center justify-center rounded-full hover:bg-muted cursor-pointer"
                    >
                      <Info className="w-4 h-4 text-muted-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className={`${glassClasses}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">ID: {editingCheck.id}</span>
                      <span className={`text-xs ${copiedCheckId ? 'text-primary' : 'text-muted-foreground'}`}>
                        {copiedCheckId ? 'Copied' : 'Click to copy'}
                      </span>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </DialogTitle>
          </DialogHeader>
        <form onSubmit={handleEditSubmit} className="space-y-4">
          <div>
            <Label htmlFor="edit-name">Name</Label>
            <Input
              id="edit-name"
              type="text"
              value={editForm.name}
              onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Enter check name"
              required
            />
          </div>
          
          <div>
            <Label htmlFor="edit-url">URL</Label>
            <Input
              id="edit-url"
              type="url"
              value={editForm.url}
              onChange={(e) => setEditForm(prev => ({ ...prev, url: e.target.value }))}
              placeholder="https://example.com"
              required
            />
          </div>

          <CheckIntervalSelector
            value={(editForm.checkFrequency ?? 10) * 60}
            onChange={(value) => setEditForm(prev => ({ ...prev, checkFrequency: Math.round(value / 60) }))}
            helperText="How often should we check this endpoint?"
          />

          <div className="flex gap-3 pt-4">
            <Button type="submit" className="flex-1">
              Update Check
            </Button>
            <Button type="button" variant="outline" onClick={handleEditCancel} className="flex-1 text-muted-foreground hover:text-foreground">
              Cancel
            </Button>
          </div>
        </form>
        </DialogContent>
      </Dialog>

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

      {/* Portal-based Action Menu */}
      {openMenuId && (() => {
        const check = checks.find(c => c.id === openMenuId);
        if (!check) return null;
        
        return createPortal(
          <div 
            data-menu="true" 
            className={`fixed ${glassClasses} rounded-lg z-[55] min-w-[160px] pointer-events-auto`}
            style={{
              left: `${menuCoords.x}px`,
              top: `${menuCoords.y}px`
            }}
          >
            <div className="py-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!check.disabled && !isManuallyChecking(check.id)) {
                    onCheckNow(check.id);
                  }
                  setOpenMenuId(null);
                }}
                disabled={check.disabled || isManuallyChecking(check.id)}
                className={`w-full text-left px-4 py-2 text-sm ${check.disabled || isManuallyChecking(check.id) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} font-mono ${check.disabled || isManuallyChecking(check.id) ? '' : `hover:bg-neutral/20 text-foreground hover:text-primary`} ${check.disabled || isManuallyChecking(check.id) ? 'text-muted-foreground' : ''} flex items-center gap-2`}
                title={check.disabled ? 'Cannot check disabled websites' : isManuallyChecking(check.id) ? 'Check in progress...' : 'Check now'}
              >
                {isManuallyChecking(check.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {isManuallyChecking(check.id) ? 'Checking...' : 'Check now'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStatus(check.id, !check.disabled);
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:bg-neutral/20 text-foreground hover:text-orange-400 flex items-center gap-2`}
              >
                {check.disabled ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                {check.disabled ? 'Enable' : 'Disable'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(check.url, '_blank');
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:bg-neutral/20 text-foreground hover:text-green-600 flex items-center gap-2`}
              >
                <ExternalLink className="w-3 h-3" />
                Open URL
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditClick(check);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:bg-neutral/20 text-foreground hover:text-primary flex items-center gap-2`}
              >
                <Edit className="w-3 h-3" />
                Edit
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteClick(check);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:bg-neutral/20 text-destructive hover:text-destructive flex items-center gap-2`}
              >
                <Trash2 className="w-3 h-3" />
                Delete
              </button>
            </div>
          </div>,
          document.body
        );
      })()}

      <BulkActionsBar
        selectedCount={selectedChecks.size}
        totalCount={sortedChecks.length}
        onClearSelection={() => {
          setSelectedChecks(new Set());
          setSelectAll(false);
        }}
        itemLabel="check"
        actions={[
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

    </>
  );
};

export default CheckTable; 