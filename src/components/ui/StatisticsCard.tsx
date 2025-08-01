import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/pro-regular-svg-icons';
import { theme, typography } from '../../config/theme';

interface StatisticsCardProps {
  title: string;
  value: string | number;
  color: 'green' | 'blue' | 'purple' | 'red' | 'cyan' | 'emerald' | 'orange' | 'yellow';
  icon?: IconDefinition;
  className?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

const StatisticsCard: React.FC<StatisticsCardProps> = ({
  title,
  value,
  color,
  icon,
  className = '',
  trend
}) => {
  const colorClasses = {
    green: {
      gradient: 'from-green-500/10 via-green-600/5 to-green-700/10',
      text: 'text-green-400',
      value: 'text-green-300',
      border: 'border-green-500/20',
      hover: 'hover:border-green-500/40 hover:from-green-500/15 hover:to-green-700/15'
    },
    blue: {
      gradient: 'from-blue-500/10 via-blue-600/5 to-blue-700/10',
      text: 'text-blue-400',
      value: 'text-blue-300',
      border: 'border-blue-500/20',
      hover: 'hover:border-blue-500/40 hover:from-blue-500/15 hover:to-blue-700/15'
    },
    purple: {
      gradient: 'from-purple-500/10 via-purple-600/5 to-purple-700/10',
      text: 'text-purple-400',
      value: 'text-purple-300',
      border: 'border-purple-500/20',
      hover: 'hover:border-purple-500/40 hover:from-purple-500/15 hover:to-purple-700/15'
    },
    red: {
      gradient: 'from-red-500/10 via-red-600/5 to-red-700/10',
      text: 'text-red-400',
      value: 'text-red-300',
      border: 'border-red-500/20',
      hover: 'hover:border-red-500/40 hover:from-red-500/15 hover:to-red-700/15'
    },
    cyan: {
      gradient: 'from-cyan-500/10 via-cyan-600/5 to-cyan-700/10',
      text: 'text-cyan-400',
      value: 'text-cyan-300',
      border: 'border-cyan-500/20',
      hover: 'hover:border-cyan-500/40 hover:from-cyan-500/15 hover:to-cyan-700/15'
    },
    emerald: {
      gradient: 'from-emerald-500/10 via-emerald-600/5 to-emerald-700/10',
      text: 'text-emerald-400',
      value: 'text-emerald-300',
      border: 'border-emerald-500/20',
      hover: 'hover:border-emerald-500/40 hover:from-emerald-500/15 hover:to-emerald-700/15'
    },
    orange: {
      gradient: 'from-orange-500/10 via-orange-600/5 to-orange-700/10',
      text: 'text-orange-400',
      value: 'text-orange-300',
      border: 'border-orange-500/20',
      hover: 'hover:border-orange-500/40 hover:from-orange-500/15 hover:to-orange-700/15'
    },
    yellow: {
      gradient: 'from-yellow-500/10 via-yellow-600/5 to-yellow-700/10',
      text: 'text-yellow-400',
      value: 'text-yellow-300',
      border: 'border-yellow-500/20',
      hover: 'hover:border-yellow-500/40 hover:from-yellow-500/15 hover:to-yellow-700/15'
    }
  };

  const colors = colorClasses[color];

  return (
    <div 
      className={`
        group relative bg-gradient-to-br from-gray-800/60 to-gray-900/60 
        backdrop-blur-sm rounded-2xl p-4 border ${colors.border} 
        shadow-lg hover:shadow-xl transition-all duration-300 ease-out
        cursor-pointer transform hover:scale-[1.02] hover:-translate-y-1
        min-h-[120px] flex flex-col justify-between
        ${colors.hover}
        ${className}
      `}
    >
      {/* Animated background gradient */}
      <div className={`absolute inset-0 bg-gradient-to-br ${colors.gradient} rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300`}></div>
      
      {/* Content */}
      <div className="relative z-10 h-full flex flex-col justify-between">
        {/* Header with icon and title */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            {icon && (
              <div className={`p-2 rounded-lg bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 group-hover:bg-gray-700/50 transition-colors duration-200`}>
                <FontAwesomeIcon 
                  icon={icon} 
                  className={`w-3 h-3 ${colors.text} transition-transform duration-200 group-hover:scale-110`} 
                />
              </div>
            )}
            <span className={`text-xs font-medium ${typography.fontFamily.sans} ${colors.text} opacity-80 group-hover:opacity-100 transition-opacity duration-200`}>
              {title}
            </span>
          </div>
          
          {/* Trend indicator */}
          {trend && (
            <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
              trend.isPositive 
                ? 'bg-green-500/20 text-green-400 border border-green-500/30' 
                : 'bg-red-500/20 text-red-400 border border-red-500/30'
            }`}>
              <FontAwesomeIcon 
                icon={trend.isPositive ? 'arrow-up' : 'arrow-down'} 
                className="w-2 h-2" 
              />
              {Math.abs(trend.value)}%
            </div>
          )}
        </div>

        {/* Value */}
        <div className="flex-1 flex items-end">
          <div className={`text-2xl font-bold ${typography.fontFamily.sans} ${colors.value} leading-tight group-hover:scale-105 transition-transform duration-200`}>
            {value}
          </div>
        </div>
      </div>

      {/* Subtle glow effect on hover */}
      <div className={`absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-20 transition-opacity duration-300 bg-gradient-to-br ${colors.gradient.replace('/10', '/30').replace('/5', '/20')}`}></div>
    </div>
  );
};

export default StatisticsCard; 