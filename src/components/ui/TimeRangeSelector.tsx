import React from 'react';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

export type TimeRange = '1h' | '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

interface TimeRangeSelectorProps {
  value: TimeRange | string;
  onChange: (range: TimeRange | string) => void;
  className?: string;
  variant?: 'compact' | 'full';
  options?: (TimeRange | string)[];
  disabled?: boolean;
}

const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({
  value,
  onChange,
  className = '',
  variant = 'full',
  options,
  disabled = false
}) => {
  const defaultOptions: TimeRange[] = ['24h', '7d', '30d', '90d', '1y', 'all'];
  const displayOptions = options || (variant === 'compact' ? ['24h', '7d'] : defaultOptions);

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(newValue) => {
        if (disabled) return;
        if (newValue) {
          onChange(newValue as TimeRange);
        }
      }}
      variant="outline"
      size="default"
      className={`${className} ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
    >
      {displayOptions.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          className={`px-3 py-1 text-xs font-medium ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
          aria-label={`Time range ${option}`}
          aria-disabled={disabled}
          disabled={disabled}
        >
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};

export default TimeRangeSelector; 