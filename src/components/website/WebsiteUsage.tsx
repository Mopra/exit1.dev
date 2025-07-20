import type { Website } from '../../types';
import { theme, typography } from '../../config/theme';

interface WebsiteUsageProps {
  websites: Website[];
  maxLimit: number;
  className?: string;
}

export default function WebsiteUsage({ websites, maxLimit, className = '' }: WebsiteUsageProps) {
  // Count only active (non-disabled) websites
  const activeCount = websites.filter(website => !website.disabled).length;
  const disabledCount = websites.filter(website => website.disabled).length;
  
  const percentage = (activeCount / maxLimit) * 100;
  const isNearLimit = percentage >= 80;
  const isAtLimit = percentage >= 100;
  
  const getStatusColor = (usage: number, limit: number) => {
    const percentage = (usage / limit) * 100;
    const isAtLimit = usage >= limit;
    const isNearLimit = percentage >= 80;

    if (isAtLimit) return theme.colors.status.offline;
    if (isNearLimit) return 'text-yellow-400';
    return theme.colors.status.online;
  };
  
  const getProgressColor = (usage: number, limit: number) => {
    const percentage = (usage / limit) * 100;
    const isAtLimit = usage >= limit;
    const isNearLimit = percentage >= 80;

    if (isAtLimit) return 'bg-slate-500';
    if (isNearLimit) return 'bg-slate-400';
    return 'bg-slate-300';
  };

  return (
    <div className={`text-sm ${typography.fontFamily.mono} ${className}`}>
      {/* Mobile Layout - Compact */}
      <div className="block sm:hidden">
        <div className="flex items-center justify-between mb-1">
          <span className="text-slate-300 text-xs">Usage</span>
          <span className={`text-xs ${getStatusColor(activeCount, maxLimit)}`}>
            {activeCount}/{maxLimit}
          </span>
        </div>
        <div className="w-full bg-gray-800 rounded-full h-1.5">
          <div 
            className={`h-full rounded-full transition-all duration-300 ${getProgressColor(activeCount, maxLimit)}`}
            style={{ width: `${Math.min((activeCount / maxLimit) * 100, 100)}%` }}
          />
        </div>
        {isAtLimit && (
          <div className={`${theme.colors.status.offline} text-xs mt-1`}>
            Limit reached
          </div>
        )}
      </div>

      {/* Desktop Layout - Full */}
      <div className="hidden sm:block">
        <div className="flex items-center justify-between mb-2">
          <span className="text-slate-300 mr-2">Website Usage</span>
          <span className={getStatusColor(activeCount, maxLimit)}>
            {activeCount} / {maxLimit}
          </span>
        </div>
        
        <div className="w-full bg-gray-800 rounded-full h-2 mb-1">
          <div 
            className={`h-full rounded-full transition-all duration-300 ${getProgressColor(activeCount, maxLimit)}`}
            style={{ width: `${Math.min((activeCount / maxLimit) * 100, 100)}%` }}
          />
        </div>
        
        {isAtLimit && (
          <div className={`${theme.colors.status.offline} text-xs mt-1`}>
            Usage limit reached
          </div>
        )}
        
        {isNearLimit && !isAtLimit && (
          <div className={`text-slate-400 text-xs mt-1`}>
            Near usage limit
          </div>
        )}
        
        {!isNearLimit && !isAtLimit && (
          <div className="text-slate-500 text-xs mt-1">
            Usage within limits
          </div>
        )}
        
        {disabledCount > 0 && (
          <div className="text-slate-500 text-xs mt-1">
            {disabledCount} disabled website{disabledCount !== 1 ? 's' : ''} (not counted in limit)
          </div>
        )}
      </div>
    </div>
  );
} 