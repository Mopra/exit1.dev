import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import EmailEditor from './EmailEditor';
import { Mail, Loader2 } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { toast } from 'sonner';
import type { PlatformUser } from './UserTable';

interface EmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: PlatformUser;
  onSend?: () => void;
}

const EmailDialog: React.FC<EmailDialogProps> = ({
  open,
  onOpenChange,
  user,
  onSend,
}) => {
  const [subject, setSubject] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!subject.trim()) {
      toast.error('Subject is required');
      return;
    }

    if (!htmlBody.trim()) {
      toast.error('Email body is required');
      return;
    }

    setSending(true);
    try {
      const sendSingleEmail = httpsCallable(functions, 'sendSingleEmail');
      await sendSingleEmail({
        subject: subject.trim(),
        htmlBody: htmlBody.trim(),
        recipientEmail: user.email,
        recipientId: user.id,
      });

      toast.success('Email sent successfully', {
        description: `Email sent to ${user.email}`,
      });

      // Reset form
      setSubject('');
      setHtmlBody('');
      onOpenChange(false);
      onSend?.();
    } catch (error: any) {
      const errorMessage = error?.message || 'Failed to send email';
      toast.error('Failed to send email', {
        description: errorMessage,
      });
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    if (!sending) {
      setSubject('');
      setHtmlBody('');
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5" />
            Send Email to {user.displayName || user.email}
          </DialogTitle>
          <DialogDescription>
            Compose and send an email to {user.email}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="email-subject">Subject</Label>
            <Input
              id="email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter email subject..."
              disabled={sending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email-body">Body</Label>
            <EmailEditor
              value={htmlBody}
              onChange={setHtmlBody}
              placeholder="Enter email content..."
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={sending}
            className="cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={sending || !subject.trim() || !htmlBody.trim()}
            className="cursor-pointer gap-2"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Mail className="w-4 h-4" />
                Send Email
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EmailDialog;

