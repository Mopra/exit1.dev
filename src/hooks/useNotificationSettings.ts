import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { WebhookEvent } from '../api/types';
import type { Website } from '../types';
import { useChecks } from './useChecks';
import { useDebounce } from './useDebounce';
import { useLocalStorage } from './useLocalStorage';
import { normalizeFolder } from '../lib/folder-utils';
import {
  DEFAULT_NOTIFICATION_EVENTS,
  type NotificationPendingOverride,
  type NotificationUsage,
} from '../lib/notification-shared';
import { toast } from 'sonner';

const DEFAULT_EVENTS = DEFAULT_NOTIFICATION_EVENTS;
const noop = () => {};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationSettings = {
  userId: string;
  enabled: boolean;
  recipient?: string;
  recipients?: string[];
  events: WebhookEvent[];
  minConsecutiveEvents?: number;
  perCheck?: Record<string, { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] }>;
  perFolder?: Record<string, { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] }>;
  checkFilter?: { mode: 'all' | 'include'; defaultEvents?: WebhookEvent[] };
  emailFormat?: 'html' | 'text';
  createdAt: number;
  updatedAt: number;
};

type PendingOverrides = Record<string, NotificationPendingOverride>;

type CallableFn = (data?: unknown) => Promise<{ data: unknown }>;

export interface NotificationCallables {
  getSettings: CallableFn;
  saveSettings: CallableFn;
  updatePerCheck: CallableFn;
  bulkUpdatePerCheck: CallableFn;
  getUsage: CallableFn;
  sendTest: CallableFn;
}

