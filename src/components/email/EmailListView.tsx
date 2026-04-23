import { memo } from 'react';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  Checkbox,
} from '../ui';
import { Users } from 'lucide-react';
import type { WebhookEvent } from '../../api/types';
import type { Website } from '../../types';
import type { NotificationSettings } from '../../hooks/useNotificationSettings';
import EmailCheckRow from './EmailCheckRow';

// ---------------------------------------------------------------------------
// EmailListView — flat list table view
// ---------------------------------------------------------------------------

export interface EmailListViewProps {
  checks: Website[];
  settings: NotificationSettings | null;
  checkFilterMode: 'all' | 'include';
  defaultEvents: WebhookEvent[];
  selectedChecks: Set<string>;
  pendingCheckUpdates: Set<string>;
  onToggle: (checkId: string, value: boolean) => void;
  onEventsChange: (checkId: string, events: WebhookEvent[]) => void;
  onSelect: (checkId: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  recipientInputs: Record<string, string>;
  onRecipientInputChange: (checkId: string, value: string) => void;
  onPerCheckRecipients: (checkId: string, recipients: string[]) => void;
  recipients: string[];
  pro: boolean;
  isMobile: boolean;
  getFolderColor?: (folder?: string | null) => string | undefined;
}

const EmailListView = memo(function EmailListView({
  checks,
  settings,
  checkFilterMode,
  defaultEvents,
  selectedChecks,
  pendingCheckUpdates,
  onToggle,
  onEventsChange,
  onSelect,
  onSelectAll,
  recipientInputs,
  onRecipientInputChange,
  onPerCheckRecipients,
  recipients,
  pro,
  isMobile,
  getFolderColor,
}: EmailListViewProps) {
  const allSelected = checks.length > 0 && selectedChecks.size === checks.length;

  return (
    <Table style={{ tableLayout: 'fixed' }}>
      <TableHeader className="bg-muted border-b">
        <TableRow>
          {!isMobile && (
            <TableHead className="px-4 py-4 text-left w-12">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(checked) => onSelectAll(!!checked)}
                className="cursor-pointer"
              />
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
        {checks.map((check) => {
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
              showFolder={true}
              isSelected={selectedChecks.has(check.id)}
              isPending={pendingCheckUpdates.has(check.id)}
              onToggle={onToggle}
              onEventsChange={onEventsChange}
              onSelect={onSelect}
              recipientInput={recipientInputs[check.id] || ''}
              onRecipientInputChange={onRecipientInputChange}
              onPerCheckRecipients={onPerCheckRecipients}
              recipients={recipients}
              pro={pro}
              isMobile={isMobile}
              folderEntry={fe}
              autoIncluded={auto}
              folderColor={getFolderColor?.(check.folder)}
            />
          );
        })}
      </TableBody>
    </Table>
  );
});

export default EmailListView;
