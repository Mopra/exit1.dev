import type { Website } from '../../types';
import { theme, typography } from '../../config/theme';

interface CheckUsageProps {
  checks: Website[];
  maxLimit: number;
  className?: string;
}

export default function CheckUsage({ checks, maxLimit, className = '' }: CheckUsageProps) {
  // Count only active (non-disabled) checks
  const activeCount = checks.filter(check => !check.disabled).length;
  const disabledCount = checks.filter(check => check.disabled).length;
  
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
  
  // const getProgressColor = (usage: number, limit: number) => {
  //   const percentage = (usage / limit) * 100;
  //   const isAtLimit = usage >= limit;
  //   const isNearLimit = percentage >= 80;

  //   if (isAtLimit) return 'bg-slate-500';
  //   if (isNearLimit) return 'bg-slate-400';
  //   return 'bg-slate-300';
  // };

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {/* Usage Counter */}
      <div className={`text-sm ${typography.fontFamily.mono} ${theme.colors.text.secondary}`}>
        {activeCount}/{maxLimit} checks
      </div>
    
      
      {/* Status Indicator */}
      <div className={`text-xs ${typography.fontFamily.mono} ${getStatusColor(activeCount, maxLimit)}`}>
        {isAtLimit ? 'Limit reached' : isNearLimit ? 'Near limit' : 'Available'}
      </div>
      
      {/* Disabled Count */}
      {disabledCount > 0 && (
        <div className={`text-xs ${typography.fontFamily.mono} ${theme.colors.text.muted}`}>
          {disabledCount} disabled
        </div>
      )}
    </div>
  );
} 