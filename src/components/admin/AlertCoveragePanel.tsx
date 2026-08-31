import { useCallback, useEffect, useState } from 'react';
import { BellOff, Loader2, RefreshCw, Send, Activity } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/api/client';
import { Button } from '@/components/ui/Button';
import GlowCard from '@/components/ui/glow-card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { AlertCoverageReport } from '@/api/types';

/**
 * Admin view of the one number that decides whether the product works: how many
 * users can actually be told when something breaks.
 *
 * Exists because this was measured by hand against production once and then had no
 * home. A fix to the onboarding alert step should move these numbers, and without
 * somewhere to read them the only way to know is to re-derive them by hand.
 */

const pct = (part: number, whole: number) =>
  whole === 0 ? '0%' : `${((100 * part) / whole).toFixed(1)}%`;

function Stat({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'good' | 'bad';
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={
          tone === 'bad'
            ? 'text-2xl font-semibold tabular-nums text-destructive'
            : tone === 'good'
              ? 'text-2xl font-semibold tabular-nums text-success'
              : 'text-2xl font-semibold tabular-nums text-foreground'
        }
      >
        {value}
      </span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </div>
  );
}

export function AlertCoveragePanel() {
  const [report, setReport] = useState<AlertCoverageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [confirmSend, setConfirmSend] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiClient.getAlertCoverageReport();
    if (res.success && res.data) setReport(res.data);
    else toast.error('Could not load alert coverage', { description: res.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Always dry-run first. The count it reports back is what the confirm dialog
  // quotes, so nobody is asked to approve a send without knowing its size.
  const previewSend = async () => {
    setNotifying(true);
    const res = await apiClient.notifyUsersWithoutAlertChannel({ dryRun: true });
    setNotifying(false);
    if (!res.success || !res.data) {
      toast.error('Dry run failed', { description: res.error });
      return;
    }
    const d = res.data;
    if (d.sent === 0) {
      toast.success('Nothing to send', {
        description: `${d.candidates} uncovered, all skipped: ${d.skippedAlreadyNotified} already notified, ${d.skippedTooNew} too new, ${d.skippedSuppressed} suppressed, ${d.skippedNoEmail} without an email.`,
      });
      return;
    }
    setConfirmSend(d.sent);
  };

  const reallySend = async () => {
    setConfirmSend(null);
    setNotifying(true);
    const res = await apiClient.notifyUsersWithoutAlertChannel({ dryRun: false });
    setNotifying(false);
    if (!res.success || !res.data) {
      toast.error('Send failed', { description: res.error });
      return;
    }
    const d = res.data;
    toast.success(`Sent ${d.sent} notice${d.sent === 1 ? '' : 's'}`, {
      description: d.failed > 0 ? `${d.failed} failed and will retry on the next run.` : undefined,
    });
    void load();
  };

  const runSweep = async (dryRun: boolean) => {
    setSweeping(true);
    const res = await apiClient.runLifecycleSweep({ dryRun });
    setSweeping(false);
    if (!res.success || !res.data) {
      toast.error('Sweep failed', { description: res.error });
      return;
    }
    const d = res.data;
    toast.success(dryRun ? 'Sweep dry run' : 'Sweep complete', {
      description: `${d.usersExamined} examined, ${d.firstIncidentEvents} first-incident, ${d.noChannelEvents} no-channel, ${d.propertiesSynced} properties${d.errors ? `, ${d.errors} errors` : ''}.`,
    });
  };

  const uncovered = report?.usersUncovered ?? 0;

  return (
    <GlowCard className="p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BellOff className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Alert coverage</h3>
            <p className="text-xs text-muted-foreground">
              Who would genuinely receive a down email, resolved with the real
              delivery gate.
            </p>
          </div>
        </div>
        <Button
          onClick={() => void load()}
          variant="outline"
          size="sm"
          disabled={loading}
          className="cursor-pointer"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {report ? (
        <>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Users with live checks"
              value={report.usersWithEnabledChecks.toLocaleString()}
            />
            <Stat
              label="Covered"
              value={pct(report.usersCovered, report.usersWithEnabledChecks)}
              detail={`${report.usersCovered.toLocaleString()} users`}
              tone="good"
            />
            <Stat
              label="Cannot be alerted"
              value={pct(uncovered, report.usersWithEnabledChecks)}
              detail={`${uncovered.toLocaleString()} users`}
              tone={uncovered > 0 ? 'bad' : 'good'}
            />
            <Stat
              label="Checks covered"
              value={pct(report.emailCoveredChecks, report.enabledChecks)}
              detail={`${report.emailCoveredChecks.toLocaleString()} of ${report.enabledChecks.toLocaleString()}`}
            />
          </div>

          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3 border-t border-border/60 pt-3">
            {([
              ['Onboarded, paying', report.byCohort.onboardedPaid],
              ['Onboarded, free', report.byCohort.onboardedFree],
              ['Pre-onboarding', report.byCohort.preOnboarding],
            ] as const).map(([label, bucket]) => (
              <div key={label} className="flex items-baseline justify-between gap-2">
                <span>{label}</span>
                <span className="tabular-nums text-foreground">
                  {pct(bucket.covered, bucket.users)}
                  <span className="text-muted-foreground"> ({bucket.covered}/{bucket.users})</span>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {loading ? 'Loading coverage…' : 'No coverage data.'}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <Button
          onClick={() => void previewSend()}
          variant="outline"
          size="sm"
          disabled={notifying}
          className="cursor-pointer"
        >
          {notifying ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Send className="h-4 w-4 mr-2" />
          )}
          Notify uncovered users
        </Button>
        <Button
          onClick={() => void runSweep(true)}
          variant="ghost"
          size="sm"
          disabled={sweeping}
          className="cursor-pointer text-muted-foreground"
        >
          {sweeping ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Activity className="h-4 w-4 mr-2" />
          )}
          Lifecycle sweep (dry run)
        </Button>
        <Button
          onClick={() => void runSweep(false)}
          variant="ghost"
          size="sm"
          disabled={sweeping}
          className="cursor-pointer text-muted-foreground"
        >
          Run sweep for real
        </Button>
      </div>

      <AlertDialog open={confirmSend !== null} onOpenChange={(o) => !o && setConfirmSend(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Email {confirmSend} user{confirmSend === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Each one owns a live check that cannot notify anybody. They get one
              notice with a link to the Emails page, and are stamped so they can
              never receive it twice. Accounts under 24 hours old and suppressed
              addresses are already excluded. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void reallySend()} className="cursor-pointer">
              Send {confirmSend}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </GlowCard>
  );
}
