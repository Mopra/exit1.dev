import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/Button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const DOCS_URL = 'https://docs.exit1.dev';
const CONTACT_EMAIL = 'connect@exit1.dev';

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

const Kbd = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <kbd
    className={cn(
      'inline-flex items-center justify-center h-5 min-w-5 px-1 rounded border border-border/50 bg-muted/60 text-[10px] font-mono text-muted-foreground',
      className,
    )}
  >
    {children}
  </kbd>
);

const FeedbackButton = () => {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!open) setMessage('');
  }, [open]);

  const handleSubmit = async () => {
    const trimmed = message.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const submitFeedback = httpsCallable(functions, 'submitFeedback');
      await submitFeedback({
        message: trimmed,
        page: typeof window !== 'undefined' ? window.location.href : undefined,
      });
      toast.success('Thanks for the feedback!');
      setOpen(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to send feedback';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Send feedback"
          className="inline-flex items-center gap-2 h-7 pl-3 pr-1.5 rounded-full text-xs font-medium text-foreground/90 hover:bg-accent/60 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>Feedback</span>
          <Kbd>F</Kbd>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 p-0 overflow-hidden"
      >
        <div className="p-3">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Have an idea to improve this page? Tell the exit1 team"
            className="min-h-[120px] resize-none border-border/60 bg-background/40 text-sm placeholder:text-muted-foreground/80 focus-visible:ring-1"
            disabled={submitting}
            autoFocus
          />
        </div>
        <div className="flex items-center justify-between gap-2 px-3 pb-3 text-xs text-muted-foreground">
          <div>
            Need help?{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-primary hover:underline"
            >
              Contact us
            </a>{' '}
            or{' '}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              see docs
            </a>
            .
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || message.trim().length === 0}
            className="h-7 gap-1.5 pl-3 pr-1.5 text-xs"
          >
            <span>{submitting ? 'Sending…' : 'Send'}</span>
            <span className="inline-flex items-center gap-0.5">
              <Kbd className="bg-background/20 border-foreground/20 text-primary-foreground/80">Ctrl</Kbd>
              <Kbd className="bg-background/20 border-foreground/20 text-primary-foreground/80">↵</Kbd>
            </span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default FeedbackButton;
