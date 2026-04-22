import { useMemo, useState, useCallback, Fragment, memo } from 'react';
import { useAuth } from '@clerk/clerk-react';
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
  FeatureGate,
} from '../components/ui';
import { PageHeader, PageContainer, DocsLink } from '../components/layout';
import { AlertCircle, AlertTriangle, Loader2, MessageSquare, TestTube2, RotateCcw, ChevronDown, Save, CheckCircle2, XCircle, Search, Info, Minus, Plus, X, Folder } from 'lucide-react';
import type { WebhookEvent } from '../api/types';
import ChecksTableShell from '../components/check/ChecksTableShell';
import { FolderGroupHeaderRow } from '../components/check/FolderGroupHeaderRow';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { usePlan } from '@/hooks/usePlan';
import { useAdmin } from '@/hooks/useAdmin';
import type { Website } from '../types';
import { ALL_NOTIFICATION_EVENTS, DEFAULT_NOTIFICATION_EVENTS } from '../lib/notification-shared';
import { useNotificationSettings } from '../hooks/useNotificationSettings';

// Firebase callable references at module scope to avoid recreating on every render
const functions = getFunctions();
const saveSmsSettingsFn = httpsCallable(functions, 'saveSmsSettings');
const updateSmsPerCheckFn = httpsCallable(functions, 'updateSmsPerCheck');
const bulkUpdateSmsPerCheckFn = httpsCallable(functions, 'bulkUpdateSmsPerCheck');
const getSmsSettingsFn = httpsCallable(functions, 'getSmsSettings');
const getSmsUsageFn = httpsCallable(functions, 'getSmsUsage');
const sendTestSmsFn = httpsCallable(functions, 'sendTestSms');

// ---------------------------------------------------------------------------
// SmsCheckRow — memoized row component
// ---------------------------------------------------------------------------

interface SmsCheckRowProps {
  check: Website;
  per: { enabled?: boolean; events?: WebhookEvent[] } | undefined;
  checkFilterMode: 'all' | 'include';
  defaultEvents: WebhookEvent[];
  showFolder: boolean;
  isSelected: boolean;
  isPending: boolean;
  onToggle: (checkId: string, value: boolean) => void;
  onEventsChange: (checkId: string, events: WebhookEvent[]) => void;
  onSelect: (checkId: string, selected: boolean) => void;
}

