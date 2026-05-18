import * as React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import type { ChartPoint } from '@/lib/ws-protocol';

interface LiveProbeTableProps {
  points: ChartPoint[];
  /** Cap on the number of rows held in the table. Older rows fall off. */
  maxRows?: number;
}

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

export const LiveProbeTable: React.FC<LiveProbeTableProps> = ({ points, maxRows = 50 }) => {
  // Re-render once a second so "Xs ago" stays current even when no new
  // probe has arrived. Cheap — single setState.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Reverse without mutating the source buffer — `points` is held by
  // ref inside useCheckStream and the chart reads it concurrently.
  const rows = React.useMemo(() => {
    if (points.length === 0) return [];
    const start = Math.max(0, points.length - maxRows);
    const slice = points.slice(start);
    slice.reverse();
    return slice;
  }, [points, maxRows]);

  // Flash the newest row briefly when a new probe arrives. Keyed by
  // timestamp so re-renders for the relative-time tick don't re-flash.
  const newestT = rows.length > 0 ? rows[0].t : 0;
  const [flashT, setFlashT] = React.useState(0);
  const lastFlashedRef = React.useRef(0);
  React.useEffect(() => {
    if (newestT === 0 || newestT === lastFlashedRef.current) return;
    lastFlashedRef.current = newestT;
    setFlashT(newestT);
    const id = setTimeout(() => setFlashT(0), 900);
    return () => clearTimeout(id);
  }, [newestT]);

  return (
    <div className="rounded-md border border-border/60">
      <div className="max-h-[420px] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75">
            <TableRow>
              <TableHead className="w-[180px] text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Time</TableHead>
              <TableHead className="w-[80px] text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Status</TableHead>
              <TableHead className="w-[120px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Response</TableHead>
              <TableHead className="w-[100px] text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Code</TableHead>
              <TableHead className="text-right text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-10">
                  Waiting for the first probe…
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => {
                const up = p.st === 'up';
                const flashed = p.t === flashT;
                return (
                  <TableRow
                    key={p.t}
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
