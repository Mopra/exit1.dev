import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faSort, 
  faSortAlphaDown, 
  faSortAlphaUp, 
  faEllipsisV,
  faPlay,
  faPause,
  faEdit,
  faTrash,
  faExternalLinkAlt,
  faClock,
  faCheckCircle,
  faTimesCircle,
  faQuestionCircle,
  faGlobe,
  faCode,
  faCheck,
  faShieldAlt,
  faExclamationTriangle,
  faPlus,
  faChartLine,
  faArrowRight
} from '@fortawesome/pro-regular-svg-icons';
import { IconButton, Badge, Button, Modal, Input, Label, EmptyState, ConfirmationModal, StatusBadge } from '../ui';
import { useTooltip } from '../ui/Tooltip';
import type { Website } from '../../types';
import { theme, typography } from '../../config/theme';
import { formatLastChecked, formatResponseTime, highlightText } from '../../utils/formatters.tsx';

interface CheckTableProps {
  checks: Website[];
  onUpdate: (id: string, name: string, url: string) => void;
  onDelete: (id: string) => void;
  onBulkDelete: (ids: string[]) => void;
  onCheckNow: (id: string) => void;
  onToggleStatus: (id: string, disabled: boolean) => void;
  onBulkToggleStatus: (ids: string[], disabled: boolean) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  searchQuery?: string;
  onAddFirstCheck?: () => void;
}

