import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClock } from '@fortawesome/free-solid-svg-icons';
import { Select } from './index';

export interface CheckInterval {
  value: number; // minutes
  label: string;
  description: string;
}

export const CHECK_INTERVALS: CheckInterval[] = [
  { value: 1, label: '1 minute', description: 'Very frequent monitoring' },
  { value: 10, label: '10 minutes', description: 'Standard monitoring' },
  { value: 60, label: '1 hour', description: 'Hourly monitoring' },
  { value: 1440, label: '1 day', description: 'Daily monitoring' },
];

interface CheckIntervalSelectorProps {
  value: number;
  onChange: (value: number) => void;
  label?: string;
  helperText?: string;
  disabled?: boolean;
  className?: string;
}

const CheckIntervalSelector: React.FC<CheckIntervalSelectorProps> = ({
  value,
  onChange,
  label = 'Check Interval',
  helperText,
  disabled = false,
  className = ''
}) => {
  const selectedInterval = CHECK_INTERVALS.find(interval => interval.value === value) || CHECK_INTERVALS[1]; // Default to 10 minutes

  const handleChange = (newValue: string) => {
    onChange(parseInt(newValue));
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <Select
        label={label}
        value={value.toString()}
        onChange={(e) => handleChange(e.target.value)}
        options={CHECK_INTERVALS.map(interval => ({
          value: interval.value.toString(),
          label: interval.label
        }))}
        leftIcon={<FontAwesomeIcon icon={faClock} className="w-4 h-4 text-blue-400" />}
        helperText={helperText || selectedInterval.description}
        disabled={disabled}
      />
    </div>
  );
};

export default CheckIntervalSelector; 