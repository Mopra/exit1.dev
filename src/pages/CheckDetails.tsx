import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Activity, ArrowLeft, ExternalLink } from 'lucide-react';
import { PageContainer, PageHeader } from '../components/layout';
import { Button, CheckSelect } from '../components/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/Select';
import { useChecks } from '../hooks/useChecks';
import { useCheckStream } from '../hooks/useCheckStream';
import { LiveChart } from '../components/check/LiveChart';
import { PhaseStackChart } from '../components/check/PhaseStackChart';
import { ChartNavigator } from '../components/check/ChartNavigator';
import { LiveProbeTable } from '../components/check/LiveProbeTable';
import { WsConnectionIndicator, WsFallbackBanner } from '../components/WsConnectionStatus';
import type { Website } from '../types';

const BUFFER_OPTIONS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

const DEFAULT_BUFFER_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_VISIBLE_WINDOW_MS = 60 * 1000; // 1 minute
const MIN_VISIBLE_WINDOW_MS = 10 * 1000; // 10s — anything tighter and the brush snaps closed

// Pick a default visible window for the given check cadence. Sub-minute
// cadences keep the tight 1-min "live ticker" feel; slower cadences scale
// up so the window holds roughly 20 probes and trends are readable.
function defaultVisibleWindowMs(cadenceMs: number): number {
  if (cadenceMs < 60_000) return DEFAULT_VISIBLE_WINDOW_MS;
  return cadenceMs * 20;
}

// Pick the smallest BUFFER_OPTIONS preset that gives at least 3× headroom
// around the default window, with a 1-hour floor so fast cadences stay on
// the existing default.
function defaultBufferMs(visibleMs: number): number {
  const desired = Math.max(DEFAULT_BUFFER_MS, visibleMs * 3);
  for (const opt of BUFFER_OPTIONS) {
    if (opt.ms >= desired) return opt.ms;
  }
  return BUFFER_OPTIONS[BUFFER_OPTIONS.length - 1].ms;
}

