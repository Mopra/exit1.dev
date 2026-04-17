import { memo, useState, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Plus, X, Settings2 } from 'lucide-react';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  Badge,
  Input,
  Button,
  Label,
  Switch,
  Popover,
  PopoverTrigger,
  PopoverContent,
  glassClasses,
} from '../ui';
import { Users } from 'lucide-react';
import { FolderGroupHeaderRow } from '../check/FolderGroupHeaderRow';
import { toast } from 'sonner';
import type { WebhookEvent } from '../../api/types';
import type { Website } from '../../types';
import type { NotificationSettings } from '../../hooks/useNotificationSettings';
import {
  ALL_NOTIFICATION_EVENTS,
  DEFAULT_NOTIFICATION_EVENTS,
} from '../../lib/notification-shared';
import EmailCheckRow from './EmailCheckRow';

// ---------------------------------------------------------------------------
// EmailFolderView — folder-grouped table view
// ---------------------------------------------------------------------------

export interface FolderGroup {
  key: string;
  label: string;
  checks: Website[];
}

export interface EmailFolderViewProps {
  groups: FolderGroup[];
  settings: NotificationSettings | null;
  checkFilterMode: 'all' | 'include';
  defaultEvents: WebhookEvent[];
  selectedChecks: Set<string>;
  pendingCheckUpdates: Set<string>;
  collapsedSet: Set<string>;
  onToggleFolderCollapsed: (folderKey: string) => void;
  getFolderColor: (folder?: string | null) => string | undefined;
  onToggle: (checkId: string, value: boolean) => void;
  onEventsChange: (checkId: string, events: WebhookEvent[]) => void;
  onSelect: (checkId: string, selected: boolean) => void;
  onSelectFolder: (folderKey: string) => void;
  recipientInputs: Record<string, string>;
  onRecipientInputChange: (checkId: string, value: string) => void;
  onPerCheckRecipients: (checkId: string, recipients: string[]) => void;
  onTogglePerFolder: (folderPath: string, enabled: boolean) => void;
  onPerFolderEvents: (folderPath: string, events: WebhookEvent[]) => void;
  onPerFolderRecipients: (folderPath: string, recipients: string[]) => void;
  recipients: string[];
  nano: boolean;
  isMobile: boolean;
}

