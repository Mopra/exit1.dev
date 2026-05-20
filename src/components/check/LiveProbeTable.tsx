import * as React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import type { ChartPoint, StateSegment, CheckStateKind } from '@/lib/ws-protocol';

interface LiveProbeTableProps {
  points: ChartPoint[];
  /** State segments (maintenance / disabled) — surfaced as event rows
   *  inlined with probes so the table mirrors the chart's shaded bands. */
  segments?: StateSegment[];
  /** Cap on the number of rows held in the table. Older rows fall off. */
  maxRows?: number;
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

export const LiveProbeTable: React.FC<LiveProbeTableProps> = ({
  points,
  segments,
  maxRows = 50,
}) => {
  // Re-render once a second so "Xs ago" stays current even when no new
  // probe has arrived. Cheap — single setState.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const segmentsProp = segments ?? EMPTY_SEGMENTS;

  // Build the interleaved row list. Probes and segment open/close events
  // are merged into a single newest-first stream so the table mirrors the
  // chart's shaded bands. Open segments (e === null) emit only a `start`
  // row; closed segments emit `start` + `end` so the user can see exactly
  // when the gap began and ended. Don't mutate the source buffer —
  // `points`/`segments` are held by ref inside useCheckStream and read
  // concurrently by the chart.
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
    return out.slice(0, maxRows);
  }, [points, segmentsProp, maxRows]);

  // Show phase columns only when at least one visible probe row carries
  // phase data — non-HTTP checks (TCP/UDP/ICMP/DNS) keep the compact
  // 5-col layout, and brand-new HTTP checks expand to 9 cols as soon as
  // the first probe with timings lands.
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

  const phaseCellClass =
    'w-[64px] text-right font-mono text-[11px] tabular-nums text-muted-foreground';

  // Flash the newest probe row briefly when a new probe arrives. Keyed
  // by timestamp so re-renders for the relative-time tick don't re-flash.
  // Only probes flash — segment transitions don't get the "ok, new
  // measurement just landed" treatment.
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

  return (
    <div className="rounded-md border border-border/60">
      <div className="max-h-[420px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
            <TableRow>
              <TableHead className="w-[180px] text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Time</TableHead>
              <TableHead className="w-[80px] text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Status</TableHead>
              <TableHead className="w-[120px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Response</TableHead>
              {showPhases && (
                <>
                  <TableHead className="w-[64px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">DNS</TableHead>
                  <TableHead className="w-[64px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Connect</TableHead>
                  <TableHead className="w-[64px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">TLS</TableHead>
                  <TableHead className="w-[64px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">TTFB</TableHead>
                </>
              )}
              <TableHead className="w-[100px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Code</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={showPhases ? 9 : 5} className="text-center text-sm text-muted-foreground py-10">
                  Waiting for the first probe…
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                if (row.kind === 'segment') {
                  const isMaintenance = row.state === 'maintenance';
                  // Match the chart's band palette: warning (amber) for
                  // maintenance, muted for disabled.
                  const badgeClass = isMaintenance
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'bg-muted text-muted-foreground';
                  const dotClass = isMaintenance ? 'bg-amber-500' : 'bg-muted-foreground';
                  const label =
                    row.edge === 'end'
                      ? `${STATE_LABEL[row.state]} ended`
                      : `${STATE_LABEL[row.state]} started`;
                  return (
                    <TableRow key={row.id} className="bg-muted/20">
                      <TableCell className="font-mono text-xs tabular-nums">
                        {formatTime(row.t)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={
                            'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ' +
                            badgeClass
                          }
                        >
                          <span className={'h-1.5 w-1.5 rounded-full ' + dotClass} />
                          {STATE_LABEL[row.state]}
                        </span>
                      </TableCell>
                      <TableCell
                        colSpan={showPhases ? 6 : 2}
                        className="text-xs text-muted-foreground"
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
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-right text-muted-foreground">
                        {formatRelative(row.t, now)}
                      </TableCell>
                    </TableRow>
                  );
                }
                const p = row.point;
                const up = p.st === 'up';
                const flashed = p.t === flashT;
                return (
                  <TableRow
                    key={`probe|${p.t}`}
                    className={flashed ? 'bg-emerald-500/10 dark:bg-emerald-400/10 transition-colors duration-700' : ''}
                  >
                    <TableCell className="font-mono text-xs tabular-nums">{formatTime(p.t)}</TableCell>
                    <TableCell>
                      <span
                        className={
                          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ' +
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
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-right">
                      {typeof p.rt === 'number' ? (
                        <>
                          {p.rt}
                          <span className="text-muted-foreground ml-0.5">ms</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {showPhases && (
                      <>
                        <TableCell className={phaseCellClass}>
                          {typeof p.dn === 'number' ? p.dn : '—'}
                        </TableCell>
                        <TableCell className={phaseCellClass}>
                          {typeof p.cn === 'number' ? p.cn : '—'}
                        </TableCell>
                        <TableCell className={phaseCellClass}>
                          {typeof p.tl === 'number' ? p.tl : '—'}
                        </TableCell>
                        <TableCell className={phaseCellClass}>
                          {typeof p.ft === 'number' ? p.ft : '—'}
                        </TableCell>
                      </>
                    )}
                    <TableCell className="font-mono text-xs tabular-nums text-right">
                      {typeof p.sc === 'number' ? p.sc : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-right text-muted-foreground">
                      {formatRelative(p.t, now)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
