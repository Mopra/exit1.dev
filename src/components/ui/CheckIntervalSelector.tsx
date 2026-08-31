import React from 'react';
import { Lock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './Select';
import { Label } from './Label';
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
  // Minimum and maximum allowed interval in seconds (optional)
  minSeconds?: number;
  maxSeconds?: number;
  /**
   * Called when the user picks an interval their plan does not allow, with the
   * cheapest tier that does. When omitted, faster intervals are hidden entirely
   * (the old behaviour) rather than shown locked.
   *
   * Providing this is strongly preferred. Interval speed is the main thing the paid
   * tiers sell, and filtering the faster options out of the list meant the one
   * differentiator worth paying for was invisible to exactly the people being asked
   * to pay for it.
   */
  onLockedSelect?: (seconds: number, tierName: string) => void;
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
  onLockedSelect,
}) => {
  const formatSeconds = (seconds: number) => {
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    const hours = Math.round(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  };

  const isLocked = (seconds: number) => minSeconds !== undefined && seconds < minSeconds;

  const options = CHECK_INTERVALS.filter((i) => {
    // The upper bound is a real constraint, not an upsell: there is no tier that
    // adds slower checks, so those stay filtered.
    if (maxSeconds !== undefined && i.value > maxSeconds) return false;
    // Without an onLockedSelect handler there is nowhere for a locked pick to go,
    // so fall back to hiding them.
    if (!onLockedSelect && isLocked(i.value)) return false;
    return true;
  });

  const selectedInterval = CHECK_INTERVALS.find(interval => interval.value === value);

  return (
    <div className={`space-y-2 ${className}`}>
      {label && <Label>{label}</Label>}
      <Select
        value={value.toString()}
        onValueChange={(newValue) => {
          const seconds = parseInt(newValue);
          if (isLocked(seconds)) {
            // Do NOT apply it. Radix has already closed the menu, so the parent
            // gets to explain the gate and the field keeps its previous value.
            const tier = cheapestTierForIntervalSeconds(seconds);
            onLockedSelect?.(seconds, tier?.name ?? 'a paid plan');
            return;
          }
          onChange(seconds);
        }}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select interval">
            {selectedInterval?.label || formatSeconds(value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((interval) => {
            const locked = isLocked(interval.value);
            const tier = locked ? cheapestTierForIntervalSeconds(interval.value) : null;
            return (
              <SelectItem key={interval.value} value={interval.value.toString()}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span className={locked ? 'text-muted-foreground' : undefined}>
                    {interval.label}
                  </span>
                  {locked && tier && (
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
      {helperText && (
        <p className="text-xs text-muted-foreground">
          {helperText}
        </p>
      )}
    </div>
  );
};

export default CheckIntervalSelector;
