import { useMemo, useState, useCallback, useRef } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { httpsCallable, getFunctions } from 'firebase/functions';
import {
  BulkActionsBar,
  type BulkAction,
} from '../components/ui';
import { PageHeader, PageContainer, DocsLink } from '../components/layout';
import { Mail, Save, CheckCircle2, XCircle } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import ChecksTableShell from '../components/check/ChecksTableShell';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useMobile } from '../hooks/useMobile';
import { useNanoPlan } from '../hooks/useNanoPlan';
import { useNotificationSettings } from '../hooks/useNotificationSettings';
import {
  ALL_NOTIFICATION_EVENTS,
  DEFAULT_NOTIFICATION_EVENTS,
} from '../lib/notification-shared';
import { toast } from 'sonner';
import { SettingsSummaryStrip } from '../components/email/SettingsSummaryStrip';
import { EmailFilterBar } from '../components/email/EmailFilterBar';
import EmailListView from '../components/email/EmailListView';
import EmailFolderView from '../components/email/EmailFolderView';
import { EmailEmptyState } from '../components/email/EmailEmptyState';

// Firebase callable references at module scope
const functions = getFunctions();
const saveEmailSettingsFn = httpsCallable(functions, 'saveEmailSettings');
const updateEmailPerCheckFn = httpsCallable(functions, 'updateEmailPerCheck');
const updateEmailPerFolderFn = httpsCallable(functions, 'updateEmailPerFolder');
const bulkUpdateEmailPerCheckFn = httpsCallable(functions, 'bulkUpdateEmailPerCheck');
const getEmailSettingsFn = httpsCallable(functions, 'getEmailSettings');
const getEmailUsageFn = httpsCallable(functions, 'getEmailUsage');
const sendTestEmailFn = httpsCallable(functions, 'sendTestEmail');

// ---------------------------------------------------------------------------
// Emails page
// ---------------------------------------------------------------------------

