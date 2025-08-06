import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Label } from './label';

export const CHECK_INTERVALS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 7200, label: '2 hours' },
  { value: 14400, label: '4 hours' },
  { value: 28800, label: '8 hours' },
  { value: 86400, label: '24 hours' }
] as const;

interface CheckIntervalSelectorProps {
  value: number;
  onChange: (interval: number) => void;
  label?: string;
  helperText?: string;
  className?: string;
  disabled?: boolean;
}

const CheckIntervalSelector: React.FC<CheckIntervalSelectorProps> = ({
  value,
  onChange,
  label = 'Check Interval',
  helperText,
  className = '',
  disabled = false
}) => {
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
            {selectedInterval?.label || 'Select interval'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CHECK_INTERVALS.map((interval) => (
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