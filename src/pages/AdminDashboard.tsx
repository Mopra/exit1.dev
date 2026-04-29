import React, { useState, useCallback } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { useAdmin } from '@/hooks/useAdmin';
import { useAdminStats } from '@/hooks/useAdminStats';
import { PageHeader, PageContainer } from '@/components/layout';
import {
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Checkbox,
  Skeleton,
} from '@/components/ui';
import GlowCard from '@/components/ui/glow-card';
import {
  Shield,
  Users,
  Globe,
  RefreshCw,
  Activity,
  UserCheck,
  CheckCircle2,
  CreditCard,
  Upload,
  Tags,
  ListFilter,
  TrendingUp,
  BarChart3,
  Layers,
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
  const [propertyLoading, setPropertyLoading] = useState(false);
  const [propertyLogs, setPropertyLogs] = useState<SyncLogEntry[]>([]);
  const [propertySyncTopics, setPropertySyncTopics] = useState(false);
  const [propertyForce, setPropertyForce] = useState(false);
  const [tierLoading, setTierLoading] = useState(false);
  const [tierLogs, setTierLogs] = useState<SyncLogEntry[]>([]);

  const addLog = useCallback((message: string, type: SyncLogEntry['type'] = 'info') => {
    setSyncLogs((prev) => [...prev, { timestamp: new Date().toLocaleTimeString(), message, type }]);
  }, []);

  const addSegmentLog = useCallback((message: string, type: SyncLogEntry['type'] = 'info') => {
    setSegmentLogs((prev) => [...prev, { timestamp: new Date().toLocaleTimeString(), message, type }]);
  }, []);

  const addPropertyLog = useCallback((message: string, type: SyncLogEntry['type'] = 'info') => {
    setPropertyLogs((prev) => [...prev, { timestamp: new Date().toLocaleTimeString(), message, type }]);
  }, []);

  const addTierLog = useCallback((message: string, type: SyncLogEntry['type'] = 'info') => {
    setTierLogs((prev) => [...prev, { timestamp: new Date().toLocaleTimeString(), message, type }]);
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

  const handleResyncProperties = useCallback(async (dryRun: boolean) => {
    setPropertyLoading(true);
    setPropertyLogs([]);
    const mode = dryRun ? 'DRY RUN' : 'LIVE';
    // Dry run skips all API calls so we can process many more per invocation.
    // Live runs are rate-limited by Resend; topic sync doubles API calls per user.
    const batchSize = dryRun ? 2000 : propertySyncTopics ? 250 : 400;
    addPropertyLog(
      `Starting ${mode} resync (syncTopics: ${propertySyncTopics}, force: ${propertyForce}, batchSize: ${batchSize})...`,
    );

    type BatchResponse = {
      success: boolean;
      done: boolean;
      nextOffset: number;
      stats: {
        batchTotal: number;
        updated: number;
        skipped: number;
        skippedFresh: number;
        errors: number;
        withOnboarding: number;
        firestoreBackfilled: number;
        topicsUpdated: number;
        dryRun: boolean;
        syncTopics: boolean;
        force: boolean;
        startOffset: number;
        batchSize: number;
      };
      schema: {
        created: string[];
        existed: string[];
        failed: Array<{ key: string; error: string }>;
      };
      errors?: Array<{ email: string; error: string }>;
    };

    const agg = {
      total: 0,
      updated: 0,
      skipped: 0,
      skippedFresh: 0,
      errors: 0,
      withOnboarding: 0,
      firestoreBackfilled: 0,
      topicsUpdated: 0,
    };

    try {
      const fn = httpsCallable(functions, 'resyncResendProperties', { timeout: 540000 });
      let offset = 0;
      let batchNum = 0;

      while (true) {
        batchNum++;
        addPropertyLog(
          `Batch ${batchNum} starting at offset ${offset} (instance: prod, dryRun: ${dryRun})...`,
        );
        const result = await fn({
          instance: 'prod',
          dryRun,
          syncTopics: propertySyncTopics,
          force: propertyForce,
          startOffset: offset,
          batchSize,
        });
        const data = result.data as BatchResponse;

        // Schema summary only logged for the first batch (that's when the
        // backend actually registers properties).
        if (offset === 0 && data.schema) {
          if (data.schema.created.length > 0) {
            addPropertyLog(
              `Schema: registered ${data.schema.created.length} new properties (${data.schema.created.join(', ')})`,
              'success',
            );
          }
          if (data.schema.existed.length > 0) {
            addPropertyLog(
              `Schema: ${data.schema.existed.length} properties already existed`,
              'info',
            );
          }
          if (data.schema.failed.length > 0) {
            addPropertyLog(`Schema: ${data.schema.failed.length} property registrations failed`, 'error');
            data.schema.failed.forEach((f) => addPropertyLog(`  ${f.key}: ${f.error}`, 'error'));
          }
        }

        agg.total += data.stats.batchTotal;
        agg.updated += data.stats.updated;
        agg.skipped += data.stats.skipped;
        agg.skippedFresh += data.stats.skippedFresh;
        agg.errors += data.stats.errors;
        agg.withOnboarding += data.stats.withOnboarding;
        agg.firestoreBackfilled += data.stats.firestoreBackfilled;
        agg.topicsUpdated += data.stats.topicsUpdated;

        addPropertyLog(
          `Batch ${batchNum}: processed ${data.stats.batchTotal}, updated ${data.stats.updated}, skipped-fresh ${data.stats.skippedFresh}, errors ${data.stats.errors}`,
          data.stats.errors > 0 ? 'error' : 'info',
        );
        data.errors?.forEach((e) => addPropertyLog(`  ${e.email}: ${e.error}`, 'error'));

        if (data.done) break;
        offset = data.nextOffset;
      }

      addPropertyLog(`Total users processed: ${agg.total}`, 'info');
      addPropertyLog(`Updated: ${agg.updated}`, 'success');
      if (agg.skippedFresh > 0) {
        addPropertyLog(`Skipped (synced within 30 days): ${agg.skippedFresh}`, 'info');
      }
      addPropertyLog(`With onboarding data: ${agg.withOnboarding}`, 'info');
      if (agg.firestoreBackfilled > 0) {
        addPropertyLog(`Firestore onboarding backfilled for: ${agg.firestoreBackfilled} users`, 'info');
      }
      addPropertyLog(`Skipped (no email): ${agg.skipped}`, 'info');
      if (propertySyncTopics) {
        addPropertyLog(`Topic subscriptions added: ${agg.topicsUpdated}`, 'info');
      }
      if (agg.errors > 0) {
        addPropertyLog(`Total errors: ${agg.errors}`, 'error');
      }
      addPropertyLog(`${mode} resync completed across ${batchNum} batch(es)!`, 'success');
      toast.success(`${mode} resync: ${agg.updated} updated, ${agg.errors} errors`);
    } catch (err: any) {
      const message = err?.message || 'Unknown error';
      addPropertyLog(`Resync failed: ${message}`, 'error');
      toast.error(`Resync failed: ${message}`);
    } finally {
      setPropertyLoading(false);
    }
  }, [addPropertyLog, propertySyncTopics, propertyForce]);

  const handleRecomputeTiers = useCallback(async (dryRun: boolean) => {
    setTierLoading(true);
    setTierLogs([]);
    const mode = dryRun ? 'DRY RUN' : 'LIVE';
    addTierLog(`Starting ${mode} tier recompute for all Clerk users...`);

    type BatchResponse = {
      success: boolean;
      done: boolean;
      nextOffset: number;
      stats: {
        total: number;
        recomputed: number;
        unchanged: number;
        checksBackfilled: number;
        errors: number;
        dryRun: boolean;
        startOffset: number;
        batchSize: number;
      };
      errors?: Array<{ userId: string; error: string }>;
    };

    const agg = { total: 0, recomputed: 0, unchanged: 0, checksBackfilled: 0, errors: 0 };

    try {
      const fn = httpsCallable(functions, 'recomputeAllTiers', { timeout: 540000 });
      let offset = 0;
      let batchNum = 0;

      while (true) {
        batchNum++;
        addTierLog(`Batch ${batchNum} starting at offset ${offset} (instance: prod, dryRun: ${dryRun})...`);
        const result = await fn({ instance: 'prod', dryRun, startOffset: offset });
        const data = result.data as BatchResponse;

        agg.total += data.stats.total;
        agg.recomputed += data.stats.recomputed;
        agg.unchanged += data.stats.unchanged;
        agg.checksBackfilled += data.stats.checksBackfilled ?? 0;
        agg.errors += data.stats.errors;

        addTierLog(
          `Batch ${batchNum}: processed ${data.stats.total}, recomputed ${data.stats.recomputed}, unchanged ${data.stats.unchanged}, checks backfilled ${data.stats.checksBackfilled ?? 0}, errors ${data.stats.errors}`,
          data.stats.errors > 0 ? 'error' : 'info',
        );
        data.errors?.forEach((e) => addTierLog(`  ${e.userId}: ${e.error}`, 'error'));

        if (data.done) break;
        offset = data.nextOffset;
      }

      addTierLog(`Total users processed: ${agg.total}`, 'info');
      addTierLog(`Recomputed: ${agg.recomputed}`, 'success');
      addTierLog(`Unchanged (already in sync): ${agg.unchanged}`, 'info');
      addTierLog(`Check docs backfilled: ${agg.checksBackfilled}`, agg.checksBackfilled > 0 ? 'success' : 'info');
      if (agg.errors > 0) {
        addTierLog(`Total errors: ${agg.errors}`, 'error');
      }
      addTierLog(`${mode} recompute completed across ${batchNum} batch(es)!`, 'success');
      toast.success(`${mode} recompute: ${agg.recomputed} recomputed, ${agg.unchanged} unchanged, ${agg.checksBackfilled} check docs backfilled, ${agg.errors} errors`);
    } catch (err: any) {
      const message = err?.message || 'Unknown error';
      addTierLog(`Recompute failed: ${message}`, 'error');
      toast.error(`Recompute failed: ${message}`);
    } finally {
      setTierLoading(false);
    }
  }, [addTierLog]);

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
    } catch {
      toast.error('Failed to refresh statistics');
    }
  };

  // --- Derived stats ---
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

  const conversionRate = stats?.totalUsers
    ? ((stats.activeUsers / stats.totalUsers) * 100).toFixed(1)
    : '0';

  // --- Skeleton card ---
  const SkeletonCard = () => (
    <GlowCard className="p-0">
      <div className="m-1">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-4 rounded" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-16 mb-1" />
          <Skeleton className="h-3 w-full" />
        </CardContent>
      </div>
    </GlowCard>
  );

  // --- KPI card ---
  const KpiCard = ({
    title,
    value,
    description,
    icon: Icon,
    trend,
  }: {
    title: string;
    value: string | number;
    description: string;
    icon: React.ElementType;
    trend?: string;
  }) => (
    <GlowCard className="p-0">
      <div className="m-1">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold">
              {typeof value === 'number' ? value.toLocaleString() : value}
            </div>
            {trend && (
              <span className="text-xs text-success font-medium">{trend}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        </CardContent>
      </div>
    </GlowCard>
  );

  // --- Log console component ---
  const LogConsole = ({ logs }: { logs: SyncLogEntry[] }) => {
    if (logs.length === 0) return null;
    return (
      <div className="bg-black/90 rounded-lg p-4 max-h-64 overflow-y-auto font-mono text-xs space-y-1">
        {logs.map((log, i) => (
          <div
            key={i}
            className={
              log.type === 'error'
                ? 'text-destructive'
                : log.type === 'success'
                  ? 'text-success'
                  : 'text-muted-foreground'
            }
          >
            <span className="text-gray-500">[{log.timestamp}]</span> {log.message}
          </div>
        ))}
      </div>
    );
  };

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

      <div className="p-2 sm:p-4 md:p-6 space-y-6 sm:space-y-8">

        {/* ── Revenue & Users ── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Users & Revenue</h3>
          </div>
          {statsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                title="Total Users"
                value={stats?.totalUsers || 0}
                description="Registered accounts"
                icon={Users}
              />
              <KpiCard
                title="Active Users"
                value={stats?.activeUsers || 0}
                description={`${conversionRate}% conversion rate`}
                icon={UserCheck}
              />
              <KpiCard
                title="Nano Subscribers"
                value={nanoSubscriptions?.subscribers || 0}
                description={`MRR: ${formatCurrency(nanoSubscriptions?.mrrCents || 0)}`}
                icon={CreditCard}
              />
              <KpiCard
                title="ARR"
                value={formatCurrency(nanoSubscriptions?.arrCents || 0)}
                description={`${nanoSubscriptions?.subscribers || 0} paying customers`}
                icon={TrendingUp}
              />
            </div>
          )}
        </section>

        {/* ── Checks Overview ── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Checks</h3>
          </div>
          {statsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard
                  title="Total Checks"
                  value={totalChecks}
                  description="All monitoring checks"
                  icon={Globe}
                />
                <KpiCard
                  title="Enabled"
                  value={enabledChecks}
                  description="Actively monitored"
                  icon={CheckCircle2}
                />
                <KpiCard
                  title="Check Executions"
                  value={stats?.totalCheckExecutions || 0}
                  description="All-time total"
                  icon={Activity}
                />
                <KpiCard
                  title="Avg Checks / User"
                  value={stats?.averageChecksPerUser?.toFixed(1) || '0'}
                  description="Per active user"
                  icon={BarChart3}
                />
              </div>

            </>
          )}
        </section>

        {/* ── Admin Tools ── */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Admin Tools</h3>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Sync Clerk → Resend */}
            <GlowCard className="p-0">
              <div className="m-1">
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
                  <LogConsole logs={syncLogs} />
                </CardContent>
              </div>
            </GlowCard>

            {/* Sync Segments */}
            <GlowCard className="p-0">
              <div className="m-1">
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Tags className="h-4 w-4" />
                    Sync Segments (Free / Nano)
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Reads each user's tier from Clerk billing and assigns them to the correct Resend segment.
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
                  <LogConsole logs={segmentLogs} />
                </CardContent>
              </div>
            </GlowCard>

            {/* Resync Resend Properties */}
            <GlowCard className="p-0 lg:col-span-2">
              <div className="m-1">
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <ListFilter className="h-4 w-4" />
                    Resync Resend Properties
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Registers every property (signup_date, plan_tier, team_size, source_*, use_case_*)
                    and pushes the correct values to every user's Resend contact. Users synced within
                    the last 30 days are skipped unless <span className="font-mono">Force</span> is checked.
                    Pulls onboarding answers from BigQuery and plan tier from cached Firestore.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="sync-topics"
                        checked={propertySyncTopics}
                        onCheckedChange={(v) => setPropertySyncTopics(v === true)}
                        disabled={propertyLoading}
                      />
                      <label htmlFor="sync-topics" className="text-xs cursor-pointer select-none">
                        Also set topic opt-in (adds ~1 extra API call per user; halves batch size)
                      </label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="sync-force"
                        checked={propertyForce}
                        onCheckedChange={(v) => setPropertyForce(v === true)}
                        disabled={propertyLoading}
                      />
                      <label htmlFor="sync-force" className="text-xs cursor-pointer select-none">
                        Force (ignore 30-day skip cache; re-sync every user)
                      </label>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleResyncProperties(true)}
                      variant="outline"
                      size="sm"
                      disabled={propertyLoading}
                      className="cursor-pointer"
                    >
                      {propertyLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                      Dry Run
                    </Button>
                    <Button
                      onClick={() => handleResyncProperties(false)}
                      variant="default"
                      size="sm"
                      disabled={propertyLoading}
                      className="cursor-pointer"
                    >
                      {propertyLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                      Resync Properties
                    </Button>
                  </div>
                  <LogConsole logs={propertyLogs} />
                </CardContent>
              </div>
            </GlowCard>

            {/* Recompute All Tiers */}
            <GlowCard className="p-0 lg:col-span-2">
              <div className="m-1">
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Layers className="h-4 w-4" />
                    Recompute All Tiers
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Re-reads every Clerk user's subscription, resolves their effective tier via the plan-key mapping
                    (Founders <span className="font-mono">nano</span> → Pro, <span className="font-mono">nanov2</span> → Nano, etc.),
                    writes <span className="font-mono">tier</span> + <span className="font-mono">subscribedPlanKey</span> on the user doc,
                    invalidates the tier cache, and re-denormalises <span className="font-mono">userTier</span> onto every check.
                    Idempotent — users already in sync are skipped. Safe to run anytime; use after the tier restructure deploy
                    to make grandfathering immediate rather than waiting for the 2h cache TTL.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleRecomputeTiers(true)}
                      variant="outline"
                      size="sm"
                      disabled={tierLoading}
                      className="cursor-pointer"
                    >
                      {tierLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                      Dry Run
                    </Button>
                    <Button
                      onClick={() => handleRecomputeTiers(false)}
                      variant="default"
                      size="sm"
                      disabled={tierLoading}
                      className="cursor-pointer"
                    >
                      {tierLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : null}
                      Recompute Tiers
                    </Button>
                  </div>
                  <LogConsole logs={tierLogs} />
                </CardContent>
              </div>
            </GlowCard>
          </div>
        </section>

      </div>
    </PageContainer>
  );
};

export default AdminDashboard;
