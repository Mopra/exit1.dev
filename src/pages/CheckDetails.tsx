import React, { useEffect, useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Link, useParams } from 'react-router-dom';
import { Activity, ArrowLeft, ExternalLink } from 'lucide-react';
import { PageContainer, PageHeader } from '../components/layout';
import { Button } from '../components/ui';
import { useChecks } from '../hooks/useChecks';
import { useCheckStream } from '../hooks/useCheckStream';
import { LiveChart } from '../components/check/LiveChart';
import type { Website } from '../types';

const WINDOW_MS = 60 * 60 * 1000; // v1: fixed 1-hour window

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

  // Narrow the regions[] array — which gets a fresh reference on every
  // throttled emit (≈4×/sec under load) — down to just our region's
  // state. Without this projection the subscribe effect below re-fires on
  // every emit and we'd be sending subscribe_history a few times per
  // second while the chart is open.
  const regionState = useMemo(() => {
    if (!check?.checkRegion) return 'idle';
    return regions.find((r) => r.region === check.checkRegion)?.state ?? 'idle';
  }, [check?.checkRegion, regions]);

  // Subscribe when (and only when) the region transitions to 'live'.
  // String-valued dep means a no-op emit doesn't re-fire the effect.
  useEffect(() => {
    if (!check?.id || !check.checkRegion) return;
    if (regionState !== 'live') return;
    subscribeHistory(check.id, check.checkRegion, WINDOW_MS);
  }, [check?.id, check?.checkRegion, regionState, subscribeHistory]);

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
                <div className="text-sm text-muted-foreground">Last hour, live</div>
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
              <LiveChart points={points} windowMs={WINDOW_MS} />
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
};

export default CheckDetails;
