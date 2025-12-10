import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '@/firebase';
import type { SystemNotification } from '@/hooks/useNotifications';
import { 
  Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Switch, GlowCard, ScrollArea, EmptyState, Tooltip, TooltipContent, TooltipTrigger
} from '@/components/ui';
import { Bell, Trash2, AlertTriangle, Info, CheckCircle, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useHorizontalScroll } from '@/hooks/useHorizontalScroll';

interface NotificationManagerProps {
  onCreateClick?: () => void;
}

export const NotificationManager: React.FC<NotificationManagerProps> = ({ onCreateClick }) => {
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();

  useEffect(() => {
    // Query all notifications - we'll sort client-side to avoid index requirement
    // This works even when the collection is empty or index isn't deployed yet
    const q = query(collection(db, 'system_notifications'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const notifs = snapshot.docs
          .map(doc => {
            const data = doc.data();
            return { 
              id: doc.id, 
              ...data,
              createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
            } as SystemNotification;
          })
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // Sort client-side
        setNotifications(notifs);
        setLoading(false);
      },
      (error: any) => {
        console.error("Error fetching notifications:", error);
        // Only show error if it's not a permission/index issue that might resolve
        if (error?.code !== 'permission-denied' && error?.code !== 'failed-precondition') {
          toast.error(`Failed to fetch notifications: ${error?.message || 'Unknown error'}`);
        } else if (error?.code === 'failed-precondition') {
          console.warn("Firestore index may be required. Deploy with: firebase deploy --only firestore:indexes");
        }
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  const handleToggle = async (id: string, currentStatus: boolean) => {
    try {
        const functions = getFunctions();
        const toggleFn = httpsCallable(functions, 'toggleSystemNotification');
        await toggleFn({ notificationId: id, active: !currentStatus });
        toast.success(`Notification ${!currentStatus ? 'activated' : 'deactivated'}`);
    } catch (error) {
        console.error(error);
        toast.error("Failed to update status");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this notification?")) return;
    
    try {
        const functions = getFunctions();
        const deleteFn = httpsCallable(functions, 'deleteSystemNotification');
        await deleteFn({ notificationId: id });
        toast.success("Notification deleted");
    } catch (error) {
        console.error(error);
        toast.error("Failed to delete notification");
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
        case 'info': return <Info className="h-4 w-4 text-sky-500" />;
        case 'warning': return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
        case 'success': return <CheckCircle className="h-4 w-4 text-green-500" />;
        case 'error': return <XCircle className="h-4 w-4 text-destructive" />;
        default: return <Info className="h-4 w-4" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-3">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          <span className="text-muted-foreground">Loading notifications...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0">
      <GlowCard className="w-full min-w-0 overflow-hidden">
        <ScrollArea className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
          <div className="min-w-[800px] w-full">
            <Table>
              <TableHeader className="bg-muted border-b">
                <TableRow>
                  <TableHead className="px-4 py-4 text-left w-12">Status</TableHead>
                  <TableHead className="px-4 py-4 text-left">Type</TableHead>
                  <TableHead className="px-4 py-4 text-left">Content</TableHead>
                  <TableHead className="px-4 py-4 text-left">Created</TableHead>
                  <TableHead className="px-4 py-4 text-left">Expires</TableHead>
                  <TableHead className="px-4 py-4 text-left">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-border">
                {notifications.map(notif => (
                  <TableRow key={notif.id} className="hover:bg-muted/50 transition-all duration-300 ease-out group">
                    <TableCell className="px-4 py-4">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div>
                            <Switch 
                              checked={notif.active} 
                              onCheckedChange={() => handleToggle(notif.id, notif.active)} 
                              className="cursor-pointer"
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-sm">
                            {notif.active 
                              ? "Notification is active and visible to all users"
                              : "Notification is inactive and hidden from users"}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        {getTypeIcon(notif.type)}
                        <span className="capitalize text-sm">{notif.type}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="flex flex-col max-w-[300px]">
                        <span className="font-medium text-sm truncate">{notif.title}</span>
                        <span className="text-xs text-muted-foreground truncate">{notif.message.replace(/<[^>]*>/g, '').substring(0, 100)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <span className="text-xs font-mono text-muted-foreground">
                        {format(notif.createdAt, 'MMM d, yyyy')}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <span className="text-xs font-mono text-muted-foreground">
                        {notif.expiresAt ? format(notif.expiresAt, 'MMM d, yyyy') : 'Never'}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8 text-muted-foreground hover:text-destructive cursor-pointer" 
                        onClick={() => handleDelete(notif.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollArea>
        
        {notifications.length === 0 && (
          <div className="px-8 py-8">
            <EmptyState
              variant="empty"
              icon={Bell}
              title="No notifications found"
              description="Create your first system notification to send a message to all users."
              action={onCreateClick ? {
                label: "Create Notification",
                onClick: onCreateClick,
                icon: Bell
              } : undefined}
            />
          </div>
        )}
      </GlowCard>
    </div>
  );
};

