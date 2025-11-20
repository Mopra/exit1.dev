import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

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
    <div className={`p-4 rounded-lg border ${borderClass}`}>
      <div className="flex items-start gap-2">
        {success ? (
          <CheckCircle2 className={`h-5 w-5 ${iconColor} mt-0.5`} />
        ) : isWarning ? (
          <AlertTriangle className={`h-5 w-5 ${iconColor} mt-0.5`} />
        ) : (
          <XCircle className={`h-5 w-5 ${iconColor} mt-0.5`} />
        )}
        <div className="flex-1">
          <p className={`font-semibold ${textClass}`}>
            {title}
          </p>
          {message && (
            <p className={`text-sm mt-1 ${textSecondaryClass}`}>
              {message}
            </p>
          )}
          {details && (
            <div className={`mt-2 text-sm ${textSecondaryClass}`}>
              {details}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

