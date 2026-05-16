import React, { useEffect, useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Link, useParams } from 'react-router-dom';
import { Activity, ArrowLeft, ExternalLink, FlaskConical } from 'lucide-react';
import { PageContainer, PageHeader } from '../components/layout';
import { Alert, AlertDescription, Button } from '../components/ui';
import { useChecks } from '../hooks/useChecks';
import { useCheckStream } from '../hooks/useCheckStream';
import { LiveChart } from '../components/check/LiveChart';
import type { Website } from '../types';

/**
 * Pick the chart window based on check cadence. The principle: fast
 * checks get a "recent activity" view; slow ones get a "trend" view.
 * Without tiering, a 1-min cadence on a fixed 1h window looks sparse
 * and a 15s cadence on the same 1h window scrolls so fast you can't
 * read it.
 */
function chartWindowMsFor(freqMinutes: number | undefined): number {
  if (freqMinutes == null) return 60 * 60 * 1000;     // unknown → 1h fallback
  if (freqMinutes < 1) return 60 * 1000;              // <1 min → 1 min
  if (freqMinutes < 5) return 30 * 60 * 1000;         // <5 min → 30 min
  if (freqMinutes < 30) return 4 * 60 * 60 * 1000;    // <30 min → 4 h
  return 24 * 60 * 60 * 1000;                         // ≥30 min → 24 h
}

function formatWindow(ms: number): string {
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60_000))} hour${ms > 60 * 60_000 ? 's' : ''}`;
  return `${Math.round(ms / (24 * 60 * 60_000))} day${ms > 24 * 60 * 60_000 ? 's' : ''}`;
}

const CheckDetails: React.FC = () => {
  const { userId } = useAuth();
  const { checkId = '' } = useParams<{ checkId: string }>();

  const { checks: firestoreChecks } = useChecks(userId ?? null, () => {});
  const {
    effectiveChecks,
    regions,
    historyByCheckId,
    subscribeHistory,
    unsubscribeHistory,
  } = useCheckStream(firestoreChecks);

  const check = useMemo<Website | undefined>(
    () => effectiveChecks.find((c) => c.id === checkId),
    [effectiveChecks, checkId],
  );

  const windowMs = useMemo(
    () => chartWindowMsFor(check?.checkFrequency),
    [check?.checkFrequency],
  );

  // Narrow the regions[] array — which gets a fresh reference on every
  // throttled emit (≈4×/sec under load) — down to just our region's
  // state. Without this projection the subscribe effect below re-fires on
  // every emit and we'd be sending subscribe_history a few times per
  // second while the chart is open.
  const regionState = useMemo(() => {
    if (!check?.checkRegion) return 'idle';
    return regions.find((r) => r.region === check.checkRegion)?.state ?? 'idle';
  }, [check?.checkRegion, regions]);

  // Subscribe when (and only when) the region transitions to 'live', or
  // when the desired window changes (e.g. user edited the check's
  // cadence in another tab). String-valued dep prevents emit-churn.
  useEffect(() => {
    if (!check?.id || !check.checkRegion) return;
    if (regionState !== 'live') return;
    subscribeHistory(check.id, check.checkRegion, windowMs);
  }, [check?.id, check?.checkRegion, regionState, windowMs, subscribeHistory]);

  // Drop the per-check buffer on unmount only — NOT on WS flap. During a
  // reconnect the overlay's last-known state is still trusted (hysteresis
  // window) and we don't want to wipe the chart the user is looking at.
  useEffect(() => {
    if (!check?.id) return;
    const id = check.id;
    return () => unsubscribeHistory(id);
  }, [check?.id, unsubscribeHistory]);

  const points = check ? historyByCheckId.get(check.id) ?? [] : [];

  return (
    <PageContainer>
      <PageHeader
        icon={Activity}
        title={check?.name ?? 'Check details'}
        description={check?.url}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/checks">
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Back</span>
              </Link>
            </Button>
            {check?.url && (
              <Button asChild variant="ghost" size="sm">
                <a href={check.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-4 h-4" />
                  <span className="hidden sm:inline">Open</span>
                </a>
              </Button>
            )}
          </>
        }
      />

      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 mb-4">
        <Alert className="border-primary/30 bg-primary/10 backdrop-blur-sm">
          <FlaskConical className="h-4 w-4 text-primary self-center !translate-y-0" />
          <AlertDescription className="text-sm text-foreground">
            Preview — this page is under active development.
          </AlertDescription>
        </Alert>
      </div>

      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8">
        {!check ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
            Check not found.
          </div>
        ) : (
          <div className="rounded-lg border bg-card p-4 sm:p-6">
            <div className="mb-4 flex items-end justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Response time
                </div>
                <div className="text-sm text-muted-foreground">Last {formatWindow(windowMs)}, live</div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Now
                </div>
                <div className="text-sm font-medium">
                  {typeof check.responseTime === 'number'
                    ? `${check.responseTime} ms`
                    : '—'}
                </div>
              </div>
            </div>
            <div className="h-[420px] w-full">
              <LiveChart points={points} windowMs={windowMs} />
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
};

export default CheckDetails;
