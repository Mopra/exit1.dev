import { cn } from '@/lib/utils';

/**
 * How much of the error budget the month has burned. Green under 75%, amber
 * from 75%, red once it is spent. Over 100% the bar stays full and the label
 * carries the real figure.
 */
export function ErrorBudgetBar({ used, className, showLabel = true }: { used: number; className?: string; showLabel?: boolean }) {
  const safe = Number.isFinite(used) && used > 0 ? used : 0;
  const pct = Math.min(100, safe * 100);
  const tone = safe >= 1 ? 'bg-destructive' : safe >= 0.75 ? 'bg-warning' : 'bg-success';
  const label = safe >= 10 ? `${Math.round(safe * 100).toLocaleString('en-US')}%` : `${(safe * 100).toFixed(safe < 0.1 && safe > 0 ? 1 : 0)}%`;

  return (
    <div className={cn('space-y-1.5', className)}>
      {showLabel && (
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Error budget used</span>
          <span className={cn('font-mono tabular-nums', safe >= 1 ? 'text-destructive' : safe >= 0.75 ? 'text-warning' : 'text-foreground')}>
            {label}
          </span>
        </div>
      )}
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="Error budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className={cn('h-full rounded-full transition-[width] duration-500', tone)} style={{ width: `${pct}%` }} />
        {/* 75% mark: where a month turns "at risk". */}
        <div className="absolute inset-y-0 left-3/4 w-px bg-background/80" aria-hidden="true" />
      </div>
    </div>
  );
}
