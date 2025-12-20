import React, { useState, useEffect } from 'react';
import { useNotifications } from '@/hooks/useNotifications';
import type { SystemNotification } from '@/hooks/useNotifications';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Clock } from 'lucide-react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { formatCreatedAt } from '@/utils/formatters';
import { cn } from '@/lib/utils';
import DOMPurify from 'dompurify';

export const SystemAlert: React.FC = () => {
  const { notifications } = useNotifications();
  const [dismissedIds, setDismissedIds] = useLocalStorage<string[]>('dismissed_notifications', []);
  const [visibleNotifications, setVisibleNotifications] = useState<SystemNotification[]>([]);
  const [expandedNotification, setExpandedNotification] = useState<SystemNotification | null>(null);

  useEffect(() => {
    setVisibleNotifications(notifications.filter(n => !dismissedIds.includes(n.id)));
  }, [notifications, dismissedIds]);

  if (visibleNotifications.length === 0) return null;

  const handleDismiss = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setDismissedIds([...dismissedIds, id]);
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'success':
        return '✓';
      case 'warning':
        return '⚠';
      case 'error':
        return '✕';
      default:
        return 'ℹ';
    }
  };

  const getNotificationColor = (type: string) => {
    switch (type) {
      case 'success':
        return 'bg-emerald-500/10 text-emerald-100 border-emerald-400/30';
      case 'warning':
        return 'bg-amber-500/10 text-amber-100 border-amber-400/30';
      case 'error':
        return 'bg-red-500/10 text-red-100 border-red-400/30';
      default:
        return 'bg-sky-500/10 text-sky-100 border-sky-400/30';
    }
  };

  const getFirstLine = (message: string): string => {
    // Strip HTML tags for preview
    const textOnly = DOMPurify.sanitize(message, { ALLOWED_TAGS: [] });
    const firstLine = textOnly.split('\n')[0].trim();
    if (firstLine.length > 100) {
      return firstLine.substring(0, 100) + '...';
    }
    return firstLine;
  };


  return (
    <>
      <div className="pt-14 mx-6 sm:mx-12">
        <div className="max-w-7xl mx-auto w-full">
          <div className="space-y-3 sm:space-y-2 px-4 sm:px-4 md:px-6 pb-4 sm:pb-0 w-full">
          {visibleNotifications.map(notification => {
            const colorClasses = getNotificationColor(notification.type);
            const firstLine = getFirstLine(notification.message);

            return (
              <div
                key={notification.id}
                onClick={() => setExpandedNotification(notification)}
                className={cn(
                  "px-4 sm:px-4 md:px-6 py-4 sm:py-4 rounded-md transition-all duration-200 w-full",
                  "backdrop-blur-md border animate-in fade-in slide-in-from-top-2",
                  colorClasses,
                  "cursor-pointer hover:bg-opacity-20 hover:shadow-md hover:scale-[1.01] hover:border-opacity-50 active:scale-[0.99]"
                )}
              >
                <div className="flex items-center gap-2 sm:gap-3 w-full">
                  <div className="flex-shrink-0 w-4 h-4 sm:w-5 sm:h-5 rounded-full flex items-center justify-center text-xs font-medium bg-white/20">
                    {getNotificationIcon(notification.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                      <span className="font-medium text-xs sm:text-sm truncate">{notification.title}</span>
                      <span className="hidden sm:inline text-xs opacity-70">·</span>
                      <span className="text-xs opacity-70 truncate line-clamp-1">{firstLine}</span>
                    </div>
                  </div>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDismiss(notification.id, e);
                    }}
                    className="flex-shrink-0 h-7 sm:h-8 px-2 sm:px-4 text-xs cursor-pointer rounded-sm"
                  >
                    <span className="hidden sm:inline">Dismiss</span>
                    <span className="sm:hidden">✕</span>
                  </Button>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {/* Expanded Notification Dialog */}
      <Dialog open={!!expandedNotification} onOpenChange={(open) => !open && setExpandedNotification(null)}>
        {expandedNotification && (
          <DialogContent
            className={cn(
              "max-w-[calc(100vw-1rem)] sm:max-w-4xl backdrop-blur-md shadow-2xl border p-0",
              getNotificationColor(expandedNotification.type)
            )}
          >
            <DialogHeader className="px-4 sm:px-8 pt-4 sm:pt-6 pb-3 sm:pb-4">
              <div className="flex items-start gap-3 sm:gap-4">
                <div className={cn(
                  "flex-shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-sm sm:text-base font-semibold",
                  "bg-white/20 backdrop-blur-sm"
                )}>
                  {getNotificationIcon(expandedNotification.type)}
                </div>
                <div className="flex-1 min-w-0 space-y-1.5 sm:space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <DialogTitle className="text-lg sm:text-xl font-semibold leading-tight text-left">
                      {expandedNotification.title}
                    </DialogTitle>
                    <Badge 
                      variant="outline" 
                      className="text-xs px-1.5 sm:px-2 py-0.5 h-5 flex-shrink-0 border-sky-300/30 text-sky-100 bg-sky-500/10"
                    >
                      System
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm text-sky-100/70 flex-wrap">
                    <Clock className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                    <span>{formatCreatedAt(expandedNotification.createdAt)}</span>
                    <span className="text-sky-100/50 hidden sm:inline">·</span>
                    <span className="hidden sm:inline">{new Date(expandedNotification.createdAt).toLocaleDateString(undefined, { 
                      month: 'short', 
                      day: 'numeric', 
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit'
                    })}</span>
                  </div>
                </div>
              </div>
            </DialogHeader>
            
            <Separator className="bg-sky-300/20" />
            
            <ScrollArea className="max-h-[calc(100vh-16rem)] sm:max-h-[60vh] px-4 sm:px-8 py-4 sm:py-6">
              <div className="space-y-3 sm:space-y-4">
                <div className={cn(
                  "prose prose-invert prose-sm max-w-none",
                  "text-sky-50 leading-relaxed"
                )}>
                  <div 
                    className={cn(
                      "break-words",
                      "text-sm sm:text-[15px] leading-6 sm:leading-7",
                      "space-y-2 sm:space-y-3",
                      "[&_p]:mb-2 sm:[&_p]:mb-3 [&_p:last-child]:mb-0",
                      "[&_ul]:list-disc [&_ul]:ml-3 sm:[&_ul]:ml-4 [&_ul]:space-y-1",
                      "[&_a]:text-sky-400 [&_a]:underline [&_a]:cursor-pointer [&_a:hover]:text-sky-300",
                      "[&_strong]:font-semibold [&_em]:italic"
                    )}
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(expandedNotification.message) }}
                  />
                </div>
              </div>
            </ScrollArea>
            
            <Separator className="bg-sky-300/20" />
            
            <div className="px-4 sm:px-8 py-3 sm:py-4 flex items-center justify-end gap-2 sm:gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer text-sky-100/80 hover:text-sky-50 hover:bg-sky-500/20 w-full sm:w-auto"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDismiss(expandedNotification.id, e);
                  setExpandedNotification(null);
                }}
              >
                Dismiss
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
};

