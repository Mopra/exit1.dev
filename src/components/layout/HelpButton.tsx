import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { ArrowUpRight } from 'lucide-react';
import { functions } from '@/firebase';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { toast } from 'sonner';

const DOCS_URL = 'https://docs.exit1.dev';
const CONTACT_EMAIL = 'connect@exit1.dev';

const DOCS_LINKS: Array<{ label: string; href: string }> = [
  { label: 'Getting started', href: `${DOCS_URL}/getting-started` },
  { label: 'Monitoring', href: `${DOCS_URL}/monitoring` },
  { label: 'Alerting', href: `${DOCS_URL}/alerting` },
  { label: 'API reference', href: `${DOCS_URL}/api-reference` },
];

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

const HelpButton = () => {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'h' && e.key !== 'H') return;
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
      toast.success("Thanks — we'll get back to you.");
      setOpen(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to send message';
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
          aria-label="Get help"
          className="inline-flex items-center gap-2 h-7 pl-3 pr-1.5 rounded-full text-xs font-medium text-foreground/90 hover:bg-accent/60 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>Help</span>
          <Kbd>H</Kbd>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 p-0 overflow-hidden bg-popover supports-[backdrop-filter]:bg-popover backdrop-blur-none backdrop-saturate-100"
      >
        <div className="px-3 pt-3 pb-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">
            Documentation
          </div>
          <ul className="flex flex-col">
            {DOCS_LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 py-1.5 text-sm text-foreground/90 hover:text-foreground transition-colors group"
                >
                  <span>{link.label}</span>
                  <ArrowUpRight className="size-3.5 text-muted-foreground/60 group-hover:text-foreground transition-colors" />
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-border/40" />
        <div className="p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">
            Still stuck?
          </div>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you need help with — we read every message"
            className="min-h-[100px] resize-none border-border/60 bg-background/40 text-sm placeholder:text-muted-foreground/80 focus-visible:ring-1 focus-visible:border-foreground/30 focus-visible:ring-foreground/15"
            disabled={submitting}
          />
        </div>
        <div className="flex items-center justify-between gap-2 px-3 pb-3 text-xs text-muted-foreground">
          <div>
            Or email{' '}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-primary hover:underline"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || message.trim().length === 0}
            className="h-7 px-3 text-xs"
          >
            {submitting ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default HelpButton;
