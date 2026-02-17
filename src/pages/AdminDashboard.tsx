import React, { useState, useCallback } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { useAdmin } from '@/hooks/useAdmin';
import { useAdminStats } from '@/hooks/useAdminStats';
import { PageHeader, PageContainer } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle, Button } from '@/components/ui';
import {
  Shield,
  Users,
  Globe,
  RefreshCw,
  Activity,
  UserCheck,
  CheckCircle2,
  Ban,
  CreditCard,
  Upload,
  Tags,
  MapPin,
} from 'lucide-react';
import { toast } from 'sonner';

interface SyncLogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

const AdminDashboard: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const { stats, loading: statsLoading, error, refresh } = useAdminStats();
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncLogs, setSyncLogs] = useState<SyncLogEntry[]>([]);
  const [segmentLoading, setSegmentLoading] = useState(false);
  const [segmentLogs, setSegmentLogs] = useState<SyncLogEntry[]>([]);
  const [migrateLoading, setMigrateLoading] = useState(false);
  const [migrateResult, setMigrateResult] = useState<string | null>(null);
  const [migrateEuLoading, setMigrateEuLoading] = useState(false);
  const [migrateEuResult, setMigrateEuResult] = useState<string | null>(null);

  const addLog = useCallback((message: string, type: SyncLogEntry['type'] = 'info') => {
    setSyncLogs((prev) => [...prev, { timestamp: new Date().toLocaleTimeString(), message, type }]);
  }, []);

  const addSegmentLog = useCallback((message: string, type: SyncLogEntry['type'] = 'info') => {
    setSegmentLogs((prev) => [...prev, { timestamp: new Date().toLocaleTimeString(), message, type }]);
  }, []);

  const handleSyncToResend = useCallback(async (dryRun: boolean) => {
    setSyncLoading(true);
    setSyncLogs([]);
    const mode = dryRun ? 'DRY RUN' : 'LIVE';
    addLog(`Starting ${mode} sync of Clerk users to Resend...`);

    try {
      const syncFn = httpsCallable(functions, 'syncClerkUsersToResend', { timeout: 540000 });
      addLog(`Calling syncClerkUsersToResend (instance: prod, dryRun: ${dryRun})...`);
      const result = await syncFn({ instance: 'prod', dryRun });
      const data = result.data as {
        success: boolean;
        stats: { total: number; synced: number; skipped: number; errors: number; dryRun: boolean };
        errors?: Array<{ email: string; error: string }>;
      };

      addLog(`Total users processed: ${data.stats.total}`, 'info');
      addLog(`Synced: ${data.stats.synced}`, 'success');
      addLog(`Skipped (already exists / no email): ${data.stats.skipped}`, 'info');
      if (data.stats.errors > 0) {
        addLog(`Errors: ${data.stats.errors}`, 'error');
        data.errors?.forEach((e) => addLog(`  ${e.email}: ${e.error}`, 'error'));
      }
      addLog(`${mode} sync completed successfully!`, 'success');
      toast.success(`${mode} sync completed: ${data.stats.synced} synced, ${data.stats.skipped} skipped`);
    } catch (err: any) {
      const message = err?.message || 'Unknown error';
      addLog(`Sync failed: ${message}`, 'error');
      toast.error(`Sync failed: ${message}`);
    } finally {
      setSyncLoading(false);
    }
  }, [addLog]);

  const handleSyncSegments = useCallback(async (dryRun: boolean) => {
    setSegmentLoading(true);
    setSegmentLogs([]);
    const mode = dryRun ? 'DRY RUN' : 'LIVE';
    addSegmentLog(`Starting ${mode} segment sync...`);

    try {
      const syncFn = httpsCallable(functions, 'syncSegmentsToResend', { timeout: 540000 });
      addSegmentLog(`Calling syncSegmentsToResend (instance: prod, dryRun: ${dryRun})...`);
      const result = await syncFn({ instance: 'prod', dryRun });
      const data = result.data as {
        success: boolean;
        stats: { total: number; free: number; nano: number; skipped: number; errors: number; dryRun: boolean };
        details?: Array<{ email: string; tier: string }>;
        errors?: Array<{ email: string; error: string }>;
      };

      addSegmentLog(`Total users processed: ${data.stats.total}`, 'info');
      addSegmentLog(`Free tier: ${data.stats.free}`, 'info');
      addSegmentLog(`Nano tier: ${data.stats.nano}`, 'success');
      addSegmentLog(`Skipped (no email): ${data.stats.skipped}`, 'info');

      if (data.details && data.details.length > 0) {
        addSegmentLog(`--- User tier breakdown ---`, 'info');
        data.details.forEach((d) => {
          addSegmentLog(`  ${d.email} → ${d.tier}`, d.tier === 'nano' ? 'success' : 'info');
        });
        if (data.stats.total > data.details.length) {
          addSegmentLog(`  ... and ${data.stats.total - data.details.length} more`, 'info');
        }
      }

      if (data.stats.errors > 0) {
        addSegmentLog(`Errors: ${data.stats.errors}`, 'error');
        data.errors?.forEach((e) => addSegmentLog(`  ${e.email}: ${e.error}`, 'error'));
      }

      addSegmentLog(`${mode} segment sync completed!`, 'success');
      toast.success(`${mode} segment sync: ${data.stats.free} free, ${data.stats.nano} nano`);
    } catch (err: any) {
      const message = err?.message || 'Unknown error';
      addSegmentLog(`Segment sync failed: ${message}`, 'error');
      toast.error(`Segment sync failed: ${message}`);
    } finally {
      setSegmentLoading(false);
    }
  }, [addSegmentLog]);

  const handleMigrateFreePlanChecks = useCallback(async () => {
    setMigrateLoading(true);
    setMigrateResult(null);
    try {
      const migrateFn = httpsCallable(functions, 'migrateFreePlanChecksToVps', { timeout: 540000 });
      const result = await migrateFn({});
      const data = result.data as { totalFreeChecks: number; updated: number; alreadyOnVps: number };
      const msg = `Done! ${data.updated} checks moved to vps-eu-1, ${data.alreadyOnVps} already there (${data.totalFreeChecks} total free checks)`;
      setMigrateResult(msg);
      toast.success(msg);
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      setMigrateResult(`Error: ${msg}`);
      toast.error(`Migration failed: ${msg}`);
    } finally {
      setMigrateLoading(false);
    }
  }, []);

  const handleMigrateEuropeWestChecks = useCallback(async () => {
    setMigrateEuLoading(true);
    setMigrateEuResult(null);
    try {
      const migrateFn = httpsCallable(functions, 'migrateEuropeWestChecksToVps', { timeout: 540000 });
      const result = await migrateFn({});
      const data = result.data as { totalEuropeWestChecks: number; updated: number };
      const msg = `Done! ${data.updated} europe-west1 checks moved to vps-eu-1 (${data.totalEuropeWestChecks} total)`;
      setMigrateEuResult(msg);
      toast.success(msg);
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      setMigrateEuResult(`Error: ${msg}`);
      toast.error(`Migration failed: ${msg}`);
    } finally {
      setMigrateEuLoading(false);
    }
  }, []);

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
      await refresh();
      toast.success('Statistics refreshed');
    } catch (error) {
      toast.error('Failed to refresh statistics');
    }
  };

  const KpiCard = ({
    title,
    value,
    description,
    icon: Icon,
  }: {
    title: string;
    value: string | number;
    description: string;
    icon: React.ElementType;
  }) => (
    <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg">
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
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </CardContent>
    </Card>
  );

  const totalChecks = stats?.totalChecks || 0;
  const disabledChecks = stats?.checksByStatus?.disabled || 0;
  const enabledChecks = Math.max(totalChecks - disabledChecks, 0);
  const nanoSubscriptions = stats?.nanoSubscriptions;
  const nanoCurrency = nanoSubscriptions?.currency || 'USD';
  const formatCurrency = (amountCents: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: nanoCurrency,
      maximumFractionDigits: 2,
    }).format(amountCents / 100);

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
            disabled={statsLoading}
            className="cursor-pointer"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${statsLoading ? 'animate-spin' : ''}`} />
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
        <div>
          <h3 className="text-lg font-semibold mb-4">Users</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
              title="Nano Subscribers"
              value={nanoSubscriptions?.subscribers || 0}
              description={`MRR: ${formatCurrency(nanoSubscriptions?.mrrCents || 0)} | ARR: ${formatCurrency(nanoSubscriptions?.arrCents || 0)}`}
              icon={CreditCard}
            />
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Checks</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <KpiCard
              title="Total Checks"
              value={totalChecks}
              description="All monitoring checks"
              icon={Globe}
            />
            <KpiCard
              title="Total Enabled Checks"
              value={enabledChecks}
              description="Checks enabled for monitoring"
              icon={CheckCircle2}
            />
            <KpiCard
              title="Total Disabled Checks"
              value={disabledChecks}
              description="Manually disabled checks"
              icon={Ban}
            />
            <KpiCard
              title="Check Executions"
              value={stats?.totalCheckExecutions || 0}
              description="Total checks performed"
              icon={Activity}
            />
          </div>
        </div>
        <div>
          <h3 className="text-lg font-semibold mb-4">Admin Tools</h3>
          <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Sync Clerk Users to Resend
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Syncs all Clerk users to Resend contacts. Use Dry Run first to preview.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  onClick={() => handleSyncToResend(true)}
                  variant="outline"
                  size="sm"
                  disabled={syncLoading}
                  className="cursor-pointer"
                >
                  {syncLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Dry Run
                </Button>
                <Button
                  onClick={() => handleSyncToResend(false)}
                  variant="default"
                  size="sm"
                  disabled={syncLoading}
                  className="cursor-pointer"
                >
                  {syncLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Sync Now
                </Button>
              </div>

              {syncLogs.length > 0 && (
                <div className="bg-black/90 rounded-lg p-4 max-h-64 overflow-y-auto font-mono text-xs space-y-1">
                  {syncLogs.map((log, i) => (
                    <div
                      key={i}
                      className={
                        log.type === 'error'
                          ? 'text-red-400'
                          : log.type === 'success'
                            ? 'text-green-400'
                            : 'text-gray-300'
                      }
                    >
                      <span className="text-gray-500">[{log.timestamp}]</span> {log.message}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Tags className="h-4 w-4" />
                Sync Segments (Free / Nano)
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Reads each user's tier from Clerk billing and assigns them to the correct Resend segment. Does not delete or recreate contacts.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  onClick={() => handleSyncSegments(true)}
                  variant="outline"
                  size="sm"
                  disabled={segmentLoading}
                  className="cursor-pointer"
                >
                  {segmentLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Dry Run
                </Button>
                <Button
                  onClick={() => handleSyncSegments(false)}
                  variant="default"
                  size="sm"
                  disabled={segmentLoading}
                  className="cursor-pointer"
                >
                  {segmentLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Sync Segments
                </Button>
              </div>

              {segmentLogs.length > 0 && (
                <div className="bg-black/90 rounded-lg p-4 max-h-64 overflow-y-auto font-mono text-xs space-y-1">
                  {segmentLogs.map((log, i) => (
                    <div
                      key={i}
                      className={
                        log.type === 'error'
                          ? 'text-red-400'
                          : log.type === 'success'
                            ? 'text-green-400'
                            : 'text-gray-300'
                      }
                    >
                      <span className="text-gray-500">[{log.timestamp}]</span> {log.message}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Migrate Free Plan Checks to VPS
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Moves all free-tier checks to the vps-eu-1 region. Sets both checkRegion and checkRegionOverride. One-time migration.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={handleMigrateFreePlanChecks}
                variant="default"
                size="sm"
                disabled={migrateLoading}
                className="cursor-pointer"
              >
                {migrateLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                {migrateLoading ? 'Migrating...' : 'Migrate Now'}
              </Button>

              {migrateResult && (
                <div className={`rounded-lg p-3 text-xs font-mono ${migrateResult.startsWith('Error') ? 'bg-red-950/50 text-red-400' : 'bg-green-950/50 text-green-400'}`}>
                  {migrateResult}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-amber-200/50 shadow-lg">
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Migrate Europe West Checks to VPS
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Moves all checks on europe-west1 (Belgium) to vps-eu-1. Empties the checkAllChecksEU scheduler.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={handleMigrateEuropeWestChecks}
                variant="default"
                size="sm"
                disabled={migrateEuLoading}
                className="cursor-pointer"
              >
                {migrateEuLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                {migrateEuLoading ? 'Migrating...' : 'Migrate Now'}
              </Button>

              {migrateEuResult && (
                <div className={`rounded-lg p-3 text-xs font-mono ${migrateEuResult.startsWith('Error') ? 'bg-red-950/50 text-red-400' : 'bg-green-950/50 text-green-400'}`}>
                  {migrateEuResult}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
};

export default AdminDashboard;
