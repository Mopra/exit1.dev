import React from 'react';
import { typography } from '../../config/theme';

export type TimeRange = '24h' | '7d';

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}

const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({ 
  value, 
  onChange, 
  className = '' 
}) => {
  const options: { value: TimeRange; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' }
  ];

  const selectedIndex = options.findIndex(opt => opt.value === value);

  return (
    <div className={`inline-flex items-center ${className}`}>
      <div className="relative flex items-center bg-gradient-to-br from-black/60 to-gray-950/90 backdrop-blur-md rounded-2xl p-1.5 border border-gray-800/60 shadow-sm hover:shadow-md transition-all duration-200">
        {/* Animated background indicator */}
        <div 
          className="absolute inset-1.5 bg-gradient-to-br from-gray-800/80 to-gray-900/80 rounded-xl shadow-sm transition-all duration-300 ease-out"
          style={{
            width: '60px',
            transform: `translateX(${selectedIndex * 60}px)`,
            transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
          }}
        />
        
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={`
              relative z-10 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ease-out
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
              width: '60px',
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