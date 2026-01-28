import React, { useState, useCallback, useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, PageContainer } from '../components/layout';
import LoadingSkeleton from '../components/layout/LoadingSkeleton';
import { Button, SearchInput } from '../components/ui';
import EmptyState from '../components/ui/EmptyState';
import { GlowCard } from '../components/ui/glow-card';
import { useDomainIntelligence } from '../hooks/useDomainIntelligence';
import { useNanoPlan } from '@/hooks/useNanoPlan';
import { useChecks } from '../hooks/useChecks';
import { useUserPreferences } from '../hooks/useUserPreferences';
import { DomainIntelligenceTable } from '../components/domain-intelligence';
import { 
  Globe, 
  RefreshCw, 
  Plus, 
  AlertTriangle,
  CheckCircle,
  XCircle,
  ExternalLink
} from 'lucide-react';
import { toast } from 'sonner';
import type { DomainIntelligenceItem } from '../types';
import { cn } from '@/lib/utils';
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
import { Badge } from "@/components/ui/badge";
import { Settings } from 'lucide-react';

const DomainIntelligence: React.FC = () => {
  const { userId } = useAuth();
  const navigate = useNavigate();
  const { nano, isLoading: tierLoading } = useNanoPlan();
  const { preferences, updateSorting } = useUserPreferences(userId);
  const [searchQuery, setSearchQuery] = useState('');
  const [showEnableModal, setShowEnableModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState<DomainIntelligenceItem | null>(null);

  // Dummy log function for useChecks
  const log = useCallback((_msg: string) => {}, []);
  
  const { 
    domains, 
    stats, 
    loading, 
    disableDomainExpiry,
    refreshDomainExpiry,
    bulkEnableDomainExpiry,
    bulkDisableDomainExpiry,
    bulkRefreshDomainExpiry,
    refreshInProgress
  } = useDomainIntelligence(userId ?? null);
  
  // Get all checks for the enable modal
  const { checks } = useChecks(userId ?? null, log, { realtime: true });
  
  // Checks without domain expiry enabled
  const availableChecks = useMemo(() => {
    const enabledCheckIds = new Set(domains.map(d => d.checkId));
    return checks.filter(c => !enabledCheckIds.has(c.id));
  }, [checks, domains]);
  
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
  
  // Handle enable domain expiry for selected checks
  const [checksToEnable, setChecksToEnable] = useState<Set<string>>(new Set());
  const [enabling, setEnabling] = useState(false);
  
  const handleEnableSelected = async () => {
    if (checksToEnable.size === 0) return;

    setEnabling(true);
    const result = await bulkEnableDomainExpiry(Array.from(checksToEnable));
    setEnabling(false);

    if (result.success && result.results) {
      const successCount = result.results.filter(r => r.success).length;
      const failureCount = result.results.filter(r => !r.success).length;

      if (successCount > 0 && failureCount === 0) {
        toast.success(`Enabled Domain Intelligence for ${successCount} check(s). Domains will be checked within 6 hours, or use "Check now" for immediate results.`);
        setShowEnableModal(false);
        setChecksToEnable(new Set());
      } else if (successCount > 0 && failureCount > 0) {
        toast.success(`Enabled Domain Intelligence for ${successCount} check(s). Domains will be checked within 6 hours, or use "Check now" for immediate results.`);

        // Show errors for failed checks
        const failures = result.results.filter(r => !r.success);
        failures.forEach(failure => {
          const checkName = availableChecks.find(c => c.id === failure.checkId)?.name || failure.checkId;
          toast.error(`${checkName}: ${failure.error}`);
        });

        // Close modal and clear selection if at least some succeeded
        setShowEnableModal(false);
        setChecksToEnable(new Set());
      } else {
        // All failed
        toast.error(`Failed to enable Domain Intelligence for ${failureCount} check(s)`);

        // Show specific errors
        const failures = result.results.filter(r => !r.success);
        failures.forEach(failure => {
          const checkName = availableChecks.find(c => c.id === failure.checkId)?.name || failure.checkId;
          toast.error(`${checkName}: ${failure.error}`);
        });
      }
    } else {
      toast.error(result.error || 'Failed to enable Domain Intelligence');
    }
  };
  
  // Handle refresh
  const handleRefresh = async (checkId: string) => {
    const result = await refreshDomainExpiry(checkId);
    if (result.success) {
      toast.success('Domain data refreshed');
    } else {
      toast.error(result.error || 'Failed to refresh');
    }
  };
  
  // Handle disable
  const handleDisable = async (checkId: string) => {
    const result = await disableDomainExpiry(checkId);
    if (result.success) {
      toast.success('Domain Intelligence disabled');
    } else {
      toast.error(result.error || 'Failed to disable');
    }
  };
  
  // Handle bulk actions
  const handleBulkRefresh = async (checkIds: string[]) => {
    const result = await bulkRefreshDomainExpiry(checkIds);
    if (result.success) {
      toast.success(`Refreshed ${checkIds.length} domain(s)`);
    } else {
      toast.error(result.error || 'Failed to refresh');
    }
  };
  
  const handleBulkDisable = async (checkIds: string[]) => {
    const result = await bulkDisableDomainExpiry(checkIds);
    if (result.success) {
      toast.success(`Disabled Domain Intelligence for ${checkIds.length} domain(s)`);
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
        />
        <EmptyState
          icon={Globe}
          title="Domain Intelligence is a Nano feature"
          description="Upgrade to Nano to monitor domain expiration dates and receive alerts before your domains expire."
          action={{
            label: 'Upgrade to Nano',
            onClick: () => navigate('/billing'),
            icon: ExternalLink
          }}
        />
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
        
        {/* Enable Modal */}
        <EnableDomainModal 
          open={showEnableModal}
          onOpenChange={setShowEnableModal}
          availableChecks={availableChecks}
          checksToEnable={checksToEnable}
          setChecksToEnable={setChecksToEnable}
          onEnable={handleEnableSelected}
          enabling={enabling}
        />
      </PageContainer>
    );
  }
  
  return (
    <PageContainer>
      <PageHeader 
        title="Domain Intelligence" 
        description="Monitor domain expiration dates"
        actions={
          <Button onClick={() => setShowEnableModal(true)} size="sm">
            <Plus className="w-4 h-4 mr-2" />
            Enable for checks
          </Button>
        }
      />
      
      {/* Content */}
      <div className="flex-1 p-4 sm:p-6 min-h-0 max-w-full overflow-x-hidden">
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
      
      {/* Enable Modal */}
      <EnableDomainModal 
        open={showEnableModal}
        onOpenChange={setShowEnableModal}
        availableChecks={availableChecks}
        checksToEnable={checksToEnable}
        setChecksToEnable={setChecksToEnable}
        onEnable={handleEnableSelected}
        enabling={enabling}
      />
      
      {/* Settings Panel */}
      <DomainSettingsPanel
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
        domain={selectedDomain}
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
    success: 'text-green-400',
    warning: 'text-yellow-400',
    danger: 'text-red-400'
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

// Enable Domain Modal
interface EnableDomainModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableChecks: { id: string; name: string; url: string }[];
  checksToEnable: Set<string>;
  setChecksToEnable: React.Dispatch<React.SetStateAction<Set<string>>>;
  onEnable: () => void;
  enabling: boolean;
}

const EnableDomainModal: React.FC<EnableDomainModalProps> = ({
  open,
  onOpenChange,
  availableChecks,
  checksToEnable,
  setChecksToEnable,
  onEnable,
  enabling
}) => {
  const [modalSearchQuery, setModalSearchQuery] = useState('');
  
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
      extractDomain(check.url).toLowerCase().includes(query)
    );
  }, [availableChecks, modalSearchQuery]);
  
  // Enable all visible checks
  const handleEnableAll = () => {
    setChecksToEnable(new Set(filteredChecks.map(c => c.id)));
  };
  
  // Check if all visible checks are selected
  const allVisibleSelected = filteredChecks.length > 0 && 
    filteredChecks.every(check => checksToEnable.has(check.id));
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          ) : (
            filteredChecks.map(check => (
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
            ))
          )}
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={onEnable}
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
}

const DomainSettingsPanel: React.FC<DomainSettingsPanelProps> = ({
  open,
  onOpenChange,
  domain
}) => {
  if (!domain) return null;
  
  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '—';
    return new Date(timestamp).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const formatRelativeTime = (timestamp?: number, isFuture = false) => {
    if (!timestamp) return '—';
    const now = Date.now();
    const diff = isFuture ? timestamp - now : now - timestamp;
    const absDiff = Math.abs(diff);
    const minutes = Math.floor(absDiff / 60000);
    const hours = Math.floor(absDiff / 3600000);
    const days = Math.floor(absDiff / 86400000);

    if (isFuture) {
      if (diff <= 0) return 'now';
      if (days > 0) return `in ${days}d`;
      if (hours > 0) return `in ${hours}h`;
      if (minutes > 0) return `in ${minutes}m`;
      return 'in < 1m';
    }

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  };
  
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0">
        <ScrollArea className="h-full">
          <div className="p-7 sm:p-8 space-y-8">
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                <Settings className="w-4 h-4 text-primary" />
              </div>
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">Domain Intelligence</h2>
                <p className="text-sm text-muted-foreground font-mono">{domain.domain}</p>
              </div>
            </div>

            {/* Domain Status */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Status</h3>
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Days until expiry</span>
                  <span className={cn(
                    "font-mono font-medium",
                    domain.daysUntilExpiry !== undefined && domain.daysUntilExpiry <= 7 ? "text-red-400" :
                    domain.daysUntilExpiry !== undefined && domain.daysUntilExpiry <= 30 ? "text-yellow-400" :
                    "text-green-400"
                  )}>
                    {domain.daysUntilExpiry !== undefined ? `${domain.daysUntilExpiry} days` : '—'}
                  </span>
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
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Alert Thresholds</h3>
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
            </div>
            
            {/* Registration Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Registration Information</h3>
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
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
                  <span className="text-sm">{formatDate(domain.createdDate)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Updated</span>
                  <span className="text-sm">{formatDate(domain.updatedDate)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Expires</span>
                  <span className="text-sm font-medium">{formatDate(domain.expiryDate)}</span>
                </div>
              </div>
            </div>

            {/* Nameservers */}
            {domain.nameservers && domain.nameservers.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Nameservers</h3>
                <div className="rounded-lg border border-border bg-muted/30 p-4">
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
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
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
                <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                  <p className="text-sm text-red-400 font-mono">
                    {domain.lastError}
                  </p>
                  {domain.consecutiveErrors > 0 && (
                    <p className="text-xs text-red-400/70 mt-2">
                      {domain.consecutiveErrors} consecutive error{domain.consecutiveErrors !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Close Button */}
            <div className="pt-4 border-t border-border">
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
