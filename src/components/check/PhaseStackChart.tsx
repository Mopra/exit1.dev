"use client";

import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartPoint, StateSegment } from "@/lib/ws-protocol";

interface PhaseStackChartProps {
  points: ChartPoint[];
  segments?: StateSegment[];
  windowMs?: number;
  /** Right-edge offset from "now" (ms). 0 = live. Matches LiveChart. */
  offsetMs?: number;
  className?: string;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const EMPTY_SEGMENTS: readonly StateSegment[] = [];

// Data shape passed to uPlot: [time, dns, dns+connect, dns+connect+tls,
// dns+connect+tls+ttfb]. Each cumulative column is what the area's *top
// edge* sits at, so consecutive areas read as a stacked breakdown.
type StackData = [
  number[],
  (number | null)[],
  (number | null)[],
  (number | null)[],
  (number | null)[],
];

interface PhaseTotals {
  dn: number | null;
  cn: number | null;
  tl: number | null;
  ft: number | null;
  total: number | null;
}

/**
 * Pull phase totals from a point. Treats absent fields as 0 so an HTTP
 * probe over plain http:// (no TLS) still stacks cleanly. Returns `null`
 * for every band when the probe has no phase data at all — the chart
 * draws a gap there, matching how LiveChart handles a failed probe.
 */
function phaseTotals(p: ChartPoint): PhaseTotals {
  const hasAny =
    typeof p.dn === "number" ||
    typeof p.cn === "number" ||
    typeof p.tl === "number" ||
    typeof p.ft === "number";
  if (!hasAny || p.rt == null) {
    return { dn: null, cn: null, tl: null, ft: null, total: null };
  }
  const dn = typeof p.dn === "number" ? p.dn : 0;
  const cn = typeof p.cn === "number" ? p.cn : 0;
  const tl = typeof p.tl === "number" ? p.tl : 0;
  const ft = typeof p.ft === "number" ? p.ft : 0;
  return { dn, cn, tl, ft, total: dn + cn + tl + ft };
}

function toStackData(points: ChartPoint[]): StackData {
  const n = points.length;
  const t = new Array<number>(n);
  const s1 = new Array<number | null>(n);
  const s2 = new Array<number | null>(n);
  const s3 = new Array<number | null>(n);
  const s4 = new Array<number | null>(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    t[i] = p.t / 1000;
    const ph = phaseTotals(p);
    if (ph.total == null) {
      s1[i] = null;
      s2[i] = null;
      s3[i] = null;
      s4[i] = null;
      continue;
    }
    s1[i] = ph.dn;
    s2[i] = (ph.dn ?? 0) + (ph.cn ?? 0);
    s3[i] = (ph.dn ?? 0) + (ph.cn ?? 0) + (ph.tl ?? 0);
    s4[i] = ph.total;
  }
  return [t, s1, s2, s3, s4];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatClock(ms: number, includeSeconds: boolean): string {
  const d = new Date(ms);
  const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return includeSeconds ? `${base}:${pad2(d.getSeconds())}` : base;
}

function formatTimeFor(windowMs: number) {
  const useSeconds = windowMs < 5 * 60 * 1000;
  return (_u: uPlot, vals: number[]): string[] => {
    return vals.map((sec) => formatClock(sec * 1000, useSeconds));
  };
}

const MAX_X_TICKS = 8;
function dataPointSplits(
  u: uPlot,
  _axisIdx: number,
  scaleMin: number,
  scaleMax: number,
): number[] {
  const xs = u.data[0];
  if (!xs || xs.length === 0) return [];
  const visible: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < scaleMin) continue;
    if (xs[i] > scaleMax) break;
    visible.push(xs[i]);
  }
  if (visible.length <= MAX_X_TICKS) return visible;
  const stride = Math.ceil(visible.length / MAX_X_TICKS);
  const thinned: number[] = [];
  for (let i = 0; i < visible.length; i += stride) thinned.push(visible[i]);
  return thinned;
}

/**
 * Y range driven by the visible window's tallest stack (series 4 =
 * cumulative total). 25% headroom keeps the highest stack from kissing
 * the top edge.
 */
function visibleStackRange(u: uPlot): [number, number] {
  const xMin = u.scales.x.min;
  const xMax = u.scales.x.max;
  if (xMin == null || xMax == null) return [0, 100];
  const xs = u.data[0];
  const tops = u.data[4] as (number | null)[];
  let max = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x < xMin) continue;
    if (x > xMax) break;
    const v = tops[i];
    if (v == null) continue;
    if (v > max) max = v;
  }
  if (max === -Infinity) return [0, 100];
  const pad = Math.max(max * 0.25, 4);
  const hi = Math.ceil(max + pad);
  return [0, Math.max(hi, 20)];
}