const SmsCheckRow = memo(function SmsCheckRow({
  check,
  per,
  checkFilterMode,
  defaultEvents,
  showFolder,
  isSelected,
  isPending,
  onToggle,
  onEventsChange,
  onSelect,
}: SmsCheckRowProps) {
  const perEnabled = per?.enabled;
  const perEvents = per?.events;
  const autoIncluded = checkFilterMode === 'all' && perEnabled !== false && !per;
  const effectiveOn = perEnabled === true || autoIncluded;
  const effectiveEvents = perEvents && perEvents.length > 0
    ? perEvents
    : autoIncluded
      ? (defaultEvents.length > 0 ? defaultEvents : DEFAULT_NOTIFICATION_EVENTS)
      : (effectiveOn ? DEFAULT_NOTIFICATION_EVENTS : []);
  const folderLabel = (check.folder ?? '').trim();

  return (
    <TableRow>
      <TableCell className="px-4 py-4">
        <Checkbox
          checked={isSelected}
          onCheckedChange={(checked) => onSelect(check.id, !!checked)}
          className="cursor-pointer"
        />
      </TableCell>
      <TableCell className="px-4 py-4">
        <div className="flex items-center gap-2">
          <Switch
            checked={effectiveOn}
            onCheckedChange={(v) => onToggle(check.id, v)}
            disabled={isPending}
            className="cursor-pointer"
          />
          {isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
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
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                Custom
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate max-w-md">
            {check.url}
          </div>
          {showFolder && folderLabel && (
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
          {ALL_NOTIFICATION_EVENTS.map((e) => {
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
                  if (isPending) return;
                  if (!effectiveOn) {
                    onToggle(check.id, true);
                    return;
                  }
                  const currentEvents = perEvents && perEvents.length > 0 ? perEvents : effectiveEvents;
                  const next = new Set(currentEvents);
                  if (next.has(e.value)) {
                    if (next.size === 1) return;
                    next.delete(e.value);
                  } else {
                    next.add(e.value);
                  }
                  onEventsChange(check.id, Array.from(next) as WebhookEvent[]);
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
});

// ---------------------------------------------------------------------------
// Sms page
// ---------------------------------------------------------------------------

export default function Sms() {
  const { userId } = useAuth();
  const { tier, nano, pro } = usePlan();
  const { isAdmin } = useAdmin();
  // SMS is Pro+ per plan §3 (tightened from Nano in Phase B1).
  const hasAccess = pro || isAdmin;
  const clientTier = nano ? 'nano' : 'free';

  // Local UI state
  const [isSetupOpen, setIsSetupOpen] = useLocalStorage('sms-setup-open', true);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [newPhone, setNewPhone] = useState('');

  // Hook callables & params (stable via useMemo)
  const callables = useMemo(() => ({
    getSettings: getSmsSettingsFn,
    saveSettings: saveSmsSettingsFn,
    updatePerCheck: updateSmsPerCheckFn,
    bulkUpdatePerCheck: bulkUpdateSmsPerCheckFn,
    getUsage: getSmsUsageFn,
    sendTest: sendTestSmsFn,
  }), []);

  const extraApiParams = useMemo(() => ({ clientTier }), [clientTier]);

  const n = useNotificationSettings({
    channel: 'sms',
    userId: userId ?? null,
    hasAccess: !!hasAccess,
    callables,
    extraApiParams,
  });

  const handleSelect = useCallback((checkId: string, selected: boolean) => {
    n.setSelectedChecks((prev) => {
      const next = new Set(prev);
      if (selected) next.add(checkId);
      else next.delete(checkId);
      return next;
    });
  }, [n.setSelectedChecks]);

  return (
    <PageContainer>
      <PageHeader
        title="SMS Alerts"
        description="Configure SMS notifications for your checks"
        icon={MessageSquare}
        actions={<DocsLink path="/alerting/sms-alerts" label="SMS alerts docs" />}
      />

      <div className="mx-6 mt-4 px-3 py-2 text-xs text-muted-foreground bg-muted/50 rounded-md border border-border/50">
        SMS delivery to US and Canada is temporarily unavailable.
      </div>

      <FeatureGate
        requiredTier="pro"
        currentTier={isAdmin ? "agency" : tier}
        title="Upgrade to Pro"
        description="SMS alerts are available on the Pro plan or higher. Upgrade to enable SMS notifications for your checks."
        ctaLabel="Upgrade to Pro"
        className="p-6"
      >
      <div className="space-y-4 sm:space-y-6 p-2 sm:p-4 md:p-6">
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
                  <CardTitle className="text-sm font-medium">SMS Setup</CardTitle>
                  <CardDescription>
                    Add a phone number and fine tune when we send a text.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {hasAccess && n.isInitialized && n.recipients.length === 0 && (
                    <Alert className="bg-sky-950/40 border-sky-500/30 text-slate-100 backdrop-blur-md shadow-lg shadow-sky-900/30">
                      <AlertCircle className="h-4 w-4 text-sky-200" />
                      <AlertTitle className="text-slate-100">Phone number required</AlertTitle>
                      <AlertDescription className="text-slate-200/90">
                        Add a phone number in E.164 format (e.g., +15551234567) to start receiving alerts.
                      </AlertDescription>
                    </Alert>
                  )}
                  {/* Phone Numbers */}
                  <div className="space-y-2">
                    <Label className="text-xs">Phone Numbers</Label>
                    {n.recipients.map((phone, index) => (
                      <div key={index} className="flex items-center gap-2 max-w-md">
                        <Input
                          type="tel"
                          value={phone}
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
                    <div className="flex items-center gap-2 max-w-md">
                      <Input
                        type="tel"
                        placeholder="Add another phone... (+15551234567)"
                        value={newPhone}
                        onChange={(e) => setNewPhone(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newPhone.trim()) {
                            e.preventDefault();
                            n.setRecipients([...n.recipients, newPhone.trim()]);
                            setNewPhone('');
                          }
                        }}
                        className="flex-1 h-9"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!newPhone.trim()}
                        onClick={() => {
                          if (newPhone.trim()) {
                            n.setRecipients([...n.recipients, newPhone.trim()]);
                            setNewPhone('');
                          }
                        }}
                        className="h-9"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground/70 max-w-md leading-relaxed">
                      By adding your phone number, you agree to receive SMS text messages from Exit1.dev for website monitoring alerts (e.g., site down, site up, SSL errors). Message frequency varies based on your alert configuration. Msg &amp; data rates may apply. Reply STOP to opt out at any time.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="flap-suppression" className="text-xs">Flap Suppression</Label>
                    <div className="flex items-center gap-2 max-w-md">
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
                      <span className="text-xs text-muted-foreground">
                        consecutive checks required
                      </span>
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
                      disabled={n.manualSaving || n.recipients.length === 0 || !hasAccess}
                      variant="outline"
                      size="sm"
                      className="gap-2 cursor-pointer h-8 text-xs"
                    >
                      <TestTube2 className="w-3 h-3" />
                      Test SMS
                    </Button>
                  </div>

                  <div className="rounded-md border border-border/50">
                    <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
                      <CollapsibleTrigger asChild>
                        <button className="w-full px-3 py-2 text-left text-sm font-medium flex items-center justify-between cursor-pointer hover:bg-muted/40 transition-colors">
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <Info className="w-4 h-4" />
                            How SMS alerts behave
                          </span>
                          <ChevronDown
                            className={`w-4 h-4 text-muted-foreground transition-transform ${isInfoOpen ? 'rotate-180' : ''}`}
                          />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="px-3 pb-3 text-sm text-muted-foreground space-y-3">
                          <p>
                            Quick refresher so you always know why (and when) we send a text.
                          </p>
                          <ul className="list-disc pl-4 space-y-2">
                            <li>We text only when a check flips states, so steady checks stay quiet.</li>
                            <li>Down/up alerts can resend roughly a minute after the last one.</li>
                            <li>SMS alerts use a separate hourly budget to avoid spam and unexpected usage.</li>
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
                  <CardTitle className="text-sm font-medium">SMS Usage</CardTitle>
                  <CardDescription>
                    Keep track of your monthly SMS budget.
                  </CardDescription>
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
                          <AlertTitle>SMS limit reached</AlertTitle>
                          <AlertDescription>{n.limitMessage}</AlertDescription>
                        </Alert>
                      )}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Monthly usage</span>
                          <span>
                            {n.usage.monthly.count}/{n.usage.monthly.max}
                          </span>
                        </div>
                        <Progress value={n.monthlyPercent} />
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Resets {n.formatWindowEnd(n.usage.monthly.windowEnd, false)}</span>
                          {n.monthlyReached && (
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
              Enable/disable SMS notifications and customize alert types for each check. When enabled, configure which alert types trigger texts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-8 pb-4 px-0">
            {/* Check filter mode toggle */}
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
                    All checks (including newly created ones) will receive SMS alerts. You can exclude specific checks below.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {ALL_NOTIFICATION_EVENTS.map((e) => {
                      const isOn = n.defaultEvents.includes(e.value);
                      const Icon = e.icon;
                      return (
                        <Badge
                          key={e.value}
                          variant={isOn ? "default" : "outline"}
                          className={`text-xs px-2 py-0.5 cursor-pointer transition-all ${!isOn ? 'opacity-50' : ''} hover:opacity-80`}
                          onClick={() => {
                            const next = isOn
                              ? n.defaultEvents.filter((v) => v !== e.value)
                              : [...n.defaultEvents, e.value];
                            if (next.length === 0) return;
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

            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative max-w-xs">
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

            <ChecksTableShell
              minWidthClassName="min-w-[600px]"
              hasRows={n.filteredChecks.length > 0}
              toolbar={(
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
              )}
              emptyState={(
                <div className="text-center py-8 text-muted-foreground">
                  {n.search ? 'No checks found' : 'No checks configured yet'}
                </div>
              )}
              table={(
                <Table>
                  <TableHeader className="bg-muted border-b">
                    <TableRow>
                      <TableHead className="px-4 py-4 text-left w-12">
                        <Checkbox
                          checked={n.selectedChecks.size > 0 && n.selectedChecks.size === n.filteredChecks.length}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              n.setSelectedChecks(new Set(n.filteredChecks.map(c => c.id)));
                            } else {
                              n.setSelectedChecks(new Set());
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
                    {n.groupBy === 'folder' && n.groupedByFolder
                      ? n.groupedByFolder.map((group) => (
                          <Fragment key={group.key}>
                            {(() => {
                              const groupColor = group.key === '__unsorted__' ? undefined : n.getFolderColor(group.key);
                              return (
                                <FolderGroupHeaderRow
                                  colSpan={4}
                                  label={group.label}
                                  count={group.checks.length}
                                  isCollapsed={n.collapsedSet.has(group.key)}
                                  onToggle={() => n.toggleFolderCollapsed(group.key)}
                                  color={groupColor}
                                />
                              );
                            })()}
                            {!n.collapsedSet.has(group.key) &&
                              group.checks.map((check) => (
                                <SmsCheckRow
                                  key={check.id}
                                  check={check}
                                  per={n.settings?.perCheck?.[check.id]}
                                  checkFilterMode={n.checkFilterMode}
                                  defaultEvents={n.defaultEvents}
                                  showFolder={false}
                                  isSelected={n.selectedChecks.has(check.id)}
                                  isPending={n.pendingCheckUpdates.has(check.id)}
                                  onToggle={n.handleTogglePerCheck}
                                  onEventsChange={n.handlePerCheckEvents}
                                  onSelect={handleSelect}
                                />
                              ))}
                          </Fragment>
                        ))
                      : n.filteredChecks.map((c) => (
                          <SmsCheckRow
                            key={c.id}
                            check={c}
                            per={n.settings?.perCheck?.[c.id]}
                            checkFilterMode={n.checkFilterMode}
                            defaultEvents={n.defaultEvents}
                            showFolder={n.groupBy !== 'folder'}
                            isSelected={n.selectedChecks.has(c.id)}
                            isPending={n.pendingCheckUpdates.has(c.id)}
                            onToggle={n.handleTogglePerCheck}
                            onEventsChange={n.handlePerCheckEvents}
                            onSelect={handleSelect}
                          />
                        ))}
                  </TableBody>
                </Table>
              )}
            />
          </CardContent>
        </Card>
      </div>

      {/* Bulk Actions Bar */}
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
      </FeatureGate>
    </PageContainer>
  );
}
