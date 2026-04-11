import { useMemo, useState, useCallback, useRef, Fragment, memo } from 'react';
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
  Popover,
  PopoverTrigger,
  PopoverContent,
  glassClasses,
} from '../components/ui';
import { PageHeader, PageContainer, DocsLink } from '../components/layout';
import { AlertCircle, AlertTriangle, Loader2, Mail, TestTube2, RotateCcw, ChevronDown, Save, CheckCircle2, XCircle, Search, Info, Minus, Plus, X, Users, FolderOpen, Folder } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import ChecksTableShell from '../components/check/ChecksTableShell';
import { FolderGroupHeaderRow } from '../components/check/FolderGroupHeaderRow';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useMobile } from '../hooks/useMobile';
import { useNanoPlan } from '../hooks/useNanoPlan';
import { useNotificationSettings } from '../hooks/useNotificationSettings';
import {
  ALL_NOTIFICATION_EVENTS,
  DEFAULT_NOTIFICATION_EVENTS,
} from '../lib/notification-shared';
import { toast } from 'sonner';
import type { Website } from '../types';

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
// EmailCheckRow — memoized row component
// ---------------------------------------------------------------------------

interface EmailCheckRowProps {
  check: Website;
  perCheck: { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] } | undefined;
  checkFilterMode: 'all' | 'include';
  defaultEvents: WebhookEvent[];
  showFolder: boolean;
  isSelected: boolean;
  isPending: boolean;
  onToggle: (checkId: string, value: boolean) => void;
  onEventsChange: (checkId: string, events: WebhookEvent[]) => void;
  onSelect: (checkId: string, selected: boolean) => void;
  recipientInput: string;
  onRecipientInputChange: (checkId: string, value: string) => void;
  onPerCheckRecipients: (checkId: string, recipients: string[]) => void;
  recipients: string[];
  nano: boolean;
  isMobile: boolean;
  folderEntry: { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] } | undefined;
  autoIncluded: boolean;
}

