import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Gauge, Lock, Mail, Plus } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui';
import EmptyState from '@/components/ui/EmptyState';
import { PageContainer, PageHeader } from '@/components/layout';
import { useAccount } from '@/AccountProvider';
import { usePlan } from '@/hooks/usePlan';
import { useSlaPeriod, useSlaReports } from '@/hooks/useSlaReports';
import { SlaReportSheet } from '@/components/sla/SlaReportSheet';
import { InsufficientDataPill, SlaStatusPill } from '@/components/sla/SlaStatusPill';
import { ErrorBudgetBar } from '@/components/sla/ErrorBudgetBar';
import {
  currentPeriod,
  formatAvailability,
  formatDayInZone,
  formatTarget,
  formatTimeInZone,
  periodLabel,
} from '@/lib/sla';
import { cn } from '@/lib/utils';
import type { SlaReport } from '@/types';

const cardClass = 'bg-card border-0 shadow-lg';

export default function Sla() {
  const account = useAccount();
  const navigate = useNavigate();
  const { slaReporting, maxSlaReports } = usePlan();
  const { reports, loading, error } = useSlaReports(account.accountId);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const canCreate = slaReporting && account.canWrite;
  const atCap = reports.length >= maxSlaReports;

  const newButton = canCreate ? (
    atCap ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>
            <Button size="sm" className="gap-2" disabled>
              <Plus className="size-4" />
              New SLA report
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>You have {maxSlaReports} reports, the most an account can keep. Delete one to add another.</TooltipContent>
      </Tooltip>
    ) : (
      <Button size="sm" className="gap-2 cursor-pointer" onClick={() => setSheetOpen(true)}>
        <Plus className="size-4" />
        New SLA report
      </Button>
    )
  ) : null;

  return (
    <PageContainer>
      <PageHeader
        title="SLA reports"
        description="Monthly availability against the targets you promise clients"
        icon={Gauge}
        actions={newButton}
      />

      <div className="flex-1 w-full">
        <div className="w-full mx-auto max-w-7xl px-2 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 space-y-6">
          {!slaReporting && !account.isMember && <UpgradeCard hasReports={reports.length > 0} />}

          {error && (
            <Card className={cardClass}>
              <CardContent className="p-4 sm:p-6 text-sm text-destructive">{error}</CardContent>
            </Card>
          )}

          {loading ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-56 rounded-xl" />
              ))}
            </div>
          ) : reports.length === 0 ? (
            slaReporting && !error ? (
              <EmptyState
                icon={Gauge}
                title="No SLA reports yet"
                description="Group the checks behind a client contract, set the target you promised, and get a branded report on the 1st of every month."
                action={canCreate ? { label: 'New SLA report', onClick: () => setSheetOpen(true), icon: Plus } : undefined}
              />
            ) : null
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {reports.map((r) => (
                <ReportCard key={r.id} report={r} readOnly={!slaReporting} />
              ))}
            </div>
          )}
        </div>
      </div>

      {canCreate && (
        <SlaReportSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          report={null}
          onSaved={(id) => id && navigate(`/sla/${id}`)}
        />
      )}
    </PageContainer>
  );
}

function UpgradeCard({ hasReports }: { hasReports: boolean }) {
  return (
    <Card className={cardClass}>
      <CardHeader className="p-4 sm:p-6 lg:p-8">
        <CardTitle className="text-xl">
          {hasReports ? 'Your SLA reports are read-only' : 'Prove you kept your promise'}
        </CardTitle>
        <CardDescription className="max-w-3xl">
          {hasReports
            ? 'SLA reporting is part of Pro. Your past reports stay here to read, but they no longer update and no monthly emails go out. Upgrade to switch them back on.'
            : 'On Pro, an SLA report tracks a set of checks against the availability you promised a client, like 99.9%. It shows the error budget left this month, every outage with exact times in your client\'s time zone, and sends a branded report on the 1st of each month. Maintenance and blocked probes are left out, the way contracts expect.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
        <Button asChild size="sm" className="cursor-pointer">
          <Link to="/billing?plan=pro">Upgrade to Pro</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ReportCard({ report, readOnly }: { report: SlaReport; readOnly: boolean }) {
  const tz = report.timezone;
  const period = React.useMemo(() => currentPeriod(Date.now(), tz), [tz]);
  const doc = useSlaPeriod(report.id, period);
  const stale = !!doc && doc.timezone !== tz;
  const o = doc && !stale ? doc.overall : null;

  const recipients = report.schedule?.recipients?.length ?? 0;
  const emailLine = report.schedule?.enabled && recipients > 0
    ? `Monthly email to ${recipients} ${recipients === 1 ? 'recipient' : 'recipients'}${report.nextSendAfter && !readOnly ? `, next on ${formatDayInZone(report.nextSendAfter, tz)}` : ''}`
    : 'No email';
  const checkCount = doc?.checks?.length;

  return (
    <Link
      to={`/sla/${report.id}`}
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className={cn(cardClass, 'h-full transition-colors group-hover:bg-accent/30')}>
        <CardContent className="p-5 sm:p-6 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold truncate">{report.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Target {formatTarget(report.targetPercent)} · {periodLabel(period)} so far
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {readOnly && <Lock className="size-3.5 text-muted-foreground" aria-label="Read-only" />}
              {o && <SlaStatusPill status={o.status} size="sm" />}
            </div>
          </div>

          <div className="flex items-end justify-between gap-4">
            {doc === undefined ? (
              <Skeleton className="h-10 w-40" />
            ) : o ? (
              <div className="min-w-0">
                <div
                  className={cn(
                    'font-mono text-3xl sm:text-4xl font-semibold tracking-tight tabular-nums',
                    o.availability === null && 'text-muted-foreground text-2xl sm:text-2xl',
                    o.status === 'breached' && 'text-destructive',
                  )}
                >
                  {formatAvailability(o.availability)}
                </div>
                {o.insufficientData && <InsufficientDataPill className="mt-2" />}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                {stale ? 'Recalculating in the new time zone. Open the report.' : 'Numbers appear after the next data run, within a few hours.'}
              </div>
            )}
          </div>

          {o && o.availability !== null && <ErrorBudgetBar used={o.budgetUsed} />}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {checkCount !== undefined
                ? `${checkCount} ${checkCount === 1 ? 'check' : 'checks'}`
                : scopeLabel(report)}
            </span>
            <span className="font-mono">{tz}</span>
            <span className="inline-flex items-center gap-1">
              <Mail className="size-3 shrink-0" />
              {emailLine}
            </span>
            {doc && !stale && <span>Data through {formatTimeInZone(doc.dataThrough, tz)}</span>}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function scopeLabel(r: SlaReport): string {
  const parts: string[] = [];
  if (r.checkIds?.length) parts.push(`${r.checkIds.length} ${r.checkIds.length === 1 ? 'check' : 'checks'}`);
  if (r.folderPaths?.length) parts.push(`${r.folderPaths.length} ${r.folderPaths.length === 1 ? 'folder' : 'folders'}`);
  return parts.join(', ') || 'No checks';
}