type BandKind = 'down' | 'maintenance' | 'disabled';
interface Band {
  id: string;
  kind: BandKind;
  s: number;
  e: number | null;
}

function computeDownRuns(points: ChartPoint[]): Band[] {
  const out: Band[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.st === 'down') {
      if (runStart === null) runStart = p.t;
    } else if (runStart !== null) {
      out.push({ id: `down|${runStart}`, kind: 'down', s: runStart, e: p.t });
      runStart = null;
    }
  }
  if (runStart !== null) {
    out.push({ id: `down|${runStart}`, kind: 'down', s: runStart, e: null });
  }
  return out;
}

interface TooltipState {
  visible: boolean;
  left: number;
  top: number;
  time: string;
  phases: PhaseTotals | null;
}

const TOOLTIP_INITIAL: TooltipState = {
  visible: false,
  left: 0,
  top: 0,
  time: "",
  phases: null,
};

interface PhaseBandSpec {
  key: 'dn' | 'cn' | 'tl' | 'ft';
  label: string;
  tokenFill: string;
  tokenFillAlpha: number;
  tokenStroke: string;
  fallbackFill: string;
  fallbackStroke: string;
}

// Bottom-to-top stack order matches the request order in the brief:
// DNS, Connect, TLS, TTFB. Token names map onto the dark-mode chart
// palette so the visual identity matches the rest of the app.
const PHASE_BANDS: PhaseBandSpec[] = [
  {
    key: 'dn',
    label: 'DNS',
    tokenFill: '--chart-1',
    tokenFillAlpha: 0.55,
    tokenStroke: '--chart-1',
    fallbackFill: '#a5b4fc',
    fallbackStroke: '#a5b4fc',
  },
  {
    key: 'cn',
    label: 'Connect',
    tokenFill: '--chart-2',
    tokenFillAlpha: 0.55,
    tokenStroke: '--chart-2',
    fallbackFill: '#7c8df0',
    fallbackStroke: '#7c8df0',
  },
  {
    key: 'tl',
    label: 'TLS',
    tokenFill: '--chart-3',
    tokenFillAlpha: 0.55,
    tokenStroke: '--chart-3',
    fallbackFill: '#5b6ee1',
    fallbackStroke: '#5b6ee1',
  },
  {
    key: 'ft',
    label: 'TTFB',
    tokenFill: '--chart-4',
    tokenFillAlpha: 0.55,
    tokenStroke: '--chart-4',
    fallbackFill: '#4451b7',
    fallbackStroke: '#4451b7',
  },
];

