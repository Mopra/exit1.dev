import { useEffect, useMemo, useState, useCallback, useRef, Fragment } from 'react';
import { Link } from 'react-router-dom';
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
  Progress,
  Alert,
  AlertTitle,
  AlertDescription,
  Switch, 
  Table, 
  TableHeader, 
  TableRow, 
  TableHead, 
  TableBody, 
  TableCell, 
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Checkbox,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  BulkActionsBar,
  type BulkAction,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  glassClasses,
} from '../components/ui';
import { PageHeader, PageContainer } from '../components/layout';
import { AlertCircle, AlertTriangle, CheckCircle, Loader2, Mail, TestTube2, RotateCcw, ChevronDown, Save, CheckCircle2, XCircle, Search, Info, Minus, Plus } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import { useChecks } from '../hooks/useChecks';
import ChecksTableShell from '../components/check/ChecksTableShell';
import { FolderGroupHeaderRow } from '../components/check/FolderGroupHeaderRow';
import { useDebounce } from '../hooks/useDebounce';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useNanoPlan } from '../hooks/useNanoPlan';
import { toast } from 'sonner';
import type { Website } from '../types';

const ALL_EVENTS: { value: WebhookEvent; label: string; icon: typeof AlertCircle }[] = [
  { value: 'website_down', label: 'Down', icon: AlertTriangle },
  { value: 'website_up', label: 'Up', icon: CheckCircle },
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

type PendingOverride = {
  enabled?: boolean | null;
  events?: WebhookEvent[] | null;
};

type PendingOverrides = Record<string, PendingOverride>;

type EmailUsageWindow = {
  count: number;
  max: number;
  windowStart: number;
  windowEnd: number;
};

type EmailUsage = {
  hourly: EmailUsageWindow;
  monthly: EmailUsageWindow;
};

const normalizeFolder = (folder?: string | null): string | null => {
  const raw = (folder ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\s+/g, ' ').trim();
  const trimmedSlashes = cleaned.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmedSlashes || null;
};

export default function Emails() {
  const { userId } = useAuth();
  const { user } = useUser();
  const { nano } = useNanoPlan();
  const userEmail = user?.primaryEmailAddress?.emailAddress || '';
  const [settings, setSettings] = useState<EmailSettings>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [recipient, setRecipient] = useState(userEmail || '');
  const [minConsecutiveEvents, setMinConsecutiveEvents] = useState<number>(1);
  const [search, setSearch] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isSetupOpen, setIsSetupOpen] = useLocalStorage('email-setup-open', true);
  const [usage, setUsage] = useState<EmailUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [pendingCheckUpdates, setPendingCheckUpdates] = useState<Set<string>>(new Set());
  const [pendingOverrides, setPendingOverrides] = useLocalStorage<PendingOverrides>('email-pending-overrides', {});
  // Track pending bulk changes: Map<checkId, Set<WebhookEvent>> - target events for each check
  const [pendingBulkChanges, setPendingBulkChanges] = useState<Map<string, Set<WebhookEvent>>>(new Map());
  const lastSavedRef = useRef<{ recipient: string; minConsecutiveEvents: number } | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef(false);
  const isFlushingPendingRef = useRef(false);
  const [groupBy, setGroupBy] = useLocalStorage<'none' | 'folder'>('emails-group-by-v1', 'none');
  const effectiveGroupBy = groupBy;
  const [collapsedFolders, setCollapsedFolders] = useLocalStorage<string[]>('emails-folder-collapsed-v1', []);
  const collapsedSet = useMemo(() => new Set(collapsedFolders), [collapsedFolders]);
  const [folderColors] = useLocalStorage<Record<string, string>>('checks-folder-view-colors-v1', {});
  
  // Default events when enabling a check
  const DEFAULT_EVENTS: WebhookEvent[] = ['website_down', 'website_up', 'ssl_error', 'ssl_warning'];

  const functions = getFunctions();
  const saveEmailSettings = httpsCallable(functions, 'saveEmailSettings');
  const updateEmailPerCheck = httpsCallable(functions, 'updateEmailPerCheck');
  const bulkUpdateEmailPerCheck = httpsCallable(functions, 'bulkUpdateEmailPerCheck');
  const getEmailSettings = httpsCallable(functions, 'getEmailSettings');
  const getEmailUsage = httpsCallable(functions, 'getEmailUsage');
  const sendTestEmail = httpsCallable(functions, 'sendTestEmail');

  const log = useCallback(
    (msg: string) => console.log(`[Emails] ${msg}`),
    []
  );

  // Use non-realtime mode to reduce Firestore reads - Emails page only needs the checks list
  const { checks } = useChecks(userId ?? null, log, { realtime: false });

  const fetchEmailUsage = useCallback(async () => {
    if (!userId) return;
    try {
      setUsageError(null);
      const res = await getEmailUsage({});
      const data = (res.data as any)?.data as EmailUsage | undefined;
      setUsage(data ?? null);
    } catch (error: any) {
      setUsageError(error?.message || 'Failed to load email usage');
    }
  }, [userId, getEmailUsage]);
  const hasFolders = useMemo(
    () => checks.some((check) => (check.folder ?? '').trim().length > 0),
    [checks]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const existing = window.localStorage.getItem('emails-group-by-v1');
      if (existing === null && hasFolders) {
        setGroupBy('folder');
      }
    } catch {
      // ignore localStorage failures
    }
  }, [hasFolders, setGroupBy]);

  // Debounce recipient for auto-save
  const debouncedRecipient = useDebounce(recipient, 1000);
  const debouncedMinConsecutive = useDebounce(minConsecutiveEvents, 500);

  const pendingOverrideCount = useMemo(() => Object.keys(pendingOverrides).length, [pendingOverrides]);

  const queuePendingOverride = useCallback((checkId: string, patch: PendingOverride) => {
    setPendingOverrides((prev) => {
      const current = prev[checkId] || {};
      return {
        ...prev,
        [checkId]: { ...current, ...patch },
      };
    });
  }, [setPendingOverrides]);

  const clearPendingOverride = useCallback((checkId: string) => {
    setPendingOverrides((prev) => {
      if (!(checkId in prev)) return prev;
      const next = { ...prev };
      delete next[checkId];
      return next;
    });
  }, [setPendingOverrides]);

  const mergePendingOverrides = (base: EmailSettings | null): EmailSettings | null => {
    if (!base && pendingOverrideCount === 0) return null;

    const seed = (base ?? {
      userId: userId || '',
      enabled: false,
      recipient: userEmail || '',
      events: DEFAULT_EVENTS,
      perCheck: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }) as NonNullable<EmailSettings>;

    if (pendingOverrideCount === 0) {
      return seed;
    }

    const perCheck = { ...(seed.perCheck || {}) };
    Object.entries(pendingOverrides).forEach(([checkId, override]) => {
      const nextEntry: { enabled?: boolean; events?: WebhookEvent[] } = { ...(perCheck[checkId] || {}) };

      if ('enabled' in override) {
        if (override.enabled === null) {
          delete nextEntry.enabled;
        } else {
          nextEntry.enabled = override.enabled;
        }
      }

      if ('events' in override) {
        if (override.events === null) {
          delete nextEntry.events;
        } else {
          nextEntry.events = override.events;
        }
      }

      if (Object.keys(nextEntry).length === 0) {
        delete perCheck[checkId];
      } else {
        perCheck[checkId] = nextEntry;
      }
    });

    return {
      ...seed,
      perCheck,
      updatedAt: Date.now(),
    };
  };

  const markChecksPending = useCallback((checkIds: string[], pending: boolean) => {
    if (checkIds.length === 0) return;
    setPendingCheckUpdates((prev) => {
      const next = new Set(prev);
      checkIds.forEach((checkId) => {
        if (pending) {
          next.add(checkId);
        } else {
          next.delete(checkId);
        }
      });
      return next;
    });
  }, []);

  useEffect(() => {
    if (pendingCheckUpdates.size === 0) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [pendingCheckUpdates.size]);

  const flushPendingOverrides = useCallback(async () => {
    if (!userId || pendingOverrideCount === 0 || isFlushingPendingRef.current) return;

    const entries = Object.entries(pendingOverrides).filter(([checkId, payload]) => {
      if (pendingCheckUpdates.has(checkId)) return false;
      return Object.keys(payload || {}).length > 0;
    });

    if (entries.length === 0) return;

    isFlushingPendingRef.current = true;
    const checkIds = entries.map(([checkId]) => checkId);
    markChecksPending(checkIds, true);

    try {
      // Use bulk endpoint instead of N individual calls
      // This reduces N function invocations + N writes to 1 function invocation + 1 write
      const updates = entries.map(([checkId, payload]) => ({ checkId, ...payload }));
      await bulkUpdateEmailPerCheck({ updates });
      
      // Clear all pending overrides on success
      entries.forEach(([checkId]) => clearPendingOverride(checkId));
    } catch (error) {
      // On failure, fall back to individual updates for retry
      console.error('[Emails] Bulk update failed, will retry on next flush:', error);
    } finally {
      markChecksPending(checkIds, false);
      isFlushingPendingRef.current = false;
    }
  }, [
    userId,
    pendingOverrideCount,
    pendingOverrides,
    pendingCheckUpdates,
    bulkUpdateEmailPerCheck,
    clearPendingOverride,
    markChecksPending,
  ]);

  useEffect(() => {
    if (!isInitialized || !userId || pendingOverrideCount === 0) return;
    flushPendingOverrides();
  }, [isInitialized, userId, pendingOverrideCount, flushPendingOverrides]);

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
      const merged = mergePendingOverrides(data);
      if (merged) {
        setSettings(merged);
        const savedRecipient = merged.recipient || userEmail || '';
        const savedMinConsecutive = Math.max(1, Number((merged as any).minConsecutiveEvents || 1));
        setRecipient(savedRecipient);
        setMinConsecutiveEvents(savedMinConsecutive);
        if (data) {
          lastSavedRef.current = {
            recipient: savedRecipient,
            minConsecutiveEvents: savedMinConsecutive,
          };
        }
      } else {
        setSettings(null);
        setRecipient((prev) => prev || userEmail || '');
      }
      setIsInitialized(true);
    })();
  }, [userId, userEmail]);

  useEffect(() => {
    if (!userId) return;
    fetchEmailUsage();
    // Poll every 5 minutes instead of 60 seconds to reduce Firestore reads
    // (2 reads per poll = 24 reads/hour instead of 120 reads/hour)
    const interval = setInterval(fetchEmailUsage, 300000);
    return () => clearInterval(interval);
  }, [userId, fetchEmailUsage]);

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

  const formatWindowEnd = useCallback((windowEnd: number, includeTime: boolean) => {
    const options: Intl.DateTimeFormatOptions = includeTime
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' };
    return new Date(windowEnd).toLocaleString(undefined, options);
  }, []);

  const getUsagePercent = useCallback((count: number, max: number) => {
    if (max <= 0) return 0;
    return Math.min(100, Math.round((count / max) * 100));
  }, []);

  const monthlyUsage = usage?.monthly;
  const monthlyPercent = monthlyUsage ? getUsagePercent(monthlyUsage.count, monthlyUsage.max) : 0;
  const monthlyReached = Boolean(
    monthlyUsage && monthlyUsage.max > 0 && monthlyUsage.count >= monthlyUsage.max
  );

  const limitMessage = useMemo(() => {
    if (!monthlyUsage || !monthlyReached) return null;
    return `Monthly limit reached. Resets ${formatWindowEnd(monthlyUsage.windowEnd, false)}.`;
  }, [monthlyUsage, monthlyReached, formatWindowEnd]);

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

  const groupedByFolder = useMemo(() => {
    if (effectiveGroupBy !== 'folder') return null;
    const map = new Map<string, Website[]>();
    for (const c of filteredChecks) {
      const key = (c.folder ?? '').trim() || '__unsorted__';
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }

    const keys = Array.from(map.keys());
    keys.sort((a, b) => {
      if (a === '__unsorted__') return -1;
      if (b === '__unsorted__') return 1;
      return a.localeCompare(b);
    });

    return keys.map((key) => ({
      key,
      label: key === '__unsorted__' ? 'Unsorted' : key,
      checks: map.get(key) ?? [],
    }));
  }, [effectiveGroupBy, filteredChecks]);

  const toggleFolderCollapsed = useCallback((folderKey: string) => {
    setCollapsedFolders((prev) => {
      const set = new Set(prev);
      if (set.has(folderKey)) set.delete(folderKey);
      else set.add(folderKey);
      return Array.from(set);
    });
  }, [setCollapsedFolders]);

  const getFolderColor = useCallback((folder?: string | null) => {
    const normalized = normalizeFolder(folder);
    if (!normalized) return undefined;
    const color = folderColors[normalized];
    return color && color !== 'default' ? color : undefined;
  }, [folderColors]);

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
    if (pendingCheckUpdates.has(checkId)) return;
    markChecksPending([checkId], true);
    // When enabling, set default events if none exist
    const per = settings?.perCheck?.[checkId];
    const hasEvents = per?.events && per.events.length > 0;
    const pendingPayload = value && !hasEvents
      ? { enabled: true, events: DEFAULT_EVENTS }
      : { enabled: value };
    
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

    queuePendingOverride(checkId, pendingPayload);
    
    try {
      await updateEmailPerCheck({ checkId, ...pendingPayload });
      toast.success('Saved', { duration: 2000 });
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
    } finally {
      clearPendingOverride(checkId);
      markChecksPending([checkId], false);
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
    
    if (pendingCheckUpdates.has(checkId)) return;
    markChecksPending([checkId], true);
    queuePendingOverride(checkId, { events: newEvents });

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
      toast.success('Saved', { duration: 2000 });
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
    } finally {
      clearPendingOverride(checkId);
      markChecksPending([checkId], false);
    }
  };

  const handleResetToDefault = async () => {
    if (!settings?.perCheck || Object.keys(settings.perCheck).length === 0) {
      toast.info('No custom settings to reset');
      return;
    }

    const checkIds = Object.keys(settings.perCheck);
    markChecksPending(checkIds, true);
    checkIds.forEach((checkId) => queuePendingOverride(checkId, { enabled: null, events: null }));

    try {
      // Reset all per-check settings
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
    } finally {
      checkIds.forEach(clearPendingOverride);
      markChecksPending(checkIds, false);
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
          // Removing event - allow removing all (will disable the check)
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

    const updates: Array<{ checkId: string; events: WebhookEvent[]; enabled: boolean }> = [];
    const stateUpdates: Record<string, { events: WebhookEvent[]; enabled: boolean }> = {};

    pendingBulkChanges.forEach((events, checkId) => {
      const eventsArray = Array.from(events) as WebhookEvent[];
      // If no events selected, disable the check; otherwise enable it
      const enabled = eventsArray.length > 0;
      updates.push({ checkId, events: eventsArray, enabled });
      stateUpdates[checkId] = { events: eventsArray, enabled };
    });

    const checkIds = updates.map((update) => update.checkId);
    markChecksPending(checkIds, true);
    updates.forEach(({ checkId, events, enabled }) => {
      queuePendingOverride(checkId, { events, enabled });
    });

    try {
      // Apply all updates using bulk API
      await bulkUpdateEmailPerCheck({ updates });

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
    } finally {
      checkIds.forEach(clearPendingOverride);
      markChecksPending(checkIds, false);
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
        // Disable all - set to empty (will disable notifications for these checks)
        const emptySet = new Set<WebhookEvent>();
        Array.from(selectedChecks).forEach((checkId) => {
          next.set(checkId, emptySet);
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

  const renderCheckRow = (c: Website) => {
    const per = settings?.perCheck?.[c.id];
    const perEnabled = per?.enabled;
    const perEvents = per?.events;
    // No fallback - if not enabled, it's disabled. If enabled but no events, use defaults.
    const effectiveOn = perEnabled === true;
    const effectiveEvents = perEvents && perEvents.length > 0 ? perEvents : (effectiveOn ? DEFAULT_EVENTS : []);
    const isSelected = selectedChecks.has(c.id);
    const isPending = pendingCheckUpdates.has(c.id);
    const folderLabel = (c.folder ?? '').trim();

    return (
      <TableRow key={c.id}>
        <TableCell className="px-4 py-4">
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
        <TableCell className="px-4 py-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={effectiveOn}
              onCheckedChange={(v) => handleTogglePerCheck(c.id, v)}
              disabled={isPending}
              className="cursor-pointer"
            />
            {isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          </div>
        </TableCell>
        <TableCell className="px-4 py-4">
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
            {effectiveGroupBy !== 'folder' && folderLabel && (
              <div className="pt-1 flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="font-mono text-[11px] w-fit">
                  {folderLabel}
                </Badge>
              </div>
            )}
          </div>
        </TableCell>
        <TableCell className="px-4 py-4">
          <div className="flex flex-wrap gap-1">
            {ALL_EVENTS.map((e) => {
              const isOn = effectiveOn && effectiveEvents.includes(e.value);
              const Icon = e.icon;
              const isLastEvent = isOn && effectiveEvents.length === 1;
              const badgeOpacity = isPending ? 'opacity-40' : (!effectiveOn || !isOn ? 'opacity-50' : '');
              const badgeCursor = isPending ? 'cursor-not-allowed' : 'cursor-pointer hover:opacity-80';
              return (
                <Badge
                  key={e.value}
                  variant={isOn ? "default" : "outline"}
                  className={`text-xs px-2 py-0.5 transition-all ${badgeCursor} ${badgeOpacity}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (isPending) {
                      return;
                    }
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
                  title={isPending ? "Saving changes..." : !effectiveOn ? "Enable notifications first" : isLastEvent ? "At least one alert type must be enabled" : `Click to ${isOn ? 'disable' : 'enable'} ${e.label}`}
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
  };

  return (
    <PageContainer>
      <PageHeader 
        title="Email Alerts"
        description="Configure email notifications for your checks"
        icon={Mail}
      />

      <div className="space-y-6 p-6">
        <Collapsible open={isSetupOpen} onOpenChange={setIsSetupOpen}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-muted-foreground">Setup</div>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-2 cursor-pointer text-xs"
              >
                {isSetupOpen ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                {isSetupOpen ? 'Minimize' : 'Expand'}
              </Button>
            </CollapsibleTrigger>
          </div>
        <CollapsibleContent className="mt-3">
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Email Setup</CardTitle>
            <CardDescription>
              Choose where alerts go and fine tune when we send them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {isInitialized && !recipient && (
              <div className="rounded-md border border-sky-500/30 bg-sky-950/40 px-3 py-2 text-sm text-slate-100">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-sky-200" />
                  <span className="font-medium">Email address required</span>
                </div>
                <p className="mt-1 text-slate-200/90">
                  Add an email address to start receiving alerts.
                </p>
              </div>
            )}
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
                  <SelectTrigger id="flap-suppression" className="w-28 h-9 cursor-pointer">
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

            <div className="flex flex-wrap items-center gap-2">
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
              <Button
                onClick={handleTest}
                disabled={manualSaving || !recipient}
                variant="outline"
                size="sm"
                className="gap-2 cursor-pointer h-8 text-xs"
              >
                <TestTube2 className="w-3 h-3" />
                Test Email
              </Button>
            </div>

            <div className="rounded-md border border-border/50">
              <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
                <CollapsibleTrigger asChild>
                  <button className="w-full px-3 py-2 text-left text-sm font-medium flex items-center justify-between cursor-pointer hover:bg-muted/40 transition-colors">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Info className="w-4 h-4" />
                      How email alerts behave
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 text-muted-foreground transition-transform ${isInfoOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-3 pb-3 text-sm text-muted-foreground space-y-3">
                    <p>
                      Quick refresher so you always know why (and when) we send an email.
                    </p>
                    <ul className="list-disc pl-4 space-y-2">
                      <li>We email only when a check flips states, so steady checks stay quiet.</li>
                      <li>Down/up alerts can resend roughly a minute after the last one.</li>
                      <li>Hourly caps: Free = 10 emails/hour, Nano = 100 emails/hour.</li>
                      <li>Monthly caps: Free = 10 emails/month, Nano = 1000 emails/month.</li>
                      <li>Flap suppression waits for the number of consecutive results you pick.</li>
                      <li>SSL and domain reminders respect longer windows and count toward your budget.</li>
                    </ul>
                  </div>
                </CollapsibleContent>
                </Collapsible>
              </div>
          </CardContent>
            </Card>
            <Card className="border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Email Usage</CardTitle>
            <CardDescription>
              Keep track of your monthly email budget.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {usageError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Usage unavailable</AlertTitle>
                <AlertDescription>{usageError}</AlertDescription>
              </Alert>
            )}
            {!usage && !usageError && (
              <div className="text-sm text-muted-foreground">Loading usage...</div>
            )}
            {usage && (
              <>
                {limitMessage && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Email limit reached</AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      <span>{limitMessage}</span>
                      {!nano && (
                        <Button asChild size="sm" variant="outline" className="w-fit cursor-pointer">
                          <Link to="/billing">Upgrade to Nano for 1000 emails/month</Link>
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Monthly usage</span>
                    <span>
                      {usage.monthly.count}/{usage.monthly.max}
                    </span>
                  </div>
                  <Progress value={monthlyPercent} />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Resets {formatWindowEnd(usage.monthly.windowEnd, false)}</span>
                    {monthlyReached && (
                      <Badge variant="destructive" className="text-[10px] uppercase tracking-wide">
                        Limit reached
                      </Badge>
                    )}
                  </div>
                </div>
              </>
            )}
          </CardContent>
            </Card>
            </div>
          </CollapsibleContent>
        </Collapsible>

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

            <ChecksTableShell
              minWidthClassName="min-w-[600px]"
              hasRows={filteredChecks.length > 0}
              toolbar={(
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="font-mono text-xs cursor-pointer"
                      >
                        Group by
                        <ChevronDown className="ml-2 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className={`${glassClasses} w-56`}>
                      <DropdownMenuRadioGroup
                        value={groupBy}
                        onValueChange={(v) => setGroupBy(v as 'none' | 'folder')}
                      >
                        <DropdownMenuRadioItem value="none" className="cursor-pointer font-mono">
                          No grouping
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="folder" className="cursor-pointer font-mono">
                          Group by folder
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              emptyState={(
                <div className="text-center py-8 text-muted-foreground">
                  {search ? 'No checks found' : 'No checks configured yet'}
                </div>
              )}
              table={(
                <Table>
                  <TableHeader className="bg-muted border-b">
                    <TableRow>
                      <TableHead className="px-4 py-4 text-left w-12">
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
                      <TableHead className="px-4 py-4 text-left w-32">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                          Notifications
                        </div>
                      </TableHead>
                      <TableHead className="px-4 py-4 text-left">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                          Check
                        </div>
                      </TableHead>
                      <TableHead className="px-4 py-4 text-left">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                          Alert Types
                        </div>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {effectiveGroupBy === 'folder' && groupedByFolder
                      ? groupedByFolder.map((group) => (
                          <Fragment key={group.key}>
                            {(() => {
                              const groupColor = group.key === '__unsorted__' ? undefined : getFolderColor(group.key);
                              return (
                                <FolderGroupHeaderRow
                                  colSpan={4}
                                  label={group.label}
                                  count={group.checks.length}
                                  isCollapsed={collapsedSet.has(group.key)}
                                  onToggle={() => toggleFolderCollapsed(group.key)}
                                  color={groupColor}
                                />
                              );
                            })()}
                            {!collapsedSet.has(group.key) &&
                              group.checks.map((check) => renderCheckRow(check))}
                          </Fragment>
                        ))
                      : filteredChecks.map((c) => renderCheckRow(c))}
                  </TableBody>
                </Table>
              )}
            />
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
