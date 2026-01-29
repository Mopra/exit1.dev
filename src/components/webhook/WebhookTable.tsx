import React, { useState, useCallback } from 'react';
import { CheckCircle, Copy, ExternalLink, HelpCircle, Edit, Trash2, Play, MoreVertical, Check, Pause, Loader2, SortAsc, SortDesc, ArrowUpDown, AlertTriangle } from 'lucide-react';
import { Badge, EmptyState, IconButton, ConfirmationModal, Checkbox, Table, TableHeader, TableBody, TableHead, TableRow, TableCell, BulkActionsBar, Switch, Tooltip, TooltipContent, TooltipTrigger, GlowCard, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, glassClasses } from '../ui';
import { WEBHOOK_EVENTS } from '../../lib/webhook-events';

import { formatCreatedAt, highlightText } from '../../utils/formatters.tsx';
import ChecksTableShell from '../check/ChecksTableShell';

interface WebhookSettings {
  id: string;
  url: string;
  name: string;
  enabled: boolean;
  events: string[];
  checkFilter?: { mode: 'all' | 'include'; checkIds?: string[] };
  secret?: string;
  headers?: { [key: string]: string };
  createdAt: number;
  updatedAt: number;
  lastDeliveryStatus?: 'success' | 'failed' | 'permanent_failure';
  lastDeliveryAt?: number;
  lastError?: string;
  lastErrorAt?: number;
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
  onToggleEvent?: (id: string, event: string) => void;
  testingWebhook: string | null;
  testResult: TestResult | null;
  searchQuery?: string;
  onAddFirstWebhook?: () => void;
  optimisticUpdates?: string[];
  sortBy?: string; // Persistent sort preference from Firestore
  onSortChange?: (sortOption: string) => void; // Callback to update sort preference
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
  onToggleEvent,
  testingWebhook,
  testResult,
  searchQuery = '',
  onAddFirstWebhook,
  optimisticUpdates = [],
  sortBy: sortByProp,
  onSortChange
}) => {
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  // Use persistent sort preference from Firestore, fallback to 'createdAt'
  const sortBy = (sortByProp as SortOption) || 'createdAt';
  const [selectedWebhooks, setSelectedWebhooks] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [deletingWebhook, setDeletingWebhook] = useState<WebhookSettings | null>(null);
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  

  // Helper function to check if a webhook is being optimistically updated
  const isOptimisticallyUpdating = useCallback((webhookId: string) => {
    return optimisticUpdates.includes(webhookId);
  }, [optimisticUpdates]);
  
  // Event types sourced from WEBHOOK_EVENTS (shared)

  const getCheckTargetLabel = useCallback((webhook: WebhookSettings) => {
    const filter = webhook.checkFilter;
    if (!filter || filter.mode !== 'include' || !filter.checkIds || filter.checkIds.length === 0) {
      return 'All checks';
    }
    const count = filter.checkIds.length;
    return `${count} ${count === 1 ? 'check' : 'checks'}`;
  }, []);

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
    if (onSortChange) {
      onSortChange(newSort);
    }
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

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedWebhooks(new Set(sortedWebhooks().map(w => w.id)));
      setSelectAll(true);
    } else {
      setSelectedWebhooks(new Set());
      setSelectAll(false);
    }
  };

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
      <ChecksTableShell
        mobile={(
          <>
            <div className="space-y-3">
              {sortedWebhooks().map((webhook) => (
                <GlowCard key={webhook.id} className={`relative p-0 ${!webhook.enabled ? 'opacity-50' : ''} ${isOptimisticallyUpdating(webhook.id) ? 'animate-pulse' : ''}`}>
                  <div className={`p-4 space-y-3`}>
                    {/* Header Row */}
                    <div className="flex items-start justify-between gap-3">
                      {/* Selection Checkbox */}
                      <Checkbox
                        checked={selectedWebhooks.has(webhook.id)}
                        onCheckedChange={() => handleSelectWebhook(webhook.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 cursor-pointer"
                        title={selectedWebhooks.has(webhook.id) ? 'Deselect' : 'Select'}
                      />

                      {/* Status */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Switch
                          checked={webhook.enabled}
                          onCheckedChange={(v) => onToggleStatus?.(webhook.id, v)}
                          className="cursor-pointer scale-75 origin-right"
                        />
                      </div>

                {/* Actions Menu */}
                <div className="pointer-events-auto flex-shrink-0">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        icon={<MoreVertical className="w-4 h-4" />}
                        size="sm"
                        variant="ghost"
                        aria-label="More actions"
                        aria-haspopup="menu"
                        className={`text-muted-foreground hover:text-primary hover:bg-primary/10 pointer-events-auto p-2 transition-colors cursor-pointer`}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className={`${glassClasses} z-[55]`}>
                      <DropdownMenuItem
                        onClick={() => onTest(webhook.id)}
                        disabled={testingWebhook === webhook.id}
                        className="cursor-pointer font-mono"
                        title={testingWebhook === webhook.id ? 'Test in progress...' : 'Test webhook'}
                      >
                        {testingWebhook === webhook.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        <span className="ml-2">{testingWebhook === webhook.id ? 'Testing...' : 'Test webhook'}</span>
                      </DropdownMenuItem>
                      {onToggleStatus && (
                        <DropdownMenuItem
                          onClick={() => onToggleStatus(webhook.id, !webhook.enabled)}
                          className="cursor-pointer font-mono"
                        >
                          {webhook.enabled ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                          <span className="ml-2">{webhook.enabled ? 'Disable' : 'Enable'}</span>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => window.open(webhook.url, '_blank', 'noopener,noreferrer')}
                        className="cursor-pointer font-mono"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span className="ml-2">Open URL</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => copyToClipboard(webhook.url, webhook.id)}
                        className="cursor-pointer font-mono"
                      >
                        {copiedUrl === webhook.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        <span className="ml-2">{copiedUrl === webhook.id ? 'Copied!' : 'Copy URL'}</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => onEdit(webhook)}
                        className="cursor-pointer font-mono"
                      >
                        <Edit className="w-3 h-3" />
                        <span className="ml-2">Edit</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleDeleteClick(webhook)}
                        className="cursor-pointer font-mono text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span className="ml-2">Delete</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
                        {WEBHOOK_EVENTS.map((e) => {
                          const isOn = webhook.events.includes(e.value);
                          const isActive = isOn;
                          const Icon = e.icon;
                          return (
                            <Badge 
                              key={e.value}
                              variant={isActive && webhook.enabled ? e.badgeVariant as any : "outline"} 
                              className={`text-xs px-2 py-1 cursor-pointer transition-all ${!webhook.enabled || !isActive ? 'opacity-50' : ''} ${isActive && webhook.enabled ? '' : 'hover:opacity-100'}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                onToggleEvent?.(webhook.id, e.value);
                              }}
                            >
                              <Icon className="w-3 h-3 mr-1" />
                              {e.label}
                            </Badge>
                          );
                        })}
                      </div>

                      {/* Health Status */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">Health:</span>
                        {webhook.lastDeliveryStatus === 'permanent_failure' ? (
                          <Badge variant="destructive" className="text-xs px-2 py-0.5 gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            Failed - {webhook.lastError || 'URL invalid/deleted'}
                          </Badge>
                        ) : webhook.lastDeliveryStatus === 'failed' ? (
                          <Badge variant="warning" className="text-xs px-2 py-0.5 gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            Warning - Retrying
                          </Badge>
                        ) : webhook.lastDeliveryStatus === 'success' ? (
                          <Badge variant="success" className="text-xs px-2 py-0.5 gap-1">
                            <CheckCircle className="w-3 h-3" />
                            Healthy
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs px-2 py-0.5 gap-1">
                            <HelpCircle className="w-3 h-3" />
                            Unknown
                          </Badge>
                        )}
                      </div>

                      <div className="text-xs text-muted-foreground">
                        Checks: {getCheckTargetLabel(webhook)}
                      </div>

                      {/* Created Date */}
                      <div className={`text-xs font-mono text-muted-foreground`}>
                        Created {formatCreatedAt(webhook.createdAt)}
                      </div>
                    </div>
                  </div>
                </GlowCard>
              ))}
            </div>
            
            {webhooks.length === 0 && (
              <div className="">
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
          </>
        )}
        table={(
          <Table>
              <TableHeader className="bg-muted border-b">
                <TableRow>
                  <TableHead className="px-3 py-4 text-left w-12">
                    <Checkbox
                      checked={selectAll}
                      onCheckedChange={handleSelectAll}
                      className="cursor-pointer"
                    />
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-12">
                    <button
                      onClick={() => handleSortChange(sortBy === 'status' ? 'createdAt' : 'status')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Status
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-28">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Health
                    </div>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-64">
                    <button
                      onClick={() => handleSortChange(sortBy === 'name-asc' ? 'name-desc' : 'name-asc')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Name & URL
                      {sortBy === 'name-asc' ? <SortDesc className="w-3 h-3" /> : sortBy === 'name-desc' ? <SortAsc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left">
                    <button
                      onClick={() => handleSortChange(sortBy === 'events' ? 'createdAt' : 'events')}
                      className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                    >
                      Alert Types
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
                  <TableHead className="px-4 py-4 text-left w-40">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Checks
                    </div>
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
                  <TableRow key={webhook.id} className={`hover:bg-muted/50 transition-all duration-200 ${isOptimisticallyUpdating(webhook.id) ? 'animate-pulse bg-accent' : ''} group cursor-pointer`}>
                    <TableCell className={`px-4 py-4`}>
                      <Checkbox
                        checked={selectedWebhooks.has(webhook.id)}
                        onCheckedChange={() => handleSelectWebhook(webhook.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="cursor-pointer"
                      />
                    </TableCell>
                    <TableCell className={`px-4 py-4`}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={webhook.enabled}
                              onCheckedChange={(v) => onToggleStatus?.(webhook.id, v)}
                              className="cursor-pointer"
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{webhook.enabled ? 'Enabled' : 'Disabled'}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className={`px-4 py-4`}>
                      {webhook.lastDeliveryStatus === 'permanent_failure' ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="destructive" className="text-xs px-2 py-0.5 gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              Failed
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="font-semibold mb-1">Permanent Failure</p>
                            <p className="text-xs">{webhook.lastError || 'Webhook URL is invalid or deleted'}</p>
                            {webhook.lastErrorAt && (
                              <p className="text-xs mt-1 text-muted-foreground">
                                {new Date(webhook.lastErrorAt).toLocaleString()}
                              </p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      ) : webhook.lastDeliveryStatus === 'failed' ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="warning" className="text-xs px-2 py-0.5 gap-1">
                              <AlertTriangle className="w-3 h-3" />
                              Warning
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="font-semibold mb-1">Temporary Failure</p>
                            <p className="text-xs">{webhook.lastError || 'Retrying delivery...'}</p>
                            {webhook.lastErrorAt && (
                              <p className="text-xs mt-1 text-muted-foreground">
                                {new Date(webhook.lastErrorAt).toLocaleString()}
                              </p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      ) : webhook.lastDeliveryStatus === 'success' ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="success" className="text-xs px-2 py-0.5 gap-1">
                              <CheckCircle className="w-3 h-3" />
                              Healthy
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Last delivery successful</p>
                            {webhook.lastDeliveryAt && (
                              <p className="text-xs text-muted-foreground">
                                {new Date(webhook.lastDeliveryAt).toLocaleString()}
                              </p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <Badge variant="outline" className="text-xs px-2 py-0.5 gap-1">
                          <HelpCircle className="w-3 h-3" />
                          Unknown
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className={`px-4 py-4 ${!webhook.enabled ? 'opacity-50' : ''}`}>
                      <div className="flex flex-col">
                        <div className={`font-medium font-sans text-foreground group-hover:text-primary transition-colors duration-150 flex items-center gap-2 text-sm`}>
                          {highlightText(webhook.name, searchQuery)}
                        </div>
                        <div className={`text-sm font-mono text-muted-foreground truncate max-w-xs`}>
                          {highlightText(webhook.url, searchQuery)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Checks: {getCheckTargetLabel(webhook)}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className={`px-4 py-4`}>
                      <div className="flex flex-wrap gap-1">
                        {WEBHOOK_EVENTS.map((e) => {
                          const isOn = webhook.events.includes(e.value);
                          // If webhook is enabled, show active color if event is ON.
                          // If webhook is disabled, everything is dimmed (via opacity-50 on parent or specific logic).
                          // Emails page logic: If Check is disabled, everything is dimmed. Clicking enables check.
                          // If Check is enabled, clicking event toggles it.
                          
                          const isActive = isOn; 
                          const Icon = e.icon;
                          
                          return (
                            <Badge
                              key={e.value}
                              variant={isActive && webhook.enabled ? e.badgeVariant as any : "outline"}
                              className={`text-xs px-2 py-0.5 cursor-pointer transition-all hover:opacity-80 ${!webhook.enabled || !isActive ? 'opacity-50' : ''} ${isActive && webhook.enabled ? '' : 'hover:opacity-100'}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                onToggleEvent?.(webhook.id, e.value);
                              }}
                              title={!webhook.enabled ? "Enable webhook first" : `Click to ${isOn ? 'disable' : 'enable'} ${e.label}`}
                            >
                              <Icon className="w-3 h-3 mr-1" />
                              {e.label}
                            </Badge>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className={`px-4 py-4 ${!webhook.enabled ? 'opacity-50' : ''}`}>
                      <div className={`text-sm font-mono text-muted-foreground`}>
                        {formatCreatedAt(webhook.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell className={`px-4 py-4 ${!webhook.enabled ? 'opacity-50' : ''}`}>
                      <div className="text-xs text-muted-foreground">
                        {getCheckTargetLabel(webhook)}
                      </div>
                    </TableCell>
                    <TableCell className={`px-4 py-4 ${!webhook.enabled ? 'opacity-50' : ''}`}>
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
                              onClick={() => onTest(webhook.id)}
                              disabled={testingWebhook === webhook.id}
                              className="cursor-pointer font-mono"
                              title={testingWebhook === webhook.id ? 'Test in progress...' : 'Test webhook'}
                            >
                              {testingWebhook === webhook.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              <span className="ml-2">{testingWebhook === webhook.id ? 'Testing...' : 'Test webhook'}</span>
                            </DropdownMenuItem>
                            {onToggleStatus && (
                              <DropdownMenuItem
                                onClick={() => onToggleStatus(webhook.id, !webhook.enabled)}
                                className="cursor-pointer font-mono"
                              >
                                {webhook.enabled ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                                <span className="ml-2">{webhook.enabled ? 'Disable' : 'Enable'}</span>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onClick={() => window.open(webhook.url, '_blank', 'noopener,noreferrer')}
                              className="cursor-pointer font-mono"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span className="ml-2">Open URL</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => copyToClipboard(webhook.url, webhook.id)}
                              className="cursor-pointer font-mono"
                            >
                              {copiedUrl === webhook.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                              <span className="ml-2">{copiedUrl === webhook.id ? 'Copied!' : 'Copy URL'}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => onEdit(webhook)}
                              className="cursor-pointer font-mono"
                            >
                              <Edit className="w-3 h-3" />
                              <span className="ml-2">Edit</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDeleteClick(webhook)}
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
                ))}
              </TableBody>
          </Table>
        )}
        hasRows={sortedWebhooks().length > 0}
        emptyState={searchQuery ? (
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
      />

      {/* Test Result Display */}
      {testResult && testingWebhook === null && (
        <div className={`p-4 sm:p-6 rounded-lg border ${testResult.success 
          ? 'bg-primary/10 border-primary/20' 
          : 'bg-destructive/10 border-destructive/20'
        }`}>
          <div className="flex items-center gap-3">
                         {testResult.success ? <CheckCircle className={`w-4 h-4 sm:w-5 sm:h-5 text-primary`} /> : <AlertTriangle className={`w-4 h-4 sm:w-5 sm:h-5 text-destructive`} />}
            <div className="flex-1">
              <p className={`font-medium text-sm sm:text-base ${testResult.success ? 'text-primary' : 'text-destructive'}`}>
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

      <BulkActionsBar
        selectedCount={selectedWebhooks.size}
        totalCount={sortedWebhooks().length}
        onClearSelection={() => {
          setSelectedWebhooks(new Set());
          setSelectAll(false);
        }}
        itemLabel="webhook"
        actions={[
          ...(onBulkToggleStatus ? [
            {
              label: 'Enable',
              icon: <Play className="w-3 h-3" />,
              onClick: () => onBulkToggleStatus(Array.from(selectedWebhooks), true),
              variant: 'ghost' as const,
            },
            {
              label: 'Disable',
              icon: <Pause className="w-3 h-3" />,
              onClick: () => onBulkToggleStatus(Array.from(selectedWebhooks), false),
              variant: 'ghost' as const,
            },
          ] : []),
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

export default WebhookTable; 