import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '@/firebase';
import type { SystemNotification } from '@/hooks/useNotifications';
import { 
  Card, CardContent, CardHeader, CardTitle, 
  Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Switch, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
  RichTextEditor, Badge
} from '@/components/ui';
import { Bell, Plus, Trash2, AlertTriangle, Info, CheckCircle, XCircle, Power } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useMobile } from '@/hooks/useMobile';
import { Separator } from '@/components/ui/separator';

export const NotificationManager: React.FC = () => {
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const isMobile = useMobile(768);
  
  // Form state
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [type, setType] = useState<'info' | 'warning' | 'success' | 'error'>('info');
  const [expiryDays, setExpiryDays] = useState('7');

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

  const handleCreate = async () => {
    if (!title || !message) {
        toast.error("Please fill in all required fields");
        return;
    }

    setSubmitting(true);
    try {
        const functions = getFunctions();
        const createFn = httpsCallable(functions, 'createSystemNotification');
        
        const expiresAt = parseInt(expiryDays) > 0 
            ? Date.now() + (parseInt(expiryDays) * 24 * 60 * 60 * 1000) 
            : undefined;

        await createFn({
            title,
            message,
            type,
            expiresAt
        });

        toast.success("Notification created");
        setOpen(false);
        resetForm();
    } catch (error) {
        console.error(error);
        toast.error("Failed to create notification");
    } finally {
        setSubmitting(false);
    }
  };

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

  const resetForm = () => {
    setTitle('');
    setMessage('');
    setType('info');
    setExpiryDays('7');
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

  return (
    <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50 shadow-lg">
        <CardHeader className="flex flex-row items-center justify-between gap-2 sm:gap-4">
            <div className="flex items-center gap-2 min-w-0">
                <Bell className="h-5 w-5 text-primary flex-shrink-0" />
                <CardTitle className="text-base sm:text-lg truncate">System Notifications</CardTitle>
            </div>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                    <Button size="sm" className="gap-1 flex-shrink-0">
                        <Plus className="h-4 w-4" />
                        <span className="hidden sm:inline">New Notification</span>
                        <span className="sm:hidden">New</span>
                    </Button>
                </DialogTrigger>
                <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl">
                    <DialogHeader>
                        <DialogTitle>Create System Notification</DialogTitle>
                        <DialogDescription>
                            Send a message to all users.
                        </DialogDescription>
                    </DialogHeader>
                    
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="title">Title</Label>
                            <Input id="title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g., Maintenance Scheduled" />
                        </div>
                        
                        <div className="grid gap-2">
                            <Label htmlFor="message">Message</Label>
                            <RichTextEditor 
                                content={message} 
                                onChange={setMessage}
                                placeholder="Notification content... You can add links, bold text, and lists."
                            />
                        </div>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label htmlFor="type">Type</Label>
                                <Select value={type} onValueChange={(v: any) => setType(v)}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select type" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="info">Info</SelectItem>
                                        <SelectItem value="warning">Warning</SelectItem>
                                        <SelectItem value="success">Success</SelectItem>
                                        <SelectItem value="error">Error</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            
                            <div className="grid gap-2">
                                <Label htmlFor="expiry">Expires In</Label>
                                <Select value={expiryDays} onValueChange={setExpiryDays}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select duration" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="1">1 Day</SelectItem>
                                        <SelectItem value="3">3 Days</SelectItem>
                                        <SelectItem value="7">1 Week</SelectItem>
                                        <SelectItem value="30">1 Month</SelectItem>
                                        <SelectItem value="0">Never</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                        <Button onClick={handleCreate} disabled={submitting}>
                            {submitting ? "Creating..." : "Create Notification"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </CardHeader>
        <CardContent>
            {loading ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
            ) : notifications.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No notifications found.</div>
            ) : (
                <>
                    {/* Mobile Card Layout */}
                    {isMobile ? (
                        <div className="space-y-4">
                            {notifications.map(notif => (
                                <Card key={notif.id} className="bg-background/40 backdrop-blur border-sky-200/30">
                                    <CardContent className="p-4 space-y-3">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                                {getTypeIcon(notif.type)}
                                                <span className="capitalize text-sm font-medium">{notif.type}</span>
                                                <Badge variant={notif.active ? "default" : "secondary"} className="ml-auto flex-shrink-0">
                                                    {notif.active ? 'Active' : 'Inactive'}
                                                </Badge>
                                            </div>
                                        </div>
                                        
                                        <div className="space-y-1">
                                            <h4 className="font-semibold text-sm">{notif.title}</h4>
                                            <p className="text-xs text-muted-foreground line-clamp-2">{notif.message.replace(/<[^>]*>/g, '').substring(0, 100)}</p>
                                        </div>
                                        
                                        <Separator />
                                        
                                        <div className="grid grid-cols-2 gap-3 text-xs">
                                            <div>
                                                <span className="text-muted-foreground">Created:</span>
                                                <p className="font-medium mt-0.5">{format(notif.createdAt, 'MMM d, yyyy')}</p>
                                            </div>
                                            <div>
                                                <span className="text-muted-foreground">Expires:</span>
                                                <p className="font-medium mt-0.5">{notif.expiresAt ? format(notif.expiresAt, 'MMM d, yyyy') : 'Never'}</p>
                                            </div>
                                        </div>
                                        
                                        <Separator />
                                        
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-muted-foreground">Status:</span>
                                                <Switch 
                                                    checked={notif.active} 
                                                    onCheckedChange={() => handleToggle(notif.id, notif.active)} 
                                                    className="scale-90"
                                                />
                                            </div>
                                            <Button 
                                                variant="ghost" 
                                                size="sm"
                                                className="h-8 text-muted-foreground hover:text-destructive" 
                                                onClick={() => handleDelete(notif.id)}
                                            >
                                                <Trash2 className="h-4 w-4 mr-2" />
                                                Delete
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    ) : (
                        /* Desktop Table Layout */
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Content</TableHead>
                                    <TableHead>Created</TableHead>
                                    <TableHead>Expires</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {notifications.map(notif => (
                                    <TableRow key={notif.id}>
                                        <TableCell>
                                            <div className={`flex items-center gap-2 ${notif.active ? 'text-green-600' : 'text-muted-foreground'}`}>
                                                <Power className="h-3 w-3" />
                                                <span className="text-xs font-medium">{notif.active ? 'Active' : 'Inactive'}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                {getTypeIcon(notif.type)}
                                                <span className="capitalize text-sm">{notif.type}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex flex-col max-w-[300px]">
                                                <span className="font-medium truncate">{notif.title}</span>
                                                <span className="text-xs text-muted-foreground truncate">{notif.message.replace(/<[^>]*>/g, '').substring(0, 100)}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-xs text-muted-foreground">
                                            {format(notif.createdAt, 'MMM d, yyyy')}
                                        </TableCell>
                                        <TableCell className="text-xs text-muted-foreground">
                                            {notif.expiresAt ? format(notif.expiresAt, 'MMM d, yyyy') : 'Never'}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <Switch 
                                                    checked={notif.active} 
                                                    onCheckedChange={() => handleToggle(notif.id, notif.active)} 
                                                    className="scale-75"
                                                />
                                                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(notif.id)}>
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </>
            )}
        </CardContent>
    </Card>
  );
};

