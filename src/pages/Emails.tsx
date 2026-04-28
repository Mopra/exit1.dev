import { useMemo, useState, useCallback, useRef } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { httpsCallable, getFunctions } from 'firebase/functions';
import {
  BulkActionsBar,
  type BulkAction,
} from '../components/ui';
import { PageHeader, PageContainer, DocsLink } from '../components/layout';
import { Mail, Save, CheckCircle2, XCircle, Folder } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import ChecksTableShell from '../components/check/ChecksTableShell';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useMobile } from '../hooks/useMobile';
import { usePlan } from '../hooks/usePlan';
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
import EmailCheckCard from '../components/email/EmailCheckCard';
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
  const { pro, nano } = usePlan();
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
      pro={!!pro}
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
      pro={!!pro}
      isMobile={isMobile}
      getFolderColor={n.getFolderColor}
    />
  );

  const bulkActions: BulkAction[] = [
    ...ALL_NOTIFICATION_EVENTS.map((e): BulkAction => ({
      label: e.label,
      icon: <e.icon className="w-3 h-3" />,
      onClick: () => n.handleBulkToggleEvent(e.value),
      variant: n.bulkEventStates[e.value] ? 'default' : 'outline',
      className: 'font-semibold',
    })),
    {
      label: n.allEventsEnabled ? 'Disable All' : 'Enable All',
      icon: n.allEventsEnabled ? <XCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />,
      onClick: n.handleBulkToggleAllEvents,
      variant: n.allEventsEnabled ? 'destructive' : 'default',
      className: 'font-semibold',
    },
    {
      label: 'Save',
      icon: <Save className="w-3 h-3" />,
      onClick: n.handleBulkSave,
      variant: 'default',
      disabled: n.pendingBulkChanges.size === 0,
      className: 'font-semibold',
    },
  ];

  const mobileList = (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      {n.filteredChecks.length === 0
        ? emptyState
        : n.filteredChecks.map((check) => {
            const per = n.settings?.perCheck?.[check.id];
            const fp = (check.folder ?? '').trim() || null;
            const fe = fp && !per ? n.settings?.perFolder?.[fp] : undefined;
            const auto = n.checkFilterMode === 'all' && per?.enabled !== false && !per && !fe;
            return (
              <EmailCheckCard
                key={check.id}
                check={check}
                perCheck={per}
                defaultEvents={n.defaultEvents}
                isPending={n.pendingCheckUpdates.has(check.id)}
                onToggle={n.handleTogglePerCheck}
                onEventsChange={n.handlePerCheckEvents}
                recipientInput={recipientInputs[check.id] || ''}
                onRecipientInputChange={handleRecipientInputChange}
                onPerCheckRecipients={handlePerCheckRecipients}
                recipients={n.recipients}
                pro={!!pro}
                folderEntry={fe}
                autoIncluded={auto}
                isSelected={n.selectedChecks.has(check.id)}
                selectionMode={mobileSelectionMode}
                onSelect={handleMobileSelect}
              />
            );
          })
      }
    </div>
  );

  return (
    <PageContainer>
      <PageHeader
        title="Email Alerts"
        description="Configure email notifications for your checks"
        icon={Mail}
        actions={<DocsLink path="/alerting/email-alerts" label="Email alerts docs" />}
      />

      <div className="p-2 sm:p-4 md:p-6">
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
      </div>

      <div className="flex-1 p-2 sm:p-4 md:p-6 min-h-0 max-w-full overflow-x-hidden space-y-4">
        <EmailFilterBar
          checkFilterMode={n.checkFilterMode}
          onCheckFilterModeChange={n.setCheckFilterMode}
          search={n.search}
          onSearchChange={n.setSearch}
          checkCount={n.filteredChecks.length}
          groupBy={n.groupBy}
          onGroupByChange={n.setGroupBy}
          hasFolders={false}
          defaultEvents={n.defaultEvents}
          onDefaultEventsChange={n.setDefaultEvents}
          onExpandSettings={() => setIsSetupOpen(true)}
        />

        <ChecksTableShell
          minWidthClassName="min-w-[960px]"
          hasRows={n.filteredChecks.length > 0}
          emptyState={emptyState}
          table={tableView}
          mobile={mobileList}
          toolbar={
            <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => n.setGroupBy('none')}
                className={`px-3 py-1 text-xs font-mono rounded-sm transition-all duration-150 cursor-pointer border ${
                  n.groupBy === 'none'
                    ? 'bg-primary/15 text-primary shadow-sm border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                }`}
              >
                List
              </button>
              <button
                type="button"
                onClick={() => n.setGroupBy('folder')}
                disabled={!n.hasFolders}
                className={`px-3 py-1 text-xs font-mono rounded-sm transition-all duration-150 cursor-pointer flex items-center gap-1.5 border ${
                  n.groupBy === 'folder'
                    ? 'bg-primary/15 text-primary shadow-sm border-primary/30'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Folder className="w-3 h-3" />
                Folders
              </button>
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