const EmailFolderView = memo(function EmailFolderView({
  groups,
  settings,
  checkFilterMode,
  defaultEvents,
  selectedChecks,
  pendingCheckUpdates,
  collapsedSet,
  onToggleFolderCollapsed,
  getFolderColor,
  onToggle,
  onEventsChange,
  onSelect,
  onSelectFolder,
  recipientInputs,
  onRecipientInputChange,
  onPerCheckRecipients,
  onTogglePerFolder,
  onPerFolderEvents,
  onPerFolderRecipients,
  recipients,
  nano,
  isMobile,
}: EmailFolderViewProps) {
  // Local state for folder-level recipient input fields
  const [folderRecipientInputs, setFolderRecipientInputs] = useState<Record<string, string>>({});

  return (
    <Table style={{ tableLayout: 'fixed' }}>
      <TableHeader className="bg-muted border-b">
        <TableRow>
          {!isMobile && (
            <TableHead className="px-4 py-4 text-left w-12">
              {/* Folder view has per-folder selection via FolderGroupHeaderRow */}
            </TableHead>
          )}
          <TableHead className="px-4 py-4 text-left w-80">
            <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Check</div>
          </TableHead>
          <TableHead className="px-4 py-4 text-left">
            <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Alert Types</div>
          </TableHead>
          <TableHead className="px-4 py-4 text-left w-72">
            <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground flex items-center gap-1">
              <Users className="w-3 h-3" />
              Extra Recipients
            </div>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-border">
        {groups.map((group) => {
          const groupColor = group.key === '__unsorted__' ? undefined : getFolderColor(group.key);
          const folderPath = group.key === '__unsorted__' ? null : group.key;
          const folderSettings = folderPath ? settings?.perFolder?.[folderPath] : undefined;
          const isFolderEnabled = folderSettings?.enabled === true;
          const folderEvents =
            folderSettings?.events && folderSettings.events.length > 0
              ? folderSettings.events
              : isFolderEnabled
              ? DEFAULT_NOTIFICATION_EVENTS
              : [];
          const folderRecipients = folderSettings?.recipients || [];
          const folderRecipientKey = `folder:${folderPath}`;
          const folderRecipientInput = folderRecipientInputs[folderRecipientKey] || '';

          // Determine folder selection state
          const folderCheckIds = group.checks.map((c) => c.id);
          const selectedInFolder = folderCheckIds.filter((id) => selectedChecks.has(id)).length;
          const folderSelected = selectedInFolder === folderCheckIds.length && folderCheckIds.length > 0;
          const folderIndeterminate = selectedInFolder > 0 && selectedInFolder < folderCheckIds.length;

          return (
            <Fragment key={group.key}>
              <FolderGroupHeaderRow
                colSpan={isMobile ? 3 : 4}
                label={group.label}
                count={group.checks.length}
                isCollapsed={collapsedSet.has(group.key)}
                onToggle={() => onToggleFolderCollapsed(group.key)}
                color={groupColor}
                selected={folderSelected}
                indeterminate={folderIndeterminate}
                onSelect={!isMobile ? () => onSelectFolder(group.key) : undefined}
                actions={
                  folderPath ? (
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted-foreground">
                          {isFolderEnabled ? 'Folder alerts on' : 'Folder alerts off'}
                        </span>
                        <Switch
                          checked={isFolderEnabled}
                          onCheckedChange={(checked) => onTogglePerFolder(folderPath, checked)}
                          className="scale-75"
                        />
                      </div>
                      {isFolderEnabled && (
                        <>
                          {folderEvents.length > 0 && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              {folderEvents.length} alert{folderEvents.length !== 1 ? 's' : ''}
                            </Badge>
                          )}
                          {folderRecipients.length > 0 && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              {folderRecipients.length} extra
                            </Badge>
                          )}
                          <Popover>
                            <PopoverTrigger asChild>
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 cursor-pointer hover:bg-muted transition-colors gap-1"
                                title="Configure folder alerts"
                              >
                                <Settings2 className="w-2.5 h-2.5" />
                                Configure
                              </Badge>
                            </PopoverTrigger>
                            <PopoverContent className={`w-80 p-3 ${glassClasses}`} align="end">
                              <div className="space-y-3">
                                <div>
                                  <Label className="text-xs font-medium">Alert types</Label>
                                  <div className="flex flex-wrap gap-1 mt-1.5">
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
                                            const current =
                                              folderSettings?.events && folderSettings.events.length > 0
                                                ? folderSettings.events
                                                : [...DEFAULT_NOTIFICATION_EVENTS];
                                            const next = new Set(current);
                                            if (next.has(e.value)) {
                                              next.delete(e.value);
                                            } else {
                                              next.add(e.value);
                                            }
                                            onPerFolderEvents(folderPath, Array.from(next) as WebhookEvent[]);
                                          }}
                                        >
                                          <Icon className="w-2.5 h-2.5 mr-0.5" />
                                          {e.label}
                                        </Badge>
                                      );
                                    })}
                                  </div>
                                </div>
                                <div>
                                  <Label className="text-xs font-medium">Extra recipients</Label>
                                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                                    {folderRecipients.map((email, index) => (
                                      <Badge
                                        key={index}
                                        variant="secondary"
                                        className="text-[10px] px-1.5 py-0 gap-0.5 cursor-pointer hover:bg-destructive/20 hover:text-destructive transition-colors"
                                        onClick={(ev) => {
                                          ev.stopPropagation();
                                          onPerFolderRecipients(
                                            folderPath,
                                            folderRecipients.filter((_, i) => i !== index),
                                          );
                                        }}
                                        title={`Click to remove ${email}`}
                                      >
                                        {email.length > 22 ? `${email.slice(0, 20)}...` : email}
                                        <X className="w-2.5 h-2.5" />
                                      </Badge>
                                    ))}
                                  </div>
                                  {nano ? (
                                    <div className="flex gap-2 mt-2">
                                      <Input
                                        type="email"
                                        placeholder="client@example.com"
                                        value={folderRecipientInput}
                                        onChange={(e) =>
                                          setFolderRecipientInputs((prev) => ({
                                            ...prev,
                                            [folderRecipientKey]: e.target.value,
                                          }))
                                        }
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' && folderRecipientInput.trim()) {
                                            e.preventDefault();
                                            const emailVal = folderRecipientInput.trim().toLowerCase();
                                            if (folderRecipients.some((r) => r.toLowerCase() === emailVal)) {
                                              toast.info('Already added for this folder', { duration: 2000 });
                                              return;
                                            }
                                            onPerFolderRecipients(folderPath, [
                                              ...folderRecipients,
                                              folderRecipientInput.trim(),
                                            ]);
                                            setFolderRecipientInputs((prev) => ({
                                              ...prev,
                                              [folderRecipientKey]: '',
                                            }));
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
                                          const emailVal = folderRecipientInput.trim().toLowerCase();
                                          if (folderRecipients.some((r) => r.toLowerCase() === emailVal)) {
                                            toast.info('Already added for this folder', { duration: 2000 });
                                            return;
                                          }
                                          onPerFolderRecipients(folderPath, [
                                            ...folderRecipients,
                                            folderRecipientInput.trim(),
                                          ]);
                                          setFolderRecipientInputs((prev) => ({
                                            ...prev,
                                            [folderRecipientKey]: '',
                                          }));
                                        }}
                                      >
                                        Add
                                      </Button>
                                    </div>
                                  ) : (
                                    <Link to="/billing" className="mt-2 inline-block" title="Upgrade to Nano to add folder recipients">
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
                              </div>
                            </PopoverContent>
                          </Popover>
                        </>
                      )}
                    </div>
                  ) : undefined
                }
              />
              {!collapsedSet.has(group.key) &&
                group.checks.map((check) => {
                  const per = settings?.perCheck?.[check.id];
                  const fp = (check.folder ?? '').trim() || null;
                  const fe = fp && !per ? settings?.perFolder?.[fp] : undefined;
                  const auto = checkFilterMode === 'all' && per?.enabled !== false && !per && !fe;
                  return (
                    <EmailCheckRow
                      key={check.id}
                      check={check}
                      perCheck={per}
                      checkFilterMode={checkFilterMode}
                      defaultEvents={defaultEvents}
                      showFolder={false}
                      isSelected={selectedChecks.has(check.id)}
                      isPending={pendingCheckUpdates.has(check.id)}
                      onToggle={onToggle}
                      onEventsChange={onEventsChange}
                      onSelect={onSelect}
                      recipientInput={recipientInputs[check.id] || ''}
                      onRecipientInputChange={onRecipientInputChange}
                      onPerCheckRecipients={onPerCheckRecipients}
                      recipients={recipients}
                      nano={nano}
                      isMobile={isMobile}
                      folderEntry={fe}
                      autoIncluded={auto}
                      folderColor={getFolderColor(check.folder)}
                    />
                  );
                })}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
});

export default EmailFolderView;
