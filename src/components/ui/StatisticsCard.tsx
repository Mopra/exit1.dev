import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Badge } from './badge';

interface StatisticsCardProps {
  title: string;
  value: string | number;
  color?: 'green' | 'blue' | 'purple' | 'red' | 'cyan' | 'emerald' | 'orange' | 'yellow';
  icon?: IconDefinition;
  trend?: {
    value: number;
    isPositive: boolean;
    label: string;
  };
  status?: 'online' | 'offline' | 'warning';
  className?: string;
}

const StatisticsCard: React.FC<StatisticsCardProps> = ({
  title,
  value,
  color: _color,
  icon,
  trend,
  status,
  className = ''
}) => {
  const getStatusColor = () => {
    switch (status) {
      case 'online':
        return 'text-green-400';
      case 'offline':
        return 'text-red-400';
      case 'warning':
        return 'text-yellow-400';
      default:
        return 'text-blue-400';
    }
  };

  const getTrendColor = () => {
    if (!trend) return '';
    return trend.isPositive ? 'text-green-400' : 'text-red-400';
  };

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        {icon && (
          <FontAwesomeIcon 
            icon={icon} 
            className={`w-4 h-4 ${getStatusColor()}`} 
          />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {trend && (
          <div className="flex items-center space-x-2 mt-2">
            <Badge 
              variant={trend.isPositive ? 'default' : 'destructive'}
              className={`text-xs ${getTrendColor()}`}
            >
              {trend.isPositive ? '+' : ''}{trend.value}%
            </Badge>
            <span className="text-xs text-muted-foreground">
              {trend.label}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default StatisticsCard; 