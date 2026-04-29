import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  Input,
  Badge,
  Progress,
  Alert,
  AlertTitle,
  AlertDescription,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../ui';
import {
  Settings,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  TestTube2,
  Info,
  X,
  Plus,
} from 'lucide-react';
import type { NotificationUsage } from '../../lib/notification-shared';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SettingsSummaryStripProps {
  /** Resolved list of recipient email addresses */
  recipients: string[];
  /** Called when recipient list changes */
  onRecipientsChange: (recipients: string[]) => void;
  /** Current flap suppression value (1–5) */
  minConsecutiveEvents: number;
  /** Called when flap suppression changes */
  onMinConsecutiveEventsChange: (value: number) => void;
  /** Current email format */
  emailFormat: 'html' | 'text';
  /** Called when email format changes */
  onEmailFormatChange: (value: 'html' | 'text') => void;
  /** Usage data (null while loading) */
  usage: NotificationUsage | null;
  /** Pre-computed monthly percent (0–100) */
  monthlyPercent: number;
  /** True when the monthly limit has been reached */
  monthlyReached: boolean;
  /** Formatted window-end string (e.g. "May 1") */
  monthlyResetLabel: string;
  /** Whether the settings have been initialized from the server */
  isInitialized: boolean;
  /** Whether the user is on a free (non-nano) plan */
  isFree: boolean;
  /** Called to reset per-check settings to default */
  onResetToDefault: () => void;
  /** Whether a reset is possible */
  canReset: boolean;
  /** Called to send a test email */
  onTest: () => void;
  /** Whether a test/save action is in progress */
  isSaving: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usageColor(percent: number): string {
  if (percent >= 100) return 'text-destructive';
  if (percent >= 80) return 'text-warning';
  return 'text-muted-foreground';
}

function progressColor(percent: number): string {
  if (percent >= 100) return '[&>[data-slot=progress-indicator]]:bg-destructive';
  if (percent >= 80) return '[&>[data-slot=progress-indicator]]:bg-warning';
  return '';
}

// ---------------------------------------------------------------------------
// Collapsed strip
// ---------------------------------------------------------------------------

interface CollapsedStripProps extends SettingsSummaryStripProps {
  onExpand: () => void;
}

const CollapsedStrip = memo(function CollapsedStrip({
  recipients,
  emailFormat,
  minConsecutiveEvents,
  usage,
  monthlyPercent,
  onExpand,
}: CollapsedStripProps) {
  const primaryEmail = recipients[0] ?? null;
  const extraCount = recipients.length - 1;

  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full text-left rounded-lg border border-border/50 bg-card px-3 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer"
      aria-label="Expand email settings"
    >
      {/* Row 1 (always visible) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
        {/* Primary email + overflow */}
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs text-muted-foreground shrink-0">To:</span>
          {primaryEmail ? (
            <span className="text-xs font-medium truncate max-w-[160px] sm:max-w-xs">
              {primaryEmail}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground italic">No recipients</span>
          )}
          {extraCount > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
              +{extraCount} more
            </Badge>
          )}
        </div>

        <div className="hidden sm:block h-3 w-px bg-border/60 shrink-0" />

        {/* Format */}
        <span className="text-xs text-muted-foreground shrink-0">
          {emailFormat === 'html' ? 'HTML' : 'Plain text'}
        </span>

        <div className="hidden sm:block h-3 w-px bg-border/60 shrink-0" />

        {/* Flap suppression */}
        <span className="text-xs text-muted-foreground shrink-0">
          Flap: {minConsecutiveEvents} {minConsecutiveEvents === 1 ? 'check' : 'checks'}
        </span>

        {/* Usage mini indicator */}
        {usage && (
          <>
            <div className="hidden sm:block h-3 w-px bg-border/60 shrink-0" />
            <span className={`text-xs shrink-0 font-mono ${usageColor(monthlyPercent)}`}>
              {usage.monthly.count}/{usage.monthly.max} emails
            </span>
          </>
        )}

        {/* Gear icon — right-aligned */}
        <Settings className="w-3.5 h-3.5 text-muted-foreground ml-auto shrink-0" />
      </div>
    </button>
  );
});

// ---------------------------------------------------------------------------
// Expanded panel
// ---------------------------------------------------------------------------

interface ExpandedPanelProps extends SettingsSummaryStripProps {
  onCollapse: () => void;
}

