import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';
import { Label } from './Label';
import { Button } from './Button';
import { cheapestTierForIntervalSeconds } from '../../lib/subscription';



export const CHECK_INTERVALS = [
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 86400, label: '24 hours' }
] as const;

/** Human label for an interval in seconds. Falls back for off-ladder values. */
export function formatIntervalLabel(seconds: number): string {
  const known = CHECK_INTERVALS.find((i) => i.value === seconds);
  if (known) return known.label;
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

interface CheckIntervalSelectorProps {
  value: number;
  onChange: (interval: number) => void;
  label?: string;
  helperText?: string;
  className?: string;
  disabled?: boolean;
  /**
   * The plan floor in seconds. Faster intervals are shown locked with the tier
   * that unlocks them, and picking one renders an upgrade hint instead of
   * applying. Interval speed is the main thing the paid tiers sell; the old
   * behaviour of filtering those options out of the list made the one
   * differentiator worth paying for invisible to exactly the people being asked to
   * pay for it.
   */
  minSeconds?: number;
  /** Slower ceiling. A real constraint, not an upsell: nothing sells slower checks. */
  maxSeconds?: number;
}

const CheckIntervalSelector: React.FC<CheckIntervalSelectorProps> = ({
  value,
  onChange,
  label = 'Check Interval',
  helperText,
  className = '',
  disabled = false,
  minSeconds,
  maxSeconds,
}) => {
  const [locked, setLocked] = useState<{ seconds: number; tierName: string } | null>(null);

  const isLocked = (seconds: number) => minSeconds !== undefined && seconds < minSeconds;

  const options = CHECK_INTERVALS.filter((i) => maxSeconds === undefined || i.value <= maxSeconds);

  return (
    <div className={`space-y-2 ${className}`}>
      {label && <Label>{label}</Label>}
      <Select
        value={value.toString()}
        onValueChange={(newValue) => {
          const seconds = parseInt(newValue);
          if (isLocked(seconds)) {
            // Do NOT apply it. Radix has already closed the menu, so the hint below
            // explains the gate and the field keeps its previous value.
            const tier = cheapestTierForIntervalSeconds(seconds);
            setLocked({ seconds, tierName: tier?.name ?? 'a paid plan' });
            return;
          }
          setLocked(null);
          onChange(seconds);
        }}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select interval">
            {formatIntervalLabel(value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((interval) => {
            const lockedOption = isLocked(interval.value);
            const tier = lockedOption ? cheapestTierForIntervalSeconds(interval.value) : null;
            return (
              <SelectItem key={interval.value} value={interval.value.toString()}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span className={lockedOption ? 'text-muted-foreground' : undefined}>
                    {interval.label}
                  </span>
                  {lockedOption && tier && (
                    <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      <Lock className="size-3" />
                      {tier.name}
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {locked && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
          <Lock className="size-3.5 shrink-0 text-primary" />
          <span className="text-foreground">
            {formatIntervalLabel(locked.seconds)} checks are on {locked.tierName} and up.
          </span>
          <Button
            asChild
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs font-semibold cursor-pointer"
          >
            <Link to="/billing?tab=plans">See plans</Link>
          </Button>
        </div>
      )}
      {helperText && (
        <p className="text-xs text-muted-foreground">
          {helperText}
        </p>
      )}
    </div>
  );
};

export default CheckIntervalSelector;
