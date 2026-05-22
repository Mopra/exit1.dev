import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChartPoint, StateSegment, CheckStateKind } from '@/lib/ws-protocol';
import { type Tier, computeMedians, tierFor } from '@/lib/probe-tiers';

interface LiveProbeTableProps {
  points: ChartPoint[];
  /** State segments (maintenance / disabled) — surfaced as event rows
   *  inlined with probes so the table mirrors the chart's shaded bands. */
  segments?: StateSegment[];
  /** Optional hard cap on row count. Omit to show every buffered row —
   *  the buffer size itself is controlled by the Range dropdown on the
   *  parent page. */
  maxRows?: number;
  /** Timestamp (ms epoch) of the currently-selected probe, or null. The
   *  matching row is highlighted and scrolled into view; clicking a row
   *  toggles the selection via `onSelectProbe`. Both ends of the
   *  bidirectional handle live in LiveCheck. */
  selectedT?: number | null;
  onSelectProbe?: (t: number) => void;
}

// Stable default so callers that omit `segments` don't reseat the
// reference every render and bust downstream memos.
const EMPTY_SEGMENTS: readonly StateSegment[] = [];

type ProbeRow = { kind: 'probe'; t: number; point: ChartPoint };
type SegmentEventRow = {
  kind: 'segment';
  t: number;
  /** start = segment opened, end = segment closed. */
  edge: 'start' | 'end';
  state: CheckStateKind;
  /** Duration in ms — only set for `end` rows. */
  durationMs?: number;
  /** Stable React key. */
  id: string;
};
type Row = ProbeRow | SegmentEventRow;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return `${n}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function formatRelative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

const STATE_LABEL: Record<CheckStateKind, string> = {
  maintenance: 'Maintenance',
  disabled: 'Disabled',
};

function tierClass(tier: Tier, base: 'muted' | 'foreground'): string {
  if (tier === 'spike') return 'text-red-500 dark:text-red-400 font-medium';
  if (tier === 'elevated') return 'text-amber-500 dark:text-amber-400';
  return base === 'muted' ? 'text-muted-foreground' : '';
}

const TIER_TOOLTIP: Record<Tier, string> = {
  normal: '',
  elevated: '≥ 2× median for the visible window',
  spike: '≥ 3× median for the visible window',
};

// Row height needs to match the rendered row tightly — react-virtual
// uses it to compute scroll geometry, and a wrong estimate makes the
// scrollbar lurch. 36px = py cell padding + text-sm line-height.
const ROW_HEIGHT = 36;
const SCROLL_MAX_HEIGHT = 420; // outer max − 44 header

const HEADER_CELL =
  'px-2 flex items-center text-xs uppercase tracking-[0.12em] text-muted-foreground font-medium';
const ROW_CELL = 'px-2 flex items-center whitespace-nowrap';

export const LiveProbeTable: React.FC<LiveProbeTableProps> = ({
  points,
  segments,
  maxRows,
  selectedT,
  onSelectProbe,
}) => {
  // Re-render once a second so "Xs ago" stays current even when no new
  // probe has arrived. Cheap — single setState.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const segmentsProp = segments ?? EMPTY_SEGMENTS;

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of points) out.push({ kind: 'probe', t: p.t, point: p });
    for (const seg of segmentsProp) {
      out.push({
        kind: 'segment',
        t: seg.s,
        edge: 'start',
        state: seg.k,
        id: `${seg.k}|${seg.s}|start`,
      });
      if (seg.e !== null) {
        out.push({
          kind: 'segment',
          t: seg.e,
          edge: 'end',
          state: seg.k,
          durationMs: Math.max(0, seg.e - seg.s),
          id: `${seg.k}|${seg.s}|end`,
        });
      }
    }
    out.sort((a, b) => b.t - a.t);
    return typeof maxRows === 'number' ? out.slice(0, maxRows) : out;
  }, [points, segmentsProp, maxRows]);

  const showPhases = React.useMemo(
    () =>
      rows.some(
        (r) =>
          r.kind === 'probe' &&
          (typeof r.point.dn === 'number' ||
            typeof r.point.cn === 'number' ||
            typeof r.point.tl === 'number' ||
            typeof r.point.ft === 'number'),
      ),
    [rows],
  );

  const medians = React.useMemo(
    () => computeMedians(rows.filter((r): r is ProbeRow => r.kind === 'probe').map((r) => r.point)),
    [rows],
  );

  const newestProbeT = React.useMemo(() => {
    for (const r of rows) if (r.kind === 'probe') return r.t;
    return 0;
  }, [rows]);
  const [flashT, setFlashT] = React.useState(0);
  const lastFlashedRef = React.useRef(0);
  React.useEffect(() => {
    if (newestProbeT === 0 || newestProbeT === lastFlashedRef.current) return;
    lastFlashedRef.current = newestProbeT;
    setFlashT(newestProbeT);
    const id = setTimeout(() => setFlashT(0), 900);
    return () => clearTimeout(id);
  }, [newestProbeT]);

  // Grid template — must match header and rows. minmax(0,1fr) on the
  // Age column lets it absorb the remaining width without forcing the
  // earlier fixed columns to shrink.
  const gridTemplate = showPhases
    ? '180px 80px 120px 64px 64px 64px 64px 100px minmax(0,1fr)'
    : '180px 80px 120px 100px minmax(0,1fr)';
  // Sum of the fixed column widths so the inner content can declare a
  // min-width and the outer wrapper scrolls horizontally on narrow
  // viewports instead of crushing the columns. Age column (1fr) has no
  // minimum, so we add a small reserve so its content has room to breathe.
  const gridMinWidthPx = showPhases ? 836 : 560;

  const parentRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Index of the selected probe row. -1 when nothing is selected or the
  // selected probe has fallen out of the current visible window (the
  // parent filters points to the brush range, so a previously-selected
  // probe simply drops out of the table until the user pans back).
  const selectedIndex = React.useMemo(() => {
    if (selectedT == null) return -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === 'probe' && r.t === selectedT) return i;
    }
    return -1;
  }, [rows, selectedT]);

  // Scroll the selected row into view whenever the selection target
  // changes (chart click, or table click from off-screen). Skip the
  // scroll when the row is already visible — virtualizer.scrollToIndex
  // with `auto` handles that, but firing it on every selection-stable
  // re-render would fight user scrolling.
  const lastScrolledForRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (selectedT == null || selectedIndex < 0) {
      lastScrolledForRef.current = null;
      return;
    }
    if (lastScrolledForRef.current === selectedT) return;
    lastScrolledForRef.current = selectedT;
    virtualizer.scrollToIndex(selectedIndex, { align: 'center', behavior: 'smooth' });
  }, [selectedT, selectedIndex, virtualizer]);

  return (
    <div className="rounded-md border border-border/60 overflow-x-auto">
      <div style={{ minWidth: gridMinWidthPx }}>
      <div
        className="grid border-b border-border/60 bg-background/95"
        style={{ gridTemplateColumns: gridTemplate, height: 44 }}
      >
        <div className={HEADER_CELL}>Time</div>
        <div className={HEADER_CELL}>Status</div>
        <div className={`${HEADER_CELL} justify-end`}>Response</div>
        {showPhases && (
          <>
            <div className={`${HEADER_CELL} justify-end`}>DNS</div>
            <div className={`${HEADER_CELL} justify-end`}>Connect</div>
            <div className={`${HEADER_CELL} justify-end`}>TLS</div>
            <div className={`${HEADER_CELL} justify-end`}>TTFB</div>
          </>
        )}
        <div className={`${HEADER_CELL} justify-end`}>Code</div>
        <div className={`${HEADER_CELL} justify-end`}>Age</div>
      </div>

      <div
        ref={parentRef}
        className="overflow-y-auto"
        style={{ maxHeight: SCROLL_MAX_HEIGHT }}
      >
        {rows.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-10">
            Waiting for the first probe…
          </div>
        ) : (
          <div style={{ height: totalSize, position: 'relative', width: '100%' }}>
            {virtualItems.map((vi) => {
              const row = rows[vi.index];
              const baseStyle: React.CSSProperties = {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
                display: 'grid',
                gridTemplateColumns: gridTemplate,
              };

              if (row.kind === 'segment') {
                const isMaintenance = row.state === 'maintenance';
                const badgeClass = isMaintenance
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-muted text-muted-foreground';
                const dotClass = isMaintenance ? 'bg-amber-500' : 'bg-muted-foreground';
                const label =
                  row.edge === 'end'
                    ? `${STATE_LABEL[row.state]} ended`
                    : `${STATE_LABEL[row.state]} started`;
                // Middle "label" cell spans Response + (phase cols) + Code.
                const middleSpan = showPhases ? 6 : 2;
                return (
                  <div
                    key={row.id}
                    className="bg-muted/20 border-b border-border/40"
                    style={baseStyle}
                  >
                    <div className={`${ROW_CELL} font-mono text-sm tabular-nums`}>
                      {formatTime(row.t)}
                    </div>
                    <div className={ROW_CELL}>
                      <span
                        className={
                          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ' +
                          badgeClass
                        }
                      >
                        <span className={'h-1.5 w-1.5 rounded-full ' + dotClass} />
                        {STATE_LABEL[row.state]}
                      </span>
                    </div>
                    <div
                      className={`${ROW_CELL} text-sm text-muted-foreground`}
                      style={{ gridColumn: `span ${middleSpan}` }}
                    >
                      <span className="font-medium text-foreground/80">{label}</span>
                      {row.edge === 'end' && typeof row.durationMs === 'number' && (
                        <span className="ml-2 font-mono tabular-nums">
                          · {formatDuration(row.durationMs)}
                        </span>
                      )}
                      {row.edge === 'start' && (
                        <span className="ml-2 font-mono tabular-nums">· no probes recorded</span>
                      )}
                    </div>
                    <div
                      className={`${ROW_CELL} justify-end font-mono text-sm tabular-nums text-muted-foreground`}
                    >
                      {formatRelative(row.t, now)}
                    </div>
                  </div>
                );
              }

              const p = row.point;
              const up = p.st === 'up';
              const flashed = p.t === flashT;
              const isSelected = selectedT != null && p.t === selectedT;

              // Roll the row up to its worst-coloured cell so a single
              // spike anywhere paints the whole row, making bad probes
              // scannable from a distance. A down probe overrides to
              // spike regardless of timings.
              let rowTier: Tier = 'normal';
              if (!up) {
                rowTier = 'spike';
              } else if (medians.enable) {
                for (const key of ['rt', 'dn', 'cn', 'tl', 'ft'] as const) {
                  const v = p[key];
                  if (typeof v !== 'number') continue;
                  const t = tierFor(v, medians[key]);
                  if (t === 'spike') {
                    rowTier = 'spike';
                    break;
                  }
                  if (t === 'elevated') rowTier = 'elevated';
                }
              }

              // Selection beats both flash and tier so the user always
              // sees what they picked. Inset ring + tint reads clearly
              // against any row state without changing the text color.
              const rowBg = isSelected
                ? 'bg-primary/10 dark:bg-primary/15 ring-1 ring-inset ring-primary/40'
                : flashed
                  ? 'bg-emerald-500/10 dark:bg-emerald-400/10 transition-colors duration-700'
                  : rowTier === 'spike'
                    ? 'bg-red-500/[0.06] dark:bg-red-500/10 transition-colors'
                    : rowTier === 'elevated'
                      ? 'bg-amber-500/[0.06] dark:bg-amber-500/10 transition-colors'
                      : 'hover:bg-gray-50/50 dark:hover:bg-gray-950/10 transition-colors';

              const interactive = onSelectProbe != null;
              return (
                <div
                  key={`probe|${p.t}`}
                  className={
                    'border-b border-border/40 ' +
                    rowBg +
                    (interactive ? ' cursor-pointer' : '')
                  }
                  style={baseStyle}
                  onClick={interactive ? () => onSelectProbe(p.t) : undefined}
                  role={interactive ? 'button' : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  onKeyDown={
                    interactive
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectProbe(p.t);
                          }
                        }
                      : undefined
                  }
                >
                  <div className={`${ROW_CELL} font-mono text-sm tabular-nums`}>
                    {formatTime(p.t)}
                  </div>
                  <div className={ROW_CELL}>
                    <span
                      className={
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ' +
                        (up
                          ? 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400'
                          : 'bg-red-500/10 text-red-500 dark:text-red-400')
                      }
                    >
                      <span
                        className={
                          'h-1.5 w-1.5 rounded-full ' + (up ? 'bg-emerald-500' : 'bg-red-500')
                        }
                      />
                      {up ? 'Up' : 'Down'}
                    </span>
                  </div>
                  <div
                    className={
                      `${ROW_CELL} justify-end font-mono text-sm tabular-nums ` +
                      (medians.enable && typeof p.rt === 'number'
                        ? tierClass(tierFor(p.rt, medians.rt), 'foreground')
                        : '')
                    }
                    title={
                      medians.enable && typeof p.rt === 'number'
                        ? TIER_TOOLTIP[tierFor(p.rt, medians.rt)] || undefined
                        : undefined
                    }
                  >
                    {typeof p.rt === 'number' ? (
                      <>
                        {p.rt}
                        <span className="text-muted-foreground ml-0.5">ms</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                  {showPhases &&
                    (['dn', 'cn', 'tl', 'ft'] as const).map((key) => {
                      const v = p[key];
                      const tier =
                        medians.enable && typeof v === 'number'
                          ? tierFor(v, medians[key])
                          : 'normal';
                      return (
                        <div
                          key={key}
                          className={`${ROW_CELL} justify-end font-mono text-xs tabular-nums ${tierClass(tier, 'muted')}`}
                          title={TIER_TOOLTIP[tier] || undefined}
                        >
                          {typeof v === 'number' ? v : '—'}
                        </div>
                      );
                    })}
                  <div className={`${ROW_CELL} justify-end font-mono text-sm tabular-nums`}>
                    {typeof p.sc === 'number' ? p.sc : <span className="text-muted-foreground">—</span>}
                  </div>
                  <div
                    className={`${ROW_CELL} justify-end font-mono text-sm tabular-nums text-muted-foreground`}
                  >
                    {formatRelative(p.t, now)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
};
