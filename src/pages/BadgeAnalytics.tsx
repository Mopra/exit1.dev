import React, { useState } from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import { useBadgeAnalytics } from '@/hooks/useBadgeAnalytics';
import { PageHeader, PageContainer } from '@/components/layout';
import {
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import GlowCard from '@/components/ui/glow-card';
import { Shield, RefreshCw, Eye, Globe, Code, Image } from 'lucide-react';
import { toast } from 'sonner';

const PERIOD_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
];

const BadgeAnalytics: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const [days, setDays] = useState(30);
  const { data, loading, error, refresh } = useBadgeAnalytics(days);

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
      toast.success('Badge analytics refreshed');
    } catch {
      toast.error('Failed to refresh badge analytics');
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
    <GlowCard className="p-0">
      <div className="m-1">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        </CardContent>
      </div>
    </GlowCard>
  );

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

  // Aggregate type stats
  const totalByType = (data?.byType ?? []).reduce(
    (acc, t) => {
      acc[t.badgeType] = (acc[t.badgeType] || 0) + t.views;
      return acc;
    },
    {} as Record<string, number>,
  );
  const totalEmbeds = (data?.byType ?? []).filter((t) => t.embed).reduce((s, t) => s + t.views, 0);
  const totalDirect = (data?.totalViews ?? 0) - totalEmbeds;
  const uniqueChecks = new Set((data?.byCheck ?? []).map((c) => c.checkId)).size;

  return (
    <PageContainer>
      <PageHeader
        title="Badge Analytics"
        description="Embeddable badge usage statistics"
        icon={Eye}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-md border">
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setDays(opt.value)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    days === opt.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  } ${opt.value === 7 ? 'rounded-l-md' : ''} ${opt.value === 90 ? 'rounded-r-md' : ''}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <Button
              onClick={handleRefresh}
              variant="outline"
              size="sm"
              disabled={loading}
              className="cursor-pointer"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
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
        {/* KPI cards */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard title="Total Views" value={data?.totalViews ?? 0} description={`Last ${days} days`} icon={Eye} />
            <KpiCard title="Unique Checks" value={uniqueChecks} description="Checks with badge views" icon={Globe} />
            <KpiCard title="Embed Views" value={totalEmbeds} description="Via script embed" icon={Code} />
            <KpiCard title="Direct Views" value={totalDirect} description="Direct image loads" icon={Image} />
          </div>
        )}

        {/* Daily views */}
        <section>
          <h3 className="text-lg font-semibold mb-4">Daily Views</h3>
          <GlowCard className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Unique IPs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                      </TableRow>
                    ))
                  ) : (data?.daily ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                        No badge views recorded yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    (data?.daily ?? []).map((row) => (
                      <TableRow key={row.day}>
                        <TableCell className="font-medium">{row.day}</TableCell>
                        <TableCell className="text-right">{row.views.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.uniqueIps.toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </GlowCard>
        </section>

        {/* By check */}
        <section>
          <h3 className="text-lg font-semibold mb-4">Top Checks</h3>
          <GlowCard className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check ID</TableHead>
                    <TableHead>User ID</TableHead>
                    <TableHead className="text-right">Views</TableHead>
                    <TableHead className="text-right">Unique IPs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                        <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                        <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                      </TableRow>
                    ))
                  ) : (data?.byCheck ?? []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                        No badge views recorded yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    (data?.byCheck ?? []).map((row) => (
                      <TableRow key={row.checkId}>
                        <TableCell className="font-mono text-xs">{row.checkId}</TableCell>
                        <TableCell className="font-mono text-xs">{row.userId}</TableCell>
                        <TableCell className="text-right">{row.views.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.uniqueIps.toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </GlowCard>
        </section>

        {/* Two columns: Referrers + By Type */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Referrers */}
          <section>
            <h3 className="text-lg font-semibold mb-4">Top Referrers</h3>
            <GlowCard className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Referrer</TableHead>
                      <TableHead className="text-right">Views</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                          <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                        </TableRow>
                      ))
                    ) : (data?.byReferrer ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={2} className="text-center text-muted-foreground py-8">
                          No referrer data yet
                        </TableCell>
                      </TableRow>
                    ) : (
                      (data?.byReferrer ?? []).map((row) => (
                        <TableRow key={row.referrer}>
                          <TableCell className="font-mono text-xs max-w-[300px] truncate">{row.referrer}</TableCell>
                          <TableCell className="text-right">{row.views.toLocaleString()}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </GlowCard>
          </section>

          {/* By type */}
          <section>
            <h3 className="text-lg font-semibold mb-4">By Badge Type</h3>
            <GlowCard className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Views</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                          <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                          <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                        </TableRow>
                      ))
                    ) : (data?.byType ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                          No badge views recorded yet
                        </TableCell>
                      </TableRow>
                    ) : (
                      (data?.byType ?? []).map((row, i) => (
                        <TableRow key={i}>
                          <TableCell className="capitalize">{row.badgeType}</TableCell>
                          <TableCell>{row.embed ? 'Embed' : 'Direct'}</TableCell>
                          <TableCell className="text-right">{row.views.toLocaleString()}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </GlowCard>
          </section>
        </div>
      </div>
    </PageContainer>
  );
};

export default BadgeAnalytics;
