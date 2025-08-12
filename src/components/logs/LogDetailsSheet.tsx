import React from 'react';
import { Button, ScrollArea, Sheet, SheetContent } from '../ui';
import { Badge } from '../ui/badge';
// Removed unused Separator
// Removed internal ScrollArea to avoid inner scrolling and overflow
import { Copy, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import StatusBadge from '../ui/StatusBadge';
import { formatResponseTime } from '../../utils/formatters';
import { copyToClipboard, copyRowData } from '../../utils/clipboard';
import { GlassSection } from "../ui/glass";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

interface LogEntry {
  id: string;
  websiteId: string;
  websiteName: string;
  websiteUrl: string;
  time: string;
  date: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  statusCode?: number;
  responseTime?: number;
  error?: string;
  timestamp: number;
}

interface LogDetailsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  logEntry: LogEntry | null;
}

export const LogDetailsSheet: React.FC<LogDetailsSheetProps> = ({
  isOpen,
  onClose,
  logEntry
}) => {
  const handleCopy = async (text: string, type: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      // Could add toast notification here
      console.log(`${type} copied to clipboard`);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online':
      case 'UP':
      case 'REDIRECT':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'offline':
      case 'DOWN':
      case 'REACHABLE_WITH_ERROR':
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <AlertCircle className="w-4 h-4 text-yellow-500" />;
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-full sm:max-w-sm md:max-w-md lg:max-w-lg p-0">
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex flex-col gap-2 p-4 pr-12 sm:pr-14 border-b bg-background/80 backdrop-blur supports-backdrop-blur:backdrop-blur-md">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
              <div className="flex items-center gap-3 min-w-0">
                {logEntry && (
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 flex-shrink-0">
                    {getStatusIcon(logEntry.status)}
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold truncate">Log Details</h2>
                  {logEntry && (
                    <p className="text-xs text-muted-foreground truncate">{`${logEntry.time} • ${logEntry.date}`}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {logEntry && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label="Copy all details"
                          onClick={() => handleCopy(copyRowData(logEntry), 'All Details')}
                          className="h-8 px-2 cursor-pointer"
                        >
                          <Copy className="w-4 h-4 mr-2" />
                          Copy all
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Copy all details</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          </div>

          {/* Body */}
          <ScrollArea className="flex-1">
            <div className="px-4 sm:px-6 py-4 space-y-4">
              {logEntry ? (
                <div className="space-y-4">
                  <GlassSection className="rounded-lg p-3 sm:p-4">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium break-words">{logEntry.websiteName}</div>
                        <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                          <span className="break-all" title={logEntry.websiteUrl}>{logEntry.websiteUrl}</span>
                        </div>
                      </div>
                    </div>
                  </GlassSection>

                  {/* Status & Timing */}
                  <GlassSection className="rounded-lg p-3 sm:p-4">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Status & Timing</div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">Status</span>
                        <div className="flex-shrink-0"><StatusBadge status={logEntry.status} /></div>
                      </div>
                      {logEntry.statusCode && (
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-muted-foreground">Status Code</span>
                          <Badge variant="outline" className="flex-shrink-0">{logEntry.statusCode}</Badge>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">Response Time</span>
                        <span className="font-mono text-sm flex-shrink-0">
                          {logEntry.responseTime ? formatResponseTime(logEntry.responseTime) : 'N/A'}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-sm text-muted-foreground">Timestamp</span>
                        <span className="font-mono text-xs break-all text-right max-w-[60%]">{new Date(logEntry.timestamp).toISOString()}</span>
                      </div>
                    </div>
                  </GlassSection>

                  {/* Error Details */}
                  {logEntry.error && (
                    <GlassSection className="rounded-lg p-3 sm:p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-medium">Error Details</h3>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopy(logEntry.error!, 'Error')}
                          className="h-8 px-2 cursor-pointer"
                        >
                          <Copy className="w-4 h-4 mr-1" />
                          Copy
                        </Button>
                      </div>
                      <div className="rounded-lg p-3 bg-background/60 border">
                        <pre className="text-sm font-mono text-muted-foreground whitespace-pre-wrap break-words max-h-40 overflow-auto">
                          {logEntry.error}
                        </pre>
                      </div>
                    </GlassSection>
                  )}

                  {/* Raw Data */}
                  <GlassSection className="rounded-lg p-3 sm:p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium">Raw Data</h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCopy(copyRowData(logEntry), 'JSON')}
                        className="h-8 px-2 cursor-pointer"
                      >
                        <Copy className="w-4 h-4 mr-1" />
                        Copy JSON
                      </Button>
                    </div>
                    <div className="rounded-lg p-3 bg-background/60 border">
                      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words max-h-60 overflow-auto">
                        {JSON.stringify(logEntry, null, 2)}
                      </pre>
                    </div>
                  </GlassSection>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">No details</div>
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
};
