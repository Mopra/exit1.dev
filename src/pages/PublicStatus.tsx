import React, { useEffect, useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle, XCircle, Shield, ExternalLink, Share2, Download } from 'lucide-react';
import { 
  Card, 
  CardContent,
  Badge,
  Skeleton,
  Button
} from '../components/ui';
import PixelCard from '../components/PixelCard';
import { PageContainer } from '../components/layout';
import { toast } from 'sonner';
import { copyToClipboard } from '../utils/clipboard';

interface BadgeData {
  checkId: string;
  name: string;
  url: string;
  uptimePercentage: number;
  lastChecked: number;
  status: string;
  createdAt?: number;
}

const PublicStatus: React.FC = () => {
  const { checkId } = useParams<{ checkId: string }>();
  const [data, setData] = useState<BadgeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const certificateRef = useRef<HTMLDivElement>(null);
  const [isDownloading, setIsDownloading] = useState(false);

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

  const handleShare = async () => {
    const currentUrl = window.location.href;
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${data?.name} - Trust Certificate`,
          text: `Check out the trust certificate for ${data?.name}`,
          url: currentUrl,
        });
        toast.success('Certificate shared successfully');
      } catch (err) {
        // User cancelled or error occurred
        if ((err as Error).name !== 'AbortError') {
          console.error('Error sharing:', err);
        }
      }
    } else {
      // Fallback: copy URL to clipboard
      const success = await copyToClipboard(currentUrl);
      if (success) {
        toast.success('Certificate link copied to clipboard');
      } else {
        toast.error('Failed to copy link to clipboard');
      }
    }
  };

  const handleDownload = async () => {
    if (!certificateRef.current || !data) return;

    setIsDownloading(true);
    try {
      // Wait a moment to ensure canvas animations are rendered
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Dynamically import html2canvas-pro to avoid HMR issues
      const html2canvas = (await import('html2canvas-pro')).default;
      
      // Find the actual PixelCard element (it's the first child div)
      const pixelCardElement = certificateRef.current.firstElementChild as HTMLElement;
      if (!pixelCardElement) {
        throw new Error('Could not find PixelCard element');
      }
      
      const canvas = await html2canvas(pixelCardElement, {
        useCORS: true,
        allowTaint: true,
        logging: false,
        scale: 3,
        width: pixelCardElement.offsetWidth,
        height: pixelCardElement.offsetHeight,
        windowWidth: pixelCardElement.scrollWidth,
        windowHeight: pixelCardElement.scrollHeight,
        backgroundColor: null,
        removeContainer: false,
        foreignObjectRendering: false,
        imageTimeout: 15000,
        onclone: (clonedDoc: Document) => {
          // Ensure all styles are properly computed in the cloned document
          const clonedElement = clonedDoc.body.querySelector(`[style*="relative"]`) || clonedDoc.body.firstElementChild;
          if (clonedElement) {
            (clonedElement as HTMLElement).style.position = 'relative';
          }
        },
      } as any);

      const link = document.createElement('a');
      link.download = `${data.name.replace(/[^a-z0-9]/gi, '_')}_certificate.png`;
      link.href = canvas.toDataURL('image/png', 1.0);
      link.click();

      toast.success('Certificate downloaded successfully');
    } catch (err) {
      console.error('Error downloading certificate:', err);
      toast.error('Failed to download certificate');
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <PageContainer className="min-h-screen">
      <div className="flex-1 flex items-center justify-center p-4 sm:p-6 min-h-full">
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
          <>
            <div ref={certificateRef}>
              <PixelCard 
                variant="blue" 
                className="w-full max-w-2xl min-h-[600px] aspect-auto border-2 shadow-lg bg-gradient-to-br from-primary/[0.02] via-transparent to-transparent border-primary/10"
              >
                <CardContent className="p12 absolute inset-0 z-10 flex flex-col justify-center pointer-events-auto">
                  <div className="text-center space-y-4 w-full">
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
                            {data.uptimePercentage >= 100 ? '100' : data.uptimePercentage.toFixed(1)}%
                          </div>
                          <div className="text-md text-muted-foreground mt-1">
                            {data.createdAt ? (
                              <div className="flex flex-col items-center">
                                <span>Uptime</span>
                                <span className="text-xs opacity-80">
                                  since {new Date(data.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                </span>
                              </div>
                            ) : (
                              "All-time Uptime"
                            )}
                          </div>
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
              </PixelCard>
            </div>
            
            {/* Share and Download Buttons */}
            <div className="flex items-center justify-center gap-4 mt-6">
              <Button
                variant="outline"
                onClick={handleShare}
                className="gap-2 cursor-pointer"
              >
                <Share2 className="h-4 w-4" />
                Share
              </Button>
              <Button
                variant="outline"
                onClick={handleDownload}
                disabled={isDownloading}
                className="gap-2 cursor-pointer"
              >
                <Download className="h-4 w-4" />
                {isDownloading ? 'Downloading...' : 'Download'}
              </Button>
            </div>
          </>
        ) : null}
        </div>
      </div>
    </PageContainer>
  );
};

export default PublicStatus;

