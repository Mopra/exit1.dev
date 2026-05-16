"use client";

import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartPoint } from "@/lib/ws-protocol";

interface LiveChartProps {
  points: ChartPoint[];
  /**
   * Span of time the X axis should always show. Defaults to 1h. Without
   * this, the chart auto-fits to the data and a sparsely-populated view
   * looks wrong.
   */
  windowMs?: number;
  className?: string;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/**
 * uPlot wants data in **column-oriented** form:
 *   [ [t0, t1, ...], [rt0, rt1, ...] ]
 *
 * Timestamps are seconds with `time: true` on the X scale — uPlot's tick
 * formatter renders them as clock values automatically. ms-precision is
 * preserved by passing fractional seconds.
 */
type UplotData = [number[], (number | null)[]];

function toUplotData(points: ChartPoint[]): UplotData {
  const t = new Array<number>(points.length);
  const rt = new Array<number | null>(points.length);
  for (let i = 0; i < points.length; i++) {
    t[i] = points[i].t / 1000;
    rt[i] = points[i].rt;
  }
  return [t, rt];
}

/**
 * Single-tier X axis formatter. uPlot's default time formatter shows a
 * secondary "date / hour" label that snaps in when the chart crosses
 * minute or day boundaries — visually distracting on a continuously-
 * scrolling chart. We pick HH:MM:SS for short windows, HH:MM for longer.
 */
function formatTimeFor(windowMs: number) {
  const useSeconds = windowMs < 5 * 60 * 1000;
  return (_u: uPlot, vals: number[]): string[] => {
    return vals.map((sec) => {
      const d = new Date(sec * 1000);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      if (!useSeconds) return `${hh}:${mm}`;
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${hh}:${mm}:${ss}`;
    });
  };
}

const MAX_X_TICKS = 10;

/**
 * Place X axis ticks at the timestamps of actual probe completions, not
 * at uPlot's auto-generated "nice" intervals. For high-density data
 * (e.g. 15s probes over a 24h window → 5760 points) we thin out evenly
 * so labels don't overlap, capped at MAX_X_TICKS.
 */
function dataPointSplits(
  u: uPlot,
  _axisIdx: number,
  scaleMin: number,
  scaleMax: number,
): number[] {
  const xs = u.data[0];
  if (!xs || xs.length === 0) return [];
  // Find the visible slice via linear scan. The data is sorted by t, so
  // a single pass picks up the range; we don't need a binary search at
  // the size this chart handles.
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
 * Compute the visible-window Y range with the same logic as the recharts
 * version: ignore nulls, clamp at 0, round to integers, enforce a 5ms
 * minimum band so a perfectly-stable check still shows a sensible axis.
 *
 * Called by uPlot on every scale update — it must be cheap (linear scan
 * over the data array, which is bounded by the 24h retention cap).
 */
function visibleYRange(u: uPlot): [number, number] {
  const xMin = u.scales.x.min;
  const xMax = u.scales.x.max;
  if (xMin == null || xMax == null) return [0, 100];
  const xs = u.data[0];
  const ys = u.data[1] as (number | null)[];
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < xMin || xs[i] > xMax) continue;
    const v = ys[i];
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return [0, 100];
  const observed = Math.max(max - min, 1);
  const pad = Math.max(observed * 0.2, 1);
  let lo = Math.max(0, Math.floor(min - pad));
  let hi = Math.ceil(max + pad);
  if (hi - lo < 5) hi = lo + 5;
  return [lo, hi];
}

export function LiveChart({
  points,
  windowMs = DEFAULT_WINDOW_MS,
  className,
}: LiveChartProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const plotRef = React.useRef<uPlot | null>(null);

  // Construct the plot once on mount. Subsequent updates flow through
  // setData / setScale — both are cheap and don't re-create canvas state.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // uPlot writes to canvas via ctx.fillStyle / strokeStyle — those
    // accept color strings but NOT `var(--token)` (the CSS engine has no
    // hook into the canvas API to resolve them). Resolve the design-system
    // tokens here, with sensible dark-theme fallbacks if a variable is
    // missing.
    const cs = getComputedStyle(container);
    const resolve = (token: string, fallback: string): string => {
      const v = cs.getPropertyValue(token).trim();
      return v || fallback;
    };
    const lineColor = resolve("--chart-5", "#60a5fa");
    const axisColor = resolve("--muted-foreground", "#9ca3af");
    const gridColor = resolve("--border", "#374151");

    const { width, height } = container.getBoundingClientRect();

    const opts: uPlot.Options = {
      width: Math.max(50, Math.floor(width)),
      height: Math.max(50, Math.floor(height)),
      // Disable cursor crosshair drag — gives true 60fps continuous
      // motion without uPlot's default zoom interactions interfering.
      cursor: { show: true, drag: { x: false, y: false } },
      legend: { show: false },
      hooks: {
        // After the data line is drawn, extend it horizontally from the
        // last probe to the right edge ("now") so the chart never has a
        // gap waiting for the next probe — the most-recent rt value
        // persists visually until the next sample replaces it. This is
        // strictly a paint-time concern: we don't touch `data`, so X
        // axis splits and point markers stay anchored to real probes.
        drawSeries: [
          (u, seriesIdx) => {
            if (seriesIdx !== 1) return;
            const xs = u.data[0];
            const ys = u.data[1] as (number | null)[];
            if (!xs || xs.length === 0) return;
            const lastIdx = xs.length - 1;
            const lastX = xs[lastIdx];
            const lastY = ys[lastIdx];
            // A failed probe (rt: null) shouldn't get a continuation —
            // the gap correctly communicates "we have no value to hold".
            if (lastX == null || lastY == null) return;
            const scaleMax = u.scales.x.max;
            if (scaleMax == null || lastX >= scaleMax) return;
            const ctx = u.ctx;
            // valToPos with `true` returns canvas pixels — what ctx draw
            // calls expect — accounting for devicePixelRatio.
            const x1 = u.valToPos(lastX, "x", true);
            const x2 = u.valToPos(scaleMax, "x", true);
            const y = u.valToPos(lastY, "y", true);
            ctx.save();
            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(x2, y);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
      scales: {
        x: {
          time: true,
          range: () => {
            const n = Date.now() / 1000;
            return [n - windowMs / 1000, n];
          },
        },
        y: {
          range: (u) => visibleYRange(u),
        },
      },
      series: [
        // X series — uPlot defaults are fine.
        {},
        {
          stroke: lineColor,
          width: 2,
          spanGaps: false, // null rt → render a gap, not a connecting line
          // Visible dot at each probe completion. uPlot auto-hides when
          // density would crowd them; we set an explicit size so sparse
          // cadences (5+ min checks) get readable markers.
          points: { show: true, size: 6, stroke: lineColor, fill: lineColor },
        },
      ],
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 0.5 },
          ticks: { stroke: gridColor, width: 0.5 },
          font: "11px ui-sans-serif, system-ui, sans-serif",
          values: formatTimeFor(windowMs),
          splits: dataPointSplits,
        },
        {
          stroke: axisColor,
          grid: { stroke: gridColor, width: 0.5 },
          ticks: { stroke: gridColor, width: 0.5 },
          font: "11px ui-sans-serif, system-ui, sans-serif",
          size: 56,
          values: (_u, vals) => vals.map((v) => `${v}ms`),
        },
      ],
    };

    const plot = new uPlot(opts, toUplotData(points), container);
    plotRef.current = plot;

    return () => {
      plot.destroy();
      plotRef.current = null;
    };
    // We intentionally exclude `points` and `windowMs` — those flow
    // through the dedicated effects below without rebuilding the plot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update data when `points` changes. setData triggers a redraw against
  // the current scale, which is what we want.
  React.useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData(toUplotData(points));
  }, [points]);

  // Continuous scroll. RAF updates the X scale every frame; uPlot
  // efficiently re-renders only the visible region. Browsers throttle
  // RAF when the tab is backgrounded.
  React.useEffect(() => {
    let rafId = 0;
    const loop = () => {
      const plot = plotRef.current;
      if (plot) {
        const n = Date.now() / 1000;
        plot.setScale("x", { min: n - windowMs / 1000, max: n });
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [windowMs]);

  // Resize: uPlot needs an explicit setSize call when the container
  // changes. ResizeObserver fires on every dimension change including
  // the initial layout.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      const plot = plotRef.current;
      if (!plot) return;
      const { width, height } = entries[0].contentRect;
      plot.setSize({
        width: Math.max(50, Math.floor(width)),
        height: Math.max(50, Math.floor(height)),
      });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={`h-full w-full ${className ?? ""}`}
      aria-label="Response time chart"
    />
  );
}

export default LiveChart;
