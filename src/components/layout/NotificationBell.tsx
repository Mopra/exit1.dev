import { useState, useMemo } from 'react';
import { Bell, Maximize2, Clock } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { useUserNotifications } from '@/hooks/useUserNotifications';
import { useNotifications } from '@/hooks/useNotifications';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { formatCreatedAt } from '@/utils/formatters';
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

  // Filter out dismissed system notifications
  const visibleSystemNotifications = useMemo(() => {
    return systemNotifications.filter(n => !dismissedSystemIds.includes(n.id));
  }, [systemNotifications, dismissedSystemIds]);

  // Combine and sort all notifications
  const allNotifications = useMemo(() => {
    const combined: CombinedNotification[] = [
      ...visibleSystemNotifications.map(n => ({
        id: `system_${n.id}`,
        title: n.title,
        message: n.message,
        type: n.type,
        createdAt: n.createdAt,
        isSystem: true,
        read: readSystemIds.includes(n.id), // Check if system notification is read
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
    
    // Sort by createdAt descending (newest first)
    return combined.sort((a, b) => b.createdAt - a.createdAt);
  }, [visibleSystemNotifications, userNotifications, readSystemIds]);

  // Calculate unread count: unread system notifications (not dismissed and not read) + unread user notifications
  const totalUnreadCount = useMemo(() => {
    const unreadSystemCount = visibleSystemNotifications.filter(n => !readSystemIds.includes(n.id)).length;
    return unreadSystemCount + unreadCount;
  }, [visibleSystemNotifications, readSystemIds, unreadCount]);

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
      toast.success('All notifications marked as read');
    } catch (error: any) {
      console.error('Error marking all notifications as read:', error);
      toast.error('Failed to mark all notifications as read');
    }
  };

  const removeNotification = async (notification: CombinedNotification) => {
    if (notification.isSystem) {
      // Dismiss system notification (store in localStorage)
      setDismissedSystemIds([...dismissedSystemIds, notification.id.replace('system_', '')]);
      toast.success('Notification dismissed');
    } else {
      // Delete user notification
      try {
        const deleteNotificationFn = httpsCallable(functions, 'deleteUserNotification');
        await deleteNotificationFn({ notificationId: notification.id });
        toast.success('Notification removed');
      } catch (error: any) {
        console.error('Error removing notification:', error);
        toast.error('Failed to remove notification');
      }
    }
  };

  const handleMarkAsRead = async (notification: CombinedNotification, e: React.MouseEvent) => {
    e.stopPropagation();
    if (notification.isSystem) {
      // Toggle system notification read state in localStorage
      const systemId = notification.id.replace('system_', '');
      if (notification.read) {
        // Mark as unread
        setReadSystemIds(readSystemIds.filter(id => id !== systemId));
        toast.success('Notification marked as unread');
      } else {
        // Mark as read
        setReadSystemIds([...readSystemIds, systemId]);
        toast.success('Notification marked as read');
      }
    } else {
      // Toggle user notification read state in Firestore
      const newReadState = !notification.read;
      await markAsRead(notification.id, newReadState);
      toast.success(`Notification marked as ${newReadState ? 'read' : 'unread'}`);
    }
  };

  const handleRemove = async (notification: CombinedNotification, e: React.MouseEvent) => {
    e.stopPropagation();
    await removeNotification(notification);
  };

  const handleNotificationClick = (notification: CombinedNotification) => {
    if (notification.link) {
      window.location.href = notification.link;
    }
  };

  const handleExpand = (notification: CombinedNotification, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedNotification(notification);
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
        return 'bg-emerald-500/15 text-emerald-50 border-emerald-300/20';
      case 'warning':
        return 'bg-amber-500/15 text-amber-50 border-amber-300/20';
      case 'error':
        return 'bg-red-500/15 text-red-50 border-red-300/20';
      default:
        return 'bg-sky-500/15 text-sky-50 border-sky-300/20';
    }
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
        className={cn(
          "w-[calc(100vw-2rem)] sm:w-96 max-w-[calc(100vw-2rem)] p-0 backdrop-blur-md shadow-2xl border overflow-hidden",
          "bg-sky-500/15 text-sky-50 border-sky-300/20",
          "max-h-[calc(100vh-4rem)]"
        )}
      >
        <div className="flex items-center justify-between px-3 sm:px-4 py-2 sm:py-3 border-b border-sky-300/20 min-w-0 gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h3 className="font-semibold text-sm sm:text-base truncate">Notifications</h3>
            {totalUnreadCount > 0 && (
              <Badge
                variant="secondary"
                className="h-5 px-1.5 text-xs font-medium bg-sky-400/20 text-sky-100 border-sky-300/30 flex-shrink-0"
              >
                {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
              </Badge>
            )}
          </div>
          {totalUnreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={markAllAsRead}
              className="h-7 sm:h-8 px-2 sm:px-4 text-xs cursor-pointer hover:bg-sky-500/20 flex-shrink-0 text-sky-200/80 hover:text-sky-50"
            >
              <span className="hidden sm:inline">Mark all read</span>
              <span className="sm:hidden">Read all</span>
            </Button>
          )}
        </div>
        <div className="max-h-[calc(100vh-12rem)] sm:max-h-[500px] overflow-y-auto w-full">
          {loading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : allNotifications.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No notifications
            </div>
          ) : (
            <div className="p-2 sm:p-4 w-full">
              {allNotifications.map((notification) => (
                <div
                  key={notification.id}
                  onClick={() => handleNotificationClick(notification)}
                  className={cn(
                    "p-3 sm:p-5 rounded-lg mb-2 sm:mb-3 transition-colors w-full box-border",
                    "backdrop-blur-md",
                    getNotificationColor(notification.type),
                    !notification.read 
                      ? "border-2 border-sky-400/50 ring-2 ring-sky-400/20 shadow-lg" 
                      : "border opacity-70",
                    notification.link ? "cursor-pointer hover:bg-opacity-25" : ""
                  )}
                >
                  <div className="flex items-start gap-2 sm:gap-3 w-full min-w-0">
                    <div className="flex-shrink-0 w-5 h-5 sm:w-6 sm:h-6 rounded-full flex items-center justify-center text-xs sm:text-sm font-semibold bg-white/20">
                      {getNotificationIcon(notification.type)}
                    </div>
                    <div className="flex-1 min-w-0 w-0">
                      <div className="flex items-start justify-between gap-2 mb-1 sm:mb-2 w-full min-w-0">
                        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1 flex-wrap">
                          <h4 className={cn(
                            "font-semibold text-sm sm:text-base truncate min-w-0",
                            notification.read && "opacity-75"
                          )}>
                            {notification.title}
                          </h4>
                          {notification.isSystem && (
                            <Badge variant="outline" className="text-xs px-1 sm:px-1.5 py-0 h-4 flex-shrink-0 whitespace-nowrap">
                              System
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 sm:h-7 sm:w-7 flex-shrink-0 cursor-pointer hover:bg-sky-500/20"
                            onClick={(e) => handleExpand(notification, e)}
                            title="Expand notification"
                          >
                            <Maximize2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                          </Button>
                        </div>
                      </div>
                      <div 
                        className={cn(
                          "text-xs sm:text-sm line-clamp-2 break-words overflow-wrap-anywhere mb-1 sm:mb-2",
                          notification.read ? "opacity-70" : "opacity-95",
                          "[&_a]:text-sky-400 [&_a]:underline [&_a]:cursor-pointer [&_a:hover]:text-sky-300"
                        )}
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(notification.message) }}
                      />
                      <p className={cn(
                        "text-xs truncate mb-2 sm:mb-0",
                        notification.read ? "opacity-50" : "opacity-70"
                      )}>
                        {new Date(notification.createdAt).toLocaleDateString()}
                      </p>
                      <div className="flex items-center gap-2 mt-3 sm:mt-4 pt-2 sm:pt-3 border-t border-sky-300/20">
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-8 sm:h-10 text-xs rounded-sm cursor-pointer hover:bg-slate-700/90 flex-1",
                            !notification.read && "bg-slate-800/90"
                          )}
                          onClick={(e) => handleMarkAsRead(notification, e)}
                        >
                          <span className="hidden sm:inline">{notification.read ? "Mark as unread" : "Mark as read"}</span>
                          <span className="sm:hidden">{notification.read ? "Unread" : "Read"}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 sm:h-10 text-xs bg-slate-900/90 rounded-sm cursor-pointer hover:bg-slate-800/90 flex-1"
                          onClick={(e) => handleRemove(notification, e)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
      
      {/* Expanded Notification Dialog */}
      <Dialog open={!!expandedNotification} onOpenChange={(open) => !open && setExpandedNotification(null)}>
        {expandedNotification && (
          <DialogContent
            className={cn(
              "max-w-[calc(100vw-1rem)] sm:max-w-4xl backdrop-blur-md shadow-2xl border p-0",
              "bg-sky-500/15 text-sky-50 border-sky-300/20"
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
                    {expandedNotification.isSystem && (
                      <Badge 
                        variant="outline" 
                        className="text-xs px-1.5 sm:px-2 py-0.5 h-5 flex-shrink-0 border-sky-300/30 text-sky-100 bg-sky-500/10"
                      >
                        System
                      </Badge>
                    )}
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
            
            <div className="px-4 sm:px-8 py-3 sm:py-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
              <Button
                variant={expandedNotification.read ? "outline" : "default"}
                size="sm"
                className={cn(
                  "cursor-pointer flex-1",
                  expandedNotification.read 
                    ? "border-sky-300/30 text-sky-100 hover:bg-sky-500/20 hover:text-sky-50"
                    : "bg-sky-500/30 text-sky-50 hover:bg-sky-500/40 border-sky-400/30"
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkAsRead(expandedNotification, e);
                }}
              >
                <span className="hidden sm:inline">{expandedNotification.read ? "Mark as unread" : "Mark as read"}</span>
                <span className="sm:hidden">{expandedNotification.read ? "Unread" : "Read"}</span>
              </Button>
              {expandedNotification.link && (
                <Button
                  variant="default"
                  size="sm"
                  className="cursor-pointer bg-sky-600/40 text-sky-50 hover:bg-sky-600/50 border-sky-400/30 flex-1 sm:flex-none"
                  onClick={() => {
                    window.location.href = expandedNotification.link!;
                  }}
                >
                  <span className="hidden sm:inline">Open Link</span>
                  <span className="sm:hidden">Link</span>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer text-sky-100/80 hover:text-sky-50 hover:bg-sky-500/20 flex-1 sm:flex-1"
                onClick={(e) => {
                  e.stopPropagation();
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

