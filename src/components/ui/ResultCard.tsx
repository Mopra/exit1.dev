import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from './card';
import { cn } from '@/lib/utils';

interface ResultCardProps {
  success: boolean;
  title: string;
  message?: string;
  details?: React.ReactNode;
  warning?: boolean; // For yellow/warning state
}

export const ResultCard: React.FC<ResultCardProps> = ({ success, title, message, details, warning }) => {
  const isWarning = warning && !success;
  const borderClass = success 
    ? 'border-green-500 bg-green-50 dark:bg-green-950' 
    : isWarning 
    ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-950'
    : 'border-red-500 bg-red-50 dark:bg-red-950';
  const textClass = success 
    ? 'text-green-900 dark:text-green-100' 
    : isWarning 
    ? 'text-yellow-900 dark:text-yellow-100'
    : 'text-red-900 dark:text-red-100';
  const textSecondaryClass = success 
    ? 'text-green-700 dark:text-green-300' 
    : isWarning 
    ? 'text-yellow-700 dark:text-yellow-300'
    : 'text-red-700 dark:text-red-300';
  const iconColor = success 
    ? 'text-green-600' 
    : isWarning 
    ? 'text-yellow-600'
    : 'text-red-600';

  return (
    <Card className={cn('p-4', borderClass)}>
      <CardContent className="p-0">
        <div className="flex items-start gap-2">
          {success ? (
            <CheckCircle2 className={cn('h-5 w-5', iconColor, 'mt-0.5')} />
          ) : isWarning ? (
            <AlertTriangle className={cn('h-5 w-5', iconColor, 'mt-0.5')} />
          ) : (
            <XCircle className={cn('h-5 w-5', iconColor, 'mt-0.5')} />
          )}
          <div className="flex-1">
            <p className={cn('font-semibold', textClass)}>
              {title}
            </p>
            {message && (
              <p className={cn('text-sm mt-1', textSecondaryClass)}>
                {message}
              </p>
            )}
            {details && (
              <div className={cn('mt-2 text-sm', textSecondaryClass)}>
                {details}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
