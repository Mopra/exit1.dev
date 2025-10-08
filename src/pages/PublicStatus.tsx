import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { CheckCircle, XCircle, Shield, Activity, Clock, TrendingUp, ExternalLink, Sparkles } from 'lucide-react';
import { 
  Card, 
  CardHeader, 
  CardTitle, 
  CardDescription, 
  CardContent,
  Badge,
  Button,
  Skeleton,
  GlowCard
} from '../components/ui';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  uptimePercentage: number;
  lastChecked: number;
  status: string;
}

const PublicStatus: React.FC = () => {
  const { checkId } = useParams<{ checkId: string }>();
  const [data, setData] = useState<BadgeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      if (!checkId) {
        setError('Invalid check ID');
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(
          `https://badgedata-xq5qkyhwba-uc.a.run.app?checkId=${checkId}`
        );

        if (!response.ok) {
          if (response.status === 404) {
            setError('Check not found');
          } else {
            setError('Failed to load status');
          }
          setLoading(false);
          return;
        }

        const result = await response.json();
        
        if (result.success && result.data) {
          setData(result.data);
        } else {
          setError('Invalid response from server');
        }
      } catch (err) {
        console.error('Error fetching badge data:', err);
        setError('Failed to load status');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [checkId]);

  const isOnline = data?.status === 'online' || data?.status === 'UP' || data?.status === 'REDIRECT';

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2 cursor-pointer">
              <img src="/e_.svg" alt="Exit1.dev" className="h-8" />
              <span className="text-xl font-bold">exit1.dev</span>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 cursor-default">
              <Shield className="h-3 w-3" />
              <span className="text-md">Public Status</span>
            </Badge>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {loading ? (
            <>
              <GlowCard magic>
                <CardHeader>
                  <Skeleton className="h-8 w-64 mb-2" />
                  <Skeleton className="h-4 w-48" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-32 w-full" />
                </CardContent>
              </GlowCard>
              <Card>
                <CardContent className="pt-6">
                  <Skeleton className="h-48 w-full" />
                </CardContent>
              </Card>
            </>
          ) : error ? (
            <Card className="border-destructive/50">
              <CardContent className="pt-12 pb-12">
                <div className="text-center space-y-4">
                  <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                    <XCircle className="h-8 w-8 text-destructive" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-semibold mb-2">{error}</h2>
                    <p className="text-md text-muted-foreground">
                      This check may not exist or has been disabled
                    </p>
                  </div>
                  <Button asChild className="mt-4 cursor-pointer">
                    <a href="https://exit1.dev">Visit Exit1.dev</a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : data ? (
            <>
              {/* Hero Status Card */}
              <GlowCard magic>
                <CardHeader>
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="space-y-1 flex-1 min-w-0">
                      <CardTitle className="text-2xl sm:text-3xl break-words">{data.name}</CardTitle>
                      <CardDescription className="flex items-center gap-2 text-md break-all">
                        <ExternalLink className="h-4 w-4 flex-shrink-0" />
                        <a 
                          href={data.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-primary cursor-pointer transition-colors"
                        >
                          {data.url}
                        </a>
                      </CardDescription>
                    </div>
                    <Badge 
                      variant={isOnline ? 'success' : 'error'} 
                      className="gap-2 px-4 py-2 text-md cursor-default"
                    >
                      {isOnline ? (
                        <>
                          <CheckCircle className="h-4 w-4" />
                          Online
                        </>
                      ) : (
                        <>
                          <XCircle className="h-4 w-4" />
                          Offline
                        </>
                      )}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {/* Uptime Metric */}
                  <div className="rounded-lg border bg-card/50 p-8 text-center backdrop-blur-sm">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 mb-4">
                      <TrendingUp className="h-6 w-6 text-primary" />
                    </div>
                    <div className="space-y-2">
                      <div className="text-6xl font-bold tracking-tight">
                        {data.uptimePercentage.toFixed(2)}%
                      </div>
                      <p className="text-md text-muted-foreground font-medium">All-Time Uptime</p>
                    </div>
                  </div>
                </CardContent>
              </GlowCard>

              {/* Details Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Status Info */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-md">Current Status</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-md text-muted-foreground">State</span>
                        <Badge variant={isOnline ? 'success' : 'error'} className="cursor-default">
                          {isOnline ? 'Operational' : 'Down'}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-md text-muted-foreground">Monitoring</span>
                        <Badge variant="secondary" className="cursor-default">Active</Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Last Check Info */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-md">Last Verified</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {data.lastChecked > 0 ? (
                        <>
                          <div className="text-md font-medium">
                            {new Date(data.lastChecked).toLocaleDateString(undefined, { 
                              month: 'long', 
                              day: 'numeric', 
                              year: 'numeric' 
                            })}
                          </div>
                          <div className="text-md text-muted-foreground">
                            {new Date(data.lastChecked).toLocaleTimeString(undefined, { 
                              hour: '2-digit', 
                              minute: '2-digit',
                              second: '2-digit'
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="text-md text-muted-foreground">No data available</div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Verified Badge */}
              <Card className="border-primary/20 bg-primary/5">
                <CardContent className="pt-6">
                  <div className="flex items-center justify-center gap-3 text-center">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <Shield className="h-5 w-5 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-md font-medium">Verified & Monitored by Exit1.dev</p>
                      <p className="text-md text-muted-foreground">
                        Real-time monitoring with instant alerts
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* CTA Card */}
              <Card>
                <CardContent className="pt-6 pb-6">
                  <div className="text-center space-y-4">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5 mb-2">
                      <Sparkles className="h-6 w-6 text-primary" />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-xl font-semibold">Monitor Your Website</h3>
                      <p className="text-md text-muted-foreground max-w-md mx-auto">
                        Get instant alerts, track uptime, and ensure your website is always online
                      </p>
                    </div>
                    <div className="flex gap-3 justify-center pt-2 flex-wrap">
                      <Button asChild size="lg" className="cursor-pointer">
                        <a href="https://app.exit1.dev/sign-up">Get Started Free</a>
                      </Button>
                      <Button asChild variant="outline" size="lg" className="cursor-pointer">
                        <a href="https://exit1.dev">Learn More</a>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : null}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t mt-12">
        <div className="container mx-auto px-4 sm:px-6 py-8">
          <div className="text-center space-y-2">
            <p className="text-md text-muted-foreground">
              © {new Date().getFullYear()} Exit1.dev. All rights reserved.
            </p>
            <div className="flex justify-center gap-6 text-md">
              <a 
                href="https://exit1.dev" 
                className="text-muted-foreground hover:text-primary cursor-pointer transition-colors"
              >
                Website
              </a>
              <a 
                href="https://discord.gg/uZvWbpwJZS" 
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-primary cursor-pointer transition-colors"
              >
                Discord
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default PublicStatus;

