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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Checkbox,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  BulkActionsBar,
  type BulkAction,
} from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { AlertCircle, AlertTriangle, CheckCircle, Mail, TestTube2, Settings2, RotateCcw, ChevronDown, Save, CheckCircle2, XCircle, Search, Info } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import { useChecks } from '../hooks/useChecks';
import { useHorizontalScroll } from '../hooks/useHorizontalScroll';
import { useDebounce } from '../hooks/useDebounce';
import { toast } from 'sonner';

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
  const [minConsecutiveEvents, setMinConsecutiveEvents] = useState<number>(1);
  const [search, setSearch] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [isEmailSettingsOpen, setIsEmailSettingsOpen] = useState(false);
  // Track pending bulk changes: Map<checkId, Set<WebhookEvent>> - target events for each check
  const [pendingBulkChanges, setPendingBulkChanges] = useState<Map<string, Set<WebhookEvent>>>(new Map());
  const lastSavedRef = useRef<{ recipient: string; minConsecutiveEvents: number } | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef(false);
  
  // Default events when enabling a check
  const DEFAULT_EVENTS: WebhookEvent[] = ['website_down', 'website_up', 'website_error', 'ssl_error', 'ssl_warning'];

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
  const debouncedMinConsecutive = useDebounce(minConsecutiveEvents, 500);

  const handleSaveSettings = useCallback(async (showSuccessToast = false, force = false) => {
    if (!userId || !recipient) return;
    
    // Prevent concurrent saves
    if (isSavingRef.current) return;
    
    // Check if anything actually changed (unless forced)
    if (!force) {
      const current = { recipient, minConsecutiveEvents };
      const lastSaved = lastSavedRef.current;
      if (lastSaved && 
          lastSaved.recipient === current.recipient &&
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
      // Save with default events - backend requires at least one event, but we don't use global events in UI
      await saveEmailSettings({ recipient, enabled: true, events: DEFAULT_EVENTS, minConsecutiveEvents });
      lastSavedRef.current = {
        recipient,
        minConsecutiveEvents,
      };
      setSettings((prev) => (prev ? { ...prev, recipient, enabled: true, events: DEFAULT_EVENTS, minConsecutiveEvents, updatedAt: Date.now() } : prev));
      if (showSuccessToast) {
        toast.success('Settings saved', { duration: 2000 });
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Failed to save settings';
      toast.error('Failed to save settings', { 
        description: errorMessage,
        duration: 4000,
      });
    } finally {
      isSavingRef.current = false;
      if (isManualSave) {
        setManualSaving(false);
      }
    }
  }, [userId, recipient, minConsecutiveEvents, saveEmailSettings]);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      const res = await getEmailSettings({});
      const data = (res.data as any)?.data as EmailSettings;
      if (data) {
        setSettings(data);
        const savedRecipient = data.recipient || userEmail || '';
        const savedMinConsecutive = Math.max(1, Number((data as any).minConsecutiveEvents || 1));
        setRecipient(savedRecipient);
        setMinConsecutiveEvents(savedMinConsecutive);
        lastSavedRef.current = {
          recipient: savedRecipient,
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
  }, [debouncedRecipient, debouncedMinConsecutive, isInitialized, userId, handleSaveSettings]);

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

  // Clear pending changes for checks that are no longer selected
  useEffect(() => {
    setPendingBulkChanges((prev) => {
      const next = new Map(prev);
      let changed = false;
      prev.forEach((_, checkId) => {
        if (!selectedChecks.has(checkId)) {
          next.delete(checkId);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [selectedChecks]);

  const handleTogglePerCheck = async (checkId: string, value: boolean) => {
    // When enabling, set default events if none exist
    const per = settings?.perCheck?.[checkId];
    const hasEvents = per?.events && per.events.length > 0;
    
    setSettings((prev) => {
      const next = prev ? { ...prev } : null;
      if (!next) return prev;
      const perCheck = { ...(next.perCheck || {}) };
      const nextEntry = { ...(perCheck[checkId] || {}) } as any;
      
      if (value) {
        // Enabling: set enabled and default events if none exist
        nextEntry.enabled = true;
        if (!hasEvents) {
          nextEntry.events = [...DEFAULT_EVENTS];
        }
      } else {
        // Disabling: just set enabled to false
        nextEntry.enabled = false;
      }
      
      perCheck[checkId] = nextEntry;
      next.perCheck = perCheck;
      next.updatedAt = Date.now();
      return next;
    });
    
    try {
      if (value && !hasEvents) {
        // Save both enabled and events
        await updateEmailPerCheck({ checkId, enabled: true, events: DEFAULT_EVENTS });
      } else {
        // Just update enabled status
        await updateEmailPerCheck({ checkId, enabled: value });
      }
    } catch (error) {
      toast.error('Failed to update check settings');
      console.error('Failed to update email settings:', error);
      // Revert on error
      setSettings((prev) => {
        if (!prev) return prev;
        const perCheck = { ...(prev.perCheck || {}) };
        const reverted = { ...(perCheck[checkId] || {}) };
        if (value) {
          delete reverted.enabled;
          if (!hasEvents) {
            delete reverted.events;
          }
        } else {
          reverted.enabled = true;
        }
        if (Object.keys(reverted).length === 0) {
          delete perCheck[checkId];
        } else {
          perCheck[checkId] = reverted;
        }
        return { ...prev, perCheck };
      });
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
    
    // Ensure check is enabled when setting events
    const per = settings?.perCheck?.[checkId];
    const wasEnabled = per?.enabled !== false;
    
    setSettings((prev) => {
      const next = prev ? { ...prev } : null;
      if (!next) return prev;
      const perCheck = { ...(next.perCheck || {}) };
      perCheck[checkId] = { 
        ...(perCheck[checkId] || {}), 
        events: newEvents,
        enabled: wasEnabled ? true : undefined, // Keep enabled state or set to true
      };
      next.perCheck = perCheck;
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
      const previousEvents = per?.events;
      setSettings((prev) => {
        const next = prev ? { ...prev } : null;
        if (!next) return prev;
        const perCheck = { ...(next.perCheck || {}) };
        if (previousEvents) {
          perCheck[checkId] = { ...(perCheck[checkId] || {}), events: previousEvents };
        } else {
          const entry = { ...(perCheck[checkId] || {}) };
          delete entry.events;
          if (Object.keys(entry).length === 0) {
            delete perCheck[checkId];
          } else {
            perCheck[checkId] = entry;
          }
        }
        return { ...next, perCheck };
      });
    }
  };

  const handleResetToDefault = async () => {
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

      toast.success('All checks reset to default', {
        duration: 3000,
      });
    } catch (error: any) {
      toast.error('Failed to reset settings', {
        description: error?.message || 'Please try again.',
        duration: 4000,
      });
    }
  };

  // Toggle event in pending changes (doesn't save yet)
  const handleBulkToggleEvent = (eventToToggle: WebhookEvent) => {
    if (selectedChecks.size === 0) {
      toast.info('Please select at least one check');
      return;
    }

    setPendingBulkChanges((prev) => {
      const next = new Map(prev);
      
      Array.from(selectedChecks).forEach((checkId) => {
        const per = settings?.perCheck?.[checkId];
        const perEnabled = per?.enabled === true;
        const perEvents = per?.events;
        
        // Get current events (from pending changes if exists, otherwise from settings)
        let currentEvents: Set<WebhookEvent>;
        if (next.has(checkId)) {
          // Use pending changes as base
          currentEvents = new Set(next.get(checkId)!);
        } else {
          // Use current settings as base
          const baseEvents = perEvents && perEvents.length > 0 
            ? perEvents 
            : (perEnabled ? DEFAULT_EVENTS : []);
          currentEvents = new Set(baseEvents);
        }

        // If check is disabled and no pending changes, enable it with defaults
        if (!perEnabled && !next.has(checkId)) {
          currentEvents = new Set(DEFAULT_EVENTS);
        }

        // Toggle the event
        if (currentEvents.has(eventToToggle)) {
          // Removing event - ensure at least one remains
          if (currentEvents.size <= 1) {
            toast.error('At least one alert type is required', {
              description: 'You must have at least one alert type enabled.',
              duration: 2000,
            });
            return; // Skip this check
          }
          currentEvents.delete(eventToToggle);
        } else {
          currentEvents.add(eventToToggle);
        }

        next.set(checkId, currentEvents);
      });

      return next;
    });
  };

  // Apply all pending bulk changes
  const handleBulkSave = async () => {
    if (pendingBulkChanges.size === 0) {
      toast.info('No changes to save');
      return;
    }

    try {
      const updates: Array<{ checkId: string; events: WebhookEvent[]; enabled: boolean }> = [];
      const stateUpdates: Record<string, { events: WebhookEvent[]; enabled: boolean }> = {};

      pendingBulkChanges.forEach((events, checkId) => {
        const eventsArray = Array.from(events) as WebhookEvent[];
        updates.push({ checkId, events: eventsArray, enabled: true });
        stateUpdates[checkId] = { events: eventsArray, enabled: true };
      });

      // Apply all updates
      await Promise.all(
        updates.map(({ checkId, events, enabled }) => 
          updateEmailPerCheck({ checkId, events, enabled })
        )
      );

      // Update local state
      setSettings((prev) => {
        if (!prev) return prev;
        const perCheck = { ...(prev.perCheck || {}) };
        Object.entries(stateUpdates).forEach(([checkId, update]) => {
          perCheck[checkId] = { 
            ...(perCheck[checkId] || {}), 
            ...update,
          };
        });
        return {
          ...prev,
          perCheck,
          updatedAt: Date.now(),
        };
      });

      toast.success(`Updated ${updates.length} check${updates.length === 1 ? '' : 's'}`, {
        duration: 2000,
      });
      
      // Clear pending changes and selection
      setPendingBulkChanges(new Map());
      setSelectedChecks(new Set());
    } catch (error: any) {
      toast.error('Failed to update checks', {
        description: error?.message || 'Please try again.',
        duration: 4000,
      });
    }
  };

  // Toggle all events for selected checks (enable all or disable all)
  const handleBulkToggleAllEvents = () => {
    if (selectedChecks.size === 0) {
      toast.info('Please select at least one check');
      return;
    }

    // Check if all selected checks have all events enabled
    let allEnabled = true;
    Array.from(selectedChecks).forEach((checkId) => {
      const pending = pendingBulkChanges.get(checkId);
      if (pending) {
        // Check pending changes
        const hasAllEvents = DEFAULT_EVENTS.every(e => pending.has(e));
        if (!hasAllEvents) {
          allEnabled = false;
        }
      } else {
        // Check current settings
        const per = settings?.perCheck?.[checkId];
        const perEnabled = per?.enabled === true;
        const perEvents = per?.events;
        const currentEvents = perEvents && perEvents.length > 0 
          ? perEvents 
          : (perEnabled ? DEFAULT_EVENTS : []);
        const hasAllEvents = DEFAULT_EVENTS.every(e => currentEvents.includes(e));
        if (!hasAllEvents) {
          allEnabled = false;
        }
      }
    });

    setPendingBulkChanges((prev) => {
      const next = new Map(prev);
      
      if (allEnabled) {
        // Disable all - set to empty (but we need at least one, so set to first event)
        const singleEventSet = new Set([DEFAULT_EVENTS[0]]);
        Array.from(selectedChecks).forEach((checkId) => {
          next.set(checkId, singleEventSet);
        });
      } else {
        // Enable all
        const allEventsSet = new Set(DEFAULT_EVENTS);
        Array.from(selectedChecks).forEach((checkId) => {
          next.set(checkId, allEventsSet);
        });
      }

      return next;
    });
  };

  // Set all events for selected checks (adds to pending changes)
  /* const handleBulkSetEvents = (newEvents: WebhookEvent[]) => {
    if (selectedChecks.size === 0) {
      toast.info('Please select at least one check');
      return;
    }

    if (!newEvents || newEvents.length === 0) {
      toast.error('At least one alert type is required');
      return;
    }

    setPendingBulkChanges((prev) => {
      const next = new Map(prev);
      const eventsSet = new Set(newEvents);
      
      Array.from(selectedChecks).forEach((checkId) => {
        next.set(checkId, eventsSet);
      });

      return next;
    });
  }; */

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
        <Card className="bg-sky-950/40 border-sky-500/30 text-slate-100 backdrop-blur-md shadow-lg shadow-sky-900/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Info className="w-4 h-4 text-sky-200" />
              How email alerts behave
            </CardTitle>
            <CardDescription className="text-slate-200/80">
              Quick refresher so you always know why (and when) we send an email.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-slate-100/90 space-y-3">
            <ul className="list-disc pl-4 space-y-2 text-slate-100/80">
              <li>We email only when a check flips states (down to up or up to down), so steady checks stay quiet.</li>
              <li>Down/up alerts can resend roughly a minute after the last one, which lets every state change through.</li>
              <li>You get a shared budget of up to 10 alert emails per hour; if you hit it we pause until the window resets and then resume automatically.</li>
              <li>Flap suppression waits for the number of consecutive results you pick below before we email, which filters noisy blips.</li>
              <li>SSL and domain reminders still respect their longer windows, and they also count toward your hourly budget.</li>
            </ul>
          </CardContent>
        </Card>
        {/* Global Settings */}
        <Card className="border-border/50">
          <Collapsible open={isEmailSettingsOpen} onOpenChange={setIsEmailSettingsOpen}>
            <CollapsibleTrigger asChild>
              <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
                <CardTitle className="flex items-center justify-between text-sm font-medium">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Settings2 className="w-4 h-4" />
                    Email Settings
                  </div>
                  <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isEmailSettingsOpen ? 'rotate-180' : ''}`} />
                </CardTitle>
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-4 pt-0">
            {/* Email Address */}
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs">Email Address</Label>
              <Input 
                id="email"
                type="email" 
                placeholder="you@example.com" 
                value={recipient} 
                onChange={(e) => setRecipient(e.target.value)}
                className="max-w-md h-9"
              />
            </div>

            {/* Flap Suppression */}
            <div className="space-y-1.5">
              <Label htmlFor="flap-suppression" className="text-xs">Flap Suppression</Label>
              <div className="flex items-center gap-2 max-w-md">
                <Select
                  value={minConsecutiveEvents.toString()}
                  onValueChange={(value) => {
                    setMinConsecutiveEvents(Number(value));
                  }}
                >
                  <SelectTrigger id="flap-suppression" className="w-28 h-9">
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
                <span className="text-xs text-muted-foreground">
                  consecutive checks required
                </span>
              </div>
            </div>

            {/* Reset to Default */}
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetToDefault}
                disabled={!settings?.perCheck || Object.keys(settings.perCheck).length === 0}
                className="gap-2 cursor-pointer h-8 text-xs"
              >
                <RotateCcw className="w-3 h-3" />
                Reset to default
              </Button>
            </div>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>

        {/* Per-Check Settings */}
        <Card className="border-0">
          <CardHeader className="pt-4 pb-4 px-0">
            <CardTitle>Check Settings</CardTitle>
            <CardDescription>
              Enable/disable email notifications and customize alert types for each check. When enabled, configure which alert types trigger emails.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-8 pb-4 px-0">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative max-w-xs">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder="Search checks..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
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
                          <TableHead className="w-12">
                            <Checkbox
                              checked={selectedChecks.size > 0 && selectedChecks.size === filteredChecks.length}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedChecks(new Set(filteredChecks.map(c => c.id)));
                                } else {
                                  setSelectedChecks(new Set());
                                }
                              }}
                              className="cursor-pointer"
                            />
                          </TableHead>
                          <TableHead className="w-12">Notifications</TableHead>
                          <TableHead>Check</TableHead>
                          <TableHead>Alert Types</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredChecks.map((c) => {
                          const per = settings?.perCheck?.[c.id];
                          const perEnabled = per?.enabled;
                          const perEvents = per?.events;
                          // No fallback - if not enabled, it's disabled. If enabled but no events, use defaults.
                          const effectiveOn = perEnabled === true;
                          const effectiveEvents = perEvents && perEvents.length > 0 ? perEvents : (effectiveOn ? DEFAULT_EVENTS : []);
                          const isSelected = selectedChecks.has(c.id);
                          
                          return (
                            <TableRow key={c.id}>
                              <TableCell>
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    const newSelected = new Set(selectedChecks);
                                    if (checked) {
                                      newSelected.add(c.id);
                                    } else {
                                      newSelected.delete(c.id);
                                    }
                                    setSelectedChecks(newSelected);
                                  }}
                                  className="cursor-pointer"
                                />
                              </TableCell>
                              <TableCell>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div>
                                      <Switch
                                        checked={effectiveOn}
                                        onCheckedChange={(v) => handleTogglePerCheck(c.id, v)}
                                        className="cursor-pointer"
                                      />
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-xs">
                                    <p className="text-sm">
                                      {effectiveOn 
                                        ? perEvents && perEvents.length > 0
                                          ? "Email notifications enabled with custom alert types"
                                          : "Email notifications enabled with default alert types"
                                        : "Email notifications disabled for this check"}
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col">
                                  <div className="font-medium text-sm flex items-center gap-2">
                                    {c.name}
                                    {perEvents && perEvents.length > 0 && (
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
                                        className={`text-xs px-2 py-0.5 cursor-pointer transition-all hover:opacity-80 ${!effectiveOn || !isOn ? 'opacity-50' : ''}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          if (!effectiveOn) {
                                            // If check is disabled, enable it first with default events
                                            handleTogglePerCheck(c.id, true);
                                            return;
                                          }
                                          // Get current events
                                          const currentEvents = perEvents && perEvents.length > 0 ? perEvents : DEFAULT_EVENTS;
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
                                        title={!effectiveOn ? "Enable notifications first" : isLastEvent ? "At least one alert type must be enabled" : `Click to ${isOn ? 'disable' : 'enable'} ${e.label}`}
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

      {/* Bulk Actions Bar */}
      <BulkActionsBar
        selectedCount={selectedChecks.size}
        totalCount={filteredChecks.length}
        onClearSelection={() => {
          setSelectedChecks(new Set());
          setPendingBulkChanges(new Map());
        }}
        itemLabel="check"
        actions={[
          ...ALL_EVENTS.map((e): BulkAction => {
            // Check if this event is active for all selected checks
            const isActive = Array.from(selectedChecks).every(checkId => {
              const pending = pendingBulkChanges.get(checkId);
              if (pending) return pending.has(e.value);
              const per = settings?.perCheck?.[checkId];
              const perEnabled = per?.enabled === true;
              const perEvents = per?.events;
              const currentEvents = perEvents && perEvents.length > 0 
                ? perEvents 
                : (perEnabled ? DEFAULT_EVENTS : []);
              return currentEvents.includes(e.value);
            });
            
            return {
              label: e.label,
              icon: <e.icon className="w-3 h-3" />,
              onClick: () => handleBulkToggleEvent(e.value),
              variant: isActive ? 'default' : 'ghost',
              className: isActive 
                ? 'font-semibold text-primary-foreground bg-primary/90' 
                : 'font-semibold opacity-70 hover:opacity-100',
            };
          }),
          (() => {
            // Check if all events are enabled for all selected checks
            const allEventsEnabled = selectedChecks.size > 0 && Array.from(selectedChecks).every(checkId => {
              const pending = pendingBulkChanges.get(checkId);
              if (pending) {
                return DEFAULT_EVENTS.every(e => pending.has(e));
              }
              const per = settings?.perCheck?.[checkId];
              const perEnabled = per?.enabled === true;
              const perEvents = per?.events;
              const currentEvents = perEvents && perEvents.length > 0 
                ? perEvents 
                : (perEnabled ? DEFAULT_EVENTS : []);
              return DEFAULT_EVENTS.every(e => currentEvents.includes(e));
            });

            return {
              label: allEventsEnabled ? 'Disable All' : 'Enable All',
              icon: allEventsEnabled ? <XCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />,
              onClick: handleBulkToggleAllEvents,
              variant: allEventsEnabled ? 'destructive' : 'default',
              className: allEventsEnabled
                ? 'font-semibold text-destructive-foreground bg-destructive/90'
                : 'font-semibold text-primary-foreground bg-primary/90',
            };
          })(),
          {
            label: 'Save',
            icon: <Save className="w-3 h-3" />,
            onClick: pendingBulkChanges.size > 0 ? handleBulkSave : () => {},
            variant: 'default',
            className: pendingBulkChanges.size === 0 
              ? 'font-semibold opacity-50 cursor-not-allowed' 
              : 'font-semibold text-primary-foreground bg-primary/90',
          },
        ]}
      />
    </PageContainer>
  );
}
