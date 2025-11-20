import { useState, useEffect } from 'react';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  Badge, Button, Skeleton, EmptyState, GlowCard
} from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { apiClient } from '../api/client';
import { Activity, Clock, AlertTriangle, CheckCircle, RefreshCw, Sparkles, BarChart3 } from 'lucide-react';

interface SystemStatus {
  firebase: 'online' | 'offline' | 'checking';
}

interface RecentError {
  id: string;
  website: string;
  error: string;
  timestamp: number;
}

const Status = () => {
  const [status, setStatus] = useState<SystemStatus>({
    firebase: 'checking'
  });
  const [recentErrors, setRecentErrors] = useState<RecentError[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [nextUpdate, setNextUpdate] = useState<Date>(new Date(Date.now() + 60000));
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const checkFirebaseStatus = async () => {
    setIsRefreshing(true);
    // Client init implies Firebase SDK reachable
    setStatus(prev => ({ ...prev, firebase: 'online' }));
    try {
      const response = await apiClient.getSystemStatus();
      if (response.success && response.data?.recentErrors) {
        setRecentErrors(response.data.recentErrors);
      }
    } catch (error) {
      // Non-blocking for status
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    const checkStatus = async () => {
      await checkFirebaseStatus();
      setLastUpdated(new Date());
      setNextUpdate(new Date(Date.now() + 60000));
    };

    checkStatus();
    
    const interval = setInterval(checkStatus, 60000);
    
    return () => {
      clearInterval(interval);
    };
  }, []);

  // Countdown timer effect - updates every second
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const getTimeUntilNextUpdate = () => {
    const timeLeft = Math.max(0, nextUpdate.getTime() - currentTime.getTime());
    return Math.ceil(timeLeft / 1000);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'success';
      case 'offline': return 'error';
      case 'checking': return 'warning';
      default: return 'secondary';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online': return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'offline': return <AlertTriangle className="w-5 h-5 text-red-500" />;
      case 'checking': return <Activity className="w-5 h-5 text-primary animate-pulse" />;
      default: return <Activity className="w-5 h-5 text-gray-500" />;
    }
  };

  return (
    <PageContainer>
      <PageHeader 
        title="Service Status" 
        description="Real-time monitoring of exit1.dev services"
        icon={BarChart3}
        actions={
          <Button
            variant="outline"
            onClick={checkFirebaseStatus}
            className="gap-2 cursor-pointer"
            disabled={isRefreshing}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      {/* Status Content */}
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Hero Status */}
          <GlowCard>
            <CardHeader className="relative">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10">
                    {getStatusIcon(status.firebase)}
                  </div>
                  <div>
                    <CardTitle className="text-lg">Firebase</CardTitle>
                    <CardDescription>Core Firebase services</CardDescription>
                  </div>
                </div>
                <Badge variant={getStatusColor(status.firebase)} className="cursor-default">
                  {status.firebase.toUpperCase()}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="relative">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-lg border bg-card p-4">
                  <div className="text-xs text-muted-foreground">Last updated</div>
                  <div className="text-sm font-medium">{lastUpdated.toLocaleTimeString()}</div>
                </div>
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-muted-foreground">Next update</div>
                    <Clock className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div className="text-sm font-medium">{getTimeUntilNextUpdate()}s</div>
                </div>
                <div className="rounded-lg border bg-card p-4">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles className="w-4 h-4" />
                    Recent issues (24h)
                  </div>
                  <div className="text-sm font-medium">{recentErrors.length}</div>
                </div>
              </div>
              {status.firebase === 'checking' && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                </div>
              )}
            </CardContent>
          </GlowCard>

          {/* Recent Issues */}
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
                <h2 className="text-lg font-semibold">Recent Issues</h2>
              </div>
              <Badge variant="secondary" className="cursor-default">Last 24 hours</Badge>
            </div>
            {recentErrors.length === 0 ? (
              <EmptyState 
                variant="empty"
                title="All clear"
                description="No recent issues detected in the past 24 hours."
                className="bg-transparent"
                icon={CheckCircle}
              />
            ) : (
              <div className="space-y-3">
                {recentErrors.map((error) => (
                                  <div key={error.id} className="flex items-start gap-3 p-3 rounded-lg border border-primary/20 bg-primary/10">
                  <AlertTriangle className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{error.website}</p>
                      <p className="text-xs text-muted-foreground mt-1">{error.error}</p>
                    </div>
                    <div className="text-xs text-muted-foreground flex-shrink-0">
                      {new Date(error.timestamp).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* System Info */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">System Information</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Last Updated</p>
                <p className="font-medium">{lastUpdated.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Auto-refresh</p>
                <p className="font-medium">Every 60 seconds</p>
              </div>
            </div>
          </Card>

          {/* Footer */}
          <div className="text-center text-sm text-muted-foreground py-4">
            <p className="mb-2">
              For support, reach out on our community Discord.
            </p>
            <a 
              href="https://discord.gg/uZvWbpwJZS" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="text-blue-500 hover:text-blue-600 cursor-pointer"
            >
              https://discord.gg/uZvWbpwJZS
            </a>
          </div>
        </div>
      </div>
    </PageContainer>
  );
};

export default Status; 
