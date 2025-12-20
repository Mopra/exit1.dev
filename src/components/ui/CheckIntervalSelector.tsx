import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Label } from './label';
import { Alert, AlertDescription, AlertTitle } from './alert';
import { Info } from 'lucide-react';

export const CHECK_INTERVALS = [
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 86400, label: '24 hours' }
] as const;

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
  const formatSeconds = (seconds: number) => {
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    const hours = Math.round(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  };

  const options = CHECK_INTERVALS.filter((i) => {
    if (minSeconds !== undefined && i.value < minSeconds) return false;
    if (maxSeconds !== undefined && i.value > maxSeconds) return false;
    return true;
  });

  const selectedInterval = CHECK_INTERVALS.find(interval => interval.value === value);

  return (
    <div className={`space-y-2 ${className}`}>
      {label && <Label>{label}</Label>}
      <Select
        value={value.toString()}
        onValueChange={(newValue) => onChange(parseInt(newValue))}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select interval">
            {selectedInterval?.label || formatSeconds(value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((interval) => (
            <SelectItem key={interval.value} value={interval.value.toString()}>
              {interval.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {helperText && (
        <p className="text-xs text-muted-foreground">
          {helperText}
        </p>
      )}
      {(value === 60 || value === 120) && (
        <Alert className="border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30">
          <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <AlertTitle className="text-blue-900 dark:text-blue-100 font-medium">
            Save short intervals for what really matters
          </AlertTitle>
          <AlertDescription className="text-blue-800 dark:text-blue-200 text-xs mt-1">
            <p className="mb-2">
              Use 1-2 minute checks only for sites or endpoints that are genuinely critical. Everything else? 5 minutes or longer works just fine.
            </p>
            <p>
              Longer intervals smooth out those inevitable 30-second DNS wobbles and network hiccups. You get cleaner analytics, less noise, and you won't get woken up for false alarms. The only trade-off is a few extra minutes before you're alerted—which is usually fine.
            </p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};

export default CheckIntervalSelector; 