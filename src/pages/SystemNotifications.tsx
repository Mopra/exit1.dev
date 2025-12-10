import React, { useState } from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import { PageHeader, PageContainer } from '@/components/layout';
import { NotificationManager } from '@/components/admin/NotificationManager';
import { Bell, Shield, Plus } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, RichTextEditor } from '@/components/ui';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { toast } from 'sonner';

const SystemNotifications: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  
  // Form state
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [type, setType] = useState<'info' | 'warning' | 'success' | 'error'>('info');
  const [expiryDays, setExpiryDays] = useState('7');

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
      setTitle('');
      setMessage('');
      setType('info');
      setExpiryDays('7');
    } catch (error) {
      console.error(error);
      toast.error("Failed to create notification");
    } finally {
      setSubmitting(false);
    }
  };

  if (adminLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-full max-w-md p-6 bg-card border rounded-lg">
            <div className="text-center space-y-4">
              <Shield className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <h2 className="text-2xl font-semibold">Access Denied</h2>
                <p className="text-muted-foreground mt-2">
                  You don't have permission to access this page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader 
        title="System Notifications"
        description="Manage system-wide notifications for all users"
        icon={Bell}
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1 cursor-pointer">
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
                <Button variant="outline" onClick={() => setOpen(false)} className="cursor-pointer">Cancel</Button>
                <Button onClick={handleCreate} disabled={submitting} className="cursor-pointer">
                  {submitting ? "Creating..." : "Create Notification"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="flex-1 p-6 min-h-0">
        <div className="h-full max-w-full overflow-hidden">
          <NotificationManager onCreateClick={() => setOpen(true)} />
        </div>
      </div>
    </PageContainer>
  );
};

export default SystemNotifications;

