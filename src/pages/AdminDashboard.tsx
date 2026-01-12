import React from 'react';
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
} from 'lucide-react';
import { toast } from 'sonner';

const AdminDashboard: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const { stats, loading: statsLoading, error, refresh } = useAdminStats();

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
      </div>
    </PageContainer>
  );
};

export default AdminDashboard;