function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^oklch\(([^)]+)\)$/i);
  if (m) return `oklch(${m[1]} / ${alpha})`;
  return `color-mix(in oklch, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

export function PhaseStackChart({
  points,
  segments,
  windowMs = DEFAULT_WINDOW_MS,
  offsetMs = 0,
  className,
}: PhaseStackChartProps) {
  const segmentsProp = segments ?? EMPTY_SEGMENTS;
  const windowMsRef = React.useRef(windowMs);
  const offsetMsRef = React.useRef(offsetMs);
  const pointsRef = React.useRef<ChartPoint[]>(points);
  React.useEffect(() => {
    windowMsRef.current = windowMs;
    offsetMsRef.current = offsetMs;
  }, [windowMs, offsetMs]);
  React.useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  const containerRef = React.useRef<HTMLDivElement>(null);
  const plotRef = React.useRef<uPlot | null>(null);
  const emptyOverlayRef = React.useRef<HTMLDivElement>(null);
  const emptyLabelRef = React.useRef<HTMLSpanElement>(null);

  const bands = React.useMemo<Band[]>(() => {
    const out = computeDownRuns(points);
    for (const seg of segmentsProp) {
      out.push({ id: `${seg.k}|${seg.s}`, kind: seg.k, s: seg.s, e: seg.e });
    }
    return out;
  }, [points, segmentsProp]);
  const bandsRef = React.useRef<Band[]>(bands);
  React.useEffect(() => {
    bandsRef.current = bands;
  }, [bands]);
  const bandNodesRef = React.useRef<Map<string, HTMLDivElement>>(new Map());

  const [tooltip, setTooltip] = React.useState<TooltipState>(TOOLTIP_INITIAL);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cs = getComputedStyle(container);
    const resolve = (token: string, fallback: string): string => {
      const v = cs.getPropertyValue(token).trim();
      return v || fallback;
    };
    const axisColor = resolve("--muted-foreground", "#9ca3af");
    const resolvedBands = PHASE_BANDS.map((b) => {
      const baseFill = resolve(b.tokenFill, b.fallbackFill);
      const baseStroke = resolve(b.tokenStroke, b.fallbackStroke);
      return {
        ...b,
        fill: withAlpha(baseFill, b.tokenFillAlpha),
        stroke: baseStroke,
      };
    });

    const { width, height } = container.getBoundingClientRect();

    const opts: uPlot.Options = {
      width: Math.max(50, Math.floor(width)),
      height: Math.max(50, Math.floor(height)),
      padding: [16, 0, 0, 0],
      cursor: {
        show: true,
        x: true,
        y: false,
        drag: { x: false, y: false },
        points: { show: false },
      },
      legend: { show: false },
      hooks: {
        drawClear: [
          (u) => {
            u.ctx.lineJoin = "round";
            u.ctx.lineCap = "round";
          },
        ],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            const leftPx = u.cursor.left;
            if (idx == null || idx < 0 || leftPx == null || leftPx < 0) {
              setTooltip((prev) => (prev.visible ? TOOLTIP_INITIAL : prev));
              return;
            }
            const t = u.data[0][idx];
            if (t == null) return;
            const pts = pointsRef.current;
            // uPlot's idx aligns with our data array since we feed it
            // straight from `points` — no resampling.
            const p = pts[idx];
            if (!p) return;
            const xPx = u.valToPos(t, "x", false);
            const yPx = u.cursor.top ?? 0;
            setTooltip({
              visible: true,
              left: xPx,
              top: yPx,
              time: formatClock(t * 1000, true),
              phases: phaseTotals(p),
            });
          },
        ],
      },
      scales: {
        x: {
          time: true,
          range: () => {
            const max = (Date.now() - offsetMsRef.current) / 1000;
            return [max - windowMsRef.current / 1000, max];
          },
        },
        y: {
          range: (u) => visibleStackRange(u),
        },
      },
      // Series 0 = x. Series 1..4 = cumulative DNS, +Connect, +TLS, +TTFB.
      // Each series strokes thinly along its own top edge and fills DOWN
      // to the previous series's top (the band immediately beneath it),
      // producing a clean stacked-area look. Wired via uPlot's `bands`.
      series: [
        {},
        ...resolvedBands.map((b) => ({
          stroke: b.stroke,
          width: 0.75,
          fill: b.fill,
          spanGaps: false,
          points: { show: false },
        })),
      ],
      bands: [
        // baseline of 0 is the x-axis itself; uPlot fills from series 1
        // straight down to the plot floor when no baseline is given.
        { series: [2, 1] },
        { series: [3, 2] },
        { series: [4, 3] },
      ],
      axes: [
        {
          stroke: axisColor,
          grid: { show: false },
          ticks: { show: false },
          font: '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          values: formatTimeFor(windowMs),
          splits: dataPointSplits,
          gap: 8,
          size: 28,
        },
        {
          side: 1,
          stroke: axisColor,
          grid: { show: false },
          ticks: { show: false },
          font: '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          size: 30,
          gap: 4,
          splits: (u) => {
            const lo = u.scales.y.min;
            const hi = u.scales.y.max;
            if (lo == null || hi == null) return [];
            return [Math.round(lo), Math.round(hi)];
          },
          values: (_u, vals) => vals.map((v) => `${v} ms`),
        },
      ],
    };

    const plot = new uPlot(opts, toStackData(points), container);
    plotRef.current = plot;

    return () => {
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData(toStackData(points));
  }, [points]);

  React.useEffect(() => {
    let rafId = 0;
    const loop = () => {
      const plot = plotRef.current;
      const now = Date.now();
      if (plot) {
        const max = (now - offsetMsRef.current) / 1000;
        plot.setScale("x", {
          min: max - windowMsRef.current / 1000,
          max,
        });
      }
      const currentBands = bandsRef.current;
      if (plot && currentBands.length > 0) {
        try {
          const bbox = (plot as unknown as {
            bbox: { left: number; top: number; width: number; height: number };
          }).bbox;
          const dpr = window.devicePixelRatio || 1;
          const win = windowMsRef.current;
          const offset = offsetMsRef.current;
          const visMin = now - offset - win;
          const visMax = now - offset;
          const span = visMax - visMin;
          const plotLeftCss = bbox.left / dpr;
          const plotTopCss = bbox.top / dpr;
          const plotWidthCss = bbox.width / dpr;
          const plotHeightCss = bbox.height / dpr;
          for (const band of currentBands) {
            const node = bandNodesRef.current.get(band.id);
            if (!node) continue;
            const endMs = band.e ?? now;
            const startMs = band.s;
            if (endMs <= visMin || startMs >= visMax) {
              node.style.display = 'none';
              continue;
            }
            const startClamped = Math.max(startMs, visMin);
            const endClamped = Math.min(endMs, visMax);
            const left = plotLeftCss + ((startClamped - visMin) / span) * plotWidthCss;
            const width = Math.max(1, ((endClamped - startClamped) / span) * plotWidthCss);
            node.style.display = '';
            node.style.left = `${left}px`;
            node.style.top = `${plotTopCss}px`;
            node.style.width = `${width}px`;
            node.style.height = `${plotHeightCss}px`;
          }
        } catch (err) {
          console.warn('[PhaseStackChart] band positioning failed:', err);
        }
      }
      const overlay = emptyOverlayRef.current;
      if (overlay && plot) {
        const bbox = (plot as unknown as {
          bbox: { left: number; top: number; width: number; height: number };
        }).bbox;
        const dpr = window.devicePixelRatio || 1;
        const win = windowMsRef.current;
        const offset = offsetMsRef.current;
        const visMin = now - offset - win;
        const visMax = now - offset;
        const pts = pointsRef.current;
        // Treat earliest phase-bearing point as the start, so an HTTP
        // check with phase data mid-buffer still shows the right gap
        // before that point.
        let earliest = visMax;
        for (let i = 0; i < pts.length; i++) {
          const ph = phaseTotals(pts[i]);
          if (ph.total != null) {
            earliest = pts[i].t;
            break;
          }
        }
        const cap = Math.min(earliest, visMax);
        const emptyMs = Math.max(0, cap - visMin);
        const emptyFrac = win > 0 ? emptyMs / win : 0;
        const plotLeftCss = bbox.left / dpr;
        const plotTopCss = bbox.top / dpr;
        const plotWidthCss = bbox.width / dpr;
        const plotHeightCss = bbox.height / dpr;
        const emptyWidthCss = emptyFrac * plotWidthCss;
        overlay.style.left = `${plotLeftCss}px`;
        overlay.style.top = `${plotTopCss}px`;
        overlay.style.height = `${plotHeightCss}px`;
        overlay.style.width = `${emptyWidthCss}px`;
        overlay.style.display = emptyWidthCss < 1 ? "none" : "flex";
        const label = emptyLabelRef.current;
        if (label) {
          label.style.opacity = emptyWidthCss > 100 ? "1" : "0";
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const plot = plotRef.current;
      if (plot) {
        plot.setSize({
          width: Math.max(50, Math.floor(width)),
          height: Math.max(50, Math.floor(height)),
        });
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full live-chart ${className ?? ""}`}
      aria-label="Response time phase breakdown chart"
    >
      {bands.length > 0 && bands.map((band) => (
        <div
          key={band.id}
          ref={(node) => {
            if (node) bandNodesRef.current.set(band.id, node);
            else bandNodesRef.current.delete(band.id);
          }}
          className={`live-chart-band live-chart-band-${band.kind}`}
          style={{ display: "none" }}
          aria-hidden="true"
        >
          <div className="live-chart-band-tint" />
          <div className="live-chart-band-strip" />
        </div>
      ))}
      <div
        ref={emptyOverlayRef}
        className="pointer-events-none absolute flex items-center justify-center overflow-hidden border-r border-muted-foreground/20 bg-muted/10"
        style={{
          display: "none",
          backgroundImage:
            "repeating-linear-gradient(135deg, transparent 0 7px, rgba(148,163,184,0.14) 7px 8px)",
        }}
        aria-hidden="true"
      >
        <span
          ref={emptyLabelRef}
          className="rounded bg-background/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 transition-opacity"
          style={{ opacity: 0 }}
        >
          Collecting history
        </span>
      </div>
      {tooltip.visible && tooltip.phases && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-xl border border-white/10 bg-card/70 px-3 py-2 text-xs backdrop-blur-md shadow-xl shadow-black/40 min-w-[160px]"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="font-mono text-muted-foreground tabular-nums">
              {tooltip.time}
            </span>
            <span className="font-mono text-foreground tabular-nums font-medium">
              {tooltip.phases.total == null ? "—" : `${tooltip.phases.total} ms`}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {PHASE_BANDS.map((b) => {
              const v = tooltip.phases![b.key];
              const swatchVar = `var(${b.tokenFill}, ${b.fallbackFill})`;
              return (
                <div
                  key={b.key}
                  className="flex items-center justify-between gap-3 font-mono tabular-nums text-[11px]"
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: swatchVar }}
                    />
                    {b.label}
                  </span>
                  <span className="text-foreground">
                    {typeof v === 'number' ? `${v} ms` : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default PhaseStackChart;
