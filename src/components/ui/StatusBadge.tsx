import React from 'react';
import { Badge } from './badge';
import { CheckCircle, XCircle, HelpCircle, AlertTriangle, PauseCircle, Wrench } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { glass } from './glass';
import { formatDistanceToNow } from 'date-fns';

type Status = 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | 'disabled' | 'maintenance';

interface StatusTooltipData {
  httpStatus?: number;
  latencyMsP50?: number;
  latencyMsP95?: number;
  uptime24hPct?: number;
  uptime7dPct?: number;
  lastCheckTs?: number; // epoch ms
  sinceTs?: number; // epoch ms (last status change)
  failureReason?: string;
  regionCodes?: string[];
  ssl?: { valid?: boolean; daysUntilExpiry?: number };
}

interface StatusBadgeProps {
  status?: Status;
  className?: string;
  tooltip?: StatusTooltipData;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '', tooltip }) => {
  const getStatusConfig = (status?: Status) => {
    switch (status) {
      case 'online':
      case 'UP':
        return {
          icon: CheckCircle,
          variant: 'default' as const,
          className: 'bg-primary/20 text-primary border-primary/30',
          text: 'Online'
        };
      case 'offline':
      case 'DOWN':
        return {
          icon: XCircle,
          variant: 'destructive' as const,
          className: 'bg-destructive/20 text-destructive border-destructive/30',
          text: 'Offline'
        };
      case 'REDIRECT':
        return {
          icon: AlertTriangle,
          variant: 'secondary' as const,
          className: 'bg-primary/10 text-primary border-primary/30',
          text: 'Redirect'
        };
      case 'REACHABLE_WITH_ERROR':
        return {
          icon: AlertTriangle,
          variant: 'secondary' as const,
          className: 'bg-primary/20 text-primary border-primary/30',
          text: 'Error'
        };
      case 'maintenance':
        return {
          icon: Wrench,
          variant: 'secondary' as const,
          className: 'bg-amber-500/20 text-amber-600 border-amber-500/30',
          text: 'Maintenance'
        };
      case 'disabled':
        return {
          icon: PauseCircle,
          variant: 'secondary' as const,
          className: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
          text: 'Paused'
        };
      case 'unknown':
      default:
        return {
          icon: HelpCircle,
          variant: 'secondary' as const,
          className: 'bg-muted/20 text-muted-foreground border-muted/30',
          text: 'Unknown'
        };
    }
  };

  const config = getStatusConfig(status);

  const badgeEl = (
    <Badge
      variant={config.variant}
      className={`${config.className} ${className} flex items-center gap-1.5 px-2 py-1 text-xs font-medium cursor-pointer`}
    >
      <config.icon className="w-3 h-3" />
      {config.text}
    </Badge>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badgeEl}</TooltipTrigger>
      <TooltipContent
        className={`max-w-sm ${glass(status === 'offline' || status === 'DOWN' ? 'destructive' : status === 'disabled' || status === 'maintenance' ? 'warning' : 'primary')}`}
        sideOffset={8}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className={`rounded-md p-1.5 ${status === 'offline' || status === 'DOWN' ? 'bg-red-400/20' : status === 'disabled' || status === 'maintenance' ? 'bg-amber-400/20' : 'bg-sky-400/20'}`}>
              <config.icon className={`w-4 h-4 ${status === 'offline' || status === 'DOWN' ? 'text-destructive' : status === 'disabled' || status === 'maintenance' ? 'text-amber-500' : 'text-primary'}`} />
            </div>
            <span className="font-semibold tracking-wide">{config.text}</span>
          </div>

          {tooltip && (
            <div className="space-y-2 text-[12px] leading-5">
              {typeof tooltip.httpStatus === 'number' && (
                <div className="flex justify-between gap-4">
                  <div className="text-sky-100/70">HTTP</div>
                  <div className="font-medium">{tooltip.httpStatus}</div>
                </div>
              )}

              {(tooltip.latencyMsP50 || tooltip.latencyMsP95) && (
                <div className="flex justify-between gap-4">
                  <div className="text-sky-100/70">Latency</div>
                  <div className="font-medium">
                    {tooltip.latencyMsP50 ? `${tooltip.latencyMsP50}ms p50` : ''}
                    {tooltip.latencyMsP50 && tooltip.latencyMsP95 ? ' · ' : ''}
                    {tooltip.latencyMsP95 ? `${tooltip.latencyMsP95}ms p95` : ''}
                  </div>
                </div>
              )}

              {(tooltip.uptime24hPct != null || tooltip.uptime7dPct != null) && (
                <div className="flex justify-between gap-4">
                  <div className="text-sky-100/70">Uptime</div>
                  <div className="font-medium">
                    {tooltip.uptime24hPct != null ? `${tooltip.uptime24hPct}% 24h` : ''}
                    {tooltip.uptime24hPct != null && tooltip.uptime7dPct != null ? ' · ' : ''}
                    {tooltip.uptime7dPct != null ? `${tooltip.uptime7dPct}% 7d` : ''}
                  </div>
                </div>
              )}

              {tooltip.failureReason && (
                <div>
                  <div className="text-sky-100/70">Reason</div>
                  <div className="text-red-200 break-words">{tooltip.failureReason}</div>
                </div>
              )}

              {tooltip.regionCodes && tooltip.regionCodes.length > 0 && (
                <div className="flex justify-between gap-4">
                  <div className="text-sky-100/70">Regions</div>
                  <div className="font-medium">{tooltip.regionCodes.join(', ')}</div>
                </div>
              )}

              {tooltip.ssl && (
                <div className="flex justify-between gap-4">
                  <div className="text-sky-100/70">SSL</div>
                  <div className="font-medium">
                    {tooltip.ssl.valid ? 'valid' : 'invalid'}
                    {typeof tooltip.ssl.daysUntilExpiry === 'number' ? ` · ${tooltip.ssl.daysUntilExpiry}d` : ''}
                  </div>
                </div>
              )}

            </div>
          )}

          {tooltip && (tooltip.lastCheckTs || tooltip.sinceTs) && (
            <div className="text-[11px] leading-4 text-sky-100/70 border-t border-sky-300/20 pt-2">
              {tooltip.lastCheckTs && (
                <span>Last check {formatDistanceToNow(tooltip.lastCheckTs, { addSuffix: true })}</span>
              )}
              {tooltip.lastCheckTs && tooltip.sinceTs ? ' · ' : ''}
              {tooltip.sinceTs && (
                <span>{config.text} since {formatDistanceToNow(tooltip.sinceTs, { addSuffix: true })}</span>
              )}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

export default StatusBadge; 
