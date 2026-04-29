import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from './Card';
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
    ? 'border-success bg-success/5'
    : isWarning
    ? 'border-warning bg-warning/5'
    : 'border-destructive bg-destructive/5';
  const textClass = success
    ? 'text-success'
    : isWarning
    ? 'text-warning'
    : 'text-destructive';
  const textSecondaryClass = success
    ? 'text-success/80'
    : isWarning
    ? 'text-warning/80'
    : 'text-destructive/80';
  const iconColor = success
    ? 'text-success'
    : isWarning
    ? 'text-warning'
    : 'text-destructive';

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
