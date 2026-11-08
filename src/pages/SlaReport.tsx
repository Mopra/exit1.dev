import * as React from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Gauge, Loader2, Lock, Pencil, RefreshCw, Send, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/ui';
import ConfirmationModal from '@/components/ui/ConfirmationModal';
import { PageContainer, PageHeader } from '@/components/layout';
import { apiClient } from '@/api/client';
import { useAccount } from '@/AccountProvider';
import { usePlan } from '@/hooks/usePlan';
import { useSlaPeriod, useSlaReport } from '@/hooks/useSlaReports';
import { SlaReportSheet } from '@/components/sla/SlaReportSheet';
import { SlaPeriodView } from '@/components/sla/SlaPeriodView';
import { currentPeriod, formatTarget, isValidPeriod, periodLabel, recentPeriods } from '@/lib/sla';
import type { SlaReport as SlaReportDoc } from '@/types';

const cardClass = 'bg-card border-0 shadow-lg';
const CURRENT_WAIT_MS = 90_000;

export default function SlaReport() {
  const { reportId } = useParams<{ reportId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const account = useAccount();
  const { slaReporting } = usePlan();
  const report = useSlaReport(reportId);

  const tz = report?.timezone ?? 'UTC';
  const current = React.useMemo(() => currentPeriod(Date.now(), tz), [tz]);
  const periods = React.useMemo(() => recentPeriods(Date.now(), tz), [tz]);
  const requested = searchParams.get('period');
  const period = isValidPeriod(requested) && requested <= current ? requested : current;
  const options = periods.includes(period) ? periods : [period, ...periods];

  const [nonce, setNonce] = React.useState(0);
  const doc = useSlaPeriod(report ? report.id : undefined, report ? period : null, nonce);
  const stale = !!doc && !!report && doc.timezone !== report.timezone;
  const [computing, setComputing] = React.useState(false);
  const [computeError, setComputeError] = React.useState<string | null>(null);
  const attempted = React.useRef(new Set<string>());

  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const compute = React.useCallback(async (r: SlaReportDoc, p: string) => {
    setComputing(true);
    setComputeError(null);
    const res = await apiClient.refreshSlaReport(r.id, p);
    setComputing(false);
    if (!res.success) setComputeError(res.error ?? 'Could not compute this month.');
    else setNonce((n) => n + 1);
  }, []);

  // A month with no doc, or one computed in an old time zone, is computed on
  // demand (rate-limited server side). Right after a save the server is
  // already computing the current month, so wait for it a little first.
  const needsCompute = !!report && (doc === null || stale);
  React.useEffect(() => {
    if (!needsCompute || !report || !slaReporting) return;
    const key = `${report.id}/${period}/${report.timezone}`;
    if (attempted.current.has(key)) return;
    if (period === current && Date.now() - (report.updatedAt ?? 0) < CURRENT_WAIT_MS) {
      const t = setTimeout(() => setNonce((n) => n + 1), 5000);
      return () => clearTimeout(t);
    }
    attempted.current.add(key);
    void compute(report, period);
  }, [needsCompute, report, period, current, slaReporting, compute, nonce]);

  const setPeriod = (p: string) => {
    setComputeError(null);
    const next = new URLSearchParams(searchParams);
    if (p === current) next.delete('period');
    else next.set('period', p);
    setSearchParams(next, { replace: true });
  };

  const sendTest = async () => {
    if (!report) return;
    setSending(true);
    const res = await apiClient.sendSlaReportTest(report.id, period);
    setSending(false);
    if (res.success) toast.success(res.data?.sentTo ? `Test email sent to ${res.data.sentTo}` : 'Test email sent to your address');
    else toast.error(res.error ?? 'Could not send the test email');
  };

  const remove = async () => {
    if (!report) return;
    setConfirmDelete(false);
    const res = await apiClient.deleteSlaReport(report.id);
    if (res.success) {
      toast.success('SLA report deleted');
      navigate('/sla');
    } else {
      toast.error(res.error ?? 'Could not delete the report');
    }
  };

  if (report === null) {
    return (
      <PageContainer>
        <PageHeader title="SLA report" icon={Gauge} />
        <div className="w-full mx-auto max-w-7xl px-2 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8">
          <Card className={cardClass}>
            <CardContent className="p-6 sm:p-8 space-y-4">
              <p className="text-sm text-muted-foreground">This report does not exist, or you don't have access to it.</p>
              <Button asChild size="sm" variant="outline">
                <Link to="/sla">All SLA reports</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    );
  }

  const canWrite = account.canWrite;
  const view = doc && !stale ? doc : null;

  const actions = report ? (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={period} onValueChange={setPeriod}>
        <SelectTrigger size="sm" className="h-8 w-[170px] cursor-pointer" aria-label="Month">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {options.map((p) => (
            <SelectItem key={p} value={p} className="cursor-pointer">
              {periodLabel(p)}{p === current ? ' (so far)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {slaReporting && (
        <Button size="sm" variant="outline" className="h-8 gap-2 cursor-pointer" onClick={sendTest} disabled={sending || !view}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          <span className="hidden sm:inline">Send test email</span>
          <span className="sm:hidden">Test</span>
        </Button>
      )}
      {canWrite && slaReporting && (
        <Button size="sm" variant="outline" className="h-8 gap-2 cursor-pointer" onClick={() => setEditOpen(true)}>
          <Pencil className="size-4" />
          Edit
        </Button>
      )}
      {canWrite && (
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 cursor-pointer text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
          aria-label="Delete report"
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  ) : null;

  return (
    <PageContainer>
      <PageHeader
        title={report?.name ?? 'SLA report'}
        description={report ? `Target ${formatTarget(report.targetPercent)} · All times in ${report.timezone}` : undefined}
        icon={Gauge}
        actions={actions}
      />

      <div className="flex-1 w-full">
        <div className="w-full mx-auto max-w-7xl px-2 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 space-y-6">
          <Link to="/sla" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" />
            All SLA reports
          </Link>

          {!slaReporting && !account.isMember && (
            <Card className={cardClass}>
              <CardContent className="p-4 sm:p-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3 min-w-0">
                  <Lock className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Read-only. SLA reporting is part of Pro, so this report no longer updates and no emails go out.
                  </p>
                </div>
                <Button asChild size="sm" className="shrink-0 cursor-pointer">
                  <Link to="/billing?plan=pro">Upgrade to Pro</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {report === undefined || doc === undefined ? (
            <LoadingBody />
          ) : !view ? (
            <Card className={cardClass}>
              <CardContent className="p-6 sm:p-8">
                {computing || (needsCompute && slaReporting && !computeError) ? (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin shrink-0" />
                    Computing {periodLabel(period)}{stale ? ` in ${report.timezone}` : ''}. This takes a few seconds.
                  </div>
                ) : computeError ? (
                  <div className="space-y-3">
                    <p className="text-sm text-destructive">{computeError}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2 cursor-pointer"
                      onClick={() => void compute(report, period)}
                    >
                      <RefreshCw className="size-4" />
                      Try again
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No numbers for {periodLabel(period)}.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <SlaPeriodView report={report} period={view} isCurrent={period === current} />
          )}
        </div>
      </div>

      {report && canWrite && slaReporting && (
        <SlaReportSheet open={editOpen} onOpenChange={setEditOpen} report={report} />
      )}
      <ConfirmationModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title="Delete this SLA report?"
        message="Its monthly numbers and the email schedule are removed. Your checks and their history are not touched."
        confirmText="Delete report"
        variant="destructive"
      />
    </PageContainer>
  );
}

function LoadingBody() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
