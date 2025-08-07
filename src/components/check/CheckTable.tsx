import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
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
  Shield,
  AlertTriangle,
  Plus,
  TrendingUp,
  Loader2,
  GripVertical
} from 'lucide-react';
import { IconButton, Button, Input, Label, EmptyState, ConfirmationModal, StatusBadge, CheckIntervalSelector, CHECK_INTERVALS, Dialog, DialogContent, DialogHeader, DialogTitle, Checkbox, Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../ui';
import type { Website } from '../../types';
import { formatLastChecked, formatResponseTime, highlightText } from '../../utils/formatters.tsx';
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll';

// Overlay component for checks that have never been checked
const NeverCheckedOverlay: React.FC<{ onCheckNow: () => void }> = ({ onCheckNow }) => (
  <div className="absolute inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-10">
    <div className="flex items-center gap-3 p-2">
      <div className="flex items-center gap-2">
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
        className="text-xs px-2 py-0.5 cursor-pointer"
      >
        Check Now
      </Button>
    </div>
  </div>
);

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
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState<SortOption>('custom');
  const [expandedRow] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuCoords, setMenuCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editingCheck, setEditingCheck] = useState<Website | null>(null);
  const [editForm, setEditForm] = useState({ name: '', url: '', checkFrequency: 10 });
  const [deletingCheck, setDeletingCheck] = useState<Website | null>(null);
  
  // Multi-select state
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  const [selectAll, setSelectAll] = useState(false);

  const { handleMouseDown: handleHorizontalScroll, wasDragging } = useHorizontalScroll();

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

  // Drag & Drop handlers
  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index);
      // Live reorder - move the item immediately
      onReorder(draggedIndex, index);
      setDraggedIndex(index); // Update dragged index to new position
    }
  }, [draggedIndex, onReorder]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Reordering already happened in dragOver, just clean up
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
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
        return <Globe className="text-green-500" />;
    }
  };

  const getSSLCertificateStatus = (check: Website) => {
    if (!check.url.startsWith('https://')) {
      return { valid: true, icon: Shield, color: 'text-muted-foreground', text: 'HTTP' };
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
          color: 'text-yellow-500', 
          text: `${daysUntilExpiry} days` 
        };
      }
      return { 
        valid: true, 
        icon: Shield, 
        color: 'text-green-500', 
        text: 'Valid' 
      };
    } else {
      return { 
        valid: false, 
        icon: AlertTriangle, 
        color: 'text-red-500', 
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
        className={`relative rounded-lg border border hover:bg-accent p-4 space-y-3 cursor-pointer transition-all duration-200 ${check.disabled ? 'opacity-50' : ''} ${isOptimisticallyUpdating(check.id) ? 'animate-pulse bg-blue-500/5' : ''} group`}
        onClick={() => {
          if (!wasDragging()) {
            navigate(`/statistics/${check.id}`);
          }
        }}
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

          {/* Status and SSL */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="cursor-help">
              <sslStatus.icon 
                className={`w-4 h-4 ${sslStatus.color}`} 
              />
            </div>
            <StatusBadge status={check.status} />
          </div>

          {/* Actions Menu */}
          <div className="relative action-menu pointer-events-auto flex-shrink-0">
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
              className={`hover:hover:bg-accent pointer-events-auto p-2`}
            />
          </div>
        </div>

        {/* Name and URL */}
        <div className="space-y-1">
          <div className={`font-medium font-sans text-foreground group-hover:text-primary transition-colors duration-150 flex items-center gap-2`}>
            {highlightText(check.name, searchQuery)}
            <TrendingUp className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
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
                const interval = CHECK_INTERVALS.find(i => i.value === (check.checkFrequency || 10));
                return interval ? interval.label : '10 minutes';
              })()}
            </span>
          </div>
        </div>

        {/* Never Checked Overlay */}
        {!check.lastChecked && !check.disabled && (
          <NeverCheckedOverlay onCheckNow={() => onCheckNow(check.id)} />
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
            <MobileCheckCard key={check.id} check={check} index={index} />
          ))}
        </div>
        
        {checks.length === 0 && (
          <div className="px-4">
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
        <div className="rounded-xl bg-card border shadow-md w-full min-w-0 overflow-hidden">
          <div 
            className="table-scroll-container w-full min-w-0 overflow-x-auto" 
            onMouseDown={handleHorizontalScroll}
          >
            <Table className="min-w-[1200px] w-full">
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
                    <div className={`text-xs font-medium uppercase tracking-wider font-mono ${sortBy === 'custom' ? 'text-muted-foreground' : 'text-muted-foreground'}`}>
                      {/* Order */}
                    </div>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-28">
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
                  <TableHead className="px-4 py-4 text-left w-24">
                    <button
                      onClick={() => handleSortChange(sortBy === 'type' ? 'custom' : 'type')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Type
                      {sortBy === 'type' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-32">
                    <button
                      onClick={() => handleSortChange(sortBy === 'responseTime' ? 'custom' : 'responseTime')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Response Time
                      {sortBy === 'responseTime' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-36">
                    <button
                      onClick={() => handleSortChange(sortBy === 'lastChecked' ? 'custom' : 'lastChecked')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Last Checked
                      {sortBy === 'lastChecked' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-28">
                    <button
                      onClick={() => handleSortChange(sortBy === 'checkFrequency' ? 'custom' : 'checkFrequency')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Check Interval
                      {sortBy === 'checkFrequency' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-center w-24">
                    <div className={`text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground`}>
                      Actions
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-border">
                {sortedChecks.map((check, index) => (
                  <React.Fragment key={check.id}>
                    <TableRow 
                      className={`hover:bg-accent transition-all duration-200 ${draggedIndex === index ? 'opacity-50 scale-95 rotate-1' : ''} ${dragOverIndex === index ? 'bg-accent border-l-2 border-l-primary' : ''} ${isOptimisticallyUpdating(check.id) ? 'animate-pulse bg-accent' : ''} group cursor-pointer`}
                      onClick={() => {
                        // Only navigate if we weren't dragging
                        if (!wasDragging()) {
                          navigate(`/statistics/${check.id}`);
                        }
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
                            className={`p-1 rounded drag-handle ${sortBy === 'custom' ? `text-muted-foreground hover:text-foreground` : 'text-muted-foreground cursor-not-allowed'}`}
                            draggable={sortBy === 'custom'}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            onDragStart={(e) => {
                              if (sortBy === 'custom') {
                                e.dataTransfer.effectAllowed = 'move';
                                e.stopPropagation();
                                handleDragStart(index);
                              }
                            }}
                            onDragOver={(e) => {
                              if (sortBy === 'custom') {
                                e.stopPropagation();
                                handleDragOver(e, index);
                              }
                            }}
                            onDragLeave={(e) => {
                              if (sortBy === 'custom') {
                                e.stopPropagation();
                                handleDragLeave(e);
                              }
                            }}
                            onDrop={(e) => {
                              if (sortBy === 'custom') {
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
                          >
                            <GripVertical className="w-3 h-3" />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-2">
                          {(() => {
                            const sslStatus = getSSLCertificateStatus(check);
                            return (
                              <div className="cursor-help">
                                <sslStatus.icon 
                                  className={`w-4 h-4 ${sslStatus.color}`} 
                                />
                              </div>
                            );
                          })()}
                          <StatusBadge status={check.status} />
                        </div>
                      </TableCell>
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className="flex flex-col">
                          <div className={`font-medium font-sans text-foreground group-hover:text-primary transition-colors duration-150 flex items-center gap-2 text-sm`}>
                            {highlightText(check.name, searchQuery)}
                            <TrendingUp className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity duration-150" />
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
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''} relative`}>
                        <div className="flex items-center gap-2">
                          <Clock className={`w-3 h-3 text-muted-foreground`} />
                          <span className={`text-sm font-mono text-muted-foreground`}>
                            {formatLastChecked(check.lastChecked)}
                          </span>
                        </div>
                        {/* Overlay for checks that have never been checked */}
                        {!check.lastChecked && !check.disabled && (
                          <NeverCheckedOverlay onCheckNow={() => onCheckNow(check.id)} />
                        )}
                      </TableCell>
                      <TableCell className={`px-4 py-4 ${check.disabled ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-2">
                          <Clock className={`w-3 h-3 text-muted-foreground`} />
                          <span className={`text-sm font-mono text-muted-foreground`}>
                            {(() => {
                              const interval = CHECK_INTERVALS.find(i => i.value === (check.checkFrequency || 10));
                              return interval ? interval.label : '10 minutes';
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
                              className={`hover:hover:bg-accent pointer-events-auto p-1`}
                            />
                            
                            {/* Menu will be rendered via portal */}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedRow === check.id && (
                      <TableRow className={`hover:bg-accent border-t border-border`}>
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
          
          {checks.length === 0 && (
            <div className="px-4">
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
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editingCheck} onOpenChange={(open) => !open && handleEditCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Check</DialogTitle>
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
            value={editForm.checkFrequency}
            onChange={(value) => setEditForm(prev => ({ ...prev, checkFrequency: value }))}
            helperText="How often should we check this endpoint?"
          />

          <div className="flex gap-3 pt-4">
            <Button type="submit" className="flex-1">
              Update Check
            </Button>
            <Button type="button" variant="secondary" onClick={handleEditCancel} className="flex-1">
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
            className={`fixed bg-popover border border rounded-lg z-[55] min-w-[160px] shadow-lg pointer-events-auto`}
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
                className={`w-full text-left px-4 py-2 text-sm ${check.disabled || isManuallyChecking(check.id) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} font-mono ${check.disabled || isManuallyChecking(check.id) ? '' : `hover:hover:bg-accent text-foreground hover:text-primary`} ${check.disabled || isManuallyChecking(check.id) ? 'text-muted-foreground' : ''} flex items-center gap-2`}
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
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:hover:bg-accent text-foreground hover:text-orange-400 flex items-center gap-2`}
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
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:hover:bg-accent text-foreground hover:text-green-600 flex items-center gap-2`}
              >
                <ExternalLink className="w-3 h-3" />
                Open URL
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/statistics/${check.id}`);
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:hover:bg-accent text-foreground hover:text-purple-400 flex items-center gap-2 font-medium`}
              >
                <TrendingUp className="w-3 h-3" />
                View Statistics
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditClick(check);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:hover:bg-accent text-foreground hover:text-primary flex items-center gap-2`}
              >
                <Edit className="w-3 h-3" />
                Edit
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteClick(check);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:hover:bg-accent text-destructive hover:text-destructive flex items-center gap-2`}
              >
                <Trash2 className="w-3 h-3" />
                Delete
              </button>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Floating Bulk Actions Navigation */}
      {selectedChecks.size > 0 && (
        <div className={`fixed bottom-0 left-0 right-0 z-[50] bg-popover border shadow-lg backdrop-blur-2xl border-t shadow-2xl`}>
          <div className="px-4 py-4 sm:px-6 sm:py-6 max-w-screen-xl mx-auto">
            {/* Mobile Layout - Stacked */}
            <div className="sm:hidden space-y-4">
              {/* Selection Info */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full bg-background border border flex items-center justify-center`}>
                    <span className={`text-sm font-semibold font-mono text-foreground`}>
                      {selectedChecks.size}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className={`text-sm font-medium font-mono text-foreground`}>
                      {selectedChecks.size} check{selectedChecks.size !== 1 ? 's' : ''} selected
                    </span>
                    <span className={`text-xs text-muted-foreground`}>
                      {Math.round((selectedChecks.size / sortedChecks.length) * 100)}% of total
                    </span>
                  </div>
                </div>
                
                {/* Close Selection */}
                <button
                  onClick={() => {
                    setSelectedChecks(new Set());
                    setSelectAll(false);
                  }}
                  className={`w-8 h-8 rounded-full hover:bg-accent border border flex items-center justify-center cursor-pointer transition-all duration-200 hover:hover:bg-accent hover:scale-105`}
                  title="Clear selection"
                >
                  <span className={`text-sm text-muted-foreground hover:text-foreground transition-colors duration-200`}>
                    ✕
                  </span>
                </button>
              </div>

              {/* Action Buttons - Full Width Grid */}
              <div className="grid grid-cols-3 gap-2">
                <Button
                  onClick={() => handleBulkToggleStatus(false)}
                  variant="secondary"
                  size="sm"
                  className="flex items-center justify-center gap-2 cursor-pointer w-full"
                >
                  <Play className="w-3 h-3" />
                  <span>Enable</span>
                </Button>
                
                <Button
                  onClick={() => handleBulkToggleStatus(true)}
                  variant="secondary"
                  size="sm"
                  className="flex items-center justify-center gap-2 cursor-pointer w-full"
                >
                  <Pause className="w-3 h-3" />
                  <span>Disable</span>
                </Button>
                
                <Button
                  onClick={handleBulkDelete}
                  variant="destructive"
                  size="sm"
                  className="flex items-center justify-center gap-2 cursor-pointer w-full"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Delete</span>
                </Button>
              </div>
            </div>

            {/* Desktop Layout - Horizontal */}
            <div className="hidden sm:flex items-center justify-between gap-6">
              {/* Selection Info */}
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full bg-background border border flex items-center justify-center`}>
                  <span className={`text-sm font-semibold font-mono text-foreground`}>
                    {selectedChecks.size}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className={`text-sm font-medium font-mono text-foreground`}>
                    {selectedChecks.size} check{selectedChecks.size !== 1 ? 's' : ''} selected
                  </span>
                  <span className={`text-xs text-muted-foreground`}>
                    {Math.round((selectedChecks.size / sortedChecks.length) * 100)}% of total
                  </span>
                </div>
              </div>

              {/* Divider */}
              <div className={`w-px h-8 border`} />

              {/* Action Buttons */}
              <div className="flex items-center gap-3">
                <Button
                  onClick={() => handleBulkToggleStatus(false)}
                  variant="secondary"
                  size="sm"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Play className="w-3 h-3" />
                  <span>Enable All</span>
                </Button>
                
                <Button
                  onClick={() => handleBulkToggleStatus(true)}
                  variant="secondary"
                  size="sm"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Pause className="w-3 h-3" />
                  <span>Disable All</span>
                </Button>
                
                <Button
                  onClick={handleBulkDelete}
                  variant="destructive"
                  size="sm"
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Delete All</span>
                </Button>
              </div>

              {/* Close Selection */}
              <button
                onClick={() => {
                  setSelectedChecks(new Set());
                  setSelectAll(false);
                }}
                className={`w-8 h-8 rounded-full hover:bg-accent border border flex items-center justify-center cursor-pointer transition-all duration-200 hover:hover:bg-accent hover:scale-105`}
                title="Clear selection"
              >
                <span className={`text-sm text-muted-foreground hover:text-foreground transition-colors duration-200`}>
                  ✕
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
};

export default CheckTable; 