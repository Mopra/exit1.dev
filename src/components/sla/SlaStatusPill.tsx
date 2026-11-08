import { cn } from '@/lib/utils';
import { SLA_STATUS_LABEL } from '@/lib/sla';
import type { SlaStatus } from '@/types';

const TONE: Record<SlaStatus, string> = {
  met: 'bg-success/15 text-success ring-success/25',
  on_track: 'bg-success/15 text-success ring-success/25',
  at_risk: 'bg-warning/15 text-warning ring-warning/25',
  breached: 'bg-destructive/15 text-destructive ring-destructive/25',
  no_data: 'bg-muted text-muted-foreground ring-border',
};

const DOT: Record<SlaStatus, string> = {
  met: 'bg-success',
  on_track: 'bg-success',
  at_risk: 'bg-warning',
  breached: 'bg-destructive',
  no_data: 'bg-muted-foreground',
};

/** Met / On track / At risk / Breached / No data. Always a text label, never color alone. */
export function SlaStatusPill({ status, size = 'md', className }: { status: SlaStatus; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium ring-1 ring-inset whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        TONE[status],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', DOT[status])} aria-hidden="true" />
      {SLA_STATUS_LABEL[status]}
    </span>
  );
}

/** Shown next to the status when less than half the time was measured. */
export function InsufficientDataPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-border text-muted-foreground whitespace-nowrap',
        className,
      )}
      title="Less than half of this month was measured"
    >
      Insufficient data
    </span>
  );
}
