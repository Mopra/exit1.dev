import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheckCircle,
  faTimesCircle,
  faQuestionCircle
} from '@fortawesome/free-regular-svg-icons';
import {
  faExclamationTriangle,
  faArrowRight
} from '@fortawesome/free-solid-svg-icons';
import Badge from './Badge';

interface StatusBadgeProps {
  status?: string;
  showIcon?: boolean;
  className?: string;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  showIcon = true,
  className = ''
}) => {
  const getStatusConfig = (status?: string) => {
    switch (status) {
      case 'online':
      case 'UP':
        return {
          icon: faCheckCircle,
          iconColor: 'text-green-500',
          badgeColor: 'text-green-600 bg-green-50 border-green-200',
          text: 'online'
        };
      case 'offline':
      case 'DOWN':
        return {
          icon: faTimesCircle,
          iconColor: 'text-red-500',
          badgeColor: 'text-red-600 bg-red-50 border-red-200',
          text: 'offline'
        };
      case 'REDIRECT':
        return {
          icon: faArrowRight,
          iconColor: 'text-blue-500',
          badgeColor: 'text-blue-600 bg-blue-50 border-blue-200',
          text: 'redirect'
        };
      case 'REACHABLE_WITH_ERROR':
        return {
          icon: faExclamationTriangle,
          iconColor: 'text-yellow-500',
          badgeColor: 'text-yellow-600 bg-yellow-50 border-yellow-200',
          text: 'error'
        };
      default:
        return {
          icon: faQuestionCircle,
          iconColor: 'text-gray-400',
          badgeColor: 'text-gray-600 bg-gray-50 border-gray-200',
          text: 'unknown'
        };
    }
  };

  const config = getStatusConfig(status);

  return (
    <div className="flex items-center gap-2">
      {showIcon && (
        <FontAwesomeIcon 
          icon={config.icon} 
          className={config.iconColor} 
        />
      )}
      <Badge 
        variant="default" 
        className={`text-xs font-medium ${config.badgeColor} ${className}`}
      >
        {config.text}
      </Badge>
    </div>
  );
};

export default StatusBadge; 