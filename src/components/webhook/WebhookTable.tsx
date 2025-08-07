import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, Copy, ExternalLink, HelpCircle, Edit, Trash2, Play, MoreVertical, Check, Pause, Bell, Loader2, SortAsc, SortDesc, ArrowUpDown, AlertTriangle } from 'lucide-react';
import { Button, Badge, EmptyState, IconButton, ConfirmationModal, Checkbox, Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '../ui';

import { formatCreatedAt, highlightText } from '../../utils/formatters.tsx';
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll';
import { getTableHoverColor } from '../../lib/utils';

interface WebhookSettings {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
  events: string[];
  secret?: string;
  headers?: { [key: string]: string };
  createdAt: number;
  updatedAt: number;
}

interface TestResult {
  success: boolean;
  message?: string;
  statusCode?: number;
  responseTime?: number;
}

interface WebhookTableProps {
  webhooks: WebhookSettings[];
  onEdit: (webhook: WebhookSettings) => void;
  onDelete: (id: string) => void;
  onBulkDelete?: (ids: string[]) => void;
  onTest: (id: string) => void;
  onToggleStatus?: (id: string, enabled: boolean) => void;
  onBulkToggleStatus?: (ids: string[], enabled: boolean) => void;
  testingWebhook: string | null;
  testResult: TestResult | null;
  searchQuery?: string;
  onAddFirstWebhook?: () => void;
}

type SortOption = 'createdAt' | 'name-asc' | 'name-desc' | 'url-asc' | 'url-desc' | 'status' | 'events';

const WebhookTable: React.FC<WebhookTableProps> = ({
  webhooks,
  onEdit,
  onDelete,
  onBulkDelete,
  onTest,
  onToggleStatus,
  onBulkToggleStatus,
  testingWebhook,
  testResult,
  searchQuery = '',
  onAddFirstWebhook
}) => {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('createdAt');
  const [selectedWebhooks, setSelectedWebhooks] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuCoords, setMenuCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [deletingWebhook, setDeletingWebhook] = useState<WebhookSettings | null>(null);
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  

  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();
  
  const eventTypes = [
    { 
      value: 'website_down', 
      label: 'Website Down', 
      color: 'red',
      description: 'Triggered when a website becomes unavailable or returns error codes',
      icon: 'exclamation-triangle'
    },
    { 
      value: 'website_up', 
      label: 'Website Up', 
      color: 'green',
      description: 'Triggered when a website becomes available again after being down',
      icon: 'check-circle'
    },
    { 
      value: 'website_error', 
      label: 'Website Error', 
      color: 'yellow',
      description: 'Triggered when a website returns error codes or has performance issues',
      icon: 'exclamation-circle'
    }
  ];

  // Sort webhooks based on current sort option
  const sortedWebhooks = useCallback(() => {
    const sorted = [...webhooks];
    switch (sortBy) {
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
          if (a.enabled === b.enabled) return 0;
          return a.enabled ? -1 : 1;
        });
      case 'events':
        return sorted.sort((a, b) => b.events.length - a.events.length);
      case 'createdAt':
      default:
        return sorted.sort((a, b) => b.createdAt - a.createdAt);
    }
  }, [webhooks, sortBy]);

  const handleSortChange = (newSort: SortOption) => {
    setSortBy(newSort);
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedUrl(id);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopiedUrl(id);
      setTimeout(() => setCopiedUrl(null), 2000);
    }
  };

  // Selection handlers
  const handleSelectWebhook = (id: string) => {
    const newSelected = new Set(selectedWebhooks);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedWebhooks(newSelected);
    setSelectAll(newSelected.size === sortedWebhooks().length);
  };

  const handleSelectAll = () => {
    if (selectAll) {
      setSelectedWebhooks(new Set());
      setSelectAll(false);
    } else {
      setSelectedWebhooks(new Set(sortedWebhooks().map(w => w.id)));
      setSelectAll(true);
    }
  };

  // Menu handlers
  const calculateMenuPosition = (button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const coords = {
      x: rect.left,
      y: rect.bottom + 8
    };
    
    // Adjust if menu would go off screen
    if (coords.x + 160 > window.innerWidth) {
      coords.x = window.innerWidth - 160 - 8;
    }
    if (coords.y + 200 > window.innerHeight) {
      coords.y = rect.top - 200 - 8;
    }
    
    return { coords };
  };

  // Click outside handler for menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-menu="true"]') && !target.closest('.action-menu')) {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Bulk action handlers
  const handleBulkDelete = () => {
    if (onBulkDelete) {
      setBulkDeleteModal(true);
    }
  };

  const handleBulkDeleteConfirm = () => {
    if (onBulkDelete) {
      onBulkDelete(Array.from(selectedWebhooks));
      setSelectedWebhooks(new Set());
      setSelectAll(false);
      setBulkDeleteModal(false);
    }
  };

  const handleBulkDeleteCancel = () => {
    setBulkDeleteModal(false);
  };

  const handleDeleteClick = (webhook: WebhookSettings) => {
    setDeletingWebhook(webhook);
  };

  const handleDeleteConfirm = () => {
    if (deletingWebhook) {
      onDelete(deletingWebhook.id);
      setDeletingWebhook(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeletingWebhook(null);
  };



  



  return (
    <>
      {/* Mobile Card Layout (640px and below) */}
      <div className="block sm:hidden">
        <div className="space-y-3">
          {sortedWebhooks().map((webhook, index) => (
            <div 
              key={webhook.id} 
              className={`relative rounded-lg border ${getTableHoverColor(webhook.enabled ? 'success' : 'neutral')} p-4 space-y-3 cursor-pointer transition-all duration-200 group`}
            >
              {/* Header Row */}
              <div className="flex items-start justify-between gap-3">
                {/* Selection Checkbox */}
                <Checkbox
                  checked={selectedWebhooks.has(webhook.id)}
                  onCheckedChange={() => handleSelectWebhook(webhook.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-1"
                  title={selectedWebhooks.has(webhook.id) ? 'Deselect' : 'Select'}
                />

                {/* Status */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className={`w-2 h-2 rounded-full ${webhook.enabled ? 'bg-green-500' : 'bg-muted-foreground'}`}></div>
                  <span className={`text-xs font-mono ${webhook.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {webhook.enabled ? 'Active' : 'Paused'}
                  </span>
                </div>

                {/* Actions Menu */}
                <div className="relative action-menu pointer-events-auto flex-shrink-0">
                  <IconButton
                    icon={<MoreVertical className="w-4 h-4" />}
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e?.stopPropagation();
                      const newMenuId = openMenuId === webhook.id ? null : webhook.id;
                      if (newMenuId) {
                        const result = calculateMenuPosition(e?.currentTarget as HTMLElement);
                        setMenuCoords(result.coords);
                      }
                      setOpenMenuId(newMenuId);
                    }}
                    aria-label="More actions"
                    aria-expanded={openMenuId === webhook.id}
                    aria-haspopup="menu"
                    className={`hover:bg-neutral/20 pointer-events-auto p-2`}
                  />
                </div>
              </div>

              {/* Name and URL */}
              <div className="space-y-1">
                <div className={`font-medium font-sans text-foreground group-hover:text-primary transition-colors duration-150 flex items-center gap-2`}>
                  {highlightText(webhook.name, searchQuery)}
                </div>
                <div className={`text-sm font-mono text-muted-foreground break-all`}>
                  {highlightText(webhook.url, searchQuery)}
                </div>
              </div>

              {/* Details Grid */}
              <div className="grid grid-cols-1 gap-3 text-sm">
                {/* Events */}
                <div className="flex flex-wrap gap-1">
                  {webhook.events.map((event) => {
                    const eventType = eventTypes.find(et => et.value === event);
                    return (
                      <Badge 
                        key={event}
                        variant={eventType?.color as any || 'default'} 
                        className="text-xs px-2 py-1 cursor-help"
                      >
                        <Bell className="w-3 h-3 mr-1" />
                        {eventType?.label || event}
                      </Badge>
                    );
                  })}
                </div>

                {/* Created Date */}
                <div className={`text-xs font-mono text-muted-foreground`}>
                  Created {formatCreatedAt(webhook.createdAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
        
        {webhooks.length === 0 && (
          <div className="px-4">
            {searchQuery ? (
              <EmptyState
                variant="search"
                title="No webhooks found"
                description={`No webhooks match your search for "${searchQuery}". Try adjusting your search terms.`}
              />
            ) : (
              <EmptyState
                variant="empty"
                icon={HelpCircle}
                title="No webhooks configured"
                description="Add your first webhook to start receiving instant notifications when your websites change status."
                action={onAddFirstWebhook ? {
                  label: 'Add Your First Webhook',
                  onClick: onAddFirstWebhook
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
                  <TableHead className="px-4 py-4 text-left w-28">
                    <button
                      onClick={() => handleSortChange(sortBy === 'status' ? 'createdAt' : 'status')}
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
                  <TableHead className="px-4 py-4 text-left w-64">
                    <button
                      onClick={() => handleSortChange(sortBy === 'events' ? 'createdAt' : 'events')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Events
                      {sortBy === 'events' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-36">
                    <button
                      onClick={() => handleSortChange(sortBy === 'createdAt' ? 'name-asc' : 'createdAt')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Created
                      {sortBy === 'createdAt' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
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
                {sortedWebhooks().map((webhook) => (
                  <TableRow key={webhook.id} className={`${getTableHoverColor(webhook.enabled ? 'success' : 'neutral')} transition-all duration-200 group cursor-pointer`}>
                    <TableCell className="px-4 py-4">
                      <div className="flex items-center justify-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectWebhook(webhook.id);
                          }}
                          className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectedWebhooks.has(webhook.id) ? `border bg-background` : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                          title={selectedWebhooks.has(webhook.id) ? 'Deselect' : 'Select'}
                        >
                          {selectedWebhooks.has(webhook.id) && (
                            <Check className="w-2.5 h-2.5 text-white" />
                          )}
                        </button>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${webhook.enabled ? 'bg-green-500' : 'bg-muted-foreground'}`}></div>
                        <span className={`text-sm font-mono ${webhook.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {webhook.enabled ? 'Active' : 'Paused'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="flex flex-col">
                        <div className={`font-medium font-sans text-foreground group-hover:text-primary transition-colors duration-150 flex items-center gap-2 text-sm`}>
                          {highlightText(webhook.name, searchQuery)}
                        </div>
                        <div className={`text-sm font-mono text-muted-foreground truncate max-w-xs`}>
                          {highlightText(webhook.url, searchQuery)}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="flex flex-wrap gap-2">
                        {webhook.events.map((event) => {
                          const eventType = eventTypes.find(et => et.value === event);
                          return (
                            <Badge 
                              key={event}
                              variant={eventType?.color as any || 'default'} 
                              className="text-xs px-2 py-1 cursor-help"
                            >
                              <Bell className="w-3 h-3 mr-1" />
                              {eventType?.label || event}
                            </Badge>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className={`text-sm font-mono text-muted-foreground`}>
                        {formatCreatedAt(webhook.createdAt)}
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
                              const newMenuId = openMenuId === webhook.id ? null : webhook.id;
                              if (newMenuId) {
                                const result = calculateMenuPosition(e?.currentTarget as HTMLElement);
                                setMenuCoords(result.coords);
                              }
                              setOpenMenuId(newMenuId);
                            }}
                            aria-label="More actions"
                            aria-expanded={openMenuId === webhook.id}
                            aria-haspopup="menu"
                            className={`hover:bg-neutral/20 pointer-events-auto p-1`}
                          />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          
          {webhooks.length === 0 && (
            <div className="px-4">
              {searchQuery ? (
                <EmptyState
                  variant="search"
                  title="No webhooks found"
                  description={`No webhooks match your search for "${searchQuery}". Try adjusting your search terms.`}
                />
              ) : (
                <EmptyState
                  variant="empty"
                  icon={HelpCircle}
                  title="No webhooks configured"
                  description="Add your first webhook to start receiving instant notifications when your websites change status."
                  action={onAddFirstWebhook ? {
                    label: 'Add Your First Webhook',
                    onClick: onAddFirstWebhook
                  } : undefined}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Test Result Display */}
      {testResult && testingWebhook === null && (
        <div className={`p-4 sm:p-6 rounded-lg border ${testResult.success 
          ? 'bg-green-500/10 border-green-500/20' 
          : 'bg-red-500/10 border-red-500/20'
        }`}>
          <div className="flex items-center gap-3">
                         {testResult.success ? <CheckCircle className={`w-4 h-4 sm:w-5 sm:h-5 text-green-600`} /> : <AlertTriangle className={`w-4 h-4 sm:w-5 sm:h-5 text-red-600`} />}
            <div className="flex-1">
              <p className={`font-medium text-sm sm:text-base ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
                {testResult.success ? 'Test webhook sent successfully!' : 'Test failed'}
              </p>
              {testResult.message && (
                <p className={`text-xs sm:text-sm mt-1 text-muted-foreground`}>
                  {testResult.message}
                </p>
              )}
              {testResult.statusCode && (
                <p className={`text-xs sm:text-sm mt-1 text-muted-foreground`}>
                  Status: {testResult.statusCode}
                  {testResult.responseTime && ` • Response time: ${testResult.responseTime}ms`}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!deletingWebhook}
        onClose={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        title={`Delete "${deletingWebhook?.name}"?`}
        message="This action cannot be undone. The webhook will be permanently removed."
        confirmText="Delete Webhook"
        variant="destructive"
      />

      {/* Bulk Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={bulkDeleteModal}
        onClose={handleBulkDeleteCancel}
        onConfirm={handleBulkDeleteConfirm}
        title={`Delete ${selectedWebhooks.size} webhook${selectedWebhooks.size !== 1 ? 's' : ''}?`}
        message="This action cannot be undone. All selected webhooks will be permanently removed."
        confirmText="Delete"
        variant="destructive"
        itemCount={selectedWebhooks.size}
        itemName="webhook"
      />

      {/* Portal-based Action Menu */}
      {openMenuId && (() => {
        const webhook = webhooks.find(w => w.id === openMenuId);
        if (!webhook) return null;
        
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
                  onTest(webhook.id);
                  setOpenMenuId(null);
                }}
                disabled={testingWebhook === webhook.id}
                className={`w-full text-left px-4 py-2 text-sm ${testingWebhook === webhook.id ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} font-mono ${testingWebhook === webhook.id ? '' : `hover:bg-neutral/20 text-foreground hover:text-primary`} ${testingWebhook === webhook.id ? 'text-muted-foreground' : ''} flex items-center gap-2`}
                title={testingWebhook === webhook.id ? 'Test in progress...' : 'Test webhook'}
              >
                                 {testingWebhook === webhook.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {testingWebhook === webhook.id ? 'Testing...' : 'Test webhook'}
              </button>
              {onToggleStatus && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStatus(webhook.id, !webhook.enabled);
                    setOpenMenuId(null);
                  }}
                  className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:bg-neutral/20 text-foreground hover:text-orange-400 flex items-center gap-2`}
                >
                                     {webhook.enabled ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  {webhook.enabled ? 'Disable' : 'Enable'}
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(webhook.url, '_blank');
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
                  copyToClipboard(webhook.url, webhook.id);
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:bg-neutral/20 text-foreground hover:text-primary flex items-center gap-2`}
              >
                                 {copiedUrl === webhook.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copiedUrl === webhook.id ? 'Copied!' : 'Copy URL'}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(webhook);
                  setOpenMenuId(null);
                }}
                className={`w-full text-left px-4 py-2 text-sm cursor-pointer font-mono hover:bg-neutral/20 text-foreground hover:text-primary flex items-center gap-2`}
              >
                                 <Edit className="w-3 h-3" />
                Edit
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteClick(webhook);
                  setOpenMenuId(null);
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

      {/* Floating Bulk Actions Navigation */}
      {selectedWebhooks.size > 0 && (
        <div className={`fixed bottom-0 left-0 right-0 z-[50] bg-popover border shadow-lg backdrop-blur-2xl border-t shadow-2xl`}>
          <div className="px-4 py-4 sm:px-6 sm:py-6 max-w-screen-xl mx-auto">
            {/* Mobile Layout - Stacked */}
            <div className="sm:hidden space-y-4">
              {/* Selection Info */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full bg-background border border flex items-center justify-center`}>
                    <span className={`text-sm font-semibold font-mono text-foreground`}>
                      {selectedWebhooks.size}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className={`text-sm font-medium font-mono text-foreground`}>
                      {selectedWebhooks.size} webhook{selectedWebhooks.size !== 1 ? 's' : ''} selected
                    </span>
                    <span className={`text-xs text-muted-foreground`}>
                      {Math.round((selectedWebhooks.size / sortedWebhooks().length) * 100)}% of total
                    </span>
                  </div>
                </div>
                
                {/* Close Selection */}
                <button
                  onClick={() => {
                    setSelectedWebhooks(new Set());
                    setSelectAll(false);
                  }}
                  className={`w-8 h-8 rounded-full hover:bg-accent border border flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-neutral/20 hover:scale-105`}
                  title="Clear selection"
                >
                  <span className={`text-sm text-muted-foreground hover:text-foreground transition-colors duration-200`}>
                    ✕
                  </span>
                </button>
              </div>

              {/* Action Buttons - Full Width Grid */}
              <div className="grid grid-cols-3 gap-2">
                {onBulkToggleStatus && (
                  <>
                                         <Button
                       onClick={() => onBulkToggleStatus(Array.from(selectedWebhooks), true)}
                       variant="secondary"
                       size="sm"
                       className="flex items-center justify-center gap-2 cursor-pointer w-full"
                     >
                       <Play className="w-3 h-3" />
                       <span>Enable</span>
                     </Button>
                    
                                         <Button
                       onClick={() => onBulkToggleStatus(Array.from(selectedWebhooks), false)}
                       variant="secondary"
                       size="sm"
                       className="flex items-center justify-center gap-2 cursor-pointer w-full"
                     >
                       <Pause className="w-3 h-3" />
                       <span>Disable</span>
                     </Button>
                  </>
                )}
                
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
                    {selectedWebhooks.size}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className={`text-sm font-medium font-mono text-foreground`}>
                    {selectedWebhooks.size} webhook{selectedWebhooks.size !== 1 ? 's' : ''} selected
                  </span>
                  <span className={`text-xs text-muted-foreground`}>
                    {Math.round((selectedWebhooks.size / sortedWebhooks().length) * 100)}% of total
                  </span>
                </div>
              </div>

              {/* Divider */}
              <div className={`w-px h-8 border`} />

              {/* Action Buttons */}
              <div className="flex items-center gap-3">
                {onBulkToggleStatus && (
                  <>
                    <Button
                      onClick={() => onBulkToggleStatus(Array.from(selectedWebhooks), true)}
                      variant="secondary"
                      size="sm"
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <Play className="w-3 h-3" />
                      <span>Enable All</span>
                    </Button>
                    
                    <Button
                      onClick={() => onBulkToggleStatus(Array.from(selectedWebhooks), false)}
                      variant="secondary"
                      size="sm"
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <Pause className="w-3 h-3" />
                      <span>Disable All</span>
                    </Button>
                  </>
                )}
                
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
                  setSelectedWebhooks(new Set());
                  setSelectAll(false);
                }}
                className={`w-8 h-8 rounded-full hover:bg-accent border border flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-neutral/20 hover:scale-105`}
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

export default WebhookTable; 