import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Radio, ArrowLeft, ExternalLink, Sparkles } from 'lucide-react';
import { PageContainer, PageHeader } from '../components/layout';
import { Button, CheckSelect } from '../components/ui';
import { usePlan } from '../hooks/usePlan';
import { useAdmin } from '../hooks/useAdmin';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/Select';
import { useChecks } from '../hooks/useChecks';
import { useCheckStream } from '../hooks/useCheckStream';
import { LiveChart } from '../components/check/LiveChart';
import { PhaseStackChart } from '../components/check/PhaseStackChart';
import { ChartNavigator } from '../components/check/ChartNavigator';
import { LiveProbeTable } from '../components/check/LiveProbeTable';
import { ExportDataButton } from '../components/check/ExportDataButton';
import { WsConnectionIndicator, WsFallbackBanner } from '../components/WsConnectionStatus';
import { computeRowTiers } from '../lib/probe-tiers';
import type { Website } from '../types';

const BUFFER_OPTIONS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

// Inline phase-mode legend. Swatch tokens mirror PhaseStackChart.PHASE_BANDS
// and LiveChart.PHASE_TOOLTIP_ROWS — three constants, kept literally
// identical so they stay in sync visually without a shared module.
const PHASE_LEGEND: Array<{ key: 'dn' | 'cn' | 'tl' | 'ft'; label: string; swatch: string }> = [
  { key: 'dn', label: 'DNS', swatch: 'var(--phase-dns, #e7eef8)' },
  { key: 'cn', label: 'Connect', swatch: 'var(--phase-connect, #a8c1e6)' },
  { key: 'tl', label: 'TLS', swatch: 'var(--phase-tls, #6b8ed1)' },
  { key: 'ft', label: 'TTFB', swatch: 'var(--phase-ttfb, #3b5bb5)' },
];

const DEFAULT_BUFFER_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_VISIBLE_WINDOW_MS = 60 * 1000; // 1 minute
const MIN_VISIBLE_WINDOW_MS = 10 * 1000; // 10s — anything tighter and the brush snaps closed
const LAST_CHECK_ID_STORAGE_KEY = 'exit1_last_check_id';

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

