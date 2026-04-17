import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Plus, X, FolderOpen } from 'lucide-react';
import {
  Badge,
  Input,
  Button,
  Label,
  Popover,
  PopoverTrigger,
  PopoverContent,
  TableRow,
  TableCell,
  Checkbox,
  glassClasses,
} from '../ui';
import type { WebhookEvent } from '../../api/types';
import type { Website } from '../../types';
import {
  ALL_NOTIFICATION_EVENTS,
  DEFAULT_NOTIFICATION_EVENTS,
} from '../../lib/notification-shared';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// EmailCheckRow — memoized row component
// ---------------------------------------------------------------------------

export interface EmailCheckRowProps {
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
  folderColor?: string;
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
  folderColor,
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
  const hasPerCheckOverrides = !!perCheck;

  return (
    <TableRow className={!effectiveOn ? 'opacity-60' : undefined}>
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
        <div className="flex flex-col">
          <div className="font-medium text-sm flex items-center gap-2">
            {check.name}
            {isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            {perEvents && perEvents.length > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">Custom</Badge>
            )}
            {inheritedFromFolder && !hasPerCheckOverrides && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5" title="Inherited from folder settings">
                <FolderOpen className="w-3 h-3" />
              </span>
            )}
            {autoIncluded && !hasPerCheckOverrides && (
              <span className="text-[10px] text-muted-foreground" title="Auto-included (all checks mode)">
                Auto
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate max-w-full sm:max-w-md">
            {check.url}
          </div>
          {showFolder && folderLabel && (
            <div className="pt-1 flex flex-wrap items-center gap-2">
              <Badge
                variant="secondary"
                className={`font-mono text-[11px] w-fit ${folderColor ? `bg-${folderColor}-500/20 text-${folderColor}-400 border-${folderColor}-400/30` : ''}`}
              >
                {folderLabel}
              </Badge>
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="px-4 py-4">
        {(
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
                        onToggle(check.id, false);
                        return;
                      }
                      next.delete(e.value);
                    } else {
                      next.add(e.value);
                    }
                    onEventsChange(check.id, Array.from(next) as WebhookEvent[]);
                  }}
                  title={
                    isPending
                      ? 'Saving changes...'
                      : !effectiveOn
                        ? 'Click to enable and configure alert type'
                        : isLastEvent
                          ? `Click to disable ${e.label} (turns off alerts for this check)`
                          : `Click to ${isOn ? 'disable' : 'enable'} ${e.label}`
                  }
                >
                  <Icon className="w-3 h-3 mr-1" />
                  {e.label}
                </Badge>
              );
            })}
          </div>
        )}
      </TableCell>
      <TableCell className="px-4 py-4">
        {(
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
                            const emailVal = recipientInput.trim().toLowerCase();
                            if (recipients.some((r) => r.toLowerCase() === emailVal)) {
                              toast.info('Already in global recipients', { duration: 2000 });
                              return;
                            }
                            if (perRecipients.some((r) => r.toLowerCase() === emailVal)) {
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
                          const emailVal = recipientInput.trim().toLowerCase();
                          if (recipients.some((r) => r.toLowerCase() === emailVal)) {
                            toast.info('Already in global recipients', { duration: 2000 });
                            return;
                          }
                          if (perRecipients.some((r) => r.toLowerCase() === emailVal)) {
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
            ) : perRecipients.length === 0 ? (
              <Link to="/billing" title="Upgrade to Nano to add extra recipients">
                <Badge
                  variant="outline"
                  className="text-xs px-2 py-0.5 cursor-pointer hover:bg-muted transition-colors text-muted-foreground"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add <span className="text-[10px] ml-1">Nano</span>
                </Badge>
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
});

export default EmailCheckRow;
