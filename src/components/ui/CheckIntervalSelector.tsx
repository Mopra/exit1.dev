import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Label } from './label';

export const CHECK_INTERVALS = [
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
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
    </div>
  );
};

export default CheckIntervalSelector; 