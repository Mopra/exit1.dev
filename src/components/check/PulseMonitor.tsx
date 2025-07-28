import React from 'react';
import { theme, typography } from '../../config/theme';

interface PulseDataPoint {
  time: string;
  status: 'online' | 'offline' | 'no-data' | 'unknown';
  timestamp: number;
  hour?: number;
}

interface PulseMonitorProps {
  data: PulseDataPoint[];
  className?: string;
  onHourClick?: (hour: number, timestamp: number) => void;
  onSuccessfulHourClick?: (hour: number, timestamp: number) => void;
}

const PulseMonitor: React.FC<PulseMonitorProps> = ({ data, className = '', onHourClick, onSuccessfulHourClick }) => {
  if (!data || data.length === 0) {
    return (
      <div className={`flex items-center justify-center h-32 ${className}`}>
        <div className={`text-sm ${typography.fontFamily.sans} ${theme.colors.text.muted}`}>
          No data available
        </div>
      </div>
    );
  }

  // Calculate dimensions
  const width = 800;
  const height = 120;
  const padding = 40;
  const chartWidth = width - (padding * 2);

  // With hour-level aggregation, we'll have exactly 24 rectangles
  const rectWidth = chartWidth / 24;
  // No spacing needed since we have exactly 24 rectangles

  return (
    <div className={`w-full ${className}`}>
      {/* Subtle instruction text */}
      <div className="text-center mb-3">
        <p className={`text-xs ${typography.fontFamily.sans} ${theme.colors.text.muted} opacity-70`}>
          Click on squares to view detailed information
        </p>
      </div>

      {/* Chart Container */}
      <div className={`relative p-1 w-full`}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto"
        >
          {/* Gradient definitions */}
          <defs>
            <linearGradient id="green-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#4ade80" />
              <stop offset="100%" stopColor="#059669" />
            </linearGradient>
            <linearGradient id="red-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#fca5a5" />
              <stop offset="100%" stopColor="#dc2626" />
            </linearGradient>
            <linearGradient id="grey-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#6b7280" />
              <stop offset="100%" stopColor="#4b5563" />
            </linearGradient>
          </defs>
          {/* Hour labels - show every 6 hours */}
          {Array.from({ length: 4 }, (_, i) => {
            const hourIndex = i * 6;
            const x = padding + (hourIndex * rectWidth) + (rectWidth / 2);
            return (
              <text
                key={`hour-${hourIndex}`}
                x={x}
                y={height - 5}
                textAnchor="middle"
                className={`text-xs ${typography.fontFamily.mono}`}
                fill="#9ca3af"
              >
                {data[hourIndex]?.time || `${(hourIndex).toString().padStart(2, '0')}:00`}
              </text>
            );
          })}
          {/* Last label at the end */}
          <text
            x={padding + (23 * rectWidth) + (rectWidth / 2)}
            y={height - 5}
            textAnchor="middle"
            className={`text-xs ${typography.fontFamily.mono}`}
            fill="#9ca3af"
          >
            {data[23]?.time || '23:00'}
          </text>

          {/* Data points - one rectangle per hour */}
          {data.map((point, index) => {
            const x = padding + (index * rectWidth);
            const y = height / 2;
            const rectHeight = point.status === 'online' ? 66 : 28;
            
            // Determine gradient based on status
            let gradientId = 'green-gradient';
            if (point.status === 'offline') {
              gradientId = 'red-gradient';
            } else if (point.status === 'no-data') {
              gradientId = 'grey-gradient';
            } else if (point.status === 'unknown') {
              gradientId = 'grey-gradient';
            }
            
            // Make offline hours clickable for incidents, online hours clickable for successful checks
            const isOfflineClickable = point.status === 'offline' && onHourClick;
            const isOnlineClickable = point.status === 'online' && onSuccessfulHourClick;
            const isClickable = isOfflineClickable || isOnlineClickable;
            
            return (
              <rect
                key={index}
                x={x}
                y={y - rectHeight / 2}
                width={rectWidth - 4} // Increased gap between rectangles
                height={rectHeight}
                rx="8"
                fill={`url(#${gradientId})`}
                stroke="#1f2937"
                strokeWidth="1"
                style={{
                  cursor: isClickable ? 'pointer' : 'default',
                  transition: 'opacity 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  if (isClickable) {
                    e.currentTarget.style.opacity = '0.8';
                  }
                }}
                onMouseLeave={(e) => {
                  if (isClickable) {
                    e.currentTarget.style.opacity = '1';
                  }
                }}
                onClick={() => {
                  if (isOfflineClickable) {
                    onHourClick(index, point.timestamp);
                  } else if (isOnlineClickable) {
                    onSuccessfulHourClick(index, point.timestamp);
                  }
                }}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
};

export default PulseMonitor; 