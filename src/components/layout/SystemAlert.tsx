import React, { useState, useEffect } from 'react';
import { useNotifications, SystemNotification } from '@/hooks/useNotifications';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { X, Info, AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react';
import { useLocalStorage } from '@/hooks/useLocalStorage';

export const SystemAlert: React.FC = () => {
  const { notifications } = useNotifications();
  const [dismissedIds, setDismissedIds] = useLocalStorage<string[]>('dismissed_notifications', []);
  const [visibleNotifications, setVisibleNotifications] = useState<SystemNotification[]>([]);

  useEffect(() => {
    setVisibleNotifications(notifications.filter(n => !dismissedIds.includes(n.id)));
  }, [notifications, dismissedIds]);

  if (visibleNotifications.length === 0) return null;

  const handleDismiss = (id: string) => {
    setDismissedIds([...dismissedIds, id]);
  };

  return (
    <div className="space-y-3 px-4 sm:px-6 pt-4 max-w-7xl mx-auto w-full">
      {visibleNotifications.map(notification => (
        <Alert 
            key={notification.id} 
            variant={notification.type === 'error' ? 'destructive' : 'default'}
            className={`
                ${
                    notification.type === 'info' ? 'border-sky-200 bg-sky-50/50 dark:bg-sky-900/20 dark:border-sky-800 text-sky-900 dark:text-sky-100' :
                    notification.type === 'warning' ? 'border-yellow-200 bg-yellow-50/50 dark:bg-yellow-900/20 dark:border-yellow-800 text-yellow-900 dark:text-yellow-100' :
                    notification.type === 'success' ? 'border-green-200 bg-green-50/50 dark:bg-green-900/20 dark:border-green-800 text-green-900 dark:text-green-100' :
                    ''
                } 
                backdrop-blur relative shadow-sm transition-all duration-300 animate-in fade-in slide-in-from-top-2 flex items-start gap-3
            `}
        >
            {notification.type === 'info' && <Info className="h-5 w-5 mt-0.5 text-sky-500" />}
            {notification.type === 'warning' && <AlertTriangle className="h-5 w-5 mt-0.5 text-yellow-500" />}
            {notification.type === 'success' && <CheckCircle className="h-5 w-5 mt-0.5 text-green-500" />}
            {notification.type === 'error' && <AlertCircle className="h-5 w-5 mt-0.5 text-destructive" />}
            
            <div className="flex-1">
                <AlertTitle className="font-semibold mb-1">{notification.title}</AlertTitle>
                <AlertDescription className="text-current opacity-90">
                  {notification.message}
                </AlertDescription>
            </div>
            
            <button 
                onClick={() => handleDismiss(notification.id)}
                className="text-current opacity-50 hover:opacity-100 transition-opacity p-1"
                aria-label="Dismiss"
            >
                <X className="h-4 w-4" />
            </button>
        </Alert>
      ))}
    </div>
  );
};

