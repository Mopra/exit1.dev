"use client";

import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartPoint } from "@/lib/ws-protocol";

interface LiveChartProps {
  points: ChartPoint[];
  windowMs?: number;
  className?: string;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

type UplotData = [number[], (number | null)[], (number | null)[]];

function toUplotData(points: ChartPoint[]): UplotData {
  const t = new Array<number>(points.length);
  const rt = new Array<number | null>(points.length);
  const sc = new Array<number | null>(points.length);
  for (let i = 0; i < points.length; i++) {
    t[i] = points[i].t / 1000;
    rt[i] = points[i].rt;
    sc[i] = points[i].sc ?? null;
  }
  return [t, rt, sc];
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

/**
 * Cap the bottom-axis tick count and snap to actual probe timestamps so
 * labels never bunch up on dense windows. We thin evenly rather than
 * picking "nice" intervals so each label corresponds to a real sample.
 */
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
 * Visible-window range with padding. Drives the Y scale and the
 * right-edge min/max labels.
 *
 * Critical detail: the most recent point is ALWAYS included, even if
 * its timestamp sits past the current scale max. Two cases make that
 * matter:
 *   1. VPS↔browser clock skew — a fresh probe's `lastChecked` can
 *      arrive a few hundred ms ahead of the browser's `Date.now()`.
 *   2. RAF-vs-WS timing — `setData` runs immediately on the WS frame,
 *      but the X scale only advances on the next animation tick, so
 *      for one frame the new probe sits past the stale `xMax`.
 * Either case would otherwise filter the latest sample out of Y
 * bounds and clip a spike that just landed at the right edge.
 */
function visibleRange(u: uPlot): [number, number] {
  const xMin = u.scales.x.min;
  const xMax = u.scales.x.max;
  if (xMin == null || xMax == null) return [0, 100];
  const xs = u.data[0];
  const ys = u.data[1] as (number | null)[];
  const lastIdx = xs.length - 1;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    // Always include the newest sample; otherwise apply the window filter.
    if (i !== lastIdx && (x < xMin || x > xMax)) continue;
    const v = ys[i];
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return [0, 100];
  const observed = Math.max(max - min, 1);
  const pad = Math.max(observed * 0.2, 1);
  const lo = Math.max(0, Math.floor(min - pad));
  let hi = Math.ceil(max + pad);
  if (hi - lo < 5) hi = lo + 5;
  return [lo, hi];
}

interface TooltipState {
  visible: boolean;
  // canvas-relative px (CSS pixels, NOT device pixels)
  left: number;
  top: number;
  time: string;
  rt: number | null;
  sc: number | null;
}

const TOOLTIP_INITIAL: TooltipState = {
  visible: false,
  left: 0,
  top: 0,
  time: "",
  rt: null,
  sc: null,
};

export function LiveChart({
  points,
  windowMs = DEFAULT_WINDOW_MS,
  className,
}: LiveChartProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const plotRef = React.useRef<uPlot | null>(null);
  const [tooltip, setTooltip] = React.useState<TooltipState>(TOOLTIP_INITIAL);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Canvas APIs (fillStyle / strokeStyle) don't resolve CSS vars; pull
    // values once here with dark-theme fallbacks.
    const cs = getComputedStyle(container);
    const resolve = (token: string, fallback: string): string => {
      const v = cs.getPropertyValue(token).trim();
      return v || fallback;
    };
    const lineColor = resolve("--chart-1", "#a5b4fc");
    const axisColor = resolve("--muted-foreground", "#9ca3af");

    /**
     * Build a translucent variant of `color`. `color-mix(..., transparent)`
     * is unreliable inside canvas gradient stops on some browsers (silently
     * returns a fully-transparent stop), so we splice an alpha into the
     * oklch() value directly. Falls back to color-mix for non-oklch inputs.
     */
    const withAlpha = (color: string, alpha: number): string => {
      const m = color.match(/^oklch\(([^)]+)\)$/i);
      if (m) return `oklch(${m[1]} / ${alpha})`;
      return `color-mix(in oklch, ${color} ${Math.round(alpha * 100)}%, transparent)`;
    };
    const fillTopColor = withAlpha(lineColor, 0.42);
    const fillBottomColor = withAlpha(lineColor, 0);

    const { width, height } = container.getBoundingClientRect();

    // Stepped paths give the Task-Manager waveform shape. align: 1 places
    // the step transition at the *new* sample, so each rt value extends
    // forward in time — matching the "this is the current value" feel.
    const steppedPath = uPlot.paths.stepped!({ align: 1 });

    const opts: uPlot.Options = {
      width: Math.max(50, Math.floor(width)),
      height: Math.max(50, Math.floor(height)),
      padding: [16, 0, 0, 0],
      // Crosshair: keep only the vertical guide; styled near-invisible by
      // CSS below. Disable drag-to-zoom so motion stays smooth.
      cursor: {
        show: true,
        x: true,
        y: false,
        drag: { x: false, y: false },
        points: { show: false },
      },
      legend: { show: false },
      hooks: {
        // Tooltip + cursor sync. Fired on every pointer move. We bail
        // when the cursor is off-chart or the indexed sample is null.
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            const leftPx = u.cursor.left;
            if (idx == null || idx < 0 || leftPx == null || leftPx < 0) {
              setTooltip((prev) => (prev.visible ? TOOLTIP_INITIAL : prev));
              return;
            }
            const t = u.data[0][idx];
            const rt = (u.data[1] as (number | null)[])[idx];
            const sc = (u.data[2] as (number | null)[])[idx];
            if (t == null) return;
            // Anchor tooltip to the data point's x (snapped), but place
            // it just above the cursor's y so it tracks vertically.
            const xPx = u.valToPos(t, "x", false);
            const yPx = u.cursor.top ?? 0;
            setTooltip({
              visible: true,
              left: xPx,
              top: yPx,
              time: formatClock(t * 1000, true),
              rt,
              sc,
            });
          },
        ],
        // After uPlot finishes drawing the line, extend it horizontally
        // from the last probe to "now" (right edge). Without this the
        // chart shows a growing dead zone while waiting for the next
        // probe. Skip for failed probes — the gap there is meaningful.
        drawSeries: [
          (u, seriesIdx) => {
            if (seriesIdx !== 1) return;
            const xs = u.data[0];
            const ys = u.data[1] as (number | null)[];
            if (!xs || xs.length === 0) return;
            const lastIdx = xs.length - 1;
            const lastX = xs[lastIdx];
            const lastY = ys[lastIdx];
            if (lastX == null || lastY == null) return;
            const scaleMax = u.scales.x.max;
            if (scaleMax == null || lastX >= scaleMax) return;
            const ctx = u.ctx;
            const x1 = u.valToPos(lastX, "x", true);
            const x2 = u.valToPos(scaleMax, "x", true);
            const y = u.valToPos(lastY, "y", true);
            const dpr = window.devicePixelRatio || 1;

            // Stroke (line continuation)
            ctx.save();
            ctx.strokeStyle = lineColor;
            ctx.lineWidth = 1.5 * dpr;
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(x2, y);
            ctx.stroke();
            ctx.restore();

            // Fill (gradient under the continuation)
            const bbox = (u as unknown as { bbox: { top: number; height: number } }).bbox;
            const plotTop = bbox.top;
            const plotBottom = bbox.top + bbox.height;
            const grad = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
            grad.addColorStop(0, fillTopColor);
            grad.addColorStop(1, fillBottomColor);
            ctx.save();
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(x2, y);
            ctx.lineTo(x2, plotBottom);
            ctx.lineTo(x1, plotBottom);
            ctx.closePath();
            ctx.fill();
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
          range: (u) => visibleRange(u),
        },
      },
      series: [
        {},
        {
          stroke: lineColor,
          width: 1.5,
          spanGaps: false,
          paths: steppedPath,
          points: { show: false },
          // Area fill — vertical gradient from line tint to transparent.
          // Recomputed per draw because the plot bbox can change on resize.
          fill: (u) => {
            const ctx = u.ctx;
            const bbox = (u as unknown as { bbox: { top: number; height: number } }).bbox;
            const top = bbox.top;
            const bottom = bbox.top + bbox.height;
            const grad = ctx.createLinearGradient(0, top, 0, bottom);
            grad.addColorStop(0, fillTopColor);
            grad.addColorStop(1, fillBottomColor);
            return grad;
          },
        },
        // 3rd series exists only as a data column for tooltip lookups —
        // never drawn. `show: false` keeps it out of the legend and
        // skips its draw pass entirely.
        {
          show: false,
          scale: "y",
        },
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
          // Right-edge axis: only the min/max of the visible range.
          // Floating, no grid, no ticks. Like the reference.
          side: 1,
          stroke: axisColor,
          grid: { show: false },
          ticks: { show: false },
          font: '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          size: 52,
          gap: 8,
          splits: (u) => {
            const [lo, hi] = visibleRange(u);
            return [lo, hi];
          },
          values: (_u, vals) => vals.map((v) => `${v} ms`),
        },
      ],
    };

    const plot = new uPlot(opts, toUplotData(points), container);
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
    plot.setData(toUplotData(points));
  }, [points]);

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
      className={`relative h-full w-full live-chart ${className ?? ""}`}
      aria-label="Response time chart"
    >
      {tooltip.visible && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-xl border border-white/10 bg-card/70 px-3 py-2 text-xs backdrop-blur-md shadow-xl shadow-black/40"
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <div className="flex items-center gap-3">
            <span className="font-mono text-muted-foreground tabular-nums">
              {tooltip.time}
            </span>
            <span className="font-mono text-foreground tabular-nums font-medium">
              {tooltip.rt == null ? "—" : `${tooltip.rt} ms`}
            </span>
            {tooltip.sc != null && (
              <span
                className={`font-mono tabular-nums ${
                  tooltip.sc >= 200 && tooltip.sc < 400
                    ? "text-primary"
                    : "text-destructive"
                }`}
              >
                {tooltip.sc}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default LiveChart;