export default function Emails() {
  const { userId } = useAuth();
  const { user } = useUser();
  const { nano } = useNanoPlan();
  const isMobile = useMobile(640);
  const userEmail = user?.primaryEmailAddress?.emailAddress || '';

  const [isSetupOpen, setIsSetupOpen] = useLocalStorage('email-setup-open', true);
  const [recipientInputs, setRecipientInputs] = useState<Record<string, string>>({});
  const [mobileSelectionMode, setMobileSelectionMode] = useState(false);

  // -------------------------------------------------------------------------
  // Shared hook
  // -------------------------------------------------------------------------

  const callables = useMemo(() => ({
    getSettings: getEmailSettingsFn,
    saveSettings: saveEmailSettingsFn,
    updatePerCheck: updateEmailPerCheckFn,
    bulkUpdatePerCheck: bulkUpdateEmailPerCheckFn,
    getUsage: getEmailUsageFn,
    sendTest: sendTestEmailFn,
  }), []);

  const n = useNotificationSettings({
    channel: 'email',
    userId: userId ?? null,
    hasAccess: true,
    callables,
    defaultRecipients: userEmail ? [userEmail] : [],
  });

  // Destructure stable functions from the hook (useState setters + useCallback-wrapped handlers)
  const {
    setSettings, setSelectedChecks,
    markChecksPending, queuePendingOverride, clearPendingOverride,
  } = n;

  // Ref for state values read at call-time inside email-specific handlers
  const settingsRef = useRef(n.settings);
  settingsRef.current = n.settings;
  const pendingCheckUpdatesRef = useRef(n.pendingCheckUpdates);
  pendingCheckUpdatesRef.current = n.pendingCheckUpdates;

  // -------------------------------------------------------------------------
  // Email-specific: per-check recipients
  // -------------------------------------------------------------------------

  const handlePerCheckRecipients = useCallback(async (checkId: string, newRecipients: string[]) => {
    if (pendingCheckUpdatesRef.current.has(checkId)) return;
    markChecksPending([checkId], true);
    queuePendingOverride(checkId, { recipients: newRecipients });

    const per = settingsRef.current?.perCheck?.[checkId];
    const previousRecipients = per?.recipients;

    setSettings((prev) => {
      if (!prev) return prev;
      const perCheck = { ...(prev.perCheck || {}) };
      perCheck[checkId] = { ...(perCheck[checkId] || {}), recipients: newRecipients };
      return { ...prev, perCheck, updatedAt: Date.now() };
    });

    try {
      await updateEmailPerCheckFn({ checkId, recipients: newRecipients });
      toast.success('Recipients updated', { duration: 2000 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update recipients';
      toast.error('Failed to update recipients', { description: msg, duration: 4000 });
      setSettings((prev) => {
        if (!prev) return prev;
        const perCheck = { ...(prev.perCheck || {}) };
        if (previousRecipients) {
          perCheck[checkId] = { ...(perCheck[checkId] || {}), recipients: previousRecipients };
        } else {
          const entry = { ...(perCheck[checkId] || {}) };
          delete entry.recipients;
          if (Object.keys(entry).length === 0) delete perCheck[checkId];
          else perCheck[checkId] = entry;
        }
        return { ...prev, perCheck };
      });
    } finally {
      clearPendingOverride(checkId);
      markChecksPending([checkId], false);
    }
  }, [markChecksPending, queuePendingOverride, clearPendingOverride, setSettings]);

  // -------------------------------------------------------------------------
  // Email-specific: per-folder handlers
  // -------------------------------------------------------------------------

  const handleTogglePerFolder = useCallback(async (folderPath: string, value: boolean) => {
    // Capture previous entry for rollback
    let previousEntry: Record<string, unknown> | undefined;
    setSettings((prev) => {
      if (!prev) return prev;
      const perFolder = { ...(prev.perFolder || {}) };
      previousEntry = perFolder[folderPath] ? { ...perFolder[folderPath] } : undefined;
      if (value) {
        perFolder[folderPath] = { ...(perFolder[folderPath] || {}), enabled: true, events: [...DEFAULT_NOTIFICATION_EVENTS] };
      } else {
        perFolder[folderPath] = { ...(perFolder[folderPath] || {}), enabled: false };
      }
      return { ...prev, perFolder, updatedAt: Date.now() };
    });
    try {
      if (value) {
        await updateEmailPerFolderFn({ folderPath, enabled: true, events: DEFAULT_NOTIFICATION_EVENTS });
      } else {
        await updateEmailPerFolderFn({ folderPath, enabled: false });
      }
      toast.success('Folder alert settings saved', { duration: 2000 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update folder settings';
      toast.error(msg);
      setSettings((prev) => {
        if (!prev) return prev;
        const perFolder = { ...(prev.perFolder || {}) };
        if (previousEntry) {
          perFolder[folderPath] = previousEntry as typeof perFolder[string];
        } else {
          delete perFolder[folderPath];
        }
        return { ...prev, perFolder };
      });
    }
  }, [setSettings]);

  const handlePerFolderEvents = useCallback(async (folderPath: string, events: WebhookEvent[]) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const perFolder = { ...(prev.perFolder || {}) };
      perFolder[folderPath] = { ...(perFolder[folderPath] || {}), events: [...events] };
      return { ...prev, perFolder, updatedAt: Date.now() };
    });
    try {
      await updateEmailPerFolderFn({ folderPath, events });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update folder events';
      toast.error(msg);
    }
  }, [setSettings]);

  const handlePerFolderRecipients = useCallback(async (folderPath: string, newRecipients: string[]) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const perFolder = { ...(prev.perFolder || {}) };
      perFolder[folderPath] = { ...(perFolder[folderPath] || {}), recipients: [...newRecipients] };
      return { ...prev, perFolder, updatedAt: Date.now() };
    });
    try {
      await updateEmailPerFolderFn({ folderPath, recipients: newRecipients });
      toast.success('Folder recipients updated', { duration: 2000 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update folder recipients';
      toast.error(msg);
    }
  }, [setSettings]);

  // -------------------------------------------------------------------------
  // Recipient input helpers
  // -------------------------------------------------------------------------

  const handleRecipientInputChange = useCallback((checkId: string, value: string) => {
    setRecipientInputs((prev) => ({ ...prev, [checkId]: value }));
  }, []);

  const handleSelectCheck = useCallback((checkId: string, selected: boolean) => {
    setSelectedChecks((prev) => {
      const next = new Set(prev);
      if (selected) next.add(checkId); else next.delete(checkId);
      return next;
    });
  }, [setSelectedChecks]);

  // Mobile card select: enables selection mode on first select
  const handleMobileSelect = useCallback((checkId: string) => {
    setMobileSelectionMode(true);
    setSelectedChecks((prev) => {
      const next = new Set(prev);
      if (next.has(checkId)) next.delete(checkId); else next.add(checkId);
      return next;
    });
  }, [setSelectedChecks]);

  // Select all checks within a folder
  const handleSelectFolder = useCallback((folderKey: string) => {
    if (!n.groupedByFolder) return;
    const group = n.groupedByFolder.find((g) => g.key === folderKey);
    if (!group) return;
    setSelectedChecks((prev) => {
      const next = new Set(prev);
      const allSelected = group.checks.every((c) => next.has(c.id));
      if (allSelected) {
        group.checks.forEach((c) => next.delete(c.id));
      } else {
        group.checks.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }, [n.groupedByFolder, setSelectedChecks]);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const monthlyResetLabel = n.usage ? n.formatWindowEnd(n.usage.monthly.windowEnd, false) : '';
  const canReset = !!(n.settings?.perCheck && Object.keys(n.settings.perCheck).length > 0);
  const hasChecks = n.filteredChecks.length > 0 || n.checks?.length > 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const emptyState = (
    <EmailEmptyState
      hasRecipients={n.recipients.length > 0}
      hasChecks={hasChecks}
      checkFilterMode={n.checkFilterMode}
      search={n.search}
    />
  );

  const tableView = n.groupBy === 'folder' && n.groupedByFolder ? (
    <EmailFolderView
      groups={n.groupedByFolder}
      settings={n.settings}
      checkFilterMode={n.checkFilterMode}
      defaultEvents={n.defaultEvents}
      selectedChecks={n.selectedChecks}
      pendingCheckUpdates={n.pendingCheckUpdates}
      collapsedSet={n.collapsedSet}
      onToggleFolderCollapsed={n.toggleFolderCollapsed}
      getFolderColor={n.getFolderColor}
      onToggle={n.handleTogglePerCheck}
      onEventsChange={n.handlePerCheckEvents}
      onSelect={handleSelectCheck}
      onSelectFolder={handleSelectFolder}
      recipientInputs={recipientInputs}
      onRecipientInputChange={handleRecipientInputChange}
      onPerCheckRecipients={handlePerCheckRecipients}
      onTogglePerFolder={handleTogglePerFolder}
      onPerFolderEvents={handlePerFolderEvents}
      onPerFolderRecipients={handlePerFolderRecipients}
      recipients={n.recipients}
      nano={!!nano}
      isMobile={isMobile}
    />
  ) : (
    <EmailListView
      checks={n.filteredChecks}
      settings={n.settings}
      checkFilterMode={n.checkFilterMode}
      defaultEvents={n.defaultEvents}
      selectedChecks={n.selectedChecks}
      pendingCheckUpdates={n.pendingCheckUpdates}
      onToggle={n.handleTogglePerCheck}
      onEventsChange={n.handlePerCheckEvents}
      onSelect={handleSelectCheck}
      onSelectAll={(selected) => {
        if (selected) {
          n.setSelectedChecks(new Set(n.filteredChecks.map((c) => c.id)));
        } else {
          n.setSelectedChecks(new Set());
        }
      }}
      recipientInputs={recipientInputs}
      onRecipientInputChange={handleRecipientInputChange}
      onPerCheckRecipients={handlePerCheckRecipients}
      recipients={n.recipients}
      nano={!!nano}
      isMobile={isMobile}
    />
  );

  const bulkActions: BulkAction[] = [
    ...ALL_NOTIFICATION_EVENTS.map((e): BulkAction => ({
      label: e.label,
      icon: <e.icon className="w-3 h-3" />,
      onClick: () => n.handleBulkToggleEvent(e.value),
      variant: n.bulkEventStates[e.value] ? 'default' : 'ghost',
      className: n.bulkEventStates[e.value]
        ? 'font-semibold text-primary-foreground bg-primary/90'
        : 'font-semibold opacity-70 hover:opacity-100',
    })),
    {
      label: n.allEventsEnabled ? 'Disable All' : 'Enable All',
      icon: n.allEventsEnabled ? <XCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />,
      onClick: n.handleBulkToggleAllEvents,
      variant: n.allEventsEnabled ? 'destructive' : 'default',
      className: n.allEventsEnabled
        ? 'font-semibold text-destructive-foreground bg-destructive/90'
        : 'font-semibold text-primary-foreground bg-primary/90',
    },
    {
      label: 'Save',
      icon: <Save className="w-3 h-3" />,
      onClick: n.pendingBulkChanges.size > 0 ? n.handleBulkSave : () => {},
      variant: 'default',
      className: n.pendingBulkChanges.size === 0
        ? 'font-semibold opacity-50 cursor-not-allowed'
        : 'font-semibold text-primary-foreground bg-primary/90',
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Email Alerts"
        description="Configure email notifications for your checks"
        icon={Mail}
        actions={<DocsLink path="/alerting/email-alerts" label="Email alerts docs" />}
      />

      <div className="space-y-4 sm:space-y-6 p-2 sm:p-4 md:p-6">
        {/* Settings summary strip with controlled expand/collapse */}
        <SettingsSummaryStrip
          recipients={n.recipients}
          onRecipientsChange={n.setRecipients}
          minConsecutiveEvents={n.minConsecutiveEvents}
          onMinConsecutiveEventsChange={n.setMinConsecutiveEvents}
          emailFormat={n.emailFormat}
          onEmailFormatChange={n.setEmailFormat}
          usage={n.usage}
          monthlyPercent={n.monthlyPercent}
          monthlyReached={n.monthlyReached}
          monthlyResetLabel={monthlyResetLabel}
          isInitialized={n.isInitialized}
          isFree={!nano}
          onResetToDefault={n.handleResetToDefault}
          canReset={canReset}
          onTest={n.handleTest}
          isSaving={n.manualSaving}
          isExpanded={isSetupOpen}
          onExpandedChange={setIsSetupOpen}
        />

        {/* Filter bar */}
        <EmailFilterBar
          checkFilterMode={n.checkFilterMode}
          onCheckFilterModeChange={n.setCheckFilterMode}
          search={n.search}
          onSearchChange={n.setSearch}
          checkCount={n.filteredChecks.length}
          groupBy={n.groupBy}
          onGroupByChange={n.setGroupBy}
          hasFolders={n.hasFolders}
          defaultEvents={n.defaultEvents}
          onDefaultEventsChange={n.setDefaultEvents}
          onExpandSettings={() => setIsSetupOpen(true)}
        />

        {/* Check list / folder view */}
        <ChecksTableShell
          minWidthClassName="min-w-[800px]"
          hasRows={n.filteredChecks.length > 0}
          emptyState={emptyState}
          table={tableView}
          mobile={
            <div className="space-y-2">
              {n.filteredChecks.length === 0
                ? emptyState
                : (n.groupBy === 'folder' && n.groupedByFolder ? (
                    <EmailFolderView
                      groups={n.groupedByFolder}
                      settings={n.settings}
                      checkFilterMode={n.checkFilterMode}
                      defaultEvents={n.defaultEvents}
                      selectedChecks={n.selectedChecks}
                      pendingCheckUpdates={n.pendingCheckUpdates}
                      collapsedSet={n.collapsedSet}
                      onToggleFolderCollapsed={n.toggleFolderCollapsed}
                      getFolderColor={n.getFolderColor}
                      onToggle={n.handleTogglePerCheck}
                      onEventsChange={n.handlePerCheckEvents}
                      onSelect={handleSelectCheck}
                      onSelectFolder={handleSelectFolder}
                      recipientInputs={recipientInputs}
                      onRecipientInputChange={handleRecipientInputChange}
                      onPerCheckRecipients={handlePerCheckRecipients}
                      onTogglePerFolder={handleTogglePerFolder}
                      onPerFolderEvents={handlePerFolderEvents}
                      onPerFolderRecipients={handlePerFolderRecipients}
                      recipients={n.recipients}
                      nano={!!nano}
                      isMobile={true}
                    />
                  ) : (
                    <EmailListView
                      checks={n.filteredChecks}
                      settings={n.settings}
                      checkFilterMode={n.checkFilterMode}
                      defaultEvents={n.defaultEvents}
                      selectedChecks={n.selectedChecks}
                      pendingCheckUpdates={n.pendingCheckUpdates}
                      onToggle={n.handleTogglePerCheck}
                      onEventsChange={n.handlePerCheckEvents}
                      onSelect={handleSelectCheck}
                      onSelectAll={(selected) => {
                        if (selected) {
                          n.setSelectedChecks(new Set(n.filteredChecks.map((c) => c.id)));
                        } else {
                          n.setSelectedChecks(new Set());
                        }
                      }}
                      recipientInputs={recipientInputs}
                      onRecipientInputChange={handleRecipientInputChange}
                      onPerCheckRecipients={handlePerCheckRecipients}
                      recipients={n.recipients}
                      nano={!!nano}
                      isMobile={true}
                    />
                  ))
              }
            </div>
          }
        />
      </div>

      {/* Bulk Actions Bar — shown on all screen sizes */}
      <BulkActionsBar
        selectedCount={n.selectedChecks.size}
        totalCount={n.filteredChecks.length}
        onClearSelection={() => {
          n.setSelectedChecks(new Set());
          n.setPendingBulkChanges(new Map());
          setMobileSelectionMode(false);
        }}
        itemLabel="check"
        actions={bulkActions}
      />
    </PageContainer>
  );
}
