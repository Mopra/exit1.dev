import React, { useState, useCallback, useMemo, useEffect } from 'react';
import ChecksTableShell from '../check/ChecksTableShell';
import { FolderGroupHeaderRow } from '../check/FolderGroupHeaderRow';
import { getDomainStatusBadge } from '../../hooks/useDomainIntelligence';
import {
  MoreVertical,
  Trash2,
  ExternalLink,
  Check,
  Settings,
  Globe,
  Plus,
  ChevronDown,
  Play,
  Loader2
} from 'lucide-react';
import {
  Button,
  EmptyState,
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  glassClasses,
  BulkActionsBar,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  Badge
} from '../ui';
import type { DomainIntelligenceItem } from '../../types';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { normalizeFolder } from '../../lib/folder-utils';
import { highlightText } from '../../utils/formatters.tsx';

interface DomainIntelligenceTableProps {
  domains: DomainIntelligenceItem[];
  onRefresh: (checkId: string) => void;
  onDisable: (checkId: string) => void;
  onBulkRefresh: (checkIds: string[]) => void;
  onBulkDisable: (checkIds: string[]) => void;
  onSettings: (domain: DomainIntelligenceItem) => void;
  onAddDomain?: () => void;
  searchQuery?: string;
  refreshInProgress?: string[];
  sortBy?: string; // Persistent sort preference from Firestore
  onSortChange?: (sortOption: string) => void; // Callback to update sort preference
}

type SortOption = 'expiryDate' | 'domain' | 'status' | 'lastChecked';

type DomainTableColumnKey =
  | 'status'
  | 'domain'
  | 'check'
  | 'registrar'
  | 'expiryDate'
  | 'lastChecked';

type DomainTableColumnVisibility = Record<DomainTableColumnKey, boolean>;

const DEFAULT_COLUMN_VISIBILITY: DomainTableColumnVisibility = {
  status: true,
  domain: true,
  check: true,
  registrar: true,
  expiryDate: true,
  lastChecked: true,
};

