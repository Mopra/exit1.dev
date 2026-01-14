import React, { useState, useCallback, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Link } from 'react-router-dom';
import { useChecks } from '../hooks/useChecks';
import { Code2, HelpCircle, Award } from 'lucide-react';
import { Card, CardContent, SearchInput } from '../components/ui';
import { Button } from '../components/ui/button';
import { PageHeader, PageContainer } from '../components/layout';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { toast } from 'sonner';
import BadgeTable from '../components/badge/BadgeTable';
import { FEATURES } from '../config/features';

interface BadgeData {
  checkId: string;
  status: string;
  uptimePercentage: number;
  createdAt?: number;
}

const BadgePreview: React.FC<{ checkId: string }> = ({ checkId }) => {
  const [data, setData] = useState<BadgeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!FEATURES.embeddableBadges) {
      setLoading(false);
      return;
    }

    const fetchBadgeData = async () => {
      try {
        const response = await fetch(`https://badgedata-xq5qkyhwba-uc.a.run.app?checkId=${encodeURIComponent(checkId)}`);
        const result = await response.json();
        
        if (result.success && result.data) {
          setData(result.data);
        }
      } catch (error) {
        console.error('Failed to load badge preview:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchBadgeData();
  }, [checkId]);

  if (loading) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md">
        <span className="text-md text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-destructive/10 border border-destructive/20 rounded-md">
        <span className="text-md text-destructive">Failed to load</span>
      </div>
    );
  }

  const isOnline = data.status === 'online' || data.status === 'UP' || data.status === 'REDIRECT';
  const statusColor = isOnline ? '#10b981' : '#ef4444';
  const uptimeText = `${data.uptimePercentage.toFixed(2)}% Uptime`;

  return (
    <Link 
      to={`/status/${checkId}`}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border backdrop-blur-md transition-all cursor-pointer hover:-translate-y-0.5 max-w-full sm:gap-2 sm:px-3 sm:py-2"
      style={{
        background: 'rgba(14, 165, 233, 0.15)',
        borderColor: 'rgba(125, 211, 252, 0.2)',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        fontSize: 'clamp(0.75rem, 2.5vw, 0.875rem)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 25px 50px -12px rgba(14, 165, 233, 0.35)';
        e.currentTarget.style.borderColor = 'rgba(125, 211, 252, 0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '0 25px 50px -12px rgba(0, 0, 0, 0.25)';
        e.currentTarget.style.borderColor = 'rgba(125, 211, 252, 0.2)';
      }}
    >
      <svg viewBox="0 0 12 12" fill="none" className="flex-shrink-0 w-[clamp(10px,3vw,12px)] h-[clamp(10px,3vw,12px)]">
        <circle cx="6" cy="6" r="5" fill={statusColor} opacity="0.2"/>
        <circle cx="6" cy="6" r="3" fill={statusColor}/>
      </svg>
      <span className="font-semibold whitespace-nowrap" style={{ color: 'rgb(240, 249, 255)' }}>
        {uptimeText}
      </span>
      <span className="whitespace-nowrap hidden sm:inline-flex sm:items-center sm:gap-1" style={{ fontSize: '0.85em', color: 'rgb(186, 230, 253)' }}>
        — Verified by{' '}
        <a 
          href="https://exit1.dev" 
          target="_blank" 
          rel="noopener"
          className="underline underline-offset-2 transition-colors hover:text-sky-100"
          style={{ color: 'rgb(186, 230, 253)' }}
          onClick={(e) => e.stopPropagation()}
        >
          Exit1.dev
        </a>
      </span>
    </Link>
  );
};

type EmbedType = 'inline' | 'container' | 'fixed';

