import React from 'react';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';

export type TimeRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

interface TimeRangeSelectorProps {
  value: TimeRange | string;
  onChange: (range: TimeRange | string) => void;
  className?: string;
  variant?: 'compact' | 'full';
  options?: (TimeRange | string)[];
}

const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({
  value,
  onChange,
  className = '',
  variant = 'full',
  options
}) => {
  const defaultOptions: TimeRange[] = ['24h', '7d', '30d', '90d', '1y', 'all'];
  const displayOptions = options || (variant === 'compact' ? ['24h', '7d'] : defaultOptions);

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(newValue) => {
        if (newValue) {
          onChange(newValue as TimeRange);
        }
      }}
      variant="outline"
      size="default"
      className={className}
    >
      {displayOptions.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          className="px-3 py-1 text-xs font-medium cursor-pointer"
          aria-label={`Time range ${option}`}
        >
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};

export default TimeRangeSelector; 