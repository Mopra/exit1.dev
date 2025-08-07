import React from 'react';
import { Badge } from './badge';
import { 
  CheckCircle, 
  XCircle, 
  HelpCircle,
  AlertTriangle
} from 'lucide-react';

type Status = 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';

interface StatusBadgeProps {
  status?: Status;
  className?: string;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '' }) => {
  const getStatusConfig = (status?: Status) => {
    switch (status) {
      case 'online':
      case 'UP':
        return {
          icon: CheckCircle,
          variant: 'default' as const,
          className: 'bg-green-500/20 text-green-400 border-green-500/30',
          text: 'Online'
        };
      case 'offline':
      case 'DOWN':
        return {
          icon: XCircle,
          variant: 'destructive' as const,
          className: 'bg-red-500/20 text-red-400 border-red-500/30',
          text: 'Offline'
        };
      case 'REDIRECT':
        return {
          icon: AlertTriangle,
          variant: 'secondary' as const,
          className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
          text: 'Redirect'
        };
      case 'REACHABLE_WITH_ERROR':
        return {
          icon: AlertTriangle,
          variant: 'secondary' as const,
          className: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
          text: 'Error'
        };
      case 'unknown':
      default:
        return {
          icon: HelpCircle,
          variant: 'secondary' as const,
          className: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
          text: 'Unknown'
        };
    }
  };

  const config = getStatusConfig(status);
  const IconComponent = config.icon;

  return (
    <Badge 
      variant={config.variant}
      className={`${config.className} ${className} flex items-center gap-1.5 px-2 py-1 text-xs font-medium`}
    >
      <IconComponent className="w-3 h-3" />
      {config.text}
    </Badge>
  );
};

export default StatusBadge; 