const LiveCheck: React.FC = () => {
  const { userId } = useAuth();
  const { checkId = '' } = useParams<{ checkId: string }>();
  const navigate = useNavigate();
  const { tier } = usePlan();
  const { isAdmin } = useAdmin();
  const gated = !isAdmin && tier === 'free';

  // Casual-tamper guard: if a user opens DevTools and deletes the upgrade
  // overlay, this poll forces a re-mount on the next tick by bumping the
  // overlay's React key. Not a real security boundary (anyone with
  // DevTools can also kill this interval) — just raises the bar so a
  // right-click → Delete element bounce-back keeps them honest.
  const [tamperKey, setTamperKey] = useState(0);
  useEffect(() => {
    if (!gated) return;
    const id = setInterval(() => {
      if (!document.querySelector('[data-live-gate]')) {
        setTamperKey((k) => k + 1);
      }
    }, 500);
    return () => clearInterval(id);
  }, [gated]);

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

  // Remember the last check the user opened so the sidebar's "Live"
  // entry can re-open it next visit. Only persist after we've confirmed
  // the id resolves to a real check — guards against stale ids in the URL.
  useEffect(() => {
    if (!check?.id) return;
    try {
      localStorage.setItem(LAST_CHECK_ID_STORAGE_KEY, check.id);
    } catch {
      // ignore quota / disabled-storage errors
    }
  }, [check?.id]);

  // Options for the header check-selector. Same shape that
  // FilterBar/Reports/LogsBigQuery feed their dropdowns so the search +
  // folder grouping behave identically. Source from `firestoreChecks`
  // rather than `effectiveChecks` so the options reference is stable —
  // `effectiveChecks` reshuffles every WS emit (≈4×/sec) and would
  // re-render every Radix SelectItem at that rate while the popover is
  // open, which manifests as dropdown lag.
  const checkSelectOptions = useMemo(
    () =>
      firestoreChecks.map((c) => ({
        value: c.id,
        label: c.name,
        folder: c.folder,
        type: c.type,
        url: c.url,
      })),
    [firestoreChecks],
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

  // Drag-to-zoom from the chart. The chart hands us offsets-from-now in
  // ms for the left/right edges of the user's drag rectangle. Selections
  // are always inside the visible window so we don't need to grow the
  // buffer — just clamp the right edge to >= 0 (selections that bleed
  // past "now" snap to live) and enforce MIN_VISIBLE_WINDOW_MS so a
  // sliver drag doesn't collapse the navigator brush.
  const handleChartZoom = useCallback(
    (leftOffsetMs: number, rightOffsetMs: number) => {
      const right = Math.max(0, rightOffsetMs);
      const left = Math.max(leftOffsetMs, right + MIN_VISIBLE_WINDOW_MS);
      setBrush({ left, right });
    },
    [],
  );

  // Double-click on the chart progressively zooms out — each dblclick
  // doubles the visible window around its current center, clamped to
  // the buffer. Once the visible span hits bufferMs and the right edge
  // is at live, further dblclicks are no-ops. To go wider, the user
  // bumps the Range dropdown.
  const handleChartZoomOut = useCallback(() => {
    setBrush((prev) => {
      const visible = prev.left - prev.right;
      if (visible >= bufferMs && prev.right === 0) return prev;
      const nextVisible = Math.min(visible * 2, bufferMs);
      const center = (prev.left + prev.right) / 2;
      let right = center - nextVisible / 2;
      let left = center + nextVisible / 2;
      // Clamp against live (right >= 0) and buffer (left <= bufferMs),
      // shifting the opposite edge so the window keeps its width.
      if (right < 0) {
        left -= right;
        right = 0;
      }
      if (left > bufferMs) {
        right -= left - bufferMs;
        left = bufferMs;
        if (right < 0) right = 0;
      }
      return { left, right };
    });
  }, [bufferMs]);

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

  // Currently-selected probe timestamp (ms epoch). Bidirectional handle
  // between the chart marker and the table row highlight. Cleared when
  // the user clicks the same probe again or switches check.
  const [selectedT, setSelectedT] = useState<number | null>(null);
  useEffect(() => {
    setSelectedT(null);
  }, [check?.id]);
  const handleSelectProbe = useCallback((t: number) => {
    setSelectedT((prev) => (prev === t ? null : t));
  }, []);

  // 1s tick drives the visible-range filter on the table. Faster than
  // needed for human reading, but it keeps the "in view" count and the
  // row set coherent with the chart's RAF-driven scroll in live mode.
  const [filterTick, setFilterTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setFilterTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const visibleRange = useMemo(() => {
    const nowMs = filterTick;
    return {
      lo: nowMs - brush.left,
      hi: nowMs - brush.right,
    };
  }, [filterTick, brush.left, brush.right]);

  const visiblePoints = useMemo(
    () => points.filter((p) => p.t >= visibleRange.lo && p.t <= visibleRange.hi),
    [points, visibleRange.lo, visibleRange.hi],
  );

  // A segment overlaps the visible window when it isn't entirely before
  // or after it. Open segments (e === null) are treated as ending at
  // "now" — same convention used by the chart's band rendering.
  const visibleSegments = useMemo(() => {
    return segments.filter((seg) => {
      const end = seg.e ?? visibleRange.hi;
      return end >= visibleRange.lo && seg.s <= visibleRange.hi;
    });
  }, [segments, visibleRange.lo, visibleRange.hi]);

  // Tier classification per probe (timestamp → 'elevated' | 'spike'),
  // computed against medians from the *visible* window so the chart
  // markers and table tints agree. Only non-normal probes land in the
  // map — the chart skips drawing for anything else.
  const tierByT = useMemo(() => computeRowTiers(visiblePoints), [visiblePoints]);

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
        icon={Radio}
        title={check?.name ?? 'Check details'}
        description={check?.url}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
            <WsConnectionIndicator
              aggregateState={aggregateState}
              regions={regions}
            />
            <div className="hidden sm:block h-5 w-px bg-border mx-1" aria-hidden />
            <CheckSelect
              value={checkId}
              onValueChange={handleCheckSelect}
              options={checkSelectOptions}
              placeholder="Switch check…"
              ariaLabel="Switch check"
              triggerClassName="h-9 w-[140px] sm:w-auto sm:min-w-[140px] sm:max-w-[220px] cursor-pointer"
            />
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link to="/checks" aria-label="Back to checks">
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Back</span>
              </Link>
            </Button>
            {check?.url && (
              <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
                <a href={check.url} target="_blank" rel="noopener noreferrer" aria-label="Open URL">
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

      <div className="w-full mx-auto px-4 sm:px-6 lg:px-8 relative">
        <div
          className={gated ? 'pointer-events-none select-none blur-[3px] opacity-70' : ''}
          aria-hidden={gated || undefined}
          inert={gated}
        >
        {!check ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
            Check not found.
          </div>
        ) : (
          <div>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 min-w-0">
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
                    className="inline-flex items-center rounded-md border border-input bg-input/30 p-0.5 sm:ml-2 text-[11px]"
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
                {chartMode === 'phases' && phaseToggleAvailable && (
                  <div className="hidden md:flex items-center gap-3 ml-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {PHASE_LEGEND.map((p) => (
                      <span key={p.key} className="inline-flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 rounded-sm"
                          style={{ backgroundColor: p.swatch }}
                        />
                        {p.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="font-mono text-xl sm:text-2xl font-light tabular-nums">
                {typeof check.responseTime === 'number'
                  ? <>{check.responseTime}<span className="text-sm sm:text-base text-muted-foreground ml-1">ms</span></>
                  : <span className="text-muted-foreground">—</span>}
              </div>
            </div>
            <div
              className="h-[360px] w-full"
              onDoubleClick={handleChartZoomOut}
              title="Drag to zoom · double-click to zoom out"
            >
              {chartMode === 'phases' ? (
                <PhaseStackChart
                  points={points}
                  segments={segments}
                  windowMs={visibleWindowMs}
                  offsetMs={brush.right}
                  onZoom={handleChartZoom}
                  selectedT={selectedT}
                  onSelectProbe={handleSelectProbe}
                  tierByT={tierByT}
                />
              ) : (
                <LiveChart
                  points={points}
                  segments={segments}
                  windowMs={visibleWindowMs}
                  offsetMs={brush.right}
                  onZoom={handleChartZoom}
                  selectedT={selectedT}
                  onSelectProbe={handleSelectProbe}
                  tierByT={tierByT}
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
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
                  <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    Probes
                  </span>
                  <span className="text-[11px] text-muted-foreground/70 font-mono tabular-nums truncate">
                    <span className="hidden sm:inline">raw stream · </span>newest first
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground/70 font-mono tabular-nums whitespace-nowrap">
                    {visiblePoints.length}<span className="hidden sm:inline"> in view</span> · {points.length}<span className="hidden sm:inline"> buffered</span>
                  </span>
                  <ExportDataButton
                    check={check}
                    points={points}
                    segments={segments}
                    bufferMs={bufferMs}
                  />
                </div>
              </div>
              <LiveProbeTable
                points={visiblePoints}
                segments={visibleSegments}
                selectedT={selectedT}
                onSelectProbe={handleSelectProbe}
              />
            </div>
          </div>
        )}
        </div>
        {gated && (
          <div
            key={tamperKey}
            data-live-gate=""
            className="pointer-events-auto absolute inset-0 z-10 flex items-start justify-center px-4 pt-16 sm:pt-24 bg-gradient-to-b from-background/30 via-background/60 to-background/85"
          >
            <div className="w-full max-w-md rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-background/90 backdrop-blur-md p-8 text-center space-y-5 shadow-2xl">
              <div className="flex justify-center">
                <div className="rounded-full bg-primary/10 p-3">
                  <Sparkles className="h-6 w-6 text-primary" />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-foreground">Upgrade to Nano for live</h3>
                <p className="text-sm text-foreground/85">
                  You're peeking at the live probe view. Upgrade to Nano to watch checks update in real time, zoom into incidents, and export raw probe data.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button asChild className="cursor-pointer">
                  <Link to="/billing">Upgrade to Nano</Link>
                </Button>
                <Button asChild variant="outline" className="cursor-pointer">
                  <Link to="/billing">See plans</Link>
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
};

export default LiveCheck;