export interface UseNotificationSettingsOptions {
  /** Prefix for localStorage keys and labels (e.g. 'sms', 'email') */
  channel: string;
  userId: string | null;
  /** Whether the current user has access to this channel */
  hasAccess: boolean;
  callables: NotificationCallables;
  /** Extra params appended to every API call (e.g. { clientTier }) */
  extraApiParams?: Record<string, unknown>;
  /** Default recipient list when no saved settings exist */
  defaultRecipients?: string[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNotificationSettings(options: UseNotificationSettingsOptions) {
  const {
    channel,
    userId,
    hasAccess,
    defaultRecipients = [],
  } = options;

  // Stabilise object props via refs so callbacks don't depend on identity
  const callablesRef = useRef(options.callables);
  callablesRef.current = options.callables;
  const extraApiParamsRef = useRef(options.extraApiParams ?? {});
  extraApiParamsRef.current = options.extraApiParams ?? {};
  const defaultRecipientsRef = useRef(defaultRecipients);
  defaultRecipientsRef.current = defaultRecipients;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [recipients, setRecipients] = useState<string[]>(defaultRecipients);
  const [minConsecutiveEvents, setMinConsecutiveEvents] = useState(1);
  const [isInitialized, setIsInitialized] = useState(false);
  const [checkFilterMode, setCheckFilterMode] = useState<'all' | 'include'>('include');
  const [defaultEvents, setDefaultEvents] = useState<WebhookEvent[]>([...DEFAULT_EVENTS]);

  const [emailFormat, setEmailFormat] = useState<'html' | 'text'>('html');

  const [selectedChecks, setSelectedChecks] = useState<Set<string>>(new Set());
  const [pendingCheckUpdates, setPendingCheckUpdates] = useState<Set<string>>(new Set());
  const [pendingOverrides, setPendingOverrides] = useLocalStorage<PendingOverrides>(`${channel}-pending-overrides`, {});
  const [pendingBulkChanges, setPendingBulkChanges] = useState<Map<string, Set<WebhookEvent>>>(new Map());

  const [usage, setUsage] = useState<NotificationUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useLocalStorage<'none' | 'folder'>(`${channel}-group-by-v1`, 'none');
  const [collapsedFolders, setCollapsedFolders] = useLocalStorage<string[]>(`${channel}-folder-collapsed-v1`, []);
  const collapsedSet = useMemo(() => new Set(collapsedFolders), [collapsedFolders]);
  const [folderColors] = useLocalStorage<Record<string, string>>('checks-folder-view-colors-v1', {});

  // -----------------------------------------------------------------------
  // Refs (for stable callbacks)
  // -----------------------------------------------------------------------

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const recipientsRef = useRef(recipients);
  recipientsRef.current = recipients;

  const minConsecutiveEventsRef = useRef(minConsecutiveEvents);
  minConsecutiveEventsRef.current = minConsecutiveEvents;

  const checkFilterModeRef = useRef(checkFilterMode);
  checkFilterModeRef.current = checkFilterMode;

  const defaultEventsRef = useRef(defaultEvents);
  defaultEventsRef.current = defaultEvents;

  const emailFormatRef = useRef(emailFormat);
  emailFormatRef.current = emailFormat;

  const pendingCheckUpdatesRef = useRef(pendingCheckUpdates);
  pendingCheckUpdatesRef.current = pendingCheckUpdates;

  const lastSavedRef = useRef<{
    recipients: string[];
    minConsecutiveEvents: number;
    checkFilterMode: 'all' | 'include';
    defaultEvents: WebhookEvent[];
    emailFormat: 'html' | 'text';
  } | null>(null);
  const isSavingRef = useRef(false);
  const isFlushingPendingRef = useRef(false);

  // -----------------------------------------------------------------------
  // Checks (non-realtime)
  // -----------------------------------------------------------------------

  const effectiveUserId = hasAccess && userId ? userId : null;
  const { checks } = useChecks(effectiveUserId, noop, { realtime: false });

  const hasFolders = useMemo(
    () => checks.some((c) => (c.folder ?? '').trim().length > 0),
    [checks],
  );

  // Auto-set folder grouping on first load
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const existing = window.localStorage.getItem(`${channel}-group-by-v1`);
      if (existing === null && hasFolders) setGroupBy('folder');
    } catch { /* ignore */ }
  }, [hasFolders, setGroupBy, channel]);

  // -----------------------------------------------------------------------
  // Debounce
  // -----------------------------------------------------------------------

  const debouncedRecipients = useDebounce(recipients, 1000);
  const debouncedMinConsecutive = useDebounce(minConsecutiveEvents, 500);
  const debouncedCheckFilterMode = useDebounce(checkFilterMode, 500);
  const debouncedDefaultEvents = useDebounce(defaultEvents, 500);
  const debouncedEmailFormat = useDebounce(emailFormat, 500);

  // -----------------------------------------------------------------------
  // Pending overrides queue
  // -----------------------------------------------------------------------

  const pendingOverrideCount = useMemo(() => Object.keys(pendingOverrides).length, [pendingOverrides]);

  const queuePendingOverride = useCallback((checkId: string, patch: NotificationPendingOverride) => {
    setPendingOverrides((prev) => ({
      ...prev,
      [checkId]: { ...(prev[checkId] || {}), ...patch },
    }));
  }, [setPendingOverrides]);

  const clearPendingOverride = useCallback((checkId: string) => {
    setPendingOverrides((prev) => {
      if (!(checkId in prev)) return prev;
      const next = { ...prev };
      delete next[checkId];
      return next;
    });
  }, [setPendingOverrides]);

  const markChecksPending = useCallback((checkIds: string[], pending: boolean) => {
    if (checkIds.length === 0) return;
    setPendingCheckUpdates((prev) => {
      const next = new Set(prev);
      checkIds.forEach((id) => (pending ? next.add(id) : next.delete(id)));
      return next;
    });
  }, []);

  // -----------------------------------------------------------------------
  // Beforeunload guard
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (pendingCheckUpdates.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [pendingCheckUpdates.size]);

  // -----------------------------------------------------------------------
  // Flush pending overrides
  // -----------------------------------------------------------------------

  const flushPendingOverrides = useCallback(async () => {
    if (!hasAccess || !userId || pendingOverrideCount === 0 || isFlushingPendingRef.current) return;

    const entries = Object.entries(pendingOverrides).filter(([checkId, payload]) => {
      if (pendingCheckUpdatesRef.current.has(checkId)) return false;
      return Object.keys(payload || {}).length > 0;
    });
    if (entries.length === 0) return;

    isFlushingPendingRef.current = true;
    const checkIds = entries.map(([id]) => id);
    markChecksPending(checkIds, true);

    try {
      const updates = entries.map(([checkId, payload]) => ({ checkId, ...payload }));
      await callablesRef.current.bulkUpdatePerCheck({ updates, ...extraApiParamsRef.current });
      entries.forEach(([checkId]) => clearPendingOverride(checkId));
    } catch (error) {
      console.error(`[${channel}] Bulk update failed, will retry:`, error);
    } finally {
      markChecksPending(checkIds, false);
      isFlushingPendingRef.current = false;
    }
  }, [hasAccess, userId, pendingOverrideCount, pendingOverrides, clearPendingOverride, markChecksPending, channel]);

  useEffect(() => {
    if (!isInitialized || !hasAccess || !userId || pendingOverrideCount === 0) return;
    flushPendingOverrides();
  }, [isInitialized, hasAccess, userId, pendingOverrideCount, flushPendingOverrides]);

  // -----------------------------------------------------------------------
  // Save settings (stable via refs)
  // -----------------------------------------------------------------------

  const handleSaveSettings = useCallback(async (showSuccessToast = false, force = false) => {
    const curRecipients = recipientsRef.current;
    const curMinConsecutive = minConsecutiveEventsRef.current;
    const curCheckFilterMode = checkFilterModeRef.current;
    const curDefaultEvents = defaultEventsRef.current;
    const curEmailFormat = emailFormatRef.current;

    if (!hasAccess || !userId || curRecipients.length === 0) return;
    if (isSavingRef.current) return;

    if (!force) {
      const last = lastSavedRef.current;
      if (last &&
          JSON.stringify(last.recipients) === JSON.stringify(curRecipients) &&
          last.minConsecutiveEvents === curMinConsecutive &&
          last.checkFilterMode === curCheckFilterMode &&
          JSON.stringify(last.defaultEvents) === JSON.stringify(curDefaultEvents) &&
          last.emailFormat === curEmailFormat) {
        return;
      }
    }

    const isManualSave = showSuccessToast || force;
    isSavingRef.current = true;
    if (isManualSave) setManualSaving(true);

    try {
      const checkFilter = { mode: curCheckFilterMode, defaultEvents: curDefaultEvents };
      await callablesRef.current.saveSettings({
        recipients: curRecipients, enabled: true, events: DEFAULT_EVENTS,
        minConsecutiveEvents: curMinConsecutive, checkFilter, emailFormat: curEmailFormat, ...extraApiParamsRef.current,
      });
      lastSavedRef.current = {
        recipients: [...curRecipients],
        minConsecutiveEvents: curMinConsecutive,
        checkFilterMode: curCheckFilterMode,
        defaultEvents: [...curDefaultEvents],
        emailFormat: curEmailFormat,
      };
      setSettings((prev) =>
        prev ? {
          ...prev, recipients: curRecipients, enabled: true, events: DEFAULT_EVENTS,
          minConsecutiveEvents: curMinConsecutive, checkFilter, emailFormat: curEmailFormat, updatedAt: Date.now(),
        } : prev,
      );
      if (showSuccessToast) toast.success('Settings saved', { duration: 2000 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to save settings';
      toast.error('Failed to save settings', { description: msg, duration: 4000 });
    } finally {
      isSavingRef.current = false;
      if (isManualSave) setManualSaving(false);
    }
  }, [hasAccess, userId]);

  // -----------------------------------------------------------------------
  // Load settings
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!hasAccess || !userId) return;
    (async () => {
      try {
        const res = await callablesRef.current.getSettings({ ...extraApiParamsRef.current });
        const raw = (res.data as { data?: NotificationSettings })?.data ?? null;

        // Merge any pending overrides persisted in localStorage
        let merged: NotificationSettings | null;
        if (!raw && pendingOverrideCount === 0) {
          merged = null;
        } else {
          const seed: NotificationSettings = raw ?? {
            userId: userId || '',
            enabled: false,
            recipients: [...defaultRecipientsRef.current],
            events: DEFAULT_EVENTS,
            perCheck: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          if (pendingOverrideCount === 0) {
            merged = seed;
          } else {
            const perCheck = { ...(seed.perCheck || {}) };
            Object.entries(pendingOverrides).forEach(([checkId, override]) => {
              const entry: { enabled?: boolean; events?: WebhookEvent[] } = { ...(perCheck[checkId] || {}) };
              if ('enabled' in override) {
                if (override.enabled === null) delete entry.enabled;
                else entry.enabled = override.enabled;
              }
              if ('events' in override) {
                if (override.events === null) delete entry.events;
                else entry.events = override.events;
              }
              if (Object.keys(entry).length === 0) delete perCheck[checkId];
              else perCheck[checkId] = entry;
            });
            merged = { ...seed, perCheck, updatedAt: Date.now() };
          }
        }

        if (merged) {
          setSettings(merged);
          const savedRecipients = merged.recipients?.length
            ? merged.recipients
            : (merged.recipient ? [merged.recipient] : [...defaultRecipientsRef.current]);
          const savedMinConsecutive = Math.max(1, Number(merged.minConsecutiveEvents || 1));
          setRecipients(savedRecipients);
          setMinConsecutiveEvents(savedMinConsecutive);
          setCheckFilterMode(merged.checkFilter?.mode || 'include');
          setDefaultEvents(merged.checkFilter?.defaultEvents?.length ? merged.checkFilter.defaultEvents : [...DEFAULT_EVENTS]);
          setEmailFormat(merged.emailFormat || 'html');
          if (raw) {
            lastSavedRef.current = {
              recipients: savedRecipients,
              minConsecutiveEvents: savedMinConsecutive,
              checkFilterMode: merged.checkFilter?.mode || 'include',
              defaultEvents: merged.checkFilter?.defaultEvents?.length ? [...merged.checkFilter.defaultEvents] : [...DEFAULT_EVENTS],
              emailFormat: merged.emailFormat || 'html',
            };
          }
        } else {
          setSettings(null);
          if (defaultRecipientsRef.current.length > 0) {
            setRecipients((prev) => (prev.length > 0 ? prev : [...defaultRecipientsRef.current]));
          }
        }
        setIsInitialized(true);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Please try again.';
        toast.error(`Failed to load ${channel} settings`, { description: msg, duration: 4000 });
        setIsInitialized(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAccess, userId, channel]);

  // -----------------------------------------------------------------------
  // Usage
  // -----------------------------------------------------------------------

  const fetchUsage = useCallback(async () => {
    if (!hasAccess || !userId) return;
    try {
      setUsageError(null);
      const res = await callablesRef.current.getUsage({ ...extraApiParamsRef.current });
      const data = (res.data as { data?: NotificationUsage })?.data;
      setUsage(data ?? null);
    } catch (error: unknown) {
      setUsageError(error instanceof Error ? error.message : `Failed to load ${channel} usage`);
    }
  }, [hasAccess, userId, channel]);

  useEffect(() => {
    if (!hasAccess || !userId) return;
    fetchUsage();
    const interval = setInterval(fetchUsage, 300_000);
    return () => clearInterval(interval);
  }, [hasAccess, userId, fetchUsage]);

  // -----------------------------------------------------------------------
  // Auto-save (P4 fix: single debounce, no extra setTimeout)
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!isInitialized || !hasAccess || !userId || debouncedRecipients.length === 0) return;
    handleSaveSettings(false, false);
  }, [debouncedRecipients, debouncedMinConsecutive, debouncedCheckFilterMode, debouncedDefaultEvents, debouncedEmailFormat, isInitialized, hasAccess, userId, handleSaveSettings]);

  // -----------------------------------------------------------------------
  // Test
  // -----------------------------------------------------------------------

  const handleTest = useCallback(async () => {
    if (!hasAccess) return;
    try {
      await handleSaveSettings(true, true);
      await callablesRef.current.sendTest({ ...extraApiParamsRef.current });
      toast.success(`Test ${channel} sent`, {
        description: channel === 'sms' ? 'Check your phone.' : 'Check your inbox.',
        duration: 4000,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Please try again.';
      toast.error(`Failed to send test ${channel}`, { description: msg, duration: 5000 });
    }
  }, [hasAccess, handleSaveSettings, channel]);

  // -----------------------------------------------------------------------
  // Usage helpers
  // -----------------------------------------------------------------------

  const formatWindowEnd = useCallback((windowEnd: number, includeTime: boolean) => {
    const opts: Intl.DateTimeFormatOptions = includeTime
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric' };
    return new Date(windowEnd).toLocaleString(undefined, opts);
  }, []);

  const monthlyUsage = usage?.monthly;
  const monthlyPercent = useMemo(() => {
    if (!monthlyUsage || monthlyUsage.max <= 0) return 0;
    return Math.min(100, Math.round((monthlyUsage.count / monthlyUsage.max) * 100));
  }, [monthlyUsage]);
  const monthlyReached = Boolean(monthlyUsage && monthlyUsage.max > 0 && monthlyUsage.count >= monthlyUsage.max);

  const limitMessage = useMemo(() => {
    if (!monthlyUsage || !monthlyReached) return null;
    return `Monthly limit reached. Resets ${formatWindowEnd(monthlyUsage.windowEnd, false)}.`;
  }, [monthlyUsage, monthlyReached, formatWindowEnd]);

  // -----------------------------------------------------------------------
  // Filtering & grouping
  // -----------------------------------------------------------------------

  const filteredChecks = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return checks;
    return checks.filter((c) =>
      (c.name || '').toLowerCase().includes(term) || (c.url || '').toLowerCase().includes(term),
    );
  }, [checks, search]);

  const groupedByFolder = useMemo(() => {
    if (groupBy !== 'folder') return null;
    const map = new Map<string, Website[]>();
    for (const c of filteredChecks) {
      const key = (c.folder ?? '').trim() || '__unsorted__';
      const list = map.get(key) ?? [];
      list.push(c);
      map.set(key, list);
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === '__unsorted__') return -1;
      if (b === '__unsorted__') return 1;
      return a.localeCompare(b);
    });
    return keys.map((key) => ({
      key,
      label: key === '__unsorted__' ? 'Unsorted' : key,
      checks: map.get(key) ?? [],
    }));
  }, [groupBy, filteredChecks]);

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

  // -----------------------------------------------------------------------
  // Clear bulk changes for deselected checks
  // -----------------------------------------------------------------------

  useEffect(() => {
    setPendingBulkChanges((prev) => {
      const next = new Map(prev);
      let changed = false;
      prev.forEach((_, checkId) => {
        if (!selectedChecks.has(checkId)) { next.delete(checkId); changed = true; }
      });
      return changed ? next : prev;
    });
  }, [selectedChecks]);

  // -----------------------------------------------------------------------
  // Per-check handlers (P7 fix: stable via refs)
  // -----------------------------------------------------------------------

  const handleTogglePerCheck = useCallback(async (checkId: string, value: boolean) => {
    if (pendingCheckUpdatesRef.current.has(checkId)) return;
    markChecksPending([checkId], true);

    const per = settingsRef.current?.perCheck?.[checkId];
    const hasEvents = per?.events && per.events.length > 0;
    const cfm = checkFilterModeRef.current;

    let pendingPayload: { enabled: boolean | null; events?: WebhookEvent[] | null };
    if (cfm === 'all') {
      pendingPayload = value ? { enabled: null, events: null } : { enabled: false };
    } else {
      pendingPayload = value && !hasEvents
        ? { enabled: true, events: DEFAULT_EVENTS }
        : { enabled: value };
    }

    setSettings((prev) => {
      if (!prev) return prev;
      const perCheck = { ...(prev.perCheck || {}) };
      if (cfm === 'all' && value) {
        delete perCheck[checkId];
      } else {
        const entry: { enabled?: boolean; events?: WebhookEvent[] } = { ...(perCheck[checkId] || {}) };
        if (cfm === 'all') {
          entry.enabled = false;
        } else if (value) {
          entry.enabled = true;
          if (!hasEvents) entry.events = [...DEFAULT_EVENTS];
        } else {
          entry.enabled = false;
        }
        perCheck[checkId] = entry;
      }
      return { ...prev, perCheck, updatedAt: Date.now() };
    });

    queuePendingOverride(checkId, pendingPayload);

    try {
      await callablesRef.current.updatePerCheck({ checkId, ...pendingPayload, ...extraApiParamsRef.current });
      toast.success('Saved', { duration: 2000 });
    } catch {
      toast.error('Failed to update check settings');
      // Revert
      setSettings((prev) => {
        if (!prev) return prev;
        const perCheck = { ...(prev.perCheck || {}) };
        if (cfm === 'all' && value) {
          perCheck[checkId] = { ...(perCheck[checkId] || {}), enabled: false };
        } else {
          const reverted = { ...(perCheck[checkId] || {}) };
          if (value) {
            delete reverted.enabled;
            if (!hasEvents) delete reverted.events;
          } else {
            reverted.enabled = true;
          }
          if (Object.keys(reverted).length === 0) delete perCheck[checkId];
          else perCheck[checkId] = reverted;
        }
        return { ...prev, perCheck };
      });
    } finally {
      clearPendingOverride(checkId);
      markChecksPending([checkId], false);
    }
  }, [queuePendingOverride, clearPendingOverride, markChecksPending]);

  const handlePerCheckEvents = useCallback(async (checkId: string, newEvents: WebhookEvent[]) => {
    if (pendingCheckUpdatesRef.current.has(checkId)) return;
    markChecksPending([checkId], true);
    queuePendingOverride(checkId, { events: newEvents });

    const per = settingsRef.current?.perCheck?.[checkId];
    const wasEnabled = per?.enabled !== false;

    setSettings((prev) => {
      if (!prev) return prev;
      const perCheck = { ...(prev.perCheck || {}) };
      perCheck[checkId] = {
        ...(perCheck[checkId] || {}),
        events: newEvents,
        enabled: wasEnabled ? true : undefined,
      };
      return { ...prev, perCheck, updatedAt: Date.now() };
    });

    try {
      await callablesRef.current.updatePerCheck({ checkId, events: newEvents, ...extraApiParamsRef.current });
      toast.success('Saved', { duration: 2000 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update check events';
      toast.error('Failed to update check events', { description: msg, duration: 4000 });
      // Revert
      const previousEvents = per?.events;
      setSettings((prev) => {
        if (!prev) return prev;
        const perCheck = { ...(prev.perCheck || {}) };
        if (previousEvents) {
          perCheck[checkId] = { ...(perCheck[checkId] || {}), events: previousEvents };
        } else {
          const entry = { ...(perCheck[checkId] || {}) };
          delete entry.events;
          if (Object.keys(entry).length === 0) delete perCheck[checkId];
          else perCheck[checkId] = entry;
        }
        return { ...prev, perCheck };
      });
    } finally {
      clearPendingOverride(checkId);
      markChecksPending([checkId], false);
    }
  }, [queuePendingOverride, clearPendingOverride, markChecksPending]);

  // -----------------------------------------------------------------------
  // Reset to default (P3 fix: uses bulk endpoint)
  // -----------------------------------------------------------------------

  const handleResetToDefault = useCallback(async () => {
    const perCheck = settingsRef.current?.perCheck;
    if (!perCheck || Object.keys(perCheck).length === 0) {
      toast.info('No custom settings to reset');
      return;
    }

    const checkIds = Object.keys(perCheck);
    markChecksPending(checkIds, true);
    checkIds.forEach((id) => queuePendingOverride(id, { enabled: null, events: null }));

    try {
      const updates = checkIds.map((checkId) => ({ checkId, enabled: null, events: null }));
      await callablesRef.current.bulkUpdatePerCheck({ updates, ...extraApiParamsRef.current });

      setSettings((prev) => (prev ? { ...prev, perCheck: {}, updatedAt: Date.now() } : prev));
      toast.success('All checks reset to default', { duration: 3000 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Please try again.';
      toast.error('Failed to reset settings', { description: msg, duration: 4000 });
    } finally {
      checkIds.forEach(clearPendingOverride);
      markChecksPending(checkIds, false);
    }
  }, [queuePendingOverride, clearPendingOverride, markChecksPending]);

  // -----------------------------------------------------------------------
  // Bulk operations
  // -----------------------------------------------------------------------

  const handleBulkToggleEvent = useCallback((eventToToggle: WebhookEvent) => {
    if (selectedChecks.size === 0) {
      toast.info('Please select at least one check');
      return;
    }
    setPendingBulkChanges((prev) => {
      const next = new Map(prev);
      Array.from(selectedChecks).forEach((checkId) => {
        const per = settingsRef.current?.perCheck?.[checkId];
        const perEnabled = per?.enabled === true;
        const perEvents = per?.events;

        let currentEvents: Set<WebhookEvent>;
        if (next.has(checkId)) {
          currentEvents = new Set(next.get(checkId)!);
        } else {
          const baseEvents = perEvents && perEvents.length > 0
            ? perEvents
            : (perEnabled ? DEFAULT_EVENTS : []);
          currentEvents = new Set(baseEvents);
        }
        if (!perEnabled && !prev.has(checkId)) {
          currentEvents = new Set(DEFAULT_EVENTS);
        }

        if (currentEvents.has(eventToToggle)) currentEvents.delete(eventToToggle);
        else currentEvents.add(eventToToggle);

        next.set(checkId, currentEvents);
      });
      return next;
    });
  }, [selectedChecks]);

  const handleBulkSave = useCallback(async () => {
    if (pendingBulkChanges.size === 0) {
      toast.info('No changes to save');
      return;
    }

    const updates: Array<{ checkId: string; events: WebhookEvent[]; enabled: boolean }> = [];
    const stateUpdates: Record<string, { events: WebhookEvent[]; enabled: boolean }> = {};

    pendingBulkChanges.forEach((events, checkId) => {
      const eventsArray = Array.from(events) as WebhookEvent[];
      const enabled = eventsArray.length > 0;
      updates.push({ checkId, events: eventsArray, enabled });
      stateUpdates[checkId] = { events: eventsArray, enabled };
    });

    const checkIds = updates.map((u) => u.checkId);
    markChecksPending(checkIds, true);
    updates.forEach(({ checkId, events, enabled }) => queuePendingOverride(checkId, { events, enabled }));

    try {
      await callablesRef.current.bulkUpdatePerCheck({ updates, ...extraApiParamsRef.current });
      setSettings((prev) => {
        if (!prev) return prev;
        const perCheck = { ...(prev.perCheck || {}) };
        Object.entries(stateUpdates).forEach(([checkId, update]) => {
          perCheck[checkId] = { ...(perCheck[checkId] || {}), ...update };
        });
        return { ...prev, perCheck, updatedAt: Date.now() };
      });
      toast.success(`Updated ${updates.length} check${updates.length === 1 ? '' : 's'}`, { duration: 2000 });
      setPendingBulkChanges(new Map());
      setSelectedChecks(new Set());
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Please try again.';
      toast.error('Failed to update checks', { description: msg, duration: 4000 });
    } finally {
      checkIds.forEach(clearPendingOverride);
      markChecksPending(checkIds, false);
    }
  }, [pendingBulkChanges, queuePendingOverride, clearPendingOverride, markChecksPending]);

  const handleBulkToggleAllEvents = useCallback(() => {
    if (selectedChecks.size === 0) {
      toast.info('Please select at least one check');
      return;
    }

    let allEnabled = true;
    Array.from(selectedChecks).forEach((checkId) => {
      const pending = pendingBulkChanges.get(checkId);
      if (pending) {
        if (!DEFAULT_EVENTS.every((e) => pending.has(e))) allEnabled = false;
      } else {
        const per = settingsRef.current?.perCheck?.[checkId];
        const perEnabled = per?.enabled === true;
        const perEvents = per?.events;
        const currentEvents = perEvents && perEvents.length > 0 ? perEvents : (perEnabled ? DEFAULT_EVENTS : []);
        if (!DEFAULT_EVENTS.every((e) => currentEvents.includes(e))) allEnabled = false;
      }
    });

    setPendingBulkChanges((prev) => {
      const next = new Map(prev);
      Array.from(selectedChecks).forEach((checkId) => {
        next.set(checkId, allEnabled ? new Set<WebhookEvent>() : new Set(DEFAULT_EVENTS));
      });
      return next;
    });
  }, [selectedChecks, pendingBulkChanges]);

  // -----------------------------------------------------------------------
  // Pre-computed bulk state (P10 fix)
  // -----------------------------------------------------------------------

  const bulkEventStates = useMemo(() => {
    const states = {} as Record<WebhookEvent, boolean>;
    for (const e of DEFAULT_EVENTS) {
      states[e] = selectedChecks.size > 0 && Array.from(selectedChecks).every((checkId) => {
        const pending = pendingBulkChanges.get(checkId);
        if (pending) return pending.has(e);
        const per = settings?.perCheck?.[checkId];
        const perEnabled = per?.enabled === true;
        const perEvents = per?.events;
        const currentEvents = perEvents && perEvents.length > 0 ? perEvents : (perEnabled ? DEFAULT_EVENTS : []);
        return currentEvents.includes(e);
      });
    }
    return states;
  }, [selectedChecks, pendingBulkChanges, settings?.perCheck]);

  const allEventsEnabled = useMemo(
    () => selectedChecks.size > 0 && DEFAULT_EVENTS.every((e) => bulkEventStates[e]),
    [selectedChecks.size, bulkEventStates],
  );

  // -----------------------------------------------------------------------
  // Return
  // -----------------------------------------------------------------------

  return {
    settings, setSettings, isInitialized, manualSaving,
    recipients, setRecipients, minConsecutiveEvents, setMinConsecutiveEvents,
    checkFilterMode, setCheckFilterMode, defaultEvents, setDefaultEvents,
    emailFormat, setEmailFormat,
    selectedChecks, setSelectedChecks, pendingCheckUpdates, pendingOverrideCount,
    pendingBulkChanges, setPendingBulkChanges,
    usage, usageError, monthlyUsage, monthlyPercent, monthlyReached, limitMessage, formatWindowEnd,
    checks, search, setSearch, filteredChecks,
    groupBy, setGroupBy, groupedByFolder, collapsedSet, toggleFolderCollapsed, getFolderColor, hasFolders,
    handleSaveSettings, handleTogglePerCheck, handlePerCheckEvents, handleResetToDefault,
    handleBulkToggleEvent, handleBulkSave, handleBulkToggleAllEvents, handleTest,
    markChecksPending, queuePendingOverride, clearPendingOverride,
    bulkEventStates, allEventsEnabled,
  };
}