const EmailCheckRow = memo(function EmailCheckRow({
  check,
  perCheck,
  checkFilterMode: _checkFilterMode,
  defaultEvents,
  showFolder,
  isSelected,
  isPending,
  onToggle,
  onEventsChange,
  onSelect,
  recipientInput,
  onRecipientInputChange,
  onPerCheckRecipients,
  recipients,
  nano,
  isMobile,
  folderEntry,
  autoIncluded,
}: EmailCheckRowProps) {
  const perEnabled = perCheck?.enabled;
  const perEvents = perCheck?.events;
  const perRecipients = perCheck?.recipients || [];

  const inheritedFromFolder = !perCheck && folderEntry?.enabled === true;
  const effectiveOn = perEnabled === true || inheritedFromFolder || autoIncluded;

  const effectiveEvents = perEvents && perEvents.length > 0
    ? perEvents
    : inheritedFromFolder && folderEntry?.events && folderEntry.events.length > 0
      ? folderEntry.events
      : autoIncluded
        ? (defaultEvents.length > 0 ? defaultEvents : DEFAULT_NOTIFICATION_EVENTS)
        : (effectiveOn ? DEFAULT_NOTIFICATION_EVENTS : []);

  const folderLabel = (check.folder ?? '').trim();

  return (
    <TableRow>
      {!isMobile && (
        <TableCell className="px-4 py-4">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onSelect(check.id, !!checked)}
            className="cursor-pointer"
          />
        </TableCell>
      )}
      <TableCell className="px-4 py-4">
        <div className="flex items-center gap-2">
          <Switch
            checked={effectiveOn}
            onCheckedChange={(v) => onToggle(check.id, v)}
            disabled={isPending}
            className="cursor-pointer"
          />
          {isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {inheritedFromFolder && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5" title="Inherited from folder settings">
              <FolderOpen className="w-3 h-3" />
            </span>
          )}
          {autoIncluded && (
            <span className="text-[10px] text-muted-foreground" title="Auto-included (all checks mode)">
              Auto
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="px-4 py-4">
        <div className="flex flex-col">
          <div className="font-medium text-sm flex items-center gap-2">
            {check.name}
            {perEvents && perEvents.length > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">Custom</Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate max-w-full sm:max-w-md">
            {check.url}
          </div>
          {showFolder && folderLabel && (
            <div className="pt-1 flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono text-[11px] w-fit">{folderLabel}</Badge>
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="px-4 py-4">
        <div className="flex flex-wrap gap-1">
          {ALL_NOTIFICATION_EVENTS.map((e) => {
            const isOn = effectiveOn && effectiveEvents.includes(e.value);
            const Icon = e.icon;
            const isLastEvent = isOn && effectiveEvents.length === 1;
            const badgeOpacity = isPending ? 'opacity-40' : (!effectiveOn || !isOn ? 'opacity-50' : '');
            const badgeCursor = isPending ? 'cursor-not-allowed' : 'cursor-pointer hover:opacity-80';
            return (
              <Badge
                key={e.value}
                variant={isOn ? 'default' : 'outline'}
                className={`text-xs px-2 py-0.5 transition-all ${badgeCursor} ${badgeOpacity}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isPending) return;
                  if (!effectiveOn) {
                    onToggle(check.id, true);
                    return;
                  }
                  const currentEvents = perEvents && perEvents.length > 0 ? perEvents : effectiveEvents;
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
                  onEventsChange(check.id, Array.from(next) as WebhookEvent[]);
                }}
                title={isPending ? 'Saving changes...' : !effectiveOn ? 'Enable notifications first' : isLastEvent ? 'At least one alert type must be enabled' : `Click to ${isOn ? 'disable' : 'enable'} ${e.label}`}
              >
                <Icon className="w-3 h-3 mr-1" />
                {e.label}
              </Badge>
            );
          })}
        </div>
      </TableCell>
      <TableCell className="px-4 py-4">
        <div className="flex flex-wrap items-center gap-1">
          {perRecipients.map((email, index) => (
            <Badge
              key={index}
              variant="secondary"
              className="text-xs px-2 py-0.5 gap-1 cursor-pointer hover:bg-destructive/20 hover:text-destructive transition-colors"
              onClick={() => {
                if (isPending) return;
                onPerCheckRecipients(check.id, perRecipients.filter((_, i) => i !== index));
              }}
              title={`Click to remove ${email}`}
            >
              {email.length > 20 ? `${email.slice(0, 17)}...` : email}
              <X className="w-3 h-3 ml-0.5" />
            </Badge>
          ))}
          {nano ? (
            <Popover>
              <PopoverTrigger asChild>
                <Badge
                  variant="outline"
                  className={`text-xs px-2 py-0.5 cursor-pointer hover:bg-muted transition-colors ${isPending ? 'opacity-40 cursor-not-allowed' : ''}`}
                  title="Add additional recipient for this check"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add
                </Badge>
              </PopoverTrigger>
              <PopoverContent className={`w-72 p-3 ${glassClasses}`} align="start">
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Add recipient for this check</Label>
                  <p className="text-xs text-muted-foreground">
                    This email will receive alerts for this check only, in addition to global recipients.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      placeholder="client@example.com"
                      value={recipientInput}
                      onChange={(e) => onRecipientInputChange(check.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && recipientInput.trim()) {
                          e.preventDefault();
                          const email = recipientInput.trim().toLowerCase();
                          if (recipients.some((r) => r.toLowerCase() === email)) {
                            toast.info('Already in global recipients', { duration: 2000 });
                            return;
                          }
                          if (perRecipients.some((r) => r.toLowerCase() === email)) {
                            toast.info('Already added for this check', { duration: 2000 });
                            return;
                          }
                          onPerCheckRecipients(check.id, [...perRecipients, recipientInput.trim()]);
                          onRecipientInputChange(check.id, '');
                        }
                      }}
                      className="h-8 text-sm"
                      disabled={isPending}
                    />
                    <Button
                      size="sm"
                      variant="default"
                      className="h-8 px-3"
                      disabled={!recipientInput.trim() || isPending}
                      onClick={() => {
                        if (!recipientInput.trim()) return;
                        const email = recipientInput.trim().toLowerCase();
                        if (recipients.some((r) => r.toLowerCase() === email)) {
                          toast.info('Already in global recipients', { duration: 2000 });
                          return;
                        }
                        if (perRecipients.some((r) => r.toLowerCase() === email)) {
                          toast.info('Already added for this check', { duration: 2000 });
                          return;
                        }
                        onPerCheckRecipients(check.id, [...perRecipients, recipientInput.trim()]);
                        onRecipientInputChange(check.id, '');
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <Link to="/billing" title="Upgrade to Nano to add extra recipients">
              <Badge
                variant="outline"
                className="text-xs px-2 py-0.5 cursor-pointer hover:bg-muted transition-colors text-muted-foreground"
              >
                <Plus className="w-3 h-3 mr-1" />
                Add <span className="text-[10px] ml-1">Nano</span>
              </Badge>
            </Link>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
});

// ---------------------------------------------------------------------------
// Emails page
// ---------------------------------------------------------------------------

export default function Emails() {
  const { userId } = useAuth();
  const { user } = useUser();
  const { nano } = useNanoPlan();
  const isMobile = useMobile(640);
  const userEmail = user?.primaryEmailAddress?.emailAddress || '';

  const [newEmail, setNewEmail] = useState('');
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isSetupOpen, setIsSetupOpen] = useLocalStorage('email-setup-open', true);
  const [recipientInputs, setRecipientInputs] = useState<Record<string, string>>({});

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

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <PageContainer>
      <PageHeader
        title="Email Alerts"
        description="Configure email notifications for your checks"
        icon={Mail}
        actions={<DocsLink path="/alerting/email-alerts" label="Email alerts docs" />}
      />

      <div className="space-y-4 sm:space-y-6 p-2 sm:p-4 md:p-6">
        {/* Setup collapsible */}
        <Collapsible open={isSetupOpen} onOpenChange={setIsSetupOpen}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-muted-foreground">Setup</div>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-2 cursor-pointer text-xs">
                {isSetupOpen ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                {isSetupOpen ? 'Minimize' : 'Expand'}
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="mt-3">
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
              {/* Email Setup Card */}
              <Card className="border-border/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Email Setup</CardTitle>
                  <CardDescription>Choose where alerts go and fine tune when we send them.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {n.isInitialized && n.recipients.length === 0 && (
                    <div className="rounded-md border border-sky-500/30 bg-sky-950/40 px-3 py-2 text-sm text-slate-100">
                      <div className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-sky-200" />
                        <span className="font-medium">Email address required</span>
                      </div>
                      <p className="mt-1 text-slate-200/90">Add an email address to start receiving alerts.</p>
                    </div>
                  )}

                  {/* Email Addresses */}
                  <div className="space-y-2">
                    <Label className="text-xs">Email Addresses</Label>
                    {n.recipients.map((email, index) => (
                      <div key={index} className="flex items-center gap-2 max-w-full sm:max-w-md">
                        <Input
                          type="email"
                          value={email}
                          onChange={(e) => {
                            const updated = [...n.recipients];
                            updated[index] = e.target.value;
                            n.setRecipients(updated);
                          }}
                          className="flex-1 h-9"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => n.setRecipients(n.recipients.filter((_, i) => i !== index))}
                          className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center gap-2 max-w-full sm:max-w-md">
                      <Input
                        type="email"
                        placeholder="Add another email..."
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newEmail.trim()) {
                            e.preventDefault();
                            n.setRecipients([...n.recipients, newEmail.trim()]);
                            setNewEmail('');
                          }
                        }}
                        className="flex-1 h-9"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!newEmail.trim()}
                        onClick={() => {
                          if (newEmail.trim()) {
                            n.setRecipients([...n.recipients, newEmail.trim()]);
                            setNewEmail('');
                          }
                        }}
                        className="h-9"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Flap Suppression */}
                  <div className="space-y-1.5">
                    <Label htmlFor="flap-suppression" className="text-xs">Flap Suppression</Label>
                    <div className="flex items-center gap-2 max-w-full sm:max-w-md">
                      <Select
                        value={n.minConsecutiveEvents.toString()}
                        onValueChange={(value) => n.setMinConsecutiveEvents(Number(value))}
                      >
                        <SelectTrigger id="flap-suppression" className="w-28 h-9 cursor-pointer">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5].map((v) => (
                            <SelectItem key={v} value={v.toString()}>
                              {v} {v === 1 ? 'check' : 'checks'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground">consecutive checks required</span>
                    </div>
                  </div>

                  {/* Email Format */}
                  <div className="space-y-1.5">
                    <Label htmlFor="email-format" className="text-xs">Email Format</Label>
                    <div className="flex items-center gap-2 max-w-full sm:max-w-md">
                      <Select
                        value={n.emailFormat}
                        onValueChange={(value) => n.setEmailFormat(value as 'html' | 'text')}
                      >
                        <SelectTrigger id="email-format" className="w-36 h-9 cursor-pointer">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="html">HTML (rich)</SelectItem>
                          <SelectItem value="text">Plain text</SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground">useful for ticket systems</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={n.handleResetToDefault}
                      disabled={!n.settings?.perCheck || Object.keys(n.settings.perCheck).length === 0}
                      className="gap-2 cursor-pointer h-8 text-xs"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset to default
                    </Button>
                    <Button
                      onClick={n.handleTest}
                      disabled={n.manualSaving || n.recipients.length === 0}
                      variant="outline"
                      size="sm"
                      className="gap-2 cursor-pointer h-8 text-xs"
                    >
                      <TestTube2 className="w-3 h-3" />
                      Test Email
                    </Button>
                  </div>

                  {/* Info accordion */}
                  <div className="rounded-md border border-border/50">
                    <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
                      <CollapsibleTrigger asChild>
                        <button className="w-full px-3 py-2 text-left text-sm font-medium flex items-center justify-between cursor-pointer hover:bg-muted/40 transition-colors">
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <Info className="w-4 h-4" />
                            How email alerts behave
                          </span>
                          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isInfoOpen ? 'rotate-180' : ''}`} />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="px-3 pb-3 text-sm text-muted-foreground space-y-3">
                          <p>Quick refresher so you always know why (and when) we send an email.</p>
                          <ul className="list-disc pl-4 space-y-2">
                            <li>We email only when a check flips states, so steady checks stay quiet.</li>
                            <li>Down/up alerts can resend roughly a minute after the last one.</li>
                            <li>Hourly caps: Free = 10 emails/hour, Nano = 100 emails/hour.</li>
                            <li>Monthly caps: Free = 10 emails/month, Nano = 1000 emails/month.</li>
                            <li>Flap suppression waits for the number of consecutive results you pick.</li>
                            <li>SSL and domain reminders respect longer windows and count toward your budget.</li>
                            <li><strong>Extra Recipients:</strong> Add client emails to specific checks. They receive alerts for that check only, in addition to your global recipients.</li>
                          </ul>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                </CardContent>
              </Card>

              {/* Usage Card */}
              <Card className="border-border/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Email Usage</CardTitle>
                  <CardDescription>Keep track of your monthly email budget.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {n.usageError && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Usage unavailable</AlertTitle>
                      <AlertDescription>{n.usageError}</AlertDescription>
                    </Alert>
                  )}
                  {!n.usage && !n.usageError && (
                    <div className="text-sm text-muted-foreground">Loading usage...</div>
                  )}
                  {n.usage && (
                    <>
                      {n.limitMessage && (
                        <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle>Email limit reached</AlertTitle>
                          <AlertDescription className="flex flex-col gap-2">
                            <span>{n.limitMessage}</span>
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
                          <span>{n.usage.monthly.count}/{n.usage.monthly.max}</span>
                        </div>
                        <Progress value={n.monthlyPercent} />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Resets {n.formatWindowEnd(n.usage.monthly.windowEnd, false)}</span>
                          {n.monthlyReached && (
                            <Badge variant="destructive" className="text-[10px] uppercase tracking-wide">Limit reached</Badge>
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
              Enable/disable email notifications and customize alert types for each check. Add extra recipients to send alerts for specific checks to clients or team members.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-8 pb-4 px-0">
            {/* Check filter mode */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Apply to</Label>
              <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/40 p-0.5">
                <button
                  type="button"
                  onClick={() => n.setCheckFilterMode('all')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors cursor-pointer ${
                    n.checkFilterMode === 'all'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  All checks
                </button>
                <button
                  type="button"
                  onClick={() => n.setCheckFilterMode('include')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors cursor-pointer ${
                    n.checkFilterMode === 'include'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Selected checks only
                </button>
              </div>
              {n.checkFilterMode === 'all' && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    All checks (including newly created ones) will receive email alerts. You can exclude specific checks below.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {ALL_NOTIFICATION_EVENTS.map((e) => {
                      const isOn = n.defaultEvents.includes(e.value);
                      const Icon = e.icon;
                      return (
                        <Badge
                          key={e.value}
                          variant={isOn ? 'default' : 'outline'}
                          className={`text-xs px-2 py-0.5 cursor-pointer transition-all ${!isOn ? 'opacity-50' : ''} hover:opacity-80`}
                          onClick={() => {
                            const next = isOn
                              ? n.defaultEvents.filter((v) => v !== e.value)
                              : [...n.defaultEvents, e.value];
                            if (next.length === 0) {
                              toast.error('At least one default alert type is required');
                              return;
                            }
                            n.setDefaultEvents(next as WebhookEvent[]);
                          }}
                          title={`Click to ${isOn ? 'disable' : 'enable'} ${e.label} for auto-included checks`}
                        >
                          <Icon className="w-3 h-3 mr-1" />
                          {e.label}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Search & count */}
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  type="text"
                  placeholder="Search checks..."
                  value={n.search}
                  onChange={(e) => n.setSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="text-sm text-muted-foreground">
                {n.filteredChecks.length} {n.filteredChecks.length === 1 ? 'check' : 'checks'}
              </div>
            </div>

            {/* Table */}
            <ChecksTableShell
              minWidthClassName="min-w-[800px]"
              hasRows={n.filteredChecks.length > 0}
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
                    className={`px-3 py-1 text-xs font-mono rounded-sm transition-all duration-150 cursor-pointer flex items-center gap-1.5 border ${
                      n.groupBy === 'folder'
                        ? 'bg-primary/15 text-primary shadow-sm border-primary/30'
                        : 'text-muted-foreground hover:text-foreground border-transparent'
                    }`}
                  >
                    <Folder className="w-3 h-3" />
                    Folders
                  </button>
                </div>
              }
              emptyState={
                <div className="text-center py-8 text-muted-foreground">
                  {n.search ? 'No checks found' : 'No checks configured yet'}
                </div>
              }
              table={
                <Table>
                  <TableHeader className="bg-muted border-b">
                    <TableRow>
                      {!isMobile && (
                        <TableHead className="px-4 py-4 text-left w-12">
                          <Checkbox
                            checked={n.selectedChecks.size > 0 && n.selectedChecks.size === n.filteredChecks.length}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                n.setSelectedChecks(new Set(n.filteredChecks.map((c) => c.id)));
                              } else {
                                n.setSelectedChecks(new Set());
                              }
                            }}
                            className="cursor-pointer"
                          />
                        </TableHead>
                      )}
                      <TableHead className="px-4 py-4 text-left w-32">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Notifications</div>
                      </TableHead>
                      <TableHead className="px-4 py-4 text-left">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Check</div>
                      </TableHead>
                      <TableHead className="px-4 py-4 text-left">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Alert Types</div>
                      </TableHead>
                      <TableHead className="px-4 py-4 text-left">
                        <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          Extra Recipients
                        </div>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {n.groupBy === 'folder' && n.groupedByFolder
                      ? n.groupedByFolder.map((group) => {
                          const groupColor = group.key === '__unsorted__' ? undefined : n.getFolderColor(group.key);
                          const folderPath = group.key === '__unsorted__' ? null : group.key;
                          const folderSettings = folderPath ? n.settings?.perFolder?.[folderPath] : undefined;
                          const isFolderEnabled = folderSettings?.enabled === true;
                          const folderEvents = folderSettings?.events && folderSettings.events.length > 0
                            ? folderSettings.events
                            : (isFolderEnabled ? DEFAULT_NOTIFICATION_EVENTS : []);
                          const folderRecipients = folderSettings?.recipients || [];
                          const folderRecipientKey = `folder:${folderPath}`;
                          const folderRecipientInput = recipientInputs[folderRecipientKey] || '';

                          return (
                            <Fragment key={group.key}>
                              <FolderGroupHeaderRow
                                colSpan={5}
                                label={group.label}
                                count={group.checks.length}
                                isCollapsed={n.collapsedSet.has(group.key)}
                                onToggle={() => n.toggleFolderCollapsed(group.key)}
                                color={groupColor}
                                actions={folderPath ? (
                                  <div className="flex items-center gap-3">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[10px] text-muted-foreground">
                                        {isFolderEnabled ? 'Folder alerts on' : 'Folder alerts off'}
                                      </span>
                                      <Switch
                                        checked={isFolderEnabled}
                                        onCheckedChange={(checked) => handleTogglePerFolder(folderPath, checked)}
                                        className="scale-75"
                                      />
                                    </div>
                                    {isFolderEnabled && (
                                      <div className="flex items-center gap-1">
                                        {ALL_NOTIFICATION_EVENTS.map((e) => {
                                          const isOn = folderEvents.includes(e.value);
                                          const Icon = e.icon;
                                          return (
                                            <Badge
                                              key={e.value}
                                              variant={isOn ? 'default' : 'outline'}
                                              className={`text-[10px] px-1.5 py-0 cursor-pointer hover:opacity-80 transition-all ${!isOn ? 'opacity-50' : ''}`}
                                              onClick={(ev) => {
                                                ev.stopPropagation();
                                                const current = folderSettings?.events && folderSettings.events.length > 0
                                                  ? folderSettings.events : [...DEFAULT_NOTIFICATION_EVENTS];
                                                const next = new Set(current);
                                                if (next.has(e.value)) {
                                                  if (next.size === 1) {
                                                    toast.error('At least one alert type is required', { duration: 3000 });
                                                    return;
                                                  }
                                                  next.delete(e.value);
                                                } else {
                                                  next.add(e.value);
                                                }
                                                handlePerFolderEvents(folderPath, Array.from(next) as WebhookEvent[]);
                                              }}
                                              title={`Click to ${isOn ? 'disable' : 'enable'} ${e.label} for this folder`}
                                            >
                                              <Icon className="w-2.5 h-2.5 mr-0.5" />
                                              {e.label}
                                            </Badge>
                                          );
                                        })}
                                      </div>
                                    )}
                                    {isFolderEnabled && (
                                      <div className="flex items-center gap-1">
                                        {folderRecipients.map((email, index) => (
                                          <Badge
                                            key={index}
                                            variant="secondary"
                                            className="text-[10px] px-1.5 py-0 gap-0.5 cursor-pointer hover:bg-destructive/20 hover:text-destructive transition-colors"
                                            onClick={(ev) => {
                                              ev.stopPropagation();
                                              handlePerFolderRecipients(folderPath, folderRecipients.filter((_, i) => i !== index));
                                            }}
                                            title={`Click to remove ${email}`}
                                          >
                                            {email.length > 16 ? `${email.slice(0, 14)}...` : email}
                                            <X className="w-2.5 h-2.5" />
                                          </Badge>
                                        ))}
                                        {nano ? (
                                          <Popover>
                                            <PopoverTrigger asChild>
                                              <Badge
                                                variant="outline"
                                                className="text-[10px] px-1.5 py-0 cursor-pointer hover:bg-muted transition-colors"
                                                title="Add extra recipient for this folder"
                                              >
                                                <Plus className="w-2.5 h-2.5 mr-0.5" />
                                                Add
                                              </Badge>
                                            </PopoverTrigger>
                                            <PopoverContent className={`w-72 p-3 ${glassClasses}`} align="start">
                                              <div className="space-y-2">
                                                <Label className="text-xs font-medium">Add recipient for this folder</Label>
                                                <p className="text-xs text-muted-foreground">
                                                  This email will receive alerts for all checks in this folder, in addition to global recipients.
                                                </p>
                                                <div className="flex gap-2">
                                                  <Input
                                                    type="email"
                                                    placeholder="client@example.com"
                                                    value={folderRecipientInput}
                                                    onChange={(e) => setRecipientInputs((prev) => ({ ...prev, [folderRecipientKey]: e.target.value }))}
                                                    onKeyDown={(e) => {
                                                      if (e.key === 'Enter' && folderRecipientInput.trim()) {
                                                        e.preventDefault();
                                                        const email = folderRecipientInput.trim().toLowerCase();
                                                        if (folderRecipients.some((r) => r.toLowerCase() === email)) {
                                                          toast.info('Already added for this folder', { duration: 2000 });
                                                          return;
                                                        }
                                                        handlePerFolderRecipients(folderPath, [...folderRecipients, folderRecipientInput.trim()]);
                                                        setRecipientInputs((prev) => ({ ...prev, [folderRecipientKey]: '' }));
                                                      }
                                                    }}
                                                    className="h-8 text-sm"
                                                  />
                                                  <Button
                                                    size="sm"
                                                    variant="default"
                                                    className="h-8 px-3"
                                                    disabled={!folderRecipientInput.trim()}
                                                    onClick={() => {
                                                      if (!folderRecipientInput.trim()) return;
                                                      const email = folderRecipientInput.trim().toLowerCase();
                                                      if (folderRecipients.some((r) => r.toLowerCase() === email)) {
                                                        toast.info('Already added for this folder', { duration: 2000 });
                                                        return;
                                                      }
                                                      handlePerFolderRecipients(folderPath, [...folderRecipients, folderRecipientInput.trim()]);
                                                      setRecipientInputs((prev) => ({ ...prev, [folderRecipientKey]: '' }));
                                                    }}
                                                  >
                                                    Add
                                                  </Button>
                                                </div>
                                              </div>
                                            </PopoverContent>
                                          </Popover>
                                        ) : (
                                          <Link to="/billing" title="Upgrade to Nano to add folder recipients">
                                            <Badge
                                              variant="outline"
                                              className="text-[10px] px-1.5 py-0 cursor-pointer hover:bg-muted transition-colors text-muted-foreground"
                                            >
                                              <Plus className="w-2.5 h-2.5 mr-0.5" />
                                              Add <span className="text-[9px] ml-0.5">Nano</span>
                                            </Badge>
                                          </Link>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ) : undefined}
                              />
                              {!n.collapsedSet.has(group.key) &&
                                group.checks.map((check) => {
                                  const per = n.settings?.perCheck?.[check.id];
                                  const fp = (check.folder ?? '').trim() || null;
                                  const fe = fp && !per ? n.settings?.perFolder?.[fp] : undefined;
                                  const auto = n.checkFilterMode === 'all' && per?.enabled !== false && !per && !fe;
                                  return (
                                    <EmailCheckRow
                                      key={check.id}
                                      check={check}
                                      perCheck={per}
                                      checkFilterMode={n.checkFilterMode}
                                      defaultEvents={n.defaultEvents}
                                      showFolder={false}
                                      isSelected={n.selectedChecks.has(check.id)}
                                      isPending={n.pendingCheckUpdates.has(check.id)}
                                      onToggle={n.handleTogglePerCheck}
                                      onEventsChange={n.handlePerCheckEvents}
                                      onSelect={handleSelectCheck}
                                      recipientInput={recipientInputs[check.id] || ''}
                                      onRecipientInputChange={handleRecipientInputChange}
                                      onPerCheckRecipients={handlePerCheckRecipients}
                                      recipients={n.recipients}
                                      nano={!!nano}
                                      isMobile={isMobile}
                                      folderEntry={fe}
                                      autoIncluded={auto}
                                    />
                                  );
                                })}
                            </Fragment>
                          );
                        })
                      : n.filteredChecks.map((check) => {
                          const per = n.settings?.perCheck?.[check.id];
                          const fp = (check.folder ?? '').trim() || null;
                          const fe = fp && !per ? n.settings?.perFolder?.[fp] : undefined;
                          const auto = n.checkFilterMode === 'all' && per?.enabled !== false && !per && !fe;
                          return (
                            <EmailCheckRow
                              key={check.id}
                              check={check}
                              perCheck={per}
                              checkFilterMode={n.checkFilterMode}
                              defaultEvents={n.defaultEvents}
                              showFolder={true}
                              isSelected={n.selectedChecks.has(check.id)}
                              isPending={n.pendingCheckUpdates.has(check.id)}
                              onToggle={n.handleTogglePerCheck}
                              onEventsChange={n.handlePerCheckEvents}
                              onSelect={handleSelectCheck}
                              recipientInput={recipientInputs[check.id] || ''}
                              onRecipientInputChange={handleRecipientInputChange}
                              onPerCheckRecipients={handlePerCheckRecipients}
                              recipients={n.recipients}
                              nano={!!nano}
                              isMobile={isMobile}
                              folderEntry={fe}
                              autoIncluded={auto}
                            />
                          );
                        })}
                  </TableBody>
                </Table>
              }
            />
          </CardContent>
        </Card>
      </div>

      {/* Bulk Actions Bar - hidden on mobile */}
      {!isMobile && (
        <BulkActionsBar
          selectedCount={n.selectedChecks.size}
          totalCount={n.filteredChecks.length}
          onClearSelection={() => {
            n.setSelectedChecks(new Set());
            n.setPendingBulkChanges(new Map());
          }}
          itemLabel="check"
          actions={[
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
          ]}
        />
      )}
    </PageContainer>
  );
}
