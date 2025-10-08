import React, { useState, useCallback, useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useChecks } from '../hooks/useChecks';
import { Copy, Check, Code2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from 'sonner';

interface BadgeData {
  checkId: string;
  status: string;
  uptimePercentage: number;
}

const BadgePreview: React.FC<{ checkId: string }> = ({ checkId }) => {
  const [data, setData] = useState<BadgeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
    <div 
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border transition-all cursor-pointer hover:-translate-y-0.5 hover:shadow-md"
      style={{
        background: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
        borderColor: 'rgba(148, 163, 184, 0.2)',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="flex-shrink-0">
        <circle cx="6" cy="6" r="5" fill={statusColor} opacity="0.2"/>
        <circle cx="6" cy="6" r="3" fill={statusColor}/>
      </svg>
      <span className="text-md font-medium text-white whitespace-nowrap">
        {uptimeText}
      </span>
      <span className="text-xs text-slate-400 whitespace-nowrap">
        — Verified by Exit1.dev
      </span>
    </div>
  );
};

type EmbedType = 'inline' | 'container' | 'fixed';

const Badge: React.FC = () => {
  const { userId } = useAuth();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [embedType, setEmbedType] = useState<EmbedType>('inline');
  
  const log = useCallback((msg: string) => {
    console.log('[Badge]', msg);
  }, []);
  
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

  // Filter out disabled checks
  const activeChecks = checks.filter(check => !check.disabled);

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Embeddable Badges</h1>
        <p className="text-muted-foreground text-md">
          Display your uptime on your website to build trust with visitors
        </p>
      </div>

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
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Your Embeddable Badges</CardTitle>
            <CardDescription className="text-md">
              Choose your preferred embedding method and copy the code
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex gap-2">
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
            </div>
            
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-md">Check Name</TableHead>
                  <TableHead className="text-md">Preview</TableHead>
                  <TableHead className="text-md">Embed Code</TableHead>
                  <TableHead className="text-md w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeChecks.map((check) => {
                  const embedCode = getEmbedCode(check.id, embedType);
                  const isCopied = copiedId === check.id;
                  
                  return (
                    <TableRow key={check.id}>
                      <TableCell className="font-medium text-md">
                        <div className="flex flex-col gap-1">
                          <div>{check.name}</div>
                          <div className="text-md text-muted-foreground font-normal">{check.url}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <BadgePreview checkId={check.id} />
                      </TableCell>
                      <TableCell>
                        <code className="relative rounded bg-muted px-[0.5rem] py-[0.3rem] font-mono text-md break-all whitespace-pre-wrap inline-block max-w-full">
                          {embedCode}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyToClipboard(check.id, embedType)}
                          className="cursor-pointer"
                        >
                          {isCopied ? (
                            <>
                              <Check className="h-4 w-4 mr-2" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-4 w-4 mr-2" />
                              Copy
                            </>
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Embedding Options</CardTitle>
          <CardDescription className="text-md">
            Choose the method that works best for your website
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
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
        </CardContent>
      </Card>
    </div>
  );
};

export default Badge;

