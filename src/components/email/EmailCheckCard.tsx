import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Check, Plus, X, FolderOpen } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Label } from '../ui/Label';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { glassClasses } from '../ui/glass';
import { ALL_NOTIFICATION_EVENTS, DEFAULT_NOTIFICATION_EVENTS } from '../../lib/notification-shared';
import type { Website } from '../../types';
import type { WebhookEvent } from '../../api/types';
import { toast } from 'sonner';

interface EmailCheckCardProps {
  check: Website;
  perCheck: { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] } | undefined;
  defaultEvents: WebhookEvent[];
  isPending: boolean;
  onToggle: (checkId: string, value: boolean) => void;
  onEventsChange: (checkId: string, events: WebhookEvent[]) => void;
  recipientInput: string;
  onRecipientInputChange: (checkId: string, value: string) => void;
  onPerCheckRecipients: (checkId: string, recipients: string[]) => void;
  recipients: string[];
  pro: boolean;
  folderEntry: { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] } | undefined;
  autoIncluded: boolean;
  isSelected: boolean;
  selectionMode: boolean;
  onSelect: (checkId: string) => void;
}

export const EmailCheckCard = memo(function EmailCheckCard({
  check,
  perCheck,
  defaultEvents,
  isPending,
  onToggle,
  onEventsChange,
  recipientInput,
  onRecipientInputChange,
  onPerCheckRecipients,
  recipients,
  pro,
  folderEntry,
  autoIncluded,
  isSelected,
  selectionMode,
  onSelect,
}: EmailCheckCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Derived state
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

  // Collapsed summary: active event labels joined with " · "
  const activeEventLabels = ALL_NOTIFICATION_EVENTS
    .filter((e) => effectiveOn && effectiveEvents.includes(e.value))
    .map((e) => e.label)
    .join(' · ');

  // First recipient (truncated) for collapsed view
  const firstRecipient = perRecipients[0];
  const firstRecipientDisplay = firstRecipient
    ? (firstRecipient.length > 22 ? `${firstRecipient.slice(0, 19)}...` : firstRecipient)
    : null;
  const extraRecipientCount = perRecipients.length > 1 ? perRecipients.length - 1 : 0;

  const handleCardClick = () => {
    if (selectionMode) {
      onSelect(check.id);
    } else {
      setIsExpanded((prev) => !prev);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onSelect(check.id);
  };

  return (
    <div
      className={`relative rounded-lg border border-border/60 bg-card transition-all duration-200 ${check.disabled ? 'opacity-60' : ''} ${isSelected ? 'ring-2 ring-primary/60 border-primary/40' : ''}`}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
    >
      {/* Selection indicator */}
      {selectionMode && (
        <div className="absolute top-3 left-3 z-10">
          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/50 bg-background'}`}>
            {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
          </div>
        </div>
      )}

      {/* Card content */}
      <div className={`p-3 ${selectionMode ? 'pl-10' : ''}`}>
        {/* Collapsed header: name, status pill, chevron */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {/* Name row */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-sm text-foreground truncate">{check.name}</span>
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
              {/* On/off indicator pill */}
              <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${effectiveOn ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
                {effectiveOn ? 'On' : 'Off'}
              </span>
            </div>

            {/* Collapsed summary row */}
            {!isExpanded && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {activeEventLabels ? (
                  <span className="text-xs text-muted-foreground font-mono truncate">
                    {activeEventLabels}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground italic">No alerts</span>
                )}
                {firstRecipientDisplay && (
                  <span className="text-xs text-muted-foreground truncate">
                    {firstRecipientDisplay}
                    {extraRecipientCount > 0 && (
                      <span className="ml-1 text-[10px]">+{extraRecipientCount}</span>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Expand/collapse chevron */}
          {!selectionMode && (
            <button
              type="button"
              className="p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex-shrink-0 mt-0.5"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded((prev) => !prev);
              }}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>

        {/* Expanded content */}
        {isExpanded && !selectionMode && (
          <div className="mt-3 space-y-3 border-t border-border/40 pt-3" onClick={(e) => e.stopPropagation()}>
            {/* Alert type badges */}
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Alert Types</p>
              <div className="flex flex-wrap gap-1.5">
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
                            ? 'Enable notifications first'
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
            </div>

            {/* Extra recipients */}
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">Extra Recipients</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {perRecipients.map((email, index) => (
                  <Badge
                    key={index}
                    variant="secondary"
                    className="text-xs px-2 py-0.5 gap-1 cursor-pointer hover:bg-destructive/20 hover:text-destructive transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isPending) return;
                      onPerCheckRecipients(check.id, perRecipients.filter((_, i) => i !== index));
                    }}
                    title={`Click to remove ${email}`}
                  >
                    {email.length > 20 ? `${email.slice(0, 17)}...` : email}
                    <X className="w-3 h-3 ml-0.5" />
                  </Badge>
                ))}

                {pro ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Badge
                        variant="outline"
                        className={`text-xs px-2 py-0.5 cursor-pointer hover:bg-muted transition-colors ${isPending ? 'opacity-40 cursor-not-allowed' : ''}`}
                        title="Add additional recipient for this check"
                        onClick={(e) => e.stopPropagation()}
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
                            onClick={(e) => {
                              e.stopPropagation();
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
                  <Link to="/billing" title="Upgrade to Pro to add extra recipients">
                    <Badge
                      variant="outline"
                      className="text-xs px-2 py-0.5 cursor-pointer hover:bg-muted transition-colors text-muted-foreground"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add <span className="text-[10px] ml-1 text-amber-300/95">Pro</span>
                    </Badge>
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default EmailCheckCard;
