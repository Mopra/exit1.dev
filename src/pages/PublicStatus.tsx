import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle, XCircle, Shield, ExternalLink } from 'lucide-react';
import { 
  Card, 
  CardContent,
  Badge,
  Skeleton
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
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {loading ? (
          <Card className="border-2">
            <CardContent className="p-12">
              <div className="text-center space-y-6">
                <Skeleton className="h-12 w-48 mx-auto" />
                <Skeleton className="h-32 w-32 mx-auto rounded-full" />
                <Skeleton className="h-6 w-64 mx-auto" />
              </div>
            </CardContent>
          </Card>
        ) : error ? (
          <Card className="border-2 border-destructive/50">
            <CardContent className="p-12">
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
              </div>
            </CardContent>
          </Card>
        ) : data ? (
          <Card className="border-2 shadow-lg">
            <CardContent className="p-12">
              <div className="text-center space-y-8">
                {/* Header */}
                <div className="space-y-2">
                  <div className="flex items-center justify-center gap-2 text-md text-muted-foreground mb-4">
                    <Shield className="h-4 w-4" />
                    <span>Trust Certificate</span>
                  </div>
                  <h1 className="text-3xl font-bold break-words">{data.name}</h1>
                  <a 
                    href={data.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-md text-muted-foreground hover:text-primary cursor-pointer transition-colors break-all"
                  >
                    <ExternalLink className="h-4 w-4 flex-shrink-0" />
                    {data.url}
                  </a>
                </div>

                {/* Status Badge */}
                <div>
                  <Badge 
                    variant={isOnline ? 'success' : 'error'} 
                    className="gap-2 px-6 py-3 text-lg cursor-default"
                  >
                    {isOnline ? (
                      <>
                        <CheckCircle className="h-5 w-5" />
                        Online
                      </>
                    ) : (
                      <>
                        <XCircle className="h-5 w-5" />
                        Offline
                      </>
                    )}
                  </Badge>
                </div>

                {/* Uptime Circle */}
                <div className="py-4">
                  <div className="inline-flex items-center justify-center w-40 h-40 rounded-full border-8 border-primary/20 bg-primary/5">
                    <div className="text-center">
                      <div className="text-4xl font-bold">
                        {data.uptimePercentage.toFixed(2)}%
                      </div>
                      <div className="text-md text-muted-foreground mt-1">Uptime</div>
                    </div>
                  </div>
                </div>

                {/* Last Checked */}
                {data.lastChecked > 0 && (
                  <div className="text-md text-muted-foreground">
                    Last verified: {new Date(data.lastChecked).toLocaleString()}
                  </div>
                )}

                {/* Verified By */}
                <div className="pt-6 border-t">
                  <div className="flex items-center justify-center gap-2 text-md text-muted-foreground">
                    <Shield className="h-4 w-4" />
                    <span>Verified by</span>
                    <a 
                      href="https://exit1.dev" 
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-foreground hover:text-primary cursor-pointer transition-colors"
                    >
                      exit1.dev
                    </a>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
};

export default PublicStatus;