type SortOption = 'custom' | 'name-asc' | 'name-desc' | 'url-asc' | 'url-desc' | 'status' | 'lastChecked' | 'createdAt' | 'responseTime' | 'type';

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
  onAddFirstCheck
}) => {
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState<SortOption>('custom');
  const [expandedRow] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuCoords, setMenuCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [editingCheck, setEditingCheck] = useState<Website | null>(null);
  const [editForm, setEditForm] = useState({ name: '', url: '' });
  const [deletingCheck, setDeletingCheck] = useState<Website | null>(null);
  
  // Multi-select state
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  const [selectAll, setSelectAll] = useState(false);
  const { showTooltip, hideTooltip } = useTooltip();

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
    setEditForm({ name: check.name, url: check.url });
    setOpenMenuId(null);
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingCheck) {
      onUpdate(editingCheck.id, editForm.name, editForm.url);
      setEditingCheck(null);
      setEditForm({ name: '', url: '' });
    }
  };

  const handleEditCancel = () => {
    setEditingCheck(null);
    setEditForm({ name: '', url: '' });
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
        return <FontAwesomeIcon icon={faCode} className="text-blue-500" />;
      default:
        return <FontAwesomeIcon icon={faGlobe} className="text-green-500" />;
    }
  };

  const getSSLCertificateStatus = (check: Website) => {
    if (!check.url.startsWith('https://')) {
      return { valid: true, icon: faShieldAlt, color: 'text-gray-400', text: 'HTTP' };
    }
    
    if (!check.sslCertificate) {
      return { valid: false, icon: faExclamationTriangle, color: 'text-gray-400', text: 'Unknown' };
    }
    
    if (check.sslCertificate.valid) {
      const daysUntilExpiry = check.sslCertificate.daysUntilExpiry || 0;
      if (daysUntilExpiry <= 30) {
        return { 
          valid: true, 
          icon: faExclamationTriangle, 
          color: 'text-yellow-500', 
          text: `${daysUntilExpiry} days` 
        };
      }
      return { 
        valid: true, 
        icon: faShieldAlt, 
        color: 'text-green-500', 
        text: 'Valid' 
      };
    } else {
      return { 
        valid: false, 
        icon: faExclamationTriangle, 
        color: 'text-red-500', 
        text: 'Invalid' 
      };
    }
  };





  return (
    <div className="space-y-6">

      {/* Table */}
      <div className="overflow-hidden rounded-xl bg-gradient-to-br from-gray-950/80 to-black/90 backdrop-blur-sm border border-gray-800/50 shadow-md">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gradient-to-br from-black/85 to-gray-950/70 backdrop-blur-sm border-b border-gray-700/40">
              <tr>
                <th className="px-2 sm:px-4 py-4 sm:py-6 text-left w-10 sm:w-12">
                  <div className="flex items-center justify-center">
                    <button
                      onClick={handleSelectAll}
                      className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectAll ? `${theme.colors.border.primary} ${theme.colors.background.primary}` : theme.colors.border.secondary} hover:${theme.colors.border.primary} cursor-pointer flex items-center justify-center`}
                      title={selectAll ? 'Deselect all' : 'Select all'}
                    >
                      {selectAll && (
                        <FontAwesomeIcon icon={faCheck} className="w-2.5 h-2.5 text-white" />
                      )}
                    </button>
                  </div>
                </th>
                <th className="px-2 sm:px-4 py-4 sm:py-6 text-left w-10 sm:w-12">
                  <div className={`text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${sortBy === 'custom' ? theme.colors.text.muted : 'text-gray-400'}`}>
                    {/* Order */}
                  </div>
                </th>
                <th className="px-4 sm:px-8 py-4 sm:py-6 text-left">
                  <button
                    onClick={() => handleSortChange(sortBy === 'status' ? 'custom' : 'status')}
                    className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted} hover:${theme.colors.text.primary} transition-colors duration-150 cursor-pointer`}
                  >
                    Status
                    <FontAwesomeIcon 
                      icon={sortBy === 'status' ? faSortAlphaDown : faSort} 
                      className="w-3 h-3" 
                    />
                  </button>
                </th>
                <th className="px-4 sm:px-8 py-4 sm:py-6 text-left">
                  <button
                    onClick={() => handleSortChange(sortBy === 'name-asc' ? 'name-desc' : 'name-asc')}
                    className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted} hover:${theme.colors.text.primary} transition-colors duration-150 cursor-pointer`}
                  >
                    Name & URL
                    <FontAwesomeIcon 
                      icon={sortBy === 'name-asc' ? faSortAlphaDown : sortBy === 'name-desc' ? faSortAlphaUp : faSort} 
                      className="w-3 h-3" 
                    />
                  </button>
                </th>
                <th className="hidden md:table-cell px-8 py-6 text-left">
                  <button
                    onClick={() => handleSortChange(sortBy === 'type' ? 'custom' : 'type')}
                    className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted} hover:${theme.colors.text.primary} transition-colors duration-150 cursor-pointer`}
                  >
                    Type
                    <FontAwesomeIcon 
                      icon={sortBy === 'type' ? faSortAlphaDown : faSort} 
                      className="w-3 h-3" 
                    />
                  </button>
                </th>
                <th className="hidden lg:table-cell px-8 py-6 text-left">
                  <button
                    onClick={() => handleSortChange(sortBy === 'responseTime' ? 'custom' : 'responseTime')}
                    className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted} hover:${theme.colors.text.primary} transition-colors duration-150 cursor-pointer`}
                  >
                    Response Time
                    <FontAwesomeIcon 
                      icon={sortBy === 'responseTime' ? faSortAlphaDown : faSort} 
                      className="w-3 h-3" 
                    />
                  </button>
                </th>

                <th className="hidden lg:table-cell px-8 py-6 text-left">
                  <button
                    onClick={() => handleSortChange(sortBy === 'lastChecked' ? 'custom' : 'lastChecked')}
                    className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted} hover:${theme.colors.text.primary} transition-colors duration-150 cursor-pointer`}
                  >
                    Last Checked
                    <FontAwesomeIcon 
                      icon={sortBy === 'lastChecked' ? faSortAlphaDown : faSort} 
                      className="w-3 h-3" 
                    />
                  </button>
                </th>
                <th className="px-4 sm:px-8 py-4 sm:py-6 text-center w-12 sm:w-16">
                  <div className={`text-xs font-medium uppercase tracking-wider ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                    Actions
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/30">
              {sortedChecks.map((check, index) => (
                <React.Fragment key={check.id}>
                  <tr 
                    className={`${theme.colors.background.tableRowHover} transition-all duration-200 ${draggedIndex === index ? 'opacity-50 scale-95 rotate-1' : ''} ${dragOverIndex === index ? 'bg-blue-500/10 border-l-2 border-l-blue-500' : ''} cursor-pointer`}
                    draggable={sortBy === 'custom'}
                    onClick={() => navigate(`/statistics/${check.id}`)}
                    onDragStart={(e) => {
                      if (sortBy === 'custom') {
                        e.dataTransfer.effectAllowed = 'move';
                        handleDragStart(index);
                      }
                    }}
                    onDragOver={(e) => {
                      if (sortBy === 'custom') {
                        handleDragOver(e, index);
                      }
                    }}
                    onDragLeave={(e) => {
                      if (sortBy === 'custom') {
                        handleDragLeave(e);
                      }
                    }}
                    onDrop={(e) => {
                      if (sortBy === 'custom') {
                        handleDrop(e);
                      }
                    }}
                    onDragEnd={() => {
                      if (sortBy === 'custom') {
                        handleDragEnd();
                      }
                    }}
                  >
                    <td className={`px-2 sm:px-4 py-4 sm:py-6 ${check.disabled ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectCheck(check.id);
                          }}
                          className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectedChecks.has(check.id) ? `${theme.colors.border.primary} ${theme.colors.background.primary}` : theme.colors.border.secondary} hover:${theme.colors.border.primary} cursor-pointer flex items-center justify-center`}
                          title={selectedChecks.has(check.id) ? 'Deselect' : 'Select'}
                        >
                          {selectedChecks.has(check.id) && (
                            <FontAwesomeIcon icon={faCheck} className="w-2.5 h-2.5 text-white" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className={`px-2 sm:px-4 py-4 sm:py-6 ${check.disabled ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-center">
                        <div 
                          className={`p-2 sm:p-1 rounded ${sortBy === 'custom' ? `cursor-grab active:cursor-grabbing ${theme.colors.text.muted} hover:${theme.colors.text.primary}` : 'text-gray-400 cursor-not-allowed'}`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={sortBy === 'custom' ? `Drag to reorder ${check.name}` : 'Custom ordering disabled'}
                          title={sortBy === 'custom' ? 'Drag to reorder' : 'Custom ordering disabled when sorting by other columns'}
                        >
                          <FontAwesomeIcon icon={faSort} className="w-3 h-3" />
                        </div>
                      </div>
                    </td>
                    <td className={`px-4 sm:px-8 py-4 sm:py-6 ${check.disabled ? 'opacity-50' : ''}`}>
                      <div className="flex items-center gap-2">
                        {(() => {
                          const sslStatus = getSSLCertificateStatus(check);
                          const tooltipContent = (() => {
                            if (!check.url.startsWith('https://')) {
                              return 'HTTP site (no SSL certificate)';
                            }
                            if (!check.sslCertificate) {
                              return 'SSL certificate status unknown';
                            }
                            if (check.sslCertificate.valid) {
                              const daysUntilExpiry = check.sslCertificate.daysUntilExpiry || 0;
                              if (daysUntilExpiry <= 30) {
                                return `SSL Certificate: Expiring in ${daysUntilExpiry} days\nIssuer: ${check.sslCertificate.issuer || 'Unknown'}\nExpires: ${check.sslCertificate.validTo ? new Date(check.sslCertificate.validTo).toLocaleDateString() : 'Unknown'}`;
                              }
                              return `SSL Certificate: Valid\nIssuer: ${check.sslCertificate.issuer || 'Unknown'}\nExpires: ${check.sslCertificate.validTo ? new Date(check.sslCertificate.validTo).toLocaleDateString() : 'Unknown'}`;
                            } else {
                              return `SSL Certificate: Invalid\nError: ${check.sslCertificate.error || 'Unknown error'}`;
                            }
                          })();
                          
                          return (
                            <div 
                              className="cursor-help"
                              onMouseEnter={(e) => showTooltip(e, tooltipContent)}
                              onMouseLeave={hideTooltip}
                            >
                              <FontAwesomeIcon 
                                icon={sslStatus.icon} 
                                className={`w-4 h-4 ${sslStatus.color}`} 
                              />
                            </div>
                          );
                        })()}
                        <StatusBadge status={check.status} />
                      </div>
                    </td>
                    <td className={`px-4 sm:px-8 py-4 sm:py-6 ${check.disabled ? 'opacity-50' : ''}`}>
                      <div className="flex flex-col">
                        <div className={`font-medium ${typography.fontFamily.sans} ${theme.colors.text.primary}`}>
                          {highlightText(check.name, searchQuery)}
                        </div>
                        <div className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted} truncate max-w-[200px] sm:max-w-xs`}>
                          {highlightText(check.url, searchQuery)}
                        </div>
                      </div>
                    </td>
                    <td className={`hidden md:table-cell px-8 py-6 ${check.disabled ? 'opacity-50' : ''}`}>
                      <div className="flex items-center gap-2">
                        {getTypeIcon(check.type)}
                        <span className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                          {check.type === 'rest_endpoint' ? 'API' : 'Website'}
                        </span>
                      </div>
                    </td>
                    <td className={`hidden lg:table-cell px-8 py-6 ${check.disabled ? 'opacity-50' : ''}`}>
                      <div className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                        {formatResponseTime(check.responseTime)}
                      </div>
                    </td>

                    <td className={`hidden lg:table-cell px-8 py-6 ${check.disabled ? 'opacity-50' : ''}`}>
                      <div className="flex items-center gap-2">
                        <FontAwesomeIcon icon={faClock} className={`w-3 h-3 ${theme.colors.text.muted}`} />
                        <span className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
                          {formatLastChecked(check.lastChecked)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 sm:px-8 py-4 sm:py-6">
                      <div className="flex items-center justify-center">
                        <div className="relative action-menu pointer-events-auto">
                          <IconButton
                            icon={<FontAwesomeIcon icon={faEllipsisV} className="w-4 h-4" />}
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              const newMenuId = openMenuId === check.id ? null : check.id;
                              if (newMenuId) {
                                const result = calculateMenuPosition(e.currentTarget);
                                setMenuCoords(result.coords);
                              }
                              setOpenMenuId(newMenuId);
                            }}
                            aria-label="More actions"
                            aria-expanded={openMenuId === check.id}
                            aria-haspopup="menu"
                            className={`hover:${theme.colors.background.hover} pointer-events-auto p-2 sm:p-1`}
                          />
                          
                          {/* Menu will be rendered via portal */}
                        </div>
                      </div>
                    </td>
                  </tr>
                  {expandedRow === check.id && (
                    <tr className={`${theme.colors.background.hover} border-t border-gray-200/30`}>
                      <td colSpan={7} className="px-4 sm:px-8 py-4 sm:py-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                          <div>
                            <div className={`font-medium ${theme.colors.text.primary} mb-1`}>Details</div>
                            <div className={`${typography.fontFamily.mono} ${theme.colors.text.muted} space-y-1`}>
                              <div>ID: {check.id}</div>
                              <div>Created: {check.createdAt ? new Date(check.createdAt).toLocaleDateString() : 'Unknown'}</div>
                              {check.lastStatusCode && <div>Last Status: {check.lastStatusCode}</div>}
                            </div>
                          </div>
                          {check.type === 'rest_endpoint' && (
                            <div>
                              <div className={`font-medium ${theme.colors.text.primary} mb-1`}>API Details</div>
                              <div className={`${typography.fontFamily.mono} ${theme.colors.text.muted} space-y-1`}>
                                <div>Method: {check.httpMethod || 'GET'}</div>
                                <div>Expected: {check.expectedStatusCodes?.join(', ') || '200'}</div>
                              </div>
                            </div>
                          )}
                          {check.sslCertificate && check.url.startsWith('https://') && (
                            <div>
                              <div className={`font-medium ${theme.colors.text.primary} mb-1`}>SSL Certificate</div>
                              <div className={`${typography.fontFamily.mono} ${theme.colors.text.muted} space-y-1`}>
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
                                  <div className="text-red-500">Error: {check.sslCertificate.error}</div>
                                )}
                              </div>
                            </div>
                          )}
                          {check.lastError && (
                            <div>
                              <div className={`font-medium ${theme.colors.text.primary} mb-1`}>Last Error</div>
                              <div className={`${typography.fontFamily.mono} ${theme.colors.text.muted} text-xs`}>
                                {check.lastError}
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        
        {checks.length === 0 && (
          <div className="px-4 sm:px-8">
            {searchQuery ? (
              <EmptyState
                variant="search"
                title="No checks found"
                description={`No checks match your search for "${searchQuery}". Try adjusting your search terms.`}
              />
            ) : (
              <EmptyState
                variant="empty"
                icon={faGlobe}
                title="No checks configured yet"
                description="Start monitoring your websites and API endpoints to get real-time status updates and alerts when they go down."
                action={onAddFirstCheck ? {
                  label: "ADD YOUR FIRST CHECK",
                  onClick: onAddFirstCheck,
                  icon: faPlus
                } : undefined}
              />
            )}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      <Modal
        isOpen={!!editingCheck}
        onClose={handleEditCancel}
        title="Edit Check"
        size="md"
      >
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

          <div className="flex gap-3 pt-4">
            <Button type="submit" className="flex-1">
              Update Check
            </Button>
            <Button type="button" variant="secondary" onClick={handleEditCancel} className="flex-1">
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!deletingCheck}
        onClose={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        title={`Delete "${deletingCheck?.name}"?`}
        message="This action cannot be undone. The check will be permanently removed from your monitoring list."
        confirmText="Delete Check"
        variant="danger"
      />

      {/* Bulk Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={bulkDeleteModal}
        onClose={handleBulkDeleteCancel}
        onConfirm={handleBulkDeleteConfirm}
        title={`Delete ${selectedChecks.size} check${selectedChecks.size !== 1 ? 's' : ''}?`}
        message="This action cannot be undone. All selected checks will be permanently removed from your monitoring list."
        confirmText="Delete"
        variant="danger"
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
            className={`fixed ${theme.colors.background.modal} border ${theme.colors.border.primary} rounded-lg z-[55] min-w-[160px] shadow-lg pointer-events-auto`}
            style={{
              left: `${menuCoords.x}px`,
              top: `${menuCoords.y}px`
            }}
          >
            <div className="py-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!check.disabled) {
                    onCheckNow(check.id);
                  }
                  setOpenMenuId(null);
                }}
                disabled={check.disabled}
                className={`w-full text-left px-4 py-2 text-sm ${check.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${typography.fontFamily.mono} ${check.disabled ? '' : `hover:${theme.colors.background.hover} ${theme.colors.text.primary} hover:text-blue-400`} ${check.disabled ? theme.colors.text.muted : ''} flex items-center gap-2`}
                title={check.disabled ? 'Cannot check disabled websites' : 'Check now'}
              >
                <FontAwesomeIcon icon={faPlay} className="w-3 h-3" />
                Check now
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStatus(check.id, !check.disabled);
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} ${theme.colors.text.primary} hover:text-orange-400 flex items-center gap-2`}
              >
                <FontAwesomeIcon icon={check.disabled ? faPlay : faPause} className="w-3 h-3" />
                {check.disabled ? 'Enable' : 'Disable'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(check.url, '_blank');
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} ${theme.colors.text.primary} hover:text-green-400 flex items-center gap-2`}
              >
                <FontAwesomeIcon icon={faExternalLinkAlt} className="w-3 h-3" />
                Open URL
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/statistics/${check.id}`);
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} ${theme.colors.text.primary} hover:text-purple-400 flex items-center gap-2`}
              >
                <FontAwesomeIcon icon={faChartLine} className="w-3 h-3" />
                Statistics
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditClick(check);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} ${theme.colors.text.primary} hover:text-blue-400 flex items-center gap-2`}
              >
                <FontAwesomeIcon icon={faEdit} className="w-3 h-3" />
                Edit
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteClick(check);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer ${typography.fontFamily.mono} hover:${theme.colors.background.hover} text-red-500 hover:text-red-400 flex items-center gap-2`}
              >
                <FontAwesomeIcon icon={faTrash} className="w-3 h-3" />
                Delete
              </button>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Floating Bulk Actions Toolbar */}
      {selectedChecks.size > 0 && (
        <div className={`fixed bottom-20 sm:bottom-1 left-4 right-4 z-[35] flex flex-col sm:flex-row items-center justify-between p-4 sm:p-6 rounded-lg border shadow-lg backdrop-blur-xl ${theme.colors.border.secondary} ${theme.colors.background.modal} max-w-[95vw]`}>
          <div className="flex items-center gap-4 mb-3 sm:mb-0">
            <span className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.primary}`}>
              {selectedChecks.size} check{selectedChecks.size !== 1 ? 's' : ''} selected
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => handleBulkToggleStatus(false)}
              variant="secondary"
              size="sm"
              className="flex items-center gap-2"
            >
              <FontAwesomeIcon icon={faPlay} className="w-3 h-3" />
              <span className="hidden sm:inline">Enable All</span>
              <span className="sm:hidden">Enable</span>
            </Button>
            <Button
              onClick={() => handleBulkToggleStatus(true)}
              variant="secondary"
              size="sm"
              className="flex items-center gap-2"
            >
              <FontAwesomeIcon icon={faPause} className="w-3 h-3" />
              <span className="hidden sm:inline">Disable All</span>
              <span className="sm:hidden">Disable</span>
            </Button>
            <Button
              onClick={handleBulkDelete}
              variant="danger"
              size="sm"
              className="flex items-center gap-2"
            >
              <FontAwesomeIcon icon={faTrash} className="w-3 h-3" />
              <span className="hidden sm:inline">Delete All</span>
              <span className="sm:hidden">Delete</span>
            </Button>
          </div>
        </div>
      )}

    </div>
  );
};

export default CheckTable; 