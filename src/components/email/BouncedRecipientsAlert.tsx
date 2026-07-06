import { useCallback, useEffect, useState } from 'react';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription, Button } from '../ui';
import { toast } from 'sonner';

const functions = getFunctions();
const getEmailSuppressionsFn = httpsCallable(functions, 'getEmailSuppressions');
const resumeSuppressedEmailFn = httpsCallable(functions, 'resumeSuppressedEmail');

interface Suppression {
  email: string;
  permanent: boolean;
  suppressedUntil: number | null;
  lastBounceKind: 'permanent' | 'transient' | 'complaint';
  lastBounceAt: number;
  lastReason: string | null;
  totalBounces: number;
}

const pauseLabel = (s: Suppression): string => {
  if (s.permanent) {
    return s.lastBounceKind === 'complaint'
      ? 'Marked our email as spam — paused until you resume it.'
      : 'Hard-bounced (address may not exist) — paused until you resume it.';
  }
  if (s.suppressedUntil) {
    return `Bouncing repeatedly — paused until ${new Date(s.suppressedUntil).toLocaleString()}.`;
  }
  return 'Bouncing repeatedly — temporarily paused.';
};

/**
 * Warns when configured alert recipients are being suppressed because their
 * mailbox bounces (fed by the Resend bounce webhook). Renders nothing when
 * every recipient is deliverable.
 */
export function BouncedRecipientsAlert() {
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getEmailSuppressionsFn();
      const data = (result.data as { data?: Suppression[] })?.data;
      setSuppressions(Array.isArray(data) ? data : []);
    } catch {
      // Non-critical — the banner just stays hidden.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleResume = useCallback(async (email: string) => {
    setResuming(email);
    try {
      await resumeSuppressedEmailFn({ email });
      toast.success('Email delivery resumed', {
        description: `Alerts to ${email} will be sent again. If it keeps bouncing it will pause again.`,
        duration: 4000,
      });
      setSuppressions((prev) => prev.filter((s) => s.email !== email));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to resume delivery';
      toast.error('Failed to resume delivery', { description: msg, duration: 4000 });
    } finally {
      setResuming(null);
    }
  }, []);

  if (suppressions.length === 0) return null;

  return (
    <Alert variant="destructive" className="mb-4 border-destructive/30 bg-destructive/10">
      <AlertTriangle />
      <AlertTitle>
        {suppressions.length === 1
          ? 'Email alerts to one of your recipients are paused'
          : `Email alerts to ${suppressions.length} of your recipients are paused`}
      </AlertTitle>
      <AlertDescription>
        <p>
          The recipient{suppressions.length === 1 ? "'s" : "s'"} mail server rejected our alert
          emails, so delivery is paused to protect deliverability. Fix or remove the address, then
          resume delivery.
        </p>
        <div className="mt-1 w-full space-y-2">
          {suppressions.map((s) => (
            <div
              key={s.email}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-destructive/20 bg-card px-3 py-2"
            >
              <span className="font-medium text-foreground break-all">{s.email}</span>
              <span className="text-xs text-muted-foreground flex-1 min-w-40">{pauseLabel(s)}</span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={resuming === s.email}
                onClick={() => void handleResume(s.email)}
              >
                {resuming === s.email ? 'Resuming…' : 'Resume delivery'}
              </Button>
            </div>
          ))}
        </div>
      </AlertDescription>
    </Alert>
  );
}
