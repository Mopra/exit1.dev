import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { Button, Input, Checkbox, Badge, Separator, GlowCard, Switch, Table, TableHeader, TableRow, TableHead, TableBody, TableCell, ScrollArea, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui';
import { AlertCircle, AlertTriangle, CheckCircle, Mail, Save, TestTube2 } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import { useChecks } from '../hooks/useChecks';
import { findWebhookEvent } from '../lib/webhook-events';
import { useHorizontalScroll } from '../hooks/useHorizontalScroll';

const ALL_EVENTS: { value: WebhookEvent; label: string }[] = [
  { value: 'website_down', label: 'Website Down' },
  { value: 'website_up', label: 'Website Up' },
  { value: 'website_error', label: 'Website Error' },
  { value: 'ssl_error', label: 'SSL Error' },
  { value: 'ssl_warning', label: 'SSL Warning' },
];

type EmailSettings = {
  userId: string;
  enabled: boolean;
  recipient: string;
  events: WebhookEvent[];
  minConsecutiveEvents?: number;
  perCheck?: Record<string, { enabled?: boolean; events?: WebhookEvent[] }>;
  createdAt: number;
  updatedAt: number;
} | null;

export default function Emails() {
  const { userId } = useAuth();
  const { user } = useUser();
  const userEmail = user?.primaryEmailAddress?.emailAddress || '';
  const [settings, setSettings] = useState<EmailSettings>(null);
  const [saving, setSaving] = useState(false);
  const [recipient, setRecipient] = useState(userEmail || '');
  const [enabled, setEnabled] = useState(false);
  const [events, setEvents] = useState<WebhookEvent[]>(['website_down', 'website_up', 'website_error', 'ssl_error', 'ssl_warning']);
  const [minConsecutiveEvents, setMinConsecutiveEvents] = useState<number>(1);
  const [search, setSearch] = useState('');

  const functions = getFunctions();
  const saveEmailSettings = httpsCallable(functions, 'saveEmailSettings');
  const updateEmailPerCheck = httpsCallable(functions, 'updateEmailPerCheck');
  const getEmailSettings = httpsCallable(functions, 'getEmailSettings');
  const sendTestEmail = httpsCallable(functions, 'sendTestEmail');

  const log = useCallback(
    (msg: string) => console.log(`[Emails] ${msg}`),
    []
  );

  // Use the same hook as the Checks page for consistency
  const { checks } = useChecks(userId ?? null, log);
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();

  useEffect(() => {
    if (!userId) return;
    (async () => {
      const res = await getEmailSettings({});
      const data = (res.data as any)?.data as EmailSettings;
      if (data) {
        setSettings(data);
        setRecipient(data.recipient || userEmail || '');
        setEnabled(Boolean(data.enabled));
        setEvents((data.events && data.events.length ? data.events : events) as WebhookEvent[]);
        setMinConsecutiveEvents(Math.max(1, Number((data as any).minConsecutiveEvents || 1)));
      } else {
        setRecipient((prev) => prev || userEmail || '');
      }
    })();
  }, [userId, userEmail]);

  const filteredChecks = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return checks;
    return checks.filter((c) =>
      (c.name || '').toLowerCase().includes(term) || (c.url || '').toLowerCase().includes(term)
    );
  }, [checks, search]);

  const toggleEvent = (value: WebhookEvent) => {
    setEvents((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const handleSave = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      await saveEmailSettings({ recipient, enabled: true, events, minConsecutiveEvents });
      setSettings((prev) => (prev ? { ...prev, recipient, enabled: true, events, minConsecutiveEvents, updatedAt: Date.now() } : prev));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    try {
      await handleSave();
      await sendTestEmail({});
      alert('Test email sent. Check your inbox.');
    } catch (e: any) {
      alert(e?.message || 'Failed to send test email');
    }
  };

  const handleTogglePerCheck = async (checkId: string, value: boolean | null) => {
    // Update local state immediately for better UX
    setSettings((prev) => {
      const next = prev ? { ...prev } : null;
      if (!next) return prev;
      const per = { ...(next.perCheck || {}) };
      const nextEntry = { ...(per[checkId] || {}) } as any;
      if (value === null) {
        delete nextEntry.enabled;
      } else {
        nextEntry.enabled = value;
      }
      per[checkId] = nextEntry;
      next.perCheck = per;
      next.updatedAt = Date.now();
      return next;
    });
    
    // Then update the server
    try {
      await updateEmailPerCheck({ checkId, enabled: value });
    } catch (error) {
      // Revert on error
      setSettings((prev) => {
        const next = prev ? { ...prev } : null;
        if (!next) return prev;
        const per = { ...(next.perCheck || {}) };
        const nextEntry = { ...(per[checkId] || {}) } as any;
        if (value === null) {
          // could not clear; set to default-on fallback
          nextEntry.enabled = true;
        } else {
          nextEntry.enabled = !value;
        }
        per[checkId] = nextEntry;
        next.perCheck = per;
        next.updatedAt = Date.now();
        return next;
      });
      console.error('Failed to update email settings:', error);
    }
  };

  const handleToggleAllPerCheck = async (value: boolean) => {
    // Update local state for all filtered checks
    setSettings((prev) => {
      const next = prev ? { ...prev } : null;
      if (!next) return prev;
      const per = { ...(next.perCheck || {}) };
      filteredChecks.forEach((c) => {
        const entry = { ...(per[c.id] || {}) } as any;
        entry.enabled = value;
        per[c.id] = entry;
      });
      next.perCheck = per;
      next.updatedAt = Date.now();
      return next;
    });
    try {
      await Promise.allSettled(
        filteredChecks.map((c) => updateEmailPerCheck({ checkId: c.id, enabled: value }))
      );
    } catch (error) {
      console.error('Failed to bulk update email settings:', error);
    }
  };

  const handlePerCheckEvents = async (checkId: string, newEvents: WebhookEvent[]) => {
    // Update local state immediately for better UX
    setSettings((prev) => {
      const next = prev ? { ...prev } : null;
      if (!next) return prev;
      const per = { ...(next.perCheck || {}) };
      per[checkId] = { ...(per[checkId] || {}), events: newEvents };
      next.perCheck = per;
      next.updatedAt = Date.now();
      return next;
    });
    
    // Then update the server
    try {
      await updateEmailPerCheck({ checkId, events: newEvents });
    } catch (error) {
      // Revert on error - we'd need to know the previous events to revert properly
      console.error('Failed to update email events:', error);
    }
  };

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden min-w-0 w-full max-w-full">
      <div className="flex items-center justify-between gap-4 p-4 sm:p-6 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2"><Mail className="w-5 h-5" /> Emails</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">Get email alerts when your checks go down, recover, or error.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleTest} disabled={saving || !recipient} variant="ghost" className="gap-2 cursor-pointer">
            <TestTube2 className="w-4 h-4" /> Test
          </Button>
          <Button onClick={handleSave} disabled={saving} className="gap-2 cursor-pointer">
            <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6">
        <GlowCard className="lg:col-span-1">
          <div className="p-4 sm:p-6 space-y-5">
              <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Default email events</div>
                <div className="text-xs text-muted-foreground">Used by checks without overrides</div>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Recipient email</div>
              <Input type="email" placeholder="you@example.com" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            </div>
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-sm font-medium">Flap suppression</div>
                <Badge variant="outline" className="text-[10px] px-2 py-0.5">Global</Badge>
              </div>
              <div className="text-xs text-muted-foreground mb-2">Require consecutive checks before sending any email (applies to Down, Up, and Error).</div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={minConsecutiveEvents}
                  onChange={(e) => setMinConsecutiveEvents(Math.max(1, Number(e.target.value || 1)))}
                  className="w-24"
                />
                <span className="text-xs text-muted-foreground">checks</span>
              </div>
            </div>
            <div className="rounded-md border border-sky-500/30 bg-sky-500/5 backdrop-blur px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium">Email delivery policy</div>
                  <div className="text-xs text-muted-foreground">1 email per check per event type per hour • Flap suppression: {minConsecutiveEvents} consecutive</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-sky-500/40 text-sky-300 bg-sky-500/10">1/hr</Badge>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs cursor-pointer">Details</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Email delivery policy</DialogTitle>
                        <DialogDescription>
                          We cap email notifications to keep them actionable:
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-2 text-sm">
                        <p>• At most one email per check per event type every hour.</p>
                        <p>• Flap suppression requires {minConsecutiveEvents} consecutive checks before the first email.</p>
                        <p>• Webhooks are not throttled and still fire for every event.</p>
                        <p>• Per‑check overrides below still apply to decide which events send.</p>
                        <p className="text-xs text-muted-foreground">Example: If a check goes down multiple times in an hour, you’ll get a single “Down” email for that hour.</p>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </div>
            </div>
            <Separator />
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Events</div>
                <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-sky-500/40 text-sky-300 bg-sky-500/10">1/hr per check</Badge>
              </div>
              <div className="text-xs text-muted-foreground mb-3">Sent by default; checks can override</div>
              <div className="space-y-2">
                {ALL_EVENTS.map((e) => (
                  <label key={e.value} className="flex items-center justify-between p-2 rounded border cursor-pointer">
                    <div className="flex items-center gap-2">
                      <Checkbox checked={events.includes(e.value)} onCheckedChange={() => toggleEvent(e.value)} />
                      <span className="text-sm">{e.label}</span>
                    </div>
                    {e.value === 'website_down' ? <AlertTriangle className="w-4 h-4 text-destructive" /> : e.value === 'website_up' ? <CheckCircle className="w-4 h-4 text-primary" /> : <AlertCircle className="w-4 h-4 text-yellow-500" />}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </GlowCard>

        <GlowCard className="lg:col-span-2">
          <div className="p-4 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium">Individual check settings</div>
              <Input placeholder="Search checks..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
            </div>
            <div className="rounded-md border overflow-hidden">
              <ScrollArea className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
                                 <div className="min-w-[400px] w-full">
                  <Table>
                <TableHeader>
                  <TableRow>
                                                               <TableHead className="w-12">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={filteredChecks.length > 0 && filteredChecks.every((c) => {
                              const per = settings?.perCheck?.[c.id];
                              const perEnabled = per?.enabled ?? undefined;
                              const effectiveOn = perEnabled === undefined ? enabled : perEnabled;
                              return Boolean(effectiveOn);
                            })}
                            onCheckedChange={(v) => handleToggleAllPerCheck(v)}
                            className="cursor-pointer"
                          />
                        </div>
                      </TableHead>
                      <TableHead className="w-64">Check</TableHead>
                      <TableHead className="w-48">Events</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredChecks.map((c) => {
                    const per = settings?.perCheck?.[c.id];
                    const perEnabled = per?.enabled ?? undefined;
                    const perEvents = per?.events ?? undefined;
                    const effectiveOn = perEnabled === undefined ? enabled : perEnabled;
                    const effectiveEvents = (perEvents ?? events);
                    
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <Switch
                            checked={Boolean(effectiveOn)}
                            onCheckedChange={(v) => handleTogglePerCheck(c.id, v)}
                            className="cursor-pointer"
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <div className="font-medium font-sans text-foreground flex items-center gap-2 text-sm">
                              {c.name}
                            </div>
                            <div className="text-sm font-mono text-muted-foreground truncate max-w-xs">
                              {c.url}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {ALL_EVENTS.map((e) => {
                              const isOn = effectiveOn && effectiveEvents.includes(e.value);
                              const eventType = findWebhookEvent(e.value);
                              const colorClass = eventType?.badgeVariant === 'error'
                                ? 'bg-destructive hover:bg-destructive/90'
                                : eventType?.badgeVariant === 'success'
                                ? 'bg-primary hover:bg-primary/90'
                                : eventType?.badgeVariant === 'warning'
                                ? 'bg-primary hover:bg-primary/90'
                                : '';
                              const Icon = eventType?.icon;
                              return (
                                <Badge
                                  key={e.value}
                                  variant={isOn ? (eventType?.badgeVariant as any || 'default') : 'outline'}
                                  className={`text-xs px-2 py-1 cursor-pointer ${isOn ? colorClass : ''} ${!isOn ? 'text-muted-foreground border-muted-foreground' : ''}`}
                                  onClick={() => {
                                    const next = new Set(effectiveEvents);
                                    if (next.has(e.value)) next.delete(e.value); else next.add(e.value);
                                    handlePerCheckEvents(c.id, Array.from(next) as WebhookEvent[]);
                                  }}
                                >
                                  {Icon ? <Icon className="w-3 h-3 mr-1" /> : null}
                                  {e.label}
                                </Badge>
                              );
                            })}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
                </div>
              </ScrollArea>
            </div>
          </div>
        </GlowCard>
      </div>
    </div>
  );
}