const ExpandedPanel = memo(function ExpandedPanel({
  recipients,
  onRecipientsChange,
  minConsecutiveEvents,
  onMinConsecutiveEventsChange,
  emailFormat,
  onEmailFormatChange,
  usage,
  monthlyPercent,
  monthlyReached,
  monthlyResetLabel,
  isInitialized,
  isFree,
  onResetToDefault,
  canReset,
  onTest,
  isSaving,
  onCollapse,
}: ExpandedPanelProps) {
  const [newEmail, setNewEmail] = useState('');
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const handleAddEmail = () => {
    const trimmed = newEmail.trim();
    if (!trimmed) return;
    onRecipientsChange([...recipients, trimmed]);
    setNewEmail('');
  };

  return (
    <div className="rounded-lg border border-border/50 bg-card p-4 space-y-6">
      {/* "Email address required" alert */}
      {isInitialized && recipients.length === 0 && (
        <Alert className="border-primary/30 bg-background/80">
          <AlertCircle className="h-4 w-4 text-primary" />
          <AlertTitle>Email address required</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Add an email address to start receiving alerts.
          </AlertDescription>
        </Alert>
      )}

      {/* 2×2 grid */}
      <div className="grid gap-6 sm:grid-cols-2">
        {/* Left column */}
        <div className="space-y-6">
          {/* Email Addresses */}
          <div className="space-y-2">
            <Label className="text-xs">Email Addresses</Label>
            {recipients.map((email, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    const updated = [...recipients];
                    updated[index] = e.target.value;
                    onRecipientsChange(updated);
                  }}
                  className="flex-1 h-9"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRecipientsChange(recipients.filter((_, i) => i !== index))}
                  className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Input
                type="email"
                placeholder="Add another email..."
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newEmail.trim()) {
                    e.preventDefault();
                    handleAddEmail();
                  }
                }}
                className="flex-1 h-9"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!newEmail.trim()}
                onClick={handleAddEmail}
                className="h-9"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Flap Suppression */}
          <div className="space-y-1.5">
            <Label htmlFor="strip-flap-suppression" className="text-xs">Flap Suppression</Label>
            <div className="flex items-center gap-2">
              <Select
                value={minConsecutiveEvents.toString()}
                onValueChange={(value) => onMinConsecutiveEventsChange(Number(value))}
              >
                <SelectTrigger id="strip-flap-suppression" className="w-28 h-9 cursor-pointer">
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
        </div>

        {/* Right column */}
        <div className="space-y-6">
          {/* Email Usage */}
          <div className="space-y-2">
            <Label className="text-xs">Email Usage</Label>
            {!usage && (
              <p className="text-sm text-muted-foreground">Loading usage...</p>
            )}
            {usage && (
              <div className="space-y-3">
                {monthlyReached && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Email limit reached</AlertTitle>
                    <AlertDescription className="flex flex-col gap-2">
                      <span>You've reached your monthly email limit.</span>
                      {isFree && (
                        <Button asChild size="sm" variant="outline" className="w-fit cursor-pointer">
                          <Link to="/billing">Upgrade to Nano for 1000 emails/month</Link>
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Monthly usage</span>
                    <span className={`font-mono ${usageColor(monthlyPercent)}`}>
                      {usage.monthly.count}/{usage.monthly.max}
                    </span>
                  </div>
                  <Progress
                    value={monthlyPercent}
                    className={progressColor(monthlyPercent)}
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Resets {monthlyResetLabel}</span>
                    {monthlyReached && (
                      <Badge variant="destructive" className="text-[10px] uppercase tracking-wide">
                        Limit reached
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Email Format */}
          <div className="space-y-1.5">
            <Label htmlFor="strip-email-format" className="text-xs">Email Format</Label>
            <div className="flex items-center gap-2">
              <Select
                value={emailFormat}
                onValueChange={(value) => onEmailFormatChange(value as 'html' | 'text')}
              >
                <SelectTrigger id="strip-email-format" className="w-36 h-9 cursor-pointer">
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
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onResetToDefault}
          disabled={!canReset}
          className="gap-2 cursor-pointer h-8 text-xs"
        >
          <RotateCcw className="w-3 h-3" />
          Reset to default
        </Button>
        <Button
          onClick={onTest}
          disabled={isSaving || recipients.length === 0}
          variant="outline"
          size="sm"
          className="gap-2 cursor-pointer h-8 text-xs"
        >
          <TestTube2 className="w-3 h-3" />
          Test Email
        </Button>
      </div>

      {/* How email alerts behave — accordion */}
      <div className="rounded-md border border-border/50">
        <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
          <CollapsibleTrigger asChild>
            <button className="w-full px-3 py-2 text-left text-sm font-medium flex items-center justify-between cursor-pointer hover:bg-muted/40 transition-colors rounded-md">
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
              <p>Quick refresher so you always know why (and when) we send an email.</p>
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

      {/* Collapse button */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCollapse}
          className="gap-2 cursor-pointer h-8 text-xs text-muted-foreground"
        >
          <ChevronUp className="w-3 h-3" />
          Collapse
        </Button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const SettingsSummaryStrip = memo(function SettingsSummaryStrip(
  props: SettingsSummaryStripProps & {
    /** Controlled expanded state — when provided, overrides internal state */
    isExpanded?: boolean;
    /** Called when expanded state should change */
    onExpandedChange?: (expanded: boolean) => void;
  },
) {
  const { isExpanded: controlledExpanded, onExpandedChange, ...rest } = props;
  const [internalExpanded, setInternalExpanded] = useState(false);

  const expanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const setExpanded = onExpandedChange ?? setInternalExpanded;

  if (!expanded) {
    return <CollapsedStrip {...rest} onExpand={() => setExpanded(true)} />;
  }

  return <ExpandedPanel {...rest} onCollapse={() => setExpanded(false)} />;
});

export default SettingsSummaryStrip;
