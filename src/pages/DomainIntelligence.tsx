import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { PageHeader, PageContainer, DocsLink } from '../components/layout';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import { Button, Input, SearchInput, FeatureGate } from '../components/ui';
import EmptyState from '../components/ui/EmptyState';
import { GlowCard } from '../components/ui/glow-card';
import { useDomainIntelligence } from '../hooks/useDomainIntelligence';
import { usePlan } from '@/hooks/usePlan';
import { useChecks } from '../hooks/useChecks';
import { useUserPreferences } from '../hooks/useUserPreferences';
import { DomainIntelligenceTable } from '../components/domain-intelligence';
import {
  FileBadge,
  Globe,
  RefreshCw,
  Plus,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Info,
  X,
  Folder as FolderIcon,
  ChevronRight,
  Pencil,
  Loader2
} from 'lucide-react';
import { toast } from 'sonner';
import type { DomainIntelligenceItem } from '../types';
import { cn } from '@/lib/utils';
import { normalizeFolder, getFolderName, getFolderTheme } from '@/lib/folder-utils';
import { formatLongDate, formatRelativeTime } from '@/lib/format-date';
import { useLocalStorage } from '../hooks/useLocalStorage';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/Badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

const DomainIntelligence: React.FC = () => {
  const { userId } = useAuth();
  const { tier, nano, isLoading: tierLoading } = usePlan();
  const { preferences, updateSorting } = useUserPreferences(userId);
  const [searchQuery, setSearchQuery] = useState('');
  const [rateLimitNoticeDismissed, setRateLimitNoticeDismissed] = useLocalStorage('domain-intel-rate-limit-notice-dismissed', false);
  const [showEnableModal, setShowEnableModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<DomainIntelligenceItem | null>(null);

  const {
    domains,
    stats,
    loading,
    disableDomainExpiry,
    updateDomainExpiry,
    refreshDomainExpiry,
    bulkEnableDomainExpiry,
    bulkDisableDomainExpiry,
    bulkRefreshDomainExpiry,
    refreshInProgress
  } = useDomainIntelligence(userId ?? null);

  const enabledCheckIds = useMemo(() => new Set(domains.map(d => d.checkId)), [domains]);

  // Filter domains based on search
  const filteredDomains = useMemo(() => {
    if (!searchQuery.trim()) return domains;
    const query = searchQuery.toLowerCase();
    return domains.filter(d => 
      d.domain.toLowerCase().includes(query) ||
      d.checkName.toLowerCase().includes(query) ||
      d.registrar?.toLowerCase().includes(query)
    );
  }, [domains, searchQuery]);
  
  // Handle refresh
  const handleRefresh = async (checkId: string) => {
    const domain = domains.find(d => d.checkId === checkId);
    const name = domain?.domain || domain?.checkName || checkId;
    const result = await refreshDomainExpiry(checkId);
    if (result.success) {
      toast.success(`${name}: Domain data refreshed`);
    } else {
      toast.error(`${name}: ${result.error || 'Failed to refresh'}`);
    }
  };
  
  // Handle disable
  const handleDisable = async (checkId: string) => {
    const domain = domains.find(d => d.checkId === checkId);
    const name = domain?.domain || domain?.checkName || checkId;
    const result = await disableDomainExpiry(checkId);
    if (result.success) {
      toast.success(`${name}: Domain Intelligence disabled`);
    } else {
      toast.error(`${name}: ${result.error || 'Failed to disable'}`);
    }
  };
  
  // Handle bulk actions
  const handleBulkRefresh = async (checkIds: string[]) => {
    const result = await bulkRefreshDomainExpiry(checkIds);

    if (result.success) {
      toast.success(`Refreshed ${checkIds.length} domain(s)`);
    } else if (result.results) {
      const successes = result.results.filter(r => r.success);
      const failures = result.results.filter(r => !r.success);

      if (successes.length > 0) {
        toast.success(`Refreshed ${successes.length} domain(s)`);
      }

      failures.forEach(failure => {
        const domain = domains.find(d => d.checkId === failure.checkId);
        const name = domain?.domain || domain?.checkName || failure.checkId;
        toast.error(`${name}: ${failure.error}`);
      });
    } else {
      toast.error(result.error || 'Failed to refresh');
    }
  };
  
  const handleBulkDisable = async (checkIds: string[]) => {
    const result = await bulkDisableDomainExpiry(checkIds);

    if (result.success) {
      toast.success(`Disabled Domain Intelligence for ${checkIds.length} domain(s)`);
    } else if (result.results) {
      const successes = result.results.filter(r => r.success);
      const failures = result.results.filter(r => !r.success);

      if (successes.length > 0) {
        toast.success(`Disabled Domain Intelligence for ${successes.length} domain(s)`);
      }

      failures.forEach(failure => {
        const domain = domains.find(d => d.checkId === failure.checkId);
        const name = domain?.domain || domain?.checkName || failure.checkId;
        toast.error(`${name}: ${failure.error}`);
      });
    } else {
      toast.error(result.error || 'Failed to disable');
    }
  };
  
  // Handle settings
  const handleSettings = (domain: DomainIntelligenceItem) => {
    setSelectedDomain(domain);
    setShowSettingsModal(true);
  };
  
  // Loading state
  if (loading || tierLoading) {
    return (
      <PageContainer>
        <PageHeader
          title="Domain Intelligence"
          description="Monitor domain expiration dates"
          icon={FileBadge}
          actions={<DocsLink path="/domain-intelligence" label="Domain intelligence docs" />}
        />
        <LoadingSkeleton />
      </PageContainer>
    );
  }
  
  // Non-Nano users see upgrade prompt
  if (!nano) {
    return (
      <PageContainer>
        <PageHeader
          title="Domain Intelligence"
          description="Monitor domain expiration dates"
          icon={FileBadge}
          actions={<DocsLink path="/domain-intelligence" label="Domain intelligence docs" />}
        />
        <FeatureGate
          requiredTier="nano"
          currentTier={tier}
          title="Domain Intelligence"
          description="Monitor domain expiration dates and get alerts before your domains expire. Upgrade to Nano to enable Domain Intelligence."
          ctaLabel="Upgrade to Nano"
        >
          {null}
        </FeatureGate>
      </PageContainer>
    );
  }

  // Empty state
  if (domains.length === 0) {
    return (
      <PageContainer>
        <PageHeader
          title="Domain Intelligence"
          description="Monitor domain expiration dates"
          icon={FileBadge}
          actions={<DocsLink path="/domain-intelligence" label="Domain intelligence docs" />}
        />
        <EmptyState
          icon={Globe}
          title="No domains monitored yet"
          description="Enable Domain Intelligence for your checks to monitor domain expiration dates and receive alerts."
          action={{
            label: 'Enable for checks',
            onClick: () => setShowEnableModal(true),
            icon: Plus
          }}
        />
        
        {showEnableModal && (
          <EnableDomainModal
            onClose={() => setShowEnableModal(false)}
            userId={userId!}
            enabledCheckIds={enabledCheckIds}
            bulkEnableDomainExpiry={bulkEnableDomainExpiry}
          />
        )}
      </PageContainer>
    );
  }
  
  return (
    <PageContainer>
      <PageHeader
        title="Domain Intelligence"
        description="Monitor domain expiration dates"
        icon={FileBadge}
        actions={
          <div className="flex items-center gap-2">
            <DocsLink path="/domain-intelligence" label="Domain intelligence docs" />
            <Button onClick={() => setShowEnableModal(true)} size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Enable for checks
            </Button>
          </div>
        }
      />
      
      {/* Content */}
      <div className="flex-1 p-2 sm:p-4 md:p-6 min-h-0 max-w-full overflow-x-hidden">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard 
            label="Total" 
            value={stats.total} 
            icon={Globe}
            variant="default"
          />
          <StatCard 
            label="Expiring Soon" 
            value={stats.expiringSoon} 
            icon={AlertTriangle}
            variant={stats.expiringSoon > 0 ? 'warning' : 'default'}
          />
          <StatCard 
            label="Healthy" 
            value={stats.healthy} 
            icon={CheckCircle}
            variant="success"
          />
          <StatCard 
            label="Errors" 
            value={stats.errors} 
            icon={XCircle}
            variant={stats.errors > 0 ? 'danger' : 'default'}
          />
        </div>
        
        {/* Rate limit notice */}
        {!rateLimitNoticeDismissed && (
          <Alert className="mb-6 relative">
            <Info className="h-4 w-4" />
            <AlertDescription className="pr-8">
              <p>
                Bulk checking may hit rate limits on some RDAP and WHOIS servers. Please be patient and retry if errors occur. Need help? Join our{' '}
                <a
                  href="https://discord.com/invite/uZvWbpwJZS"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >Discord</a>.
              </p>
            </AlertDescription>
            <button
              onClick={() => setRateLimitNoticeDismissed(true)}
              className="absolute top-1/2 -translate-y-1/2 right-3 rounded-sm opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 p-1"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4 text-foreground" />
            </button>
          </Alert>
        )}

        {/* Search */}
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search domains..."
          className="!p-0 !pb-4"
        />
        
        {/* Domain Table */}
        <DomainIntelligenceTable
        domains={filteredDomains}
        onRefresh={handleRefresh}
        onDisable={handleDisable}
        onBulkRefresh={handleBulkRefresh}
        onBulkDisable={handleBulkDisable}
        onSettings={handleSettings}
        onAddDomain={() => setShowEnableModal(true)}
        searchQuery={searchQuery}
        refreshInProgress={refreshInProgress}
        sortBy={preferences?.sorting?.domainIntelligence}
        onSortChange={(sortOption) => updateSorting('domainIntelligence', sortOption)}
        />
      </div>
      
      {showEnableModal && (
        <EnableDomainModal
          onClose={() => setShowEnableModal(false)}
          userId={userId!}
          enabledCheckIds={enabledCheckIds}
          bulkEnableDomainExpiry={bulkEnableDomainExpiry}
        />
      )}

      {/* Settings Panel */}
      <DomainSettingsPanel
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
        domain={selectedDomain}
        onUpdateThresholds={updateDomainExpiry}
      />
    </PageContainer>
  );
};

// Stat Card Component
interface StatCardProps {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const StatCard: React.FC<StatCardProps> = ({ label, value, icon: Icon, variant = 'default' }) => {
  const variantStyles = {
    default: 'text-muted-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive'
  };
  
  return (
    <GlowCard className="p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className={cn("text-2xl font-bold", variantStyles[variant])}>{value}</p>
        </div>
        <Icon className={cn("w-8 h-8 opacity-50", variantStyles[variant])} />
      </div>
    </GlowCard>
  );
};

// Enable Domain Modal (self-contained — mounts only when open)
interface EnableDomainModalProps {
  onClose: () => void;
  userId: string;
  enabledCheckIds: Set<string>;
  bulkEnableDomainExpiry: (checkIds: string[]) => Promise<{
    success: boolean;
    error?: string;
    results?: Array<{ checkId: string; success: boolean; error?: string; domain?: string }>;
  }>;
}

const EnableDomainModal: React.FC<EnableDomainModalProps> = ({
  onClose,
  userId,
  enabledCheckIds,
  bulkEnableDomainExpiry,
}) => {
  const log = useCallback((_msg: string) => {}, []);
  const { checks } = useChecks(userId, log, { realtime: true });
  const [checksToEnable, setChecksToEnable] = useState<Set<string>>(new Set());
  const [enabling, setEnabling] = useState(false);
  const [modalSearchQuery, setModalSearchQuery] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [folderColors] = useLocalStorage<Record<string, string>>('checks-folder-view-colors-v1', {});

  const availableChecks = useMemo(() => {
    const isIpAddress = (url: string) => {
      try {
        const hostname = new URL(url).hostname;
        return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
      } catch {
        return /^\d{1,3}(\.\d{1,3}){3}(:|\/|$)/.test(url);
      }
    };
    return checks.filter(c => !enabledCheckIds.has(c.id) && !isIpAddress(c.url));
  }, [checks, enabledCheckIds]);

  const handleEnableSelected = async () => {
    if (checksToEnable.size === 0) return;

    setEnabling(true);
    const result = await bulkEnableDomainExpiry(Array.from(checksToEnable));
    setEnabling(false);

    if (result.success && result.results) {
      const successCount = result.results.filter(r => r.success).length;
      const failures = result.results.filter(r => !r.success);

      if (successCount > 0) {
        toast.success(`Enabled Domain Intelligence for ${successCount} check(s). Domains will be checked within 6 hours, or use "Check now" for immediate results.`);
      }

      failures.forEach(failure => {
        const checkName = availableChecks.find(c => c.id === failure.checkId)?.name || failure.checkId;
        toast.error(`${checkName}: ${failure.error}`);
      });

      if (successCount > 0) {
        onClose();
      } else {
        toast.error(`Failed to enable Domain Intelligence for ${failures.length} check(s)`);
      }
    } else {
      toast.error(result.error || 'Failed to enable Domain Intelligence');
    }
  };

  const toggleCheck = (id: string) => {
    setChecksToEnable(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Extract domain from URL
  const extractDomain = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  // Filter checks based on search query
  const filteredChecks = useMemo(() => {
    if (!modalSearchQuery.trim()) return availableChecks;
    const query = modalSearchQuery.toLowerCase();
    return availableChecks.filter(check =>
      check.name.toLowerCase().includes(query) ||
      extractDomain(check.url).toLowerCase().includes(query) ||
      (check.folder && check.folder.toLowerCase().includes(query))
    );
  }, [availableChecks, modalSearchQuery]);

  // Group checks by folder
  const groupedChecks = useMemo(() => {
    const folders = new Map<string, typeof filteredChecks>();
    const ungrouped: typeof filteredChecks = [];

    for (const check of filteredChecks) {
      const folder = normalizeFolder(check.folder);
      if (folder) {
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder)!.push(check);
      } else {
        ungrouped.push(check);
      }
    }

    // Sort folder names alphabetically
    const sortedFolders = [...folders.entries()].sort((a, b) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: 'base' })
    );

    return { folders: sortedFolders, ungrouped };
  }, [filteredChecks]);

  const hasFolders = groupedChecks.folders.length > 0;

  // Toggle all checks in a folder
  const toggleFolder = (folderChecks: typeof filteredChecks) => {
    setChecksToEnable(prev => {
      const next = new Set(prev);
      const allSelected = folderChecks.every(c => next.has(c.id));
      if (allSelected) {
        folderChecks.forEach(c => next.delete(c.id));
      } else {
        folderChecks.forEach(c => next.add(c.id));
      }
      return next;
    });
  };

  // Toggle folder collapse
  const toggleCollapse = (folder: string) => {
    setCollapsedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  // Enable all visible checks
  const handleEnableAll = () => {
    setChecksToEnable(new Set(filteredChecks.map(c => c.id)));
  };

  // Check if all visible checks are selected
  const allVisibleSelected = filteredChecks.length > 0 &&
    filteredChecks.every(check => checksToEnable.has(check.id));

  const renderCheck = (check: typeof availableChecks[0]) => (
    <label
      key={check.id}
      className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 cursor-pointer"
    >
      <Checkbox
        checked={checksToEnable.has(check.id)}
        onCheckedChange={() => toggleCheck(check.id)}
      />
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{check.name}</p>
        <p className="text-sm text-muted-foreground truncate">
          {extractDomain(check.url)}
        </p>
      </div>
    </label>
  );

  const renderFolderGroup = (folderPath: string, checks: typeof filteredChecks) => {
    const theme = getFolderTheme(folderColors, folderPath);
    const allSelected = checks.every(c => checksToEnable.has(c.id));
    const someSelected = !allSelected && checks.some(c => checksToEnable.has(c.id));
    const isCollapsed = collapsedFolders.has(folderPath);

    return (
      <div key={folderPath}>
        <div
          className={cn(
            "flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-muted/50",
            theme.border, "border"
          )}
          onClick={() => toggleCollapse(folderPath)}
        >
          <ChevronRight className={cn(
            "w-4 h-4 text-muted-foreground transition-transform shrink-0",
            !isCollapsed && "rotate-90"
          )} />
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={() => toggleFolder(checks)}
            onClick={(e) => e.stopPropagation()}
          />
          <FolderIcon className={cn("w-4 h-4 shrink-0", theme.text)} />
          <span className="font-medium truncate text-sm">{getFolderName(folderPath)}</span>
          <span className="text-xs text-muted-foreground ml-auto shrink-0">{checks.length}</span>
        </div>
        {!isCollapsed && (
          <div className="ml-6 mt-1 space-y-1">
            {checks.map(renderCheck)}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enable Domain Intelligence</DialogTitle>
          <DialogDescription>
            Select checks to enable domain expiry monitoring.
          </DialogDescription>
        </DialogHeader>

        {availableChecks.length > 0 && (
          <div className="space-y-3">
            {/* Search bar */}
            <SearchInput
              value={modalSearchQuery}
              onChange={setModalSearchQuery}
              placeholder="Search checks..."
              className="!p-0"
            />

            {/* Enable All button */}
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleEnableAll}
                disabled={filteredChecks.length === 0 || allVisibleSelected}
              >
                Enable all{filteredChecks.length !== availableChecks.length ? ` (${filteredChecks.length})` : ''}
              </Button>
            </div>
          </div>
        )}

        <div className="max-h-[300px] overflow-y-auto space-y-2 py-2">
          {availableChecks.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              All your checks already have Domain Intelligence enabled.
            </p>
          ) : filteredChecks.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No checks match your search.
            </p>
          ) : hasFolders ? (
            <>
              {groupedChecks.folders.map(([folder, checks]) => renderFolderGroup(folder, checks))}
              {groupedChecks.ungrouped.length > 0 && (
                <>
                  {groupedChecks.folders.length > 0 && (
                    <div className="text-xs text-muted-foreground px-2 pt-2">Uncategorized</div>
                  )}
                  {groupedChecks.ungrouped.map(renderCheck)}
                </>
              )}
            </>
          ) : (
            filteredChecks.map(renderCheck)
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleEnableSelected}
            disabled={checksToEnable.size === 0 || enabling}
          >
            {enabling ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Enabling...
              </>
            ) : (
              `Enable (${checksToEnable.size})`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// Domain Settings Panel (Sheet)
interface DomainSettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domain: DomainIntelligenceItem | null;
  onUpdateThresholds: (checkId: string, thresholds: number[]) => Promise<{ success: boolean; error?: string }>;
}

const THRESHOLD_PRESETS = [
  { label: 'Standard', thresholds: [30, 14, 7, 1] },
  { label: 'Extended', thresholds: [60, 30, 14, 7, 1] },
  { label: 'Minimal', thresholds: [7, 1] },
];

const DomainSettingsPanel: React.FC<DomainSettingsPanelProps> = ({
  open,
  onOpenChange,
  domain,
  onUpdateThresholds,
}) => {
  const [isEditingThresholds, setIsEditingThresholds] = useState(false);
  const [editThresholds, setEditThresholds] = useState<number[]>([]);
  const [newThresholdInput, setNewThresholdInput] = useState('');
  const [savingThresholds, setSavingThresholds] = useState(false);

  // Reset editing state when a different domain is selected or panel opens
  useEffect(() => {
    setIsEditingThresholds(false);
    setEditThresholds([]);
    setNewThresholdInput('');
    setSavingThresholds(false);
  }, [domain?.checkId, open]);

  if (!domain) return null;

  const expiryUnavailable = !domain.expiryDate && !!domain.lastCheckedAt && !domain.lastError;
  
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0">
        <ScrollArea className="h-full">
          <div className="p-7 sm:p-8 space-y-6 sm:space-y-8">
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
                <Info className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Domain Intelligence</h2>
                <p className="text-xs text-muted-foreground font-mono mt-0.5">{domain.domain}</p>
              </div>
            </div>

            {/* Domain Status */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Status</h3>
              <div className="rounded-xl border border-border/30 bg-muted/20 p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Days until expiry</span>
                  {expiryUnavailable ? (
                    <span className="text-sm font-mono text-muted-foreground/60">N/A</span>
                  ) : (
                    <span className={cn(
                      "font-mono font-medium",
                      domain.daysUntilExpiry !== undefined && domain.daysUntilExpiry <= 7 ? "text-destructive" :
                      domain.daysUntilExpiry !== undefined && domain.daysUntilExpiry <= 30 ? "text-warning" :
                      "text-success"
                    )}>
                      {domain.daysUntilExpiry !== undefined ? `${domain.daysUntilExpiry} days` : '—'}
                    </span>
                  )}
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Last checked</span>
                  <span className="text-sm">{formatRelativeTime(domain.lastCheckedAt)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Next check</span>
                  <span className="text-sm">{domain.nextCheckAt ? formatRelativeTime(domain.nextCheckAt, true) : '—'}</span>
                </div>
              </div>
            </div>

            {/* Alert Thresholds */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Alert Thresholds</h3>
                {!expiryUnavailable && !isEditingThresholds && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => {
                      setEditThresholds([...domain.alertThresholds].sort((a, b) => b - a));
                      setNewThresholdInput('');
                      setIsEditingThresholds(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {expiryUnavailable ? (
                <p className="text-xs text-muted-foreground">
                  This domain's registry does not publish expiry dates, so expiry alerts are not available. Nameservers, status, and other registration data are still monitored.
                </p>
              ) : isEditingThresholds ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {editThresholds.map(threshold => (
                      <Badge
                        key={threshold}
                        variant="outline"
                        className="cursor-pointer hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive transition-colors"
                        onClick={() => setEditThresholds(prev => prev.filter(t => t !== threshold))}
                      >
                        {threshold} days
                        <X className="h-3 w-3 ml-1" />
                      </Badge>
                    ))}
                    {editThresholds.length === 0 && (
                      <p className="text-xs text-muted-foreground">No thresholds set. Add at least one.</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      placeholder="Days (1-365)"
                      value={newThresholdInput}
                      onChange={(e) => setNewThresholdInput(e.target.value)}
                      className="h-8 text-sm"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const val = parseInt(newThresholdInput);
                          if (val >= 1 && val <= 365 && !editThresholds.includes(val)) {
                            setEditThresholds(prev => [...prev, val].sort((a, b) => b - a));
                            setNewThresholdInput('');
                          }
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0"
                      onClick={() => {
                        const val = parseInt(newThresholdInput);
                        if (val >= 1 && val <= 365 && !editThresholds.includes(val)) {
                          setEditThresholds(prev => [...prev, val].sort((a, b) => b - a));
                          setNewThresholdInput('');
                        }
                      }}
                    >
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {THRESHOLD_PRESETS.map(preset => (
                      <Button
                        key={preset.label}
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs px-2"
                        onClick={() => setEditThresholds([...preset.thresholds])}
                      >
                        {preset.label} ({preset.thresholds.join(', ')})
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={editThresholds.length === 0 || savingThresholds}
                      onClick={async () => {
                        setSavingThresholds(true);
                        const result = await onUpdateThresholds(domain.checkId, editThresholds);
                        setSavingThresholds(false);
                        if (result.success) {
                          toast.success('Alert thresholds updated');
                          setIsEditingThresholds(false);
                        } else {
                          toast.error(result.error || 'Failed to update thresholds');
                        }
                      }}
                    >
                      {savingThresholds && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={savingThresholds}
                      onClick={() => setIsEditingThresholds(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {domain.alertThresholds.map(threshold => {
                      const sent = domain.alertsSent.includes(threshold);
                      return (
                        <Badge
                          key={threshold}
                          variant={sent ? 'default' : 'outline'}
                          className={sent ? 'bg-primary/20 text-primary border-primary/30' : ''}
                        >
                          {threshold} days {sent && '(sent)'}
                        </Badge>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    You'll receive alerts when the domain is within these thresholds of expiration.
                  </p>
                </>
              )}
            </div>
            
            {/* Registration Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Registration Information</h3>
              <div className="rounded-xl border border-border/30 bg-muted/20 p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Registrar</span>
                  <span className="text-sm font-medium">{domain.registrar || '—'}</span>
                </div>
                {domain.registrarUrl && (
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Registrar URL</span>
                    <a 
                      href={domain.registrarUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline"
                    >
                      {new URL(domain.registrarUrl).hostname}
                    </a>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Created</span>
                  <span className="text-sm">{formatLongDate(domain.createdDate)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Updated</span>
                  <span className="text-sm">{formatLongDate(domain.updatedDate)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Expires</span>
                  <span className="text-sm font-medium">{expiryUnavailable ? 'N/A' : formatLongDate(domain.expiryDate)}</span>
                </div>
              </div>
            </div>

            {/* Nameservers */}
            {domain.nameservers && domain.nameservers.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Nameservers</h3>
                <div className="rounded-xl border border-border/30 bg-muted/20 p-4">
                  <ul className="space-y-1">
                    {domain.nameservers.map((ns, i) => (
                      <li key={i} className="text-sm font-mono text-muted-foreground">{ns}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Registry Status */}
            {domain.registryStatus && domain.registryStatus.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Registry Status</h3>
                <div className="flex flex-wrap gap-2">
                  {domain.registryStatus.map((status, i) => (
                    <Badge key={i} variant="outline" className="font-mono text-xs">
                      {status}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Associated Check */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Associated Check</h3>
              <div className="rounded-xl border border-border/30 bg-muted/20 p-4 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Check name</span>
                  <span className="text-sm font-medium">{domain.checkName}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">URL</span>
                  <a 
                    href={domain.checkUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline truncate max-w-[200px]"
                  >
                    {domain.checkUrl}
                  </a>
                </div>
              </div>
            </div>
            
            {/* Error Status */}
            {domain.lastError && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Error</h3>
                <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20">
                  <p className="text-sm text-destructive font-mono">
                    {domain.lastError}
                  </p>
                  {domain.consecutiveErrors > 0 && (
                    <p className="text-xs text-destructive/70 mt-2">
                      {domain.consecutiveErrors} consecutive error{domain.consecutiveErrors !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Close Button */}
            <div className="pt-4 border-t border-border/30">
              <Button 
                variant="outline" 
                onClick={() => onOpenChange(false)}
                className="w-full cursor-pointer"
              >
                Close
              </Button>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
};

export default DomainIntelligence;
