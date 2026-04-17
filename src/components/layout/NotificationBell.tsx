import { useState, useMemo } from 'react';
import { Bell, X } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { useUserNotifications } from '@/hooks/useUserNotifications';
import { useNotifications } from '@/hooks/useNotifications';
import { useVerticalDragScroll } from '@/hooks/useVerticalDragScroll';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import DOMPurify from 'dompurify';

type CombinedNotification = {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'error';
  createdAt: number;
  read?: boolean;
  readAt?: number;
  link?: string;
  isSystem?: boolean;
};

const NotificationBell = () => {
  const { notifications: userNotifications, loading: userLoading, unreadCount } = useUserNotifications();
  const { notifications: systemNotifications, loading: systemLoading } = useNotifications();
  const [open, setOpen] = useState(false);
  const [expandedNotification, setExpandedNotification] = useState<CombinedNotification | null>(null);
  const [dismissedSystemIds, setDismissedSystemIds] = useLocalStorage<string[]>('dismissed_system_notifications_bell', []);
  const [readSystemIds, setReadSystemIds] = useLocalStorage<string[]>('read_system_notifications_bell', []);

  const visibleSystemNotifications = useMemo(() => {
    return systemNotifications.filter(n => !dismissedSystemIds.includes(n.id));
  }, [systemNotifications, dismissedSystemIds]);

  const allNotifications = useMemo(() => {
    const combined: CombinedNotification[] = [
      ...visibleSystemNotifications.map(n => ({
        id: `system_${n.id}`,
        title: n.title,
        message: n.message,
        type: n.type,
        createdAt: n.createdAt,
        isSystem: true,
        read: readSystemIds.includes(n.id),
      })),
      ...userNotifications.map(n => ({
        id: n.id,
        title: n.title,
        message: n.message,
        type: n.type,
        createdAt: n.createdAt,
        read: n.read,
        readAt: n.readAt,
        link: n.link,
        isSystem: false,
      })),
    ];
    return combined.sort((a, b) => b.createdAt - a.createdAt);
  }, [visibleSystemNotifications, userNotifications, readSystemIds]);

  const totalUnreadCount = useMemo(() => {
    const unreadSystemCount = visibleSystemNotifications.filter(n => !readSystemIds.includes(n.id)).length;
    return unreadSystemCount + unreadCount;
  }, [visibleSystemNotifications, readSystemIds, unreadCount]);

  const { containerRef: dragScrollRef, wasDragging } = useVerticalDragScroll();
  const loading = userLoading || systemLoading;

  const markAsRead = async (notificationId: string, read: boolean = true) => {
    try {
      const markAsReadFn = httpsCallable(functions, 'markNotificationAsRead');
      await markAsReadFn({ notificationId, read });
    } catch (error: any) {
      console.error(`Error marking notification as ${read ? 'read' : 'unread'}:`, error);
      toast.error(`Failed to mark notification as ${read ? 'read' : 'unread'}`);
    }
  };

  const markAllAsRead = async () => {
    try {
      const markAllAsReadFn = httpsCallable(functions, 'markAllNotificationsAsRead');
      await markAllAsReadFn();

      const unreadSystemIds = visibleSystemNotifications
        .filter(n => !readSystemIds.includes(n.id))
        .map(n => n.id);

      if (unreadSystemIds.length > 0) {
        setReadSystemIds([...readSystemIds, ...unreadSystemIds]);
      }

      toast.success('All notifications marked as read');
    } catch (error: any) {
      console.error('Error marking all notifications as read:', error);
      toast.error('Failed to mark all notifications as read');
    }
  };

  const handleNotificationClick = async (notification: CombinedNotification) => {
    if (wasDragging()) return;
    // Mark as read on click
    if (!notification.read) {
      if (notification.isSystem) {
        const systemId = notification.id.replace('system_', '');
        setReadSystemIds([...readSystemIds, systemId]);
      } else {
        await markAsRead(notification.id, true);
      }
    }
    setExpandedNotification(notification);
  };

  const handleToggleRead = async (notification: CombinedNotification, e: React.MouseEvent) => {
    e.stopPropagation();
    if (notification.isSystem) {
      const systemId = notification.id.replace('system_', '');
      if (notification.read) {
        setReadSystemIds(readSystemIds.filter(id => id !== systemId));
      } else {
        setReadSystemIds([...readSystemIds, systemId]);
      }
    } else {
      const newReadState = !notification.read;
      await markAsRead(notification.id, newReadState);
    }
  };

  const handleRemove = async (notification: CombinedNotification, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (notification.isSystem) {
      setDismissedSystemIds([...dismissedSystemIds, notification.id.replace('system_', '')]);
    } else {
      try {
        const deleteNotificationFn = httpsCallable(functions, 'deleteUserNotification');
        await deleteNotificationFn({ notificationId: notification.id });
      } catch (error: any) {
        console.error('Error removing notification:', error);
        toast.error('Failed to remove notification');
      }
    }
  };

  const getPreviewText = (message: string): string => {
    const textOnly = DOMPurify.sanitize(message, { ALLOWED_TAGS: [] });
    const firstLine = textOnly.split('\n')[0].trim();
    return firstLine.length > 80 ? firstLine.substring(0, 80) + '...' : firstLine;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative cursor-pointer overflow-visible"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
          {totalUnreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute top-2 right-2 h-5 w-5 flex items-center justify-center p-0 text-xs translate-x-1/2 -translate-y-1/2"
            >
              {totalUnreadCount > 9 ? '9+' : totalUnreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[calc(100vw-2rem)] sm:w-96 p-0 max-h-[calc(100vh-4rem)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">Notifications</span>
            {totalUnreadCount > 0 && (
              <Badge
                variant="secondary"
                className="h-5 px-1.5 text-xs font-medium"
              >
                {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
              </Badge>
            )}
          </div>
          {totalUnreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground h-auto py-1 px-2"
              onClick={markAllAsRead}
            >
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification list */}
        <ScrollArea className="max-h-[calc(100vh-12rem)] sm:max-h-[400px]" ref={dragScrollRef}>
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : allNotifications.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No notifications
            </div>
          ) : (
            allNotifications.map((notification, index) => (
              <div
                key={notification.id}
                onClick={() => handleNotificationClick(notification)}
                className={cn(
                  "group flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors hover:bg-muted",
                  index < allNotifications.length - 1 && "border-b border-border",
                  notification.read && "opacity-60"
                )}
              >
                {/* Unread dot */}
                <div className="flex-shrink-0 mt-1.5">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    !notification.read ? "bg-primary" : "bg-transparent"
                  )} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm truncate">{notification.title}</span>
                    {notification.isSystem && (
                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 flex-shrink-0">
                        System
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {getPreviewText(notification.message)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {new Date(notification.createdAt).toLocaleDateString()}
                  </p>
                </div>

                {/* Dismiss button */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="flex-shrink-0 h-6 w-6 opacity-0 group-hover:opacity-100 sm:opacity-0 max-sm:opacity-100 transition-opacity text-muted-foreground"
                  onClick={(e) => handleRemove(notification, e)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </ScrollArea>
      </PopoverContent>

      {/* Expanded Notification Dialog */}
      <Dialog open={!!expandedNotification} onOpenChange={(open) => !open && setExpandedNotification(null)}>
        {expandedNotification && (
          <DialogContent className="sm:max-w-2xl shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
            <DialogHeader className="pr-8 text-left">
              <DialogTitle>{expandedNotification.title}</DialogTitle>
              <DialogDescription>
                {new Date(expandedNotification.createdAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit'
                })}
                {expandedNotification.isSystem && ' · System'}
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

            <div className="flex items-center gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={(e) => {
                  handleToggleRead(expandedNotification, e);
                  setExpandedNotification(null);
                }}
              >
                {expandedNotification.read ? 'Mark as unread' : 'Mark as read'}
              </Button>
              {expandedNotification.link && (() => {
                try {
                  const url = new URL(expandedNotification.link!);
                  if (!['http:', 'https:'].includes(url.protocol)) return null;
                  return (
                    <Button
                      variant="secondary"
                      onClick={() => window.open(expandedNotification.link!, '_blank', 'noopener,noreferrer')}
                    >
                      Open link
                    </Button>
                  );
                } catch {
                  return null;
                }
              })()}
              <Button
                variant="secondary"
                onClick={(e) => {
                  handleRemove(expandedNotification, e);
                  setExpandedNotification(null);
                }}
              >
                Remove
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </Popover>
  );
};

export default NotificationBell;
