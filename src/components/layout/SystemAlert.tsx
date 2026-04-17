import React, { useState, useEffect } from 'react';
import { useNotifications } from '@/hooks/useNotifications';
import type { SystemNotification } from '@/hooks/useNotifications';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/Button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X } from 'lucide-react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { formatCreatedAt } from '@/utils/formatters';
import { cn } from '@/lib/utils';
import DOMPurify from 'dompurify';

export const SystemAlert: React.FC = () => {
  const { notifications } = useNotifications();
  const [dismissedIds, setDismissedIds] = useLocalStorage<string[]>('dismissed_notifications', []);
  const [visibleNotifications, setVisibleNotifications] = useState<SystemNotification[]>([]);
  const [expandedNotification, setExpandedNotification] = useState<SystemNotification | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(true);

  useEffect(() => {
    setVisibleNotifications(notifications.filter(n => !dismissedIds.includes(n.id)));
  }, [notifications, dismissedIds]);

  if (visibleNotifications.length === 0) return null;

  const handleDismiss = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setDismissedIds([...dismissedIds, id]);
  };

  const handleDismissAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissedIds([...dismissedIds, ...visibleNotifications.map(n => n.id)]);
  };

  const getFirstLine = (message: string): string => {
    const textOnly = DOMPurify.sanitize(message, { ALLOWED_TAGS: [] });
    const firstLine = textOnly.split('\n')[0].trim();
    return firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine;
  };

  const showCollapsed = visibleNotifications.length > 1 && isCollapsed;

  return (
    <>
      <div className="mb-2">
        <div className="space-y-1.5 w-full">
          {showCollapsed ? (
            <div
              onClick={() => setIsCollapsed(false)}
              className="px-4 py-2 rounded-md border border-border bg-muted/50 cursor-pointer hover:bg-muted transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">
                  {visibleNotifications.length} announcements
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground h-auto py-1 px-2"
                  onClick={handleDismissAll}
                >
                  Dismiss all
                </Button>
              </div>
            </div>
          ) : (
            visibleNotifications.map(notification => (
              <div
                key={notification.id}
                onClick={() => setExpandedNotification(notification)}
                className="group px-4 py-2 rounded-md border border-border bg-muted/50 cursor-pointer hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{notification.title}</span>
                      <span className="text-xs text-muted-foreground truncate hidden sm:inline">
                        {getFirstLine(notification.message)}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="flex-shrink-0 h-6 w-6 text-muted-foreground"
                    onClick={(e) => handleDismiss(notification.id, e)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Expanded Notification Dialog */}
      <Dialog open={!!expandedNotification} onOpenChange={(open) => !open && setExpandedNotification(null)}>
        {expandedNotification && (
          <DialogContent className="sm:max-w-2xl shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
            <DialogHeader className="pr-8 text-left">
              <DialogTitle>{expandedNotification.title}</DialogTitle>
              <DialogDescription>
                {formatCreatedAt(expandedNotification.createdAt)} · System
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="max-h-[60vh]">
              <div
                className={cn(
                  "prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed break-words",
                  "[&_p]:mb-2 [&_p:last-child]:mb-0",
                  "[&_ul]:list-disc [&_ul]:ml-4 [&_ul]:space-y-1",
                  "[&_a]:text-primary [&_a]:underline [&_a:hover]:opacity-80",
                  "[&_strong]:font-semibold [&_em]:italic"
                )}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(expandedNotification.message) }}
              />
            </ScrollArea>

            <div className="flex items-center pt-2">
              <Button
                variant="secondary"
                onClick={(e) => {
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
