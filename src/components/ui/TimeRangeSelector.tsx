import React from 'react';
import { typography } from '../../config/theme';

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
  variant = 'compact',
  options
}) => {
  // Default options for compact variant (like Statistics page)
  const defaultCompactOptions: { value: TimeRange; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' }
  ];

  // Full options for logs page
  const defaultFullOptions: { value: TimeRange; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: '90d', label: '90d' },
    { value: '1y', label: '1y' },
    { value: 'all', label: 'all' }
  ];

  const availableOptions = options 
    ? options.map(opt => {
        const found = [...defaultCompactOptions, ...defaultFullOptions].find(o => o.value === opt);
        return found || { value: opt, label: String(opt) };
      })
    : variant === 'compact' ? defaultCompactOptions : defaultFullOptions;

  const selectedIndex = availableOptions.findIndex(opt => opt.value === value);
  const optionWidth = variant === 'compact' ? '60px' : '50px';

  return (
    <div className={`inline-flex items-center ${className}`}>
      <div className="relative flex items-center bg-gradient-to-br from-black/60 to-gray-950/90 backdrop-blur-md rounded-2xl p-1 border border-gray-800/60 shadow-sm hover:shadow-md transition-all duration-200">
        {/* Animated background indicator */}
        <div 
          className="absolute inset-1 bg-gradient-to-br from-gray-800/80 to-gray-900/80 rounded-xl shadow-sm transition-all duration-300 ease-out"
          style={{
            width: optionWidth,
            transform: `translateX(${selectedIndex * parseInt(optionWidth)}px)`,
            transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
          }}
        />
        
        {availableOptions.map((option) => (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={`
              relative z-10 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200 ease-out cursor-pointer
              ${typography.fontFamily.sans}
              ${value === option.value 
                ? 'text-gray-200 drop-shadow-sm' 
                : 'text-gray-400 hover:text-gray-300'
              }
              ${value === option.value 
                ? 'shadow-sm' 
                : 'hover:bg-gray-700/30 active:bg-gray-700/50'
              }
              focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:ring-offset-1
              active:scale-95
            `}
            style={{
              width: optionWidth,
              textAlign: 'center'
            }}
            aria-pressed={value === option.value}
            aria-label={`Select ${option.label} time range`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default TimeRangeSelector; 