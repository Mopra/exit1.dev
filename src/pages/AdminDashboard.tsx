import React, { useState, useEffect } from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import { useAdminStats } from '@/hooks/useAdminStats';
import { PageHeader, PageContainer } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { 
  Shield, 
  Users, 
  Globe, 
  RefreshCw, 
  Activity, 
  UserCheck, 
  Webhook, 
  CheckCircle2, 
  XCircle, 
  HelpCircle, 
  Ban,
  TrendingUp,
  Clock,
  BarChart3,
  Award,
  Eye,
  ExternalLink,
  Database,
  HardDrive,
  Search
} from 'lucide-react';
import { Button } from '@/components/ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { NotificationManager } from '@/components/admin/NotificationManager';
import { toast } from 'sonner';
import { getFunctions, httpsCallable } from 'firebase/functions';

interface BadgeDomain {
  domain: string;
  checks: Array<{
    checkId: string;
    checkName?: string;
    checkUrl?: string;
    viewCount: number;
    firstSeen: number;
    lastSeen: number;
  }>;
  totalViews: number;
}

interface DbUsage {
  storage: {
    totalRows: number;
    totalBytes: number;
    activeBytes: number;
    longTermBytes: number;
    limitBytes: number;
    usagePercentage: number;
  };
  query: {
    totalBytesBilled: number;
    totalBytesProcessed: number;
    limitBytes: number;
    usagePercentage: number;
  };
  firestore: {
    limitBytes: number;
    note: string;
  };
}

const formatBytes = (bytes: number, decimals = 2) => {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const UsageProgressBar = ({ percentage, colorClass = 'bg-primary' }: { percentage: number, colorClass?: string }) => (
  <div className="w-full bg-secondary rounded-full h-2.5 mt-2">
    <div 
      className={`${colorClass} h-2.5 rounded-full transition-all duration-500`} 
      style={{ width: `${Math.min(Math.max(percentage, 0), 100)}%` }}
    ></div>
  </div>
);

const AdminDashboard: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const { stats, loading: statsLoading, error, refresh } = useAdminStats();
  const [badgeDomains, setBadgeDomains] = useState<BadgeDomain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [showDomainsDialog, setShowDomainsDialog] = useState(false);
  
  // DB Usage State
  const [dbUsage, setDbUsage] = useState<DbUsage | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  const fetchDbUsage = async () => {
    setLoadingUsage(true);
    try {
      const functions = getFunctions();
      const getBigQueryUsage = httpsCallable(functions, 'getBigQueryUsage');
      const result = await getBigQueryUsage();
      const data = result.data as any;
      if (data.success) {
        setDbUsage(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch DB usage:', error);
      // Don't toast error on initial load to avoid spamming if it fails silently
    } finally {
      setLoadingUsage(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      fetchDbUsage();
    }
  }, [isAdmin]);

  if (adminLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-full max-w-md p-6 bg-card border rounded-lg">
            <div className="text-center space-y-4">
              <Shield className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <h2 className="text-2xl font-semibold">Access Denied</h2>
                <p className="text-muted-foreground mt-2">
                  You don't have permission to access this page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }

  const handleRefresh = async () => {
    try {
      await Promise.all([
        refresh(),
        fetchDbUsage(),
        fetchBadgeDomains(true, { silent: true }),
      ]);
      toast.success('Statistics refreshed');
    } catch (error) {
      toast.error('Failed to refresh statistics');
    }
  };

  const fetchBadgeDomains = async (force = false, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setLoadingDomains(true);
    }
    try {
      const functions = getFunctions();
      const getBadgeDomains = httpsCallable(functions, 'getBadgeDomains');
      const result = await getBadgeDomains(force ? { refresh: true } : undefined);
      const data = result.data as { success: boolean; data: { domains: BadgeDomain[] } };
      if (data.success) {
        setBadgeDomains(data.data.domains);
      }
    } catch (error) {
      console.error('Failed to fetch badge domains:', error);
      if (!silent) {
        toast.error('Failed to load badge domains');
      }
    } finally {
      if (!silent) {
        setLoadingDomains(false);
      }
    }
  };

  const handleSitesWithBadgesClick = () => {
    setShowDomainsDialog(true);
    if (badgeDomains.length === 0) {
      fetchBadgeDomains();
    }
  };

  const KpiCard = ({ 
    title, 
    value, 
    description, 
    icon: Icon, 
    trend,
    onClick
  }: { 
    title: string; 
    value: string | number; 
    description: string; 
    icon: React.ElementType;
    trend?: string;
    onClick?: () => void;
  }) => (
    <Card 
      className={`bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg transition-shadow ${
        onClick ? 'cursor-pointer hover:shadow-xl' : ''
      }`}
      onClick={onClick}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {statsLoading ? (
            <span className="text-muted-foreground">Loading...</span>
          ) : (
            typeof value === 'number' ? value.toLocaleString() : value
          )}
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-muted-foreground">{description}</p>
          {trend && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              {trend}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );

  const UsageCard = ({ 
    title, 
    usage, 
    limit, 
    percentage, 
    description, 
    icon: Icon,
    colorClass
  }: { 
    title: string; 
    usage: string; 
    limit: string; 
    percentage: number; 
    description?: string; 
    icon: React.ElementType;
    colorClass?: string;
  }) => (
    <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="flex justify-between items-end mb-1">
          <div className="text-2xl font-bold">
            {loadingUsage ? (
              <span className="text-muted-foreground text-lg">Loading...</span>
            ) : (
              usage
            )}
          </div>
          <div className="text-sm text-muted-foreground mb-1">
            / {limit}
          </div>
        </div>
        {!loadingUsage && (
          <UsageProgressBar percentage={percentage} colorClass={percentage > 90 ? 'bg-red-500' : percentage > 75 ? 'bg-yellow-500' : colorClass} />
        )}
        {description && (
          <p className="text-xs text-muted-foreground mt-2">{description}</p>
        )}
      </CardContent>
    </Card>
  );

  return (
    <PageContainer>
      <PageHeader 
        title="Admin Dashboard"
        description="System overview and key metrics"
        icon={Shield}
        actions={
          <Button
            onClick={handleRefresh}
            variant="outline"
            size="sm"
            disabled={statsLoading || loadingUsage}
            className="cursor-pointer"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${(statsLoading || loadingUsage) ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {error && (
        <div className="px-4 sm:px-6 pt-4">
          <div className="p-4 border border-destructive rounded-lg bg-destructive/10">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        </div>
      )}

      <div className="p-4 sm:p-6 space-y-6">
        {/* System Notifications */}
        <NotificationManager />

        {/* Primary KPIs */}
        <div>
          <h3 className="text-lg font-semibold mb-4">Overview</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title="Total Users"
              value={stats?.totalUsers || 0}
              description="Registered users"
              icon={Users}
            />
            <KpiCard
              title="Active Users"
              value={stats?.activeUsers || 0}
              description="Users with checks"
              icon={UserCheck}
            />
            <KpiCard
              title="Total Checks"
              value={stats?.totalChecks || 0}
              description="Active monitoring checks"
              icon={Globe}
            />
            <KpiCard
              title="Check Executions"
              value={stats?.totalCheckExecutions || 0}
              description="Total checks performed"
              icon={Activity}
            />
          </div>
        </div>

        {/* Free Tier Usage */}
        <div>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Database className="h-5 w-5" />
            Free Tier Usage
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <UsageCard
              title="BigQuery Storage"
              usage={dbUsage ? formatBytes(dbUsage.storage.activeBytes) : '0 B'}
              limit="10 GB"
              percentage={dbUsage?.storage.usagePercentage || 0}
              description="Active logical storage (monthly)"
              icon={HardDrive}
            />
            <UsageCard
              title="BigQuery Analysis"
              usage={dbUsage ? formatBytes(dbUsage.query.totalBytesBilled) : '0 B'}
              limit="1 TB"
              percentage={dbUsage?.query.usagePercentage || 0}
              description="Query bytes billed (monthly)"
              icon={Search}
            />
            <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Firestore Storage</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="flex justify-between items-end mb-1">
                  <div className="text-lg font-bold">
                    See Console
                  </div>
                  <div className="text-sm text-muted-foreground mb-1">
                    / 1 GiB
                  </div>
                </div>
                <div className="w-full bg-secondary rounded-full h-2.5 mt-2 opacity-50">
                  <div className="bg-primary h-2.5 rounded-full w-0"></div>
                </div>
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-muted-foreground">Detailed size not available via API.</p>
                  <a 
                    href="https://console.cloud.google.com/firestore/usage" 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    Open Cloud Console <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Check Status Breakdown */}
        <div>
          <h3 className="text-lg font-semibold mb-4">Check Status</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title="Online"
              value={stats?.checksByStatus?.online || 0}
              description="Checks currently online"
              icon={CheckCircle2}
            />
            <KpiCard
              title="Offline"
              value={stats?.checksByStatus?.offline || 0}
              description="Checks currently offline"
              icon={XCircle}
            />
            <KpiCard
              title="Unknown"
              value={stats?.checksByStatus?.unknown || 0}
              description="Checks with unknown status"
              icon={HelpCircle}
            />
            <KpiCard
              title="Disabled"
              value={stats?.checksByStatus?.disabled || 0}
              description="Manually disabled checks"
              icon={Ban}
            />
          </div>
        </div>

        {/* Webhooks & Engagement */}
        <div>
          <h3 className="text-lg font-semibold mb-4">Webhooks & Engagement</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              title="Total Webhooks"
              value={stats?.totalWebhooks || 0}
              description="All webhook configurations"
              icon={Webhook}
            />
            <KpiCard
              title="Enabled Webhooks"
              value={stats?.enabledWebhooks || 0}
              description="Active webhook integrations"
              icon={Webhook}
            />
            <KpiCard
              title="Avg Checks/User"
              value={stats?.averageChecksPerUser || 0}
              description="Average checks per user"
              icon={BarChart3}
            />
            <KpiCard
              title="Active Rate"
              value={stats?.totalUsers ? `${Math.round((stats.activeUsers / stats.totalUsers) * 100)}%` : '0%'}
              description="Users with active checks"
              icon={TrendingUp}
            />
          </div>
        </div>

        {/* Badge Usage */}
        <div>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Award className="h-5 w-5" />
            Badge Usage
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <KpiCard
              title="Checks with Badges"
              value={stats?.badgeUsage?.checksWithBadges || 0}
              description="Checks using badges on sites"
              icon={Award}
            />
            <KpiCard
              title="Sites with Badges"
              value={stats?.badgeUsage?.uniqueDomainsWithBadges || 0}
              description="Click to view all sites"
              icon={Globe}
              onClick={handleSitesWithBadgesClick}
            />
            <KpiCard
              title="Total Badge Views"
              value={stats?.badgeUsage?.totalBadgeViews || 0}
              description="All-time badge views"
              icon={Eye}
            />
            <KpiCard
              title="Recent Badge Views"
              value={stats?.badgeUsage?.recentBadgeViews || 0}
              description="Badge views this week"
              icon={TrendingUp}
            />
          </div>
        </div>

        {/* Sites with Badges Dialog */}
        <Dialog open={showDomainsDialog} onOpenChange={setShowDomainsDialog}>
          <DialogContent className="max-w-[90vw] lg:max-w-7xl xl:max-w-[95vw] min-h-[600px] max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                Sites with Badges ({badgeDomains.length})
              </DialogTitle>
              <DialogDescription>
                All domains where badges are currently installed and displayed
              </DialogDescription>
            </DialogHeader>
            
            {loadingDomains ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground">Loading sites...</span>
              </div>
            ) : badgeDomains.length > 0 ? (
              <div className="flex-1 overflow-y-auto mt-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[300px]">Domain</TableHead>
                      <TableHead>Checks Displayed</TableHead>
                      <TableHead className="w-[120px] text-right">Total Views</TableHead>
                      <TableHead className="w-[80px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {badgeDomains.map((domainInfo) => {
                      const domainUrl = `https://${domainInfo.domain}`;
                      return (
                        <TableRow 
                          key={domainInfo.domain}
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          onClick={() => window.open(domainUrl, '_blank', 'noopener,noreferrer')}
                        >
                          <TableCell className="font-medium">
                            {domainInfo.domain}
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              {domainInfo.checks.map((check) => (
                                <div key={check.checkId} className="text-sm text-muted-foreground">
                                  <span className="font-medium">• {check.checkName || check.checkId}</span>
                                  {check.checkUrl && (
                                    <span className="text-xs font-mono opacity-70 ml-2">
                                      (monitoring: {check.checkUrl})
                                    </span>
                                  )}
                                  <span className="text-xs ml-2">({check.viewCount.toLocaleString()} views)</span>
                                </div>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {domainInfo.totalViews.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <ExternalLink className="h-4 w-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="py-12 text-center text-muted-foreground">
                <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No sites with badges found.</p>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Recent Activity (Last 7 Days) */}
        <div>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Recent Activity (Last 7 Days)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <KpiCard
              title="New Users"
              value={stats?.recentActivity?.newUsers || 0}
              description="Users registered this week"
              icon={Users}
            />
            <KpiCard
              title="New Checks"
              value={stats?.recentActivity?.newChecks || 0}
              description="Checks created this week"
              icon={Globe}
            />
            <KpiCard
              title="Check Executions"
              value={stats?.recentActivity?.checkExecutions || 0}
              description="Executions this week"
              icon={Activity}
            />
          </div>
        </div>
      </div>
    </PageContainer>
  );
};

export default AdminDashboard;
