import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Mail, MessageSquare, ChevronUp, ChevronDown, Sparkles, AlertTriangle } from 'lucide-react';
import { useUsage } from '@/hooks/useUsage';
import { useNanoPlan } from '@/hooks/useNanoPlan';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export function UsageWidget() {
  const { usage, loading } = useUsage();
  const { nano, isLoading: nanoLoading } = useNanoPlan();
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false);

  const emailMonthly = usage.email?.monthly;
  const emailPercent = emailMonthly && emailMonthly.max > 0
    ? Math.min(100, Math.round((emailMonthly.count / emailMonthly.max) * 100))
    : 0;

  const smsMonthly = usage.sms?.monthly;
  const smsPercent = smsMonthly && smsMonthly.max > 0
    ? Math.min(100, Math.round((smsMonthly.count / smsMonthly.max) * 100))
    : 0;

  const isEmailAtLimit = emailPercent >= 100;
  const isEmailNearLimit = emailPercent >= 70;
  const isSmsAtLimit = smsPercent >= 100;
  const isSmsNearLimit = smsPercent >= 70;

  // Auto-expand for free users at limit (only once per session)
  useEffect(() => {
    if (!loading && !nanoLoading && !nano && isEmailAtLimit && !hasAutoExpanded) {
      setIsExpanded(true);
      setHasAutoExpanded(true);
    }
  }, [loading, nanoLoading, nano, isEmailAtLimit, hasAutoExpanded]);

  // Don't show while loading
  if (nanoLoading || loading) {
    return null;
  }
  
  const hasEmailUsage = emailMonthly && emailMonthly.max > 0;

  if (!hasEmailUsage) {
    return null;
  }

  // Overall warning state (for border color)
  const hasWarning = isEmailNearLimit || isSmsNearLimit;
  const hasLimit = isEmailAtLimit || isSmsAtLimit;
  
  // Show more prominent state for free users at limit
  const showLimitAlert = !nano && isEmailAtLimit;

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div
        className={cn(
          "rounded-lg border shadow-lg backdrop-blur-xl transition-all duration-200",
          "bg-background/95 dark:bg-background/90",
          isExpanded ? "w-72" : "w-auto",
          hasLimit && "border-destructive/50",
          hasWarning && !hasLimit && "border-amber-500/50"
        )}
      >
        {/* Collapsed state - just show a small indicator */}
        {!isExpanded && (
          <button
            onClick={() => setIsExpanded(true)}
            className="flex items-center gap-3 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5" />
              <span className={cn(
                isEmailAtLimit && "text-destructive",
                isEmailNearLimit && !isEmailAtLimit && "text-amber-500"
              )}>
                {emailMonthly?.count}/{emailMonthly?.max}
              </span>
            </span>
            {nano && smsMonthly && (
              <span className="flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" />
                <span className={cn(
                  isSmsAtLimit && "text-destructive",
                  isSmsNearLimit && !isSmsAtLimit && "text-amber-500"
                )}>
                  {smsMonthly.count}/{smsMonthly.max}
                </span>
              </span>
            )}
            <ChevronUp className="w-3 h-3 opacity-50" />
          </button>
        )}

        {/* Expanded state - show full details */}
        {isExpanded && (
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium flex items-center gap-2">
                Monthly Usage
                {nano && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95">
                    <Sparkles className="h-2.5 w-2.5" />
                    nano
                  </span>
                )}
              </h4>
              <button
                onClick={() => setIsExpanded(false)}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Limit reached alert for free users */}
            {showLimitAlert && (
              <div className="mb-3 p-2.5 rounded-md bg-destructive/10 border border-destructive/20">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <div className="text-xs">
                    <p className="font-medium text-destructive">Email limit reached</p>
                    <p className="text-muted-foreground mt-0.5">You won't receive email alerts until next month.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {/* Email usage */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Mail className="w-3.5 h-3.5" />
                    <span>Email alerts</span>
                  </div>
                  <span className={cn(
                    "font-medium",
                    isEmailAtLimit && "text-destructive",
                    isEmailNearLimit && !isEmailAtLimit && "text-amber-500"
                  )}>
                    {emailMonthly?.count}/{emailMonthly?.max}
                  </span>
                </div>
                <Progress 
                  value={emailPercent} 
                  className={cn(
                    "h-1.5",
                    isEmailAtLimit && "[&>div]:bg-destructive",
                    isEmailNearLimit && !isEmailAtLimit && "[&>div]:bg-amber-500"
                  )}
                />
              </div>

              {/* SMS usage - show actual usage for Nano, locked for free */}
              {nano && smsMonthly ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>SMS alerts</span>
                    </div>
                    <span className={cn(
                      "font-medium",
                      isSmsAtLimit && "text-destructive",
                      isSmsNearLimit && !isSmsAtLimit && "text-amber-500"
                    )}>
                      {smsMonthly.count}/{smsMonthly.max}
                    </span>
                  </div>
                  <Progress 
                    value={smsPercent} 
                    className={cn(
                      "h-1.5",
                      isSmsAtLimit && "[&>div]:bg-destructive",
                      isSmsNearLimit && !isSmsAtLimit && "[&>div]:bg-amber-500"
                    )}
                  />
                </div>
              ) : (
                <div className="space-y-1.5 opacity-50">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>SMS alerts</span>
                    </div>
                    <span className="text-muted-foreground text-[10px]">Nano only</span>
                  </div>
                  <Progress value={0} className="h-1.5" />
                </div>
              )}
            </div>

            {/* Upgrade CTA - only for free users */}
            {!nano && (
              <div className="mt-4 pt-3 border-t">
                <Button asChild size="sm" className="w-full gap-1.5 cursor-pointer h-8 text-xs">
                  <Link to="/billing">
                    <Sparkles className="w-3 h-3" />
                    Upgrade for 1000 emails + SMS
                  </Link>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