const DomainIntelligenceTable: React.FC<DomainIntelligenceTableProps> = ({
  domains,
  onRefresh,
  onDisable,
  onBulkRefresh,
  onBulkDisable,
  onSettings,
  onAddDomain,
  searchQuery = '',
  refreshInProgress = [],
  sortBy: sortByProp,
  onSortChange
}) => {
  // Use persistent sort preference from Firestore, fallback to 'expiryDate'
  const sortBy = (sortByProp as SortOption) || 'expiryDate';
  const [groupBy, setGroupBy] = useLocalStorage<'none' | 'folder'>('domain-intelligence-group-by-v1', 'none');
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);

  const [columnVisibility, setColumnVisibility] = useLocalStorage<DomainTableColumnVisibility>(
    'domain-intelligence-table-columns-v1',
    DEFAULT_COLUMN_VISIBILITY
  );

  const [collapsedFolders, setCollapsedFolders] = useLocalStorage<string[]>(
    'domain-intelligence-folder-collapsed-v1',
    []
  );
  const collapsedSet = useMemo(() => new Set(collapsedFolders), [collapsedFolders]);

  // Check if user has any domains with folders
  const hasFolders = useMemo(() => (
    domains.some((domain) => (domain.folder ?? '').trim().length > 0)
  ), [domains]);

  // Default: group by folder if the user already has folders
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const existing = window.localStorage.getItem('domain-intelligence-group-by-v1');
      if (existing === null) {
        if (hasFolders) {
          setGroupBy('folder');
        }
      }
    } catch {
      // ignore localStorage failures
    }
  }, [hasFolders, setGroupBy]);

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

  const toggleFolderCollapsed = useCallback((folderKey: string) => {
    setCollapsedFolders((prev) => {
      const set = new Set(prev);
      if (set.has(folderKey)) set.delete(folderKey);
      else set.add(folderKey);
      return Array.from(set);
    });
  }, [setCollapsedFolders]);

  const setColumnVisible = useCallback((key: DomainTableColumnKey, next: boolean) => {
    setColumnVisibility((prev) => ({
      ...prev,
      [key]: next,
    }));
  }, [setColumnVisibility]);

  // Calculate column count for FolderGroupHeaderRow
  const COL_COUNT =
    2 + // selection + actions (always visible)
    (columnVisibility.status ? 1 : 0) +
    (columnVisibility.domain ? 1 : 0) +
    (columnVisibility.check ? 1 : 0) +
    (columnVisibility.registrar ? 1 : 0) +
    (columnVisibility.expiryDate ? 1 : 0) +
    (columnVisibility.lastChecked ? 1 : 0);

  // Sort domains
  const sortedDomains = useMemo(() => {
    const sorted = [...domains];
    switch (sortBy) {
      case 'expiryDate':
        return sorted.sort((a, b) => {
          const aDays = a.daysUntilExpiry ?? Infinity;
          const bDays = b.daysUntilExpiry ?? Infinity;
          return aDays - bDays;
        });
      case 'domain':
        return sorted.sort((a, b) => a.domain.localeCompare(b.domain));
      case 'status':
        return sorted.sort((a, b) => {
          const statusOrder: Record<string, number> = { error: 0, expired: 1, expiring_soon: 2, active: 3, unknown: 4 };
          const aOrder = statusOrder[a.status] ?? 4;
          const bOrder = statusOrder[b.status] ?? 4;
          return aOrder - bOrder;
        });
      case 'lastChecked':
        return sorted.sort((a, b) => {
          const aTime = a.lastCheckedAt || 0;
          const bTime = b.lastCheckedAt || 0;
          return bTime - aTime;
        });
      default:
        return sorted;
    }
  }, [domains, sortBy]);

  // Group by folder
  const groupedByFolder = useMemo(() => {
    if (groupBy !== 'folder') return null;
    const map = new Map<string, DomainIntelligenceItem[]>();
    for (const d of sortedDomains) {
      const key = (d.folder ?? '').trim() || '__unsorted__';
      const list = map.get(key) ?? [];
      list.push(d);
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
      domains: map.get(key) ?? [],
    }));
  }, [groupBy, sortedDomains]);

  // Selection handlers
  const handleSelectAll = useCallback(() => {
    if (selectAll) {
      setSelectedDomains(new Set());
      setSelectAll(false);
    } else {
      setSelectedDomains(new Set(sortedDomains.map(d => d.checkId)));
      setSelectAll(true);
    }
  }, [selectAll, sortedDomains]);

  const handleSelectDomain = useCallback((checkId: string) => {
    const newSelected = new Set(selectedDomains);
    if (newSelected.has(checkId)) {
      newSelected.delete(checkId);
    } else {
      newSelected.add(checkId);
    }
    setSelectedDomains(newSelected);
    setSelectAll(newSelected.size === sortedDomains.length);
  }, [selectedDomains, sortedDomains.length]);

  const handleBulkRefresh = useCallback(() => {
    onBulkRefresh(Array.from(selectedDomains));
    setSelectedDomains(new Set());
    setSelectAll(false);
  }, [onBulkRefresh, selectedDomains]);

  const handleBulkDisable = useCallback(() => {
    onBulkDisable(Array.from(selectedDomains));
    setSelectedDomains(new Set());
    setSelectAll(false);
  }, [onBulkDisable, selectedDomains]);

  // Format helpers
  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatRelativeTime = (timestamp?: number) => {
    if (!timestamp) return '—';
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  };

  const isRefreshing = useCallback((checkId: string) => {
    return refreshInProgress.includes(checkId);
  }, [refreshInProgress]);

  // Mobile card for responsive view
  const MobileDomainCard = ({ domain }: { domain: DomainIntelligenceItem }) => {
    const badge = getDomainStatusBadge(domain.status, domain.daysUntilExpiry);
    
    return (
      <div className="p-4 rounded-lg border border-border bg-card">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={
                badge.variant === 'success' ? 'default' :
                badge.variant === 'info' ? 'secondary' :
                badge.variant === 'warning' ? 'warning' :
                badge.variant === 'danger' ? 'destructive' :
                'outline'
              }>
                {badge.label}
              </Badge>
            </div>
            <p className="font-medium truncate">{highlightText(domain.domain, searchQuery)}</p>
            <p className="text-sm text-muted-foreground truncate">{highlightText(domain.checkName, searchQuery)}</p>
            <div className="mt-2 text-xs text-muted-foreground space-y-1">
              <div>Expires: {formatDate(domain.expiryDate)}</div>
              <div>Last checked: {formatRelativeTime(domain.lastCheckedAt)}</div>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={glassClasses}>
              <DropdownMenuItem
                onClick={() => onRefresh(domain.checkId)}
                disabled={isRefreshing(domain.checkId)}
                className="cursor-pointer font-mono"
              >
                {isRefreshing(domain.checkId) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                <span className="ml-2">{isRefreshing(domain.checkId) ? 'Checking...' : 'Check now'}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => window.open(domain.checkUrl, '_blank', 'noopener,noreferrer')}
                className="cursor-pointer font-mono"
              >
                <ExternalLink className="w-3 h-3" />
                <span className="ml-2">Open URL</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onSettings(domain)}
                className="cursor-pointer font-mono"
              >
                <Settings className="w-3 h-3" />
                <span className="ml-2">Settings</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDisable(domain.checkId)}
                className="cursor-pointer font-mono text-destructive focus:text-destructive"
              >
                <Trash2 className="w-3 h-3" />
                <span className="ml-2">Disable DI</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  return (
    <>
      <ChecksTableShell
        mobile={(
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
                          <ChevronDown className="w-4 h-4 -rotate-90" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                        <span className="font-sans">{group.label}</span>
                      </span>
                      <span className="text-xs font-mono">{group.domains.length}</span>
                    </button>
                    {!collapsedSet.has(group.key) &&
                      group.domains.map((domain) => (
                        <MobileDomainCard key={domain.checkId} domain={domain} />
                      ))}
                  </div>
                ))
              : sortedDomains.map((domain) => (
                  <MobileDomainCard key={domain.checkId} domain={domain} />
                ))}

            {domains.length === 0 && (
              <EmptyState
                variant="empty"
                icon={Globe}
                title="No domains monitored yet"
                description="Enable Domain Intelligence for your checks to monitor domain expiration dates."
                action={onAddDomain ? {
                  label: "Enable for checks",
                  onClick: onAddDomain,
                  icon: Plus
                } : undefined}
              />
            )}
          </div>
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
                >
                  Group by
                  <ChevronDown className="ml-2 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={`${glassClasses} w-56`}>
                <DropdownMenuRadioGroup
                  value={groupBy}
                  onValueChange={(v) => setGroupBy(v as 'none' | 'folder')}
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
                  checked={columnVisibility.status}
                  onCheckedChange={(checked) => setColumnVisible('status', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Status
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.domain}
                  onCheckedChange={(checked) => setColumnVisible('domain', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Domain
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.check}
                  onCheckedChange={(checked) => setColumnVisible('check', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Check
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.registrar}
                  onCheckedChange={(checked) => setColumnVisible('registrar', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Registrar
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.expiryDate}
                  onCheckedChange={(checked) => setColumnVisible('expiryDate', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Expiry Date
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={columnVisibility.lastChecked}
                  onCheckedChange={(checked) => setColumnVisible('lastChecked', checked === true)}
                  className="cursor-pointer font-mono"
                >
                  Last Checked
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        table={(
          <Table style={{ tableLayout: 'fixed' }}>
            <TableHeader className="bg-muted border-b">
              <TableRow>
                <TableHead className="px-3 py-4 text-left w-12">
                  <div className="flex items-center justify-center">
                    <button
                      onClick={handleSelectAll}
                      className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectAll ? 'border bg-background' : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                      title={selectAll ? 'Deselect all' : 'Select all'}
                    >
                      {selectAll && (
                        <Check className="w-2.5 h-2.5 text-white" />
                      )}
                    </button>
                  </div>
                </TableHead>
                {columnVisibility.status && (
                  <TableHead className="px-4 py-4 text-left w-28">
                    <button
                      onClick={() => onSortChange?.(sortBy === 'status' ? 'expiryDate' : 'status')}
                      className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      Status
                    </button>
                  </TableHead>
                )}
                {columnVisibility.domain && (
                  <TableHead className="px-4 py-4 text-left w-64">
                    <button
                      onClick={() => onSortChange?.(sortBy === 'domain' ? 'expiryDate' : 'domain')}
                      className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      Domain
                    </button>
                  </TableHead>
                )}
                {columnVisibility.check && (
                  <TableHead className="px-4 py-4 text-left w-48">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Check
                    </div>
                  </TableHead>
                )}
                {columnVisibility.registrar && (
                  <TableHead className="px-4 py-4 text-left w-40">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Registrar
                    </div>
                  </TableHead>
                )}
                {columnVisibility.expiryDate && (
                  <TableHead className="px-4 py-4 text-left w-36">
                    <button
                      onClick={() => onSortChange?.('expiryDate')}
                      className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      Expiry Date
                    </button>
                  </TableHead>
                )}
                {columnVisibility.lastChecked && (
                  <TableHead className="px-4 py-4 text-left w-32">
                    <button
                      onClick={() => onSortChange?.(sortBy === 'lastChecked' ? 'expiryDate' : 'lastChecked')}
                      className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      Last Checked
                    </button>
                  </TableHead>
                )}
                <TableHead className="px-4 py-4 text-center w-28">
                  <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                    Actions
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-border">
              {(groupBy === 'folder' && groupedByFolder
                ? groupedByFolder.flatMap((group) => {
                    const isCollapsed = collapsedSet.has(group.key);
                    const groupColor = group.key === '__unsorted__' ? undefined : getFolderColor(group.key);
                    const header = (
                      <React.Fragment key={`group-${group.key}`}>
                        <FolderGroupHeaderRow
                          colSpan={COL_COUNT}
                          label={group.label}
                          count={group.domains.length}
                          isCollapsed={isCollapsed}
                          onToggle={() => toggleFolderCollapsed(group.key)}
                          color={groupColor}
                        />
                      </React.Fragment>
                    );

                    if (isCollapsed) return [header];
                    const rows = group.domains.map((domain) => ({ domain }));
                    return [header, ...rows];
                  })
                : sortedDomains.map((domain) => ({ domain }))
              ).map((item: any) => {
                if (!('domain' in item)) return item as React.ReactNode;
                const domain: DomainIntelligenceItem = item.domain;
                const badge = getDomainStatusBadge(domain.status, domain.daysUntilExpiry);

                return (
                  <TableRow key={domain.checkId} className="hover:bg-muted/50 transition-colors group">
                    <TableCell className="px-4 py-4">
                      <div className="flex items-center justify-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectDomain(domain.checkId);
                          }}
                          className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectedDomains.has(domain.checkId) ? 'border bg-background' : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                          title={selectedDomains.has(domain.checkId) ? 'Deselect' : 'Select'}
                        >
                          {selectedDomains.has(domain.checkId) && (
                            <Check className="w-2.5 h-2.5 text-white" />
                          )}
                        </button>
                      </div>
                    </TableCell>
                    {columnVisibility.status && (
                      <TableCell className="px-4 py-4">
                        <Badge variant={
                          badge.variant === 'success' ? 'default' :
                          badge.variant === 'info' ? 'secondary' :
                          badge.variant === 'warning' ? 'warning' :
                          badge.variant === 'danger' ? 'destructive' :
                          'outline'
                        }>
                          {badge.label}
                        </Badge>
                      </TableCell>
                    )}
                    {columnVisibility.domain && (
                      <TableCell className="px-4 py-4 max-w-0">
                        <span className="font-medium font-sans text-foreground text-sm truncate block">
                          {highlightText(domain.domain, searchQuery)}
                        </span>
                      </TableCell>
                    )}
                    {columnVisibility.check && (
                      <TableCell className="px-4 py-4 max-w-0">
                        <span className="text-sm font-mono text-muted-foreground truncate block">
                          {highlightText(domain.checkName, searchQuery)}
                        </span>
                      </TableCell>
                    )}
                    {columnVisibility.registrar && (
                      <TableCell className="px-4 py-4 max-w-0">
                        <span className="text-sm font-mono text-muted-foreground truncate block">
                          {domain.registrar || '—'}
                        </span>
                      </TableCell>
                    )}
                    {columnVisibility.expiryDate && (
                      <TableCell className="px-4 py-4">
                        <span className="text-sm font-mono text-muted-foreground">
                          {formatDate(domain.expiryDate)}
                        </span>
                      </TableCell>
                    )}
                    {columnVisibility.lastChecked && (
                      <TableCell className="px-4 py-4">
                        <span className="text-sm font-mono text-muted-foreground">
                          {formatRelativeTime(domain.lastCheckedAt)}
                        </span>
                      </TableCell>
                    )}
                    <TableCell className="px-4 py-4">
                      <div className="flex items-center justify-center">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className={`${glassClasses} z-[55]`}>
                            <DropdownMenuItem
                              onClick={() => onRefresh(domain.checkId)}
                              disabled={isRefreshing(domain.checkId)}
                              className="cursor-pointer font-mono"
                            >
                              {isRefreshing(domain.checkId) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              <span className="ml-2">{isRefreshing(domain.checkId) ? 'Checking...' : 'Check now'}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => window.open(domain.checkUrl, '_blank', 'noopener,noreferrer')}
                              className="cursor-pointer font-mono"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span className="ml-2">Open URL</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => onSettings(domain)}
                              className="cursor-pointer font-mono"
                            >
                              <Settings className="w-3 h-3" />
                              <span className="ml-2">Settings</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => onDisable(domain.checkId)}
                              className="cursor-pointer font-mono text-destructive focus:text-destructive"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span className="ml-2">Disable DI</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        hasRows={domains.length > 0}
        emptyState={searchQuery ? (
          <EmptyState
            variant="search"
            title="No domains found"
            description={`No domains match your search for "${searchQuery}". Try adjusting your search terms.`}
          />
        ) : (
          <EmptyState
            variant="empty"
            icon={Globe}
            title="No domains monitored yet"
            description="Enable Domain Intelligence for your checks to monitor domain expiration dates and receive alerts."
            action={onAddDomain ? {
              label: "Enable for checks",
              onClick: onAddDomain,
              icon: Plus
            } : undefined}
          />
        )}
      />

      <BulkActionsBar
        selectedCount={selectedDomains.size}
        totalCount={sortedDomains.length}
        onClearSelection={() => {
          setSelectedDomains(new Set());
          setSelectAll(false);
        }}
        itemLabel="domain"
        actions={[
          {
            label: 'Check now',
            icon: <Play className="w-3 h-3" />,
            onClick: handleBulkRefresh,
            variant: 'ghost',
          },
          {
            label: 'Disable DI',
            onClick: handleBulkDisable,
            isDelete: true,
          },
        ]}
      />
    </>
  );
};

export default DomainIntelligenceTable;