const Badge: React.FC = () => {
  const { userId } = useAuth();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [embedType, setEmbedType] = useState<EmbedType>('inline');
  const [searchQuery, setSearchQuery] = useState('');
  
  const log = useCallback((msg: string) => {
    console.log('[Badge]', msg);
  }, []);

  if (!FEATURES.embeddableBadges) {
    return (
      <PageContainer className="py-8">
        <PageHeader
          title="Embeddable Badges"
          description="Embeddable badges are temporarily disabled."
        />
        <Card className="max-w-xl">
          <CardContent className="flex flex-col gap-4 py-6">
            <p className="text-sm text-muted-foreground">
              Embeddable badges are currently turned off. You will be able to use them again once the feature is re-enabled.
            </p>
            <Button asChild className="w-fit cursor-pointer">
              <Link to="/checks">Back to checks</Link>
            </Button>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }
  
  const { checks, loading } = useChecks(userId || null, log);

  const getEmbedCode = (checkId: string, type: EmbedType = 'inline') => {
    const baseUrl = 'https://app.exit1.dev/badge.js';
    
    switch (type) {
      case 'inline':
        return `<script src="${baseUrl}" data-check-id="${checkId}"></script>`;
      case 'container':
        return `<!-- Place this div where you want the badge -->\n<div id="uptime-badge"></div>\n\n<!-- Place this script anywhere -->\n<script src="${baseUrl}" data-check-id="${checkId}" data-container="uptime-badge"></script>`;
      case 'fixed':
        return `<script src="${baseUrl}" data-check-id="${checkId}" data-position="bottom-right"></script>`;
      default:
        return `<script src="${baseUrl}" data-check-id="${checkId}"></script>`;
    }
  };

  const copyToClipboard = async (checkId: string, type: EmbedType) => {
    try {
      const embedCode = getEmbedCode(checkId, type);
      await navigator.clipboard.writeText(embedCode);
      setCopiedId(checkId);
      toast.success('Embed code copied to clipboard');
      
      setTimeout(() => {
        setCopiedId(null);
      }, 2000);
    } catch (error) {
      toast.error('Failed to copy to clipboard');
      console.error('Copy failed:', error);
    }
  };

  // Filter out disabled checks and apply search
  const activeChecks = checks.filter(check => !check.disabled);
  
  const filteredChecks = useCallback(() => {
    if (!searchQuery.trim()) return activeChecks;
    
    const query = searchQuery.toLowerCase();
    return activeChecks.filter(check => 
      check.name.toLowerCase().includes(query) ||
      check.url.toLowerCase().includes(query)
    );
  }, [activeChecks, searchQuery]);

  return (
    <PageContainer>
      <PageHeader 
        title="Embeddable Badges" 
        description="Display your uptime on your website to build trust with visitors"
        icon={Award}
      />

      <SearchInput 
        value={searchQuery} 
        onChange={setSearchQuery} 
        placeholder="Search checks..." 
      />

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 sm:p-6">

      {loading ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-md text-muted-foreground">Loading your checks...</p>
          </CardContent>
        </Card>
      ) : activeChecks.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-md text-muted-foreground">
              No active checks found. Create a check first to generate an embeddable badge.
            </p>
          </CardContent>
        </Card>
      ) : filteredChecks().length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-md text-muted-foreground">
              No checks match your search. Try a different query.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-card border-0">

          <CardContent className="space-y-6 px-0 py-4">
            <div className="flex flex-wrap gap-2 items-center">
              <Button
                variant={embedType === 'inline' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setEmbedType('inline')}
                className="cursor-pointer"
              >
                Inline
              </Button>
              <Button
                variant={embedType === 'container' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setEmbedType('container')}
                className="cursor-pointer"
              >
                Custom Container
              </Button>
              <Button
                variant={embedType === 'fixed' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setEmbedType('fixed')}
                className="cursor-pointer"
              >
                Fixed Position
              </Button>
              
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="cursor-pointer gap-1.5">
                    <HelpCircle className="h-4 w-4" />
                    How to use
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>Embedding Options</DialogTitle>
                    <DialogDescription className="text-md">
                      Choose the embedding style that works best for your website
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-6 mt-4">
                    <div className="space-y-2">
                      <h3 className="font-semibold text-md flex items-center gap-2">
                        <Code2 className="h-4 w-4" />
                        Inline (Default)
                      </h3>
                      <p className="text-md text-muted-foreground ml-6">
                        Badge appears exactly where you place the script tag. Perfect for embedding in footers, headers, or within page content.
                      </p>
                      <code className="block ml-6 mt-2 rounded bg-muted px-3 py-2 font-mono text-md">
                        {`<script src="..." data-check-id="xxx"></script>`}
                      </code>
                    </div>
                    
                    <div className="space-y-2">
                      <h3 className="font-semibold text-md flex items-center gap-2">
                        <Code2 className="h-4 w-4" />
                        Custom Container
                      </h3>
                      <p className="text-md text-muted-foreground ml-6">
                        Place a div wherever you want, and the badge will render inside it. Great for precise positioning in your layout.
                      </p>
                      <code className="block ml-6 mt-2 rounded bg-muted px-3 py-2 font-mono text-md whitespace-pre-wrap">
                        {`<div id="uptime-badge"></div>
<script src="..." data-check-id="xxx" data-container="uptime-badge"></script>`}
                      </code>
                    </div>
                    
                    <div className="space-y-2">
                      <h3 className="font-semibold text-md flex items-center gap-2">
                        <Code2 className="h-4 w-4" />
                        Fixed Position
                      </h3>
                      <p className="text-md text-muted-foreground ml-6">
                        Floating badge in a corner of the screen. Choose from: <code className="text-md bg-muted px-1 py-0.5 rounded">bottom-right</code>, <code className="text-md bg-muted px-1 py-0.5 rounded">bottom-left</code>, <code className="text-md bg-muted px-1 py-0.5 rounded">top-right</code>, <code className="text-md bg-muted px-1 py-0.5 rounded">top-left</code>
                      </p>
                      <code className="block ml-6 mt-2 rounded bg-muted px-3 py-2 font-mono text-md">
                        {`<script src="..." data-check-id="xxx" data-position="bottom-right"></script>`}
                      </code>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            
            <BadgeTable
              checks={filteredChecks()}
              embedType={embedType}
              getEmbedCode={getEmbedCode}
              onCopyCode={copyToClipboard}
              copiedId={copiedId}
              BadgePreview={BadgePreview}
            />
          </CardContent>
        </Card>
      )}
      </div>
    </PageContainer>
  );
};

export default Badge;

