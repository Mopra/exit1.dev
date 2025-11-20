import React from 'react';
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
  Eye
} from 'lucide-react';
import { Button } from '@/components/ui';
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
    trend 
  }: { 
    title: string; 
    value: string | number; 
    description: string; 
    icon: React.ElementType;
    trend?: string;
  }) => (
    <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg cursor-pointer hover:shadow-xl transition-shadow">
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <KpiCard
              title="Checks with Badges"
              value={stats?.badgeUsage?.checksWithBadges || 0}
              description="Checks using badges on sites"
              icon={Award}
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