function formatWindow(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60_000))} hour${ms > 60 * 60_000 ? 's' : ''}`;
  return `${Math.round(ms / (24 * 60 * 60_000))} day${ms > 24 * 60 * 60_000 ? 's' : ''}`;
}

const CheckDetails: React.FC = () => {
  const { userId } = useAuth();
  const { checkId = '' } = useParams<{ checkId: string }>();
  const navigate = useNavigate();

  const { checks: firestoreChecks } = useChecks(userId ?? null, () => {});
  const {
    effectiveChecks,
    regions,
    aggregateState,
    fallbackRegion,
    historyByCheckId,
    segmentsByCheckId,
    subscribeHistory,
    unsubscribeHistory,
  } = useCheckStream(firestoreChecks);

  const check = useMemo<Website | undefined>(
    () => effectiveChecks.find((c) => c.id === checkId),
    [effectiveChecks, checkId],
  );

  // Options for the header check-selector. Same shape that
  // FilterBar/Reports/LogsBigQuery feed their dropdowns so the search +
  // folder grouping behave identically.
  const checkSelectOptions = useMemo(
    () =>
      effectiveChecks.map((c) => ({
        value: c.id,
        label: c.name,
        folder: c.folder,
        type: c.type,
        url: c.url,
      })),
    [effectiveChecks],
  );

  const handleCheckSelect = useCallback(
    (id: string) => {
      if (!id || id === checkId) return;
      navigate(`/checks/${id}`);
    },
    [checkId, navigate],
  );

  // How much history to buffer from the server. Drives the navigator's
  // total range. Changing this re-subscribes the WS history.
  const [bufferMs, setBufferMs] = useState<number>(DEFAULT_BUFFER_MS);

  // Brush state: offsets from "now" in ms. Both stay fixed as time
  // advances, which means the visible window scrolls forward
  // continuously — the user's drag chooses the relative slice, not an
  // absolute time range.
  const [brush, setBrush] = useState<{ left: number; right: number }>(() => ({
    left: DEFAULT_VISIBLE_WINDOW_MS,
    right: 0,
  }));

  // When the buffer shrinks below the brush's left offset, clamp the
  // brush so it stays within the buffer. Without this, switching from
  // 24h → 5m with a brush at 1h-ago would render the brush off-screen.
  useEffect(() => {
    setBrush((prev) => {
      const left = Math.min(prev.left, bufferMs);
      const right = Math.min(prev.right, Math.max(0, left - MIN_VISIBLE_WINDOW_MS));
      if (left === prev.left && right === prev.right) return prev;
      return { left, right };
    });
  }, [bufferMs]);

  // Apply cadence-aware defaults the first time we see the check (and
  // again when the user navigates to a different check). Without this,
  // 1-5 min cadences open the page with a 1-min window that holds 0-1
  // points. Skip if we've already initialized this check id — we don't
  // want to clobber the user's brush drag mid-session.
  const initializedCheckIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!check?.id || check.checkFrequency == null) return;
    if (initializedCheckIdRef.current === check.id) return;
    initializedCheckIdRef.current = check.id;
    const cadenceMs = check.checkFrequency * 60_000;
    const visible = defaultVisibleWindowMs(cadenceMs);
    const buffer = defaultBufferMs(visible);
    setBufferMs(buffer);
    setBrush({ left: Math.min(visible, buffer), right: 0 });
  }, [check?.id, check?.checkFrequency]);

  const visibleWindowMs = Math.max(MIN_VISIBLE_WINDOW_MS, brush.left - brush.right);

  // Fetch the full buffer plus one cadence of slack so the leftmost
  // pixel of the navigator has a probe just outside the visible range.
  const fetchWindowMs = useMemo(() => {
    const cadenceMs = (check?.checkFrequency ?? 1) * 60_000;
    return bufferMs + cadenceMs * 2;
  }, [bufferMs, check?.checkFrequency]);

  const handleBrushChange = useCallback((left: number, right: number) => {
    setBrush({ left, right });
  }, []);

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
    subscribeHistory(check.id, check.checkRegion, fetchWindowMs);
  }, [check?.id, check?.checkRegion, regionState, fetchWindowMs, subscribeHistory]);

  // Drop the per-check buffer on unmount only — NOT on WS flap. During a
  // reconnect the overlay's last-known state is still trusted (hysteresis
  // window) and we don't want to wipe the chart the user is looking at.
  useEffect(() => {
    if (!check?.id) return;
    const id = check.id;
    return () => unsubscribeHistory(id);
  }, [check?.id, unsubscribeHistory]);

  const points = check ? historyByCheckId.get(check.id) ?? [] : [];
  const segments = check ? segmentsByCheckId.get(check.id) ?? [] : [];

  // Phase breakdown only makes sense for HTTP-flavoured probes — the
  // others (TCP/UDP/ICMP/DNS/heartbeat) don't emit DNS/Connect/TLS/TTFB.
  // We also gate on actual phase data being present so a freshly-typed
  // HTTP check doesn't show the toggle while points are still arriving.
  const supportsPhases =
    check?.type === 'website' ||
    check?.type === 'rest_endpoint' ||
    check?.type === 'redirect' ||
    check?.type === 'api' ||
    check?.type === 'rest';
  const hasPhaseData = useMemo(
    () => points.some((p) => typeof p.dn === 'number' || typeof p.cn === 'number' || typeof p.tl === 'number' || typeof p.ft === 'number'),
    [points],
  );
  const phaseToggleAvailable = supportsPhases && hasPhaseData;
  const [chartMode, setChartMode] = useState<'total' | 'phases'>('total');
  // Auto-revert to total if the user switched to a check that can't
  // produce phases — otherwise the chart area would stay empty.
  useEffect(() => {
    if (!phaseToggleAvailable && chartMode === 'phases') setChartMode('total');
  }, [phaseToggleAvailable, chartMode]);

  return (
    <PageContainer>
      <PageHeader
        icon={Activity}
        title={check?.name ?? 'Check details'}
        description={check?.url}
        actions={
          <div className="flex items-center gap-2">
            <WsConnectionIndicator
              aggregateState={aggregateState}
              regions={regions}
            />
            <div className="h-5 w-px bg-border mx-1" aria-hidden />
            <CheckSelect
              value={checkId}
              onValueChange={handleCheckSelect}
              options={checkSelectOptions}
              placeholder="Switch check…"
              ariaLabel="Switch check"
              triggerClassName="h-9 w-auto min-w-[140px] max-w-[220px] cursor-pointer"
            />
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link to="/checks">
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Back</span>
              </Link>
            </Button>
            {check?.url && (
              <Button asChild variant="outline" size="sm" className="gap-2">
                <a href={check.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-4 h-4" />
                  <span className="hidden sm:inline">Open</span>
                </a>
              </Button>
            )}
          </div>
        }
      />

      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 mb-4">
        <WsFallbackBanner fallbackRegion={fallbackRegion} />
      </div>

      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8">
        {!check ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
            Check not found.
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div className="flex items-baseline gap-3 min-w-0">
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  {chartMode === 'phases' ? 'Phase breakdown' : 'Response time'}
                </span>
                <span className="text-[11px] text-muted-foreground/70 font-mono tabular-nums truncate">
                  {formatWindow(visibleWindowMs)} · live
                </span>
                {phaseToggleAvailable && (
                  <div
                    role="tablist"
                    aria-label="Chart mode"
                    className="inline-flex items-center rounded-md border border-input bg-input/30 p-0.5 ml-2 text-[11px]"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={chartMode === 'total'}
                      onClick={() => setChartMode('total')}
                      className={
                        'px-2 py-0.5 rounded-sm font-medium uppercase tracking-[0.14em] transition-colors ' +
                        (chartMode === 'total'
                          ? 'bg-background text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground')
                      }
                    >
                      Total
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={chartMode === 'phases'}
                      onClick={() => setChartMode('phases')}
                      className={
                        'px-2 py-0.5 rounded-sm font-medium uppercase tracking-[0.14em] transition-colors ' +
                        (chartMode === 'phases'
                          ? 'bg-background text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground')
                      }
                    >
                      Phases
                    </button>
                  </div>
                )}
              </div>
              <div className="font-mono text-2xl font-light tabular-nums">
                {typeof check.responseTime === 'number'
                  ? <>{check.responseTime}<span className="text-base text-muted-foreground ml-1">ms</span></>
                  : <span className="text-muted-foreground">—</span>}
              </div>
            </div>
            <div className="h-[360px] w-full">
              {chartMode === 'phases' ? (
                <PhaseStackChart
                  points={points}
                  segments={segments}
                  windowMs={visibleWindowMs}
                  offsetMs={brush.right}
                />
              ) : (
                <LiveChart
                  points={points}
                  segments={segments}
                  windowMs={visibleWindowMs}
                  offsetMs={brush.right}
                />
              )}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Select
                value={String(bufferMs)}
                onValueChange={(v) => setBufferMs(Number(v))}
              >
                <SelectTrigger
                  aria-label="Timeline range"
                  className="h-[40px]! w-[104px] shrink-0 px-2.5 text-[11px] font-medium"
                >
                  <SelectValue>
                    Range: {BUFFER_OPTIONS.find((o) => o.ms === bufferMs)?.label ?? ''}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {BUFFER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.label} value={String(opt.ms)} className="text-[11px]">
                      Range: {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="h-[40px] flex-1 min-w-0 overflow-hidden rounded-md border border-input dark:bg-input/30 shadow-xs">
                <ChartNavigator
                  points={points}
                  segments={segments}
                  bufferMs={bufferMs}
                  leftOffsetMs={brush.left}
                  rightOffsetMs={brush.right}
                  onBrushChange={handleBrushChange}
                  minWindowMs={MIN_VISIBLE_WINDOW_MS}
                  rightGutterPx={54}
                />
              </div>
            </div>

            <div className="mt-8">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-3 min-w-0">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    Probes
                  </span>
                  <span className="text-[11px] text-muted-foreground/70 font-mono tabular-nums truncate">
                    raw stream · newest first
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground/70 font-mono tabular-nums">
                  {points.length} buffered
                </span>
              </div>
              <LiveProbeTable points={points} />
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
};

export default CheckDetails;
