import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { 
  Button, 
  Input, 
  Badge, 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle,
  Switch, 
  Table, 
  TableHeader, 
  TableRow, 
  TableHead, 
  TableBody, 
  TableCell, 
  ScrollArea, 
  Label,
  Separator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { AlertCircle, AlertTriangle, CheckCircle, Mail, TestTube2, Settings2, RotateCcw } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import { useChecks } from '../hooks/useChecks';
import { useHorizontalScroll } from '../hooks/useHorizontalScroll';
import { useDebounce } from '../hooks/useDebounce';
import { toast } from 'sonner';
import { SearchInput } from '../components/ui';

const ALL_EVENTS: { value: WebhookEvent; label: string; icon: typeof AlertCircle }[] = [
  { value: 'website_down', label: 'Down', icon: AlertTriangle },
  { value: 'website_up', label: 'Up', icon: CheckCircle },
  { value: 'website_error', label: 'Error', icon: AlertCircle },
  { value: 'ssl_error', label: 'SSL Error', icon: AlertCircle },
  { value: 'ssl_warning', label: 'SSL Warning', icon: AlertCircle },
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
  const [manualSaving, setManualSaving] = useState(false);
  const [recipient, setRecipient] = useState(userEmail || '');
  const [events, setEvents] = useState<WebhookEvent[]>(['website_down', 'website_up', 'website_error', 'ssl_error', 'ssl_warning']);
  const [minConsecutiveEvents, setMinConsecutiveEvents] = useState<number>(1);
  const [search, setSearch] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const lastSavedRef = useRef<{ recipient: string; events: WebhookEvent[]; minConsecutiveEvents: number } | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef(false);
  const pendingNotificationRef = useRef<boolean>(false);

  const functions = getFunctions();
  const saveEmailSettings = httpsCallable(functions, 'saveEmailSettings');
  const updateEmailPerCheck = httpsCallable(functions, 'updateEmailPerCheck');
  const getEmailSettings = httpsCallable(functions, 'getEmailSettings');
  const sendTestEmail = httpsCallable(functions, 'sendTestEmail');

  const log = useCallback(
    (msg: string) => console.log(`[Emails] ${msg}`),
    []
  );

  const { checks } = useChecks(userId ?? null, log);
  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();

  // Debounce recipient for auto-save
  const debouncedRecipient = useDebounce(recipient, 1000);
  const debouncedEvents = useDebounce(events, 500);
  const debouncedMinConsecutive = useDebounce(minConsecutiveEvents, 500);

  const handleSaveSettings = useCallback(async (showSuccessToast = false, force = false) => {
    if (!userId || !recipient) return;
    
    // Validate events array
    if (!events || events.length === 0) {
      toast.error('At least one alert type is required', {
        description: 'Please enable at least one alert type.',
        duration: 3000,
      });
      return;
    }
    
    // Prevent concurrent saves
    if (isSavingRef.current) return;
    
    // Check if anything actually changed (unless forced)
    if (!force) {
      const current = { recipient, events: [...events].sort(), minConsecutiveEvents };
      const lastSaved = lastSavedRef.current;
      if (lastSaved && 
          lastSaved.recipient === current.recipient &&
          JSON.stringify(lastSaved.events) === JSON.stringify(current.events) &&
          lastSaved.minConsecutiveEvents === current.minConsecutiveEvents) {
        return; // Nothing changed, skip save
      }
    }

    const isManualSave = showSuccessToast || force;
    isSavingRef.current = true;
    if (isManualSave) {
      setManualSaving(true);
    }
    try {
      await saveEmailSettings({ recipient, enabled: true, events, minConsecutiveEvents });
      lastSavedRef.current = {
        recipient,
        events: [...events].sort(),
        minConsecutiveEvents,
      };
      setSettings((prev) => (prev ? { ...prev, recipient, enabled: true, events, minConsecutiveEvents, updatedAt: Date.now() } : prev));
      if (showSuccessToast) {
        toast.success('Settings saved', { duration: 2000 });
      }
      // Auto-save doesn't show notification - user actions show it immediately
    } catch (error: any) {
      const errorMessage = error?.message || 'Failed to save settings';
      toast.error('Failed to save settings', { 
        description: errorMessage,
        duration: 4000,
      });
      // If events array is empty, restore the last saved state
      if (errorMessage.includes('at least one event')) {
        if (lastSavedRef.current) {
          setEvents(lastSavedRef.current.events);
        }
      }
    } finally {
      isSavingRef.current = false;
      if (isManualSave) {
        setManualSaving(false);
      }
    }
  }, [userId, recipient, events, minConsecutiveEvents, saveEmailSettings]);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      const res = await getEmailSettings({});
      const data = (res.data as any)?.data as EmailSettings;
      if (data) {
        setSettings(data);
        const savedRecipient = data.recipient || userEmail || '';
        const savedEvents = (data.events && data.events.length ? data.events : events) as WebhookEvent[];
        const savedMinConsecutive = Math.max(1, Number((data as any).minConsecutiveEvents || 1));
        setRecipient(savedRecipient);
        setEvents(savedEvents);
        setMinConsecutiveEvents(savedMinConsecutive);
        lastSavedRef.current = {
          recipient: savedRecipient,
          events: [...savedEvents].sort(),
          minConsecutiveEvents: savedMinConsecutive,
        };
      } else {
        setRecipient((prev) => prev || userEmail || '');
      }
      setIsInitialized(true);
    })();
  }, [userId, userEmail]);

  // Auto-save when debounced values change (only after initialization)
  useEffect(() => {
    if (!isInitialized || !userId || !debouncedRecipient || isSavingRef.current) return;
    
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    // Schedule save with current (non-debounced) values to ensure we save the latest
    saveTimeoutRef.current = setTimeout(() => {
      if (!isSavingRef.current) {
        handleSaveSettings(false, false);
      }
    }, 200);
    
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [debouncedRecipient, JSON.stringify([...debouncedEvents].sort()), debouncedMinConsecutive, isInitialized, userId, handleSaveSettings]);

  const handleTest = async () => {
    try {
      await handleSaveSettings(true, true);
      await sendTestEmail({});
      toast.success('Test email sent', {
        description: 'Check your inbox.',
        duration: 4000,
      });
    } catch (e: any) {
      toast.error('Failed to send test email', {
        description: e?.message || 'Please try again.',
        duration: 5000,
      });
    }
  };

  const filteredChecks = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return checks;
    return checks.filter((c) =>
      (c.name || '').toLowerCase().includes(term) || (c.url || '').toLowerCase().includes(term)
    );
  }, [checks, search]);

  const toggleEvent = (value: WebhookEvent) => {
    setEvents((prev) => {
      if (prev.includes(value)) {
        // Prevent disabling the last event
        if (prev.length === 1) {
          toast.error('At least one alert type is required', {
            description: 'You must have at least one alert type enabled.',
            duration: 3000,
          });
          return prev;
        }
        const next = prev.filter((v) => v !== value);
        // Show notification immediately (only once per action)
        if (!pendingNotificationRef.current) {
          pendingNotificationRef.current = true;
          toast.success('Saved', { 
            duration: 1200,
            style: {
              fontSize: '0.875rem',
            },
          });
          // Reset after notification duration
          setTimeout(() => {
            pendingNotificationRef.current = false;
          }, 1300);
        }
        return next;
      } else {
        const next = [...prev, value];
        // Show notification immediately (only once per action)
        if (!pendingNotificationRef.current) {
          pendingNotificationRef.current = true;
          toast.success('Saved', { 
            duration: 1200,
            style: {
              fontSize: '0.875rem',
            },
          });
          // Reset after notification duration
          setTimeout(() => {
            pendingNotificationRef.current = false;
          }, 1300);
        }
        return next;
      }
    });
  };

  const handleTogglePerCheck = async (checkId: string, value: boolean | null) => {
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
    
    try {
      await updateEmailPerCheck({ checkId, enabled: value });
    } catch (error) {
      toast.error('Failed to update check settings');
      console.error('Failed to update email settings:', error);
    }
  };

  const handlePerCheckEvents = async (checkId: string, newEvents: WebhookEvent[]) => {
    // Validate: at least one event required
    if (!newEvents || newEvents.length === 0) {
      toast.error('At least one alert type is required', {
        description: 'You must have at least one alert type enabled.',
        duration: 3000,
      });
      return;
    }
    
    setSettings((prev) => {
      const next = prev ? { ...prev } : null;
      if (!next) return prev;
      const per = { ...(next.perCheck || {}) };
      per[checkId] = { ...(per[checkId] || {}), events: newEvents };
      next.perCheck = per;
      next.updatedAt = Date.now();
      return next;
    });
    
    try {
      await updateEmailPerCheck({ checkId, events: newEvents });
    } catch (error: any) {
      const errorMessage = error?.message || 'Failed to update check events';
      toast.error('Failed to update check events', {
        description: errorMessage,
        duration: 4000,
      });
      console.error('Failed to update email events:', error);
      // Revert on error
      const per = settings?.perCheck?.[checkId];
      const previousEvents = per?.events ?? events;
      setSettings((prev) => {
        const next = prev ? { ...prev } : null;
        if (!next) return prev;
        const perCheck = { ...(next.perCheck || {}) };
        perCheck[checkId] = { ...(perCheck[checkId] || {}), events: previousEvents };
        next.perCheck = perCheck;
        return next;
      });
    }
  };

  const handleResetAllToGlobal = async () => {
    if (!settings?.perCheck || Object.keys(settings.perCheck).length === 0) {
      toast.info('No custom settings to reset');
      return;
    }

    try {
      // Reset all per-check settings
      const checkIds = Object.keys(settings.perCheck);
      await Promise.all(
        checkIds.map((checkId) => 
          updateEmailPerCheck({ checkId, enabled: null, events: null })
        )
      );

      // Update local state
      setSettings((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          perCheck: {},
          updatedAt: Date.now(),
        };
      });

      toast.success('All checks reset to global settings', {
        duration: 3000,
      });
    } catch (error: any) {
      toast.error('Failed to reset settings', {
        description: error?.message || 'Please try again.',
        duration: 4000,
      });
    }
  };

  return (
    <PageContainer>
      <PageHeader 
        title="Email Alerts"
        description="Configure email notifications for your checks"
        icon={Mail}
        actions={
          <Button onClick={handleTest} disabled={manualSaving || !recipient} variant="outline" className="gap-2 cursor-pointer">
            <TestTube2 className="w-4 h-4" /> Test Email
          </Button>
        }
      />

      <div className="space-y-6 p-6">
        {/* Global Settings */}
        <Card className="border-sky-500/30 bg-sky-500/5 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="w-5 h-5" />
              Global Email Settings
            </CardTitle>
            <CardDescription>
              These settings apply to all checks by default. You can override them for individual checks below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Email Address */}
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input 
                id="email"
                type="email" 
                placeholder="you@example.com" 
                value={recipient} 
                onChange={(e) => setRecipient(e.target.value)}
                className="max-w-md"
              />
              <p className="text-xs text-muted-foreground">
                Email address where alerts will be sent
              </p>
            </div>

            <Separator />

            {/* Event Types */}
            <div className="space-y-3">
              <Label>Alert Types</Label>
              <div className="flex flex-wrap gap-2">
                {ALL_EVENTS.map((e) => {
                  const Icon = e.icon;
                  const isSelected = events.includes(e.value);
                  return (
                    <Button
                      key={e.value}
                      variant={isSelected ? "default" : "outline"}
                      size="sm"
                      onClick={() => toggleEvent(e.value)}
                      className="gap-2 cursor-pointer"
                    >
                      <Icon className="w-4 h-4" />
                      {e.label}
                    </Button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Select which events trigger email alerts
              </p>
            </div>

            <Separator />

            {/* Flap Suppression */}
            <div className="space-y-3">
              <Label htmlFor="flap-suppression">Flap Suppression</Label>
              <div className="flex items-center gap-3 max-w-md">
                <Select
                  value={minConsecutiveEvents.toString()}
                  onValueChange={(value) => {
                    setMinConsecutiveEvents(Number(value));
                    // Show notification immediately
                    toast.success('Saved', { 
                      duration: 1200,
                      style: {
                        fontSize: '0.875rem',
                      },
                    });
                  }}
                >
                  <SelectTrigger id="flap-suppression" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <SelectItem key={n} value={n.toString()}>
                        {n} {n === 1 ? 'check' : 'checks'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-sm text-muted-foreground">
                  consecutive checks required
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Require this many consecutive checks before sending the first email. Helps reduce noise from flapping services.
              </p>
            </div>

            <Separator />

            {/* Reset All to Global */}
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetAllToGlobal}
                disabled={!settings?.perCheck || Object.keys(settings.perCheck).length === 0}
                className="gap-2 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                Reset all checks to global settings
              </Button>
              <p className="text-xs text-muted-foreground">
                Remove all per-check overrides and use global settings for all checks
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Per-Check Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Individual Check Settings</CardTitle>
            <CardDescription>
              Override global settings for specific checks. Leave unchanged to use global settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <SearchInput
                placeholder="Search checks..."
                value={search}
                onChange={setSearch}
                className="max-w-xs"
              />
              <div className="text-sm text-muted-foreground">
                {filteredChecks.length} {filteredChecks.length === 1 ? 'check' : 'checks'}
              </div>
            </div>

            {filteredChecks.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {search ? 'No checks found' : 'No checks configured yet'}
              </div>
            ) : (
              <div className="rounded-md border overflow-hidden">
                <ScrollArea className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
                  <div className="min-w-[600px] w-full">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">Status</TableHead>
                          <TableHead>Check</TableHead>
                          <TableHead>Settings</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredChecks.map((c) => {
                          const per = settings?.perCheck?.[c.id];
                          const perEnabled = per?.enabled ?? undefined;
                          const perEvents = per?.events ?? undefined;
                          const effectiveOn = perEnabled === undefined ? true : perEnabled;
                          const effectiveEvents = (perEvents ?? events);
                          const hasOverride = perEnabled !== undefined || perEvents !== undefined;
                          
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
                                  <div className="font-medium text-sm flex items-center gap-2">
                                    {c.name}
                                    {hasOverride && (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                        Custom
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="text-xs text-muted-foreground font-mono truncate max-w-md">
                                    {c.url}
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {ALL_EVENTS.map((e) => {
                                    const isOn = effectiveOn && effectiveEvents.includes(e.value);
                                    const Icon = e.icon;
                                    const isLastEvent = isOn && effectiveEvents.length === 1;
                                    return (
                                      <Badge
                                        key={e.value}
                                        variant={isOn ? "default" : "outline"}
                                        className={`text-xs px-2 py-0.5 cursor-pointer transition-all hover:opacity-80 ${!isOn ? 'opacity-50' : ''}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          if (!effectiveOn) {
                                            // If check is disabled, enable it first
                                            handleTogglePerCheck(c.id, true);
                                          }
                                          // Get current effective events or use global
                                          const currentEvents = perEvents ?? events;
                                          const next = new Set(currentEvents);
                                          if (next.has(e.value)) {
                                            if (next.size === 1) {
                                              toast.error('At least one alert type is required', {
                                                description: 'You must have at least one alert type enabled.',
                                                duration: 3000,
                                              });
                                              return;
                                            }
                                            next.delete(e.value);
                                          } else {
                                            next.add(e.value);
                                          }
                                          handlePerCheckEvents(c.id, Array.from(next) as WebhookEvent[]);
                                        }}
                                        title={isLastEvent ? "At least one alert type must be enabled" : `Click to ${isOn ? 'disable' : 'enable'} ${e.label}`}
                                      >
                                        <Icon className="w-3 h-3 mr-1" />
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
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
