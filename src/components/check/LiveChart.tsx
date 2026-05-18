"use client";

import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartPoint } from "@/lib/ws-protocol";

interface LiveChartProps {
  points: ChartPoint[];
  windowMs?: number;
  /**
   * How far back from "now" the right edge of the visible window sits,
   * in ms. 0 (default) keeps the chart pinned to live. > 0 lets a
   * navigator/brush shift the view backwards while the buffer keeps
   * filling on the right.
   */
  offsetMs?: number;
  className?: string;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const SAMPLE_ANIM_MS = 650;
const Y_RANGE_ANIM_MS = 550;

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
 * The 1-second forward tolerance handles two timing edge cases:
 *   1. VPS↔browser clock skew — a fresh probe's `lastChecked` can
 *      arrive a few hundred ms ahead of the browser's `Date.now()`.
 *   2. RAF-vs-WS timing — `setData` runs immediately on the WS frame,
 *      but the X scale only advances on the next animation tick, so
 *      for one frame the new probe sits past the stale `xMax`.
 * Both would otherwise drop a freshly-landed spike out of Y bounds.
 * We deliberately don't "always include the latest sample" — when the
 * brush is panned back in time, the latest probe sits far past the
 * visible window and would skew the Y range away from the slice the
 * user is actually looking at.
 */
function visibleRange(u: uPlot): [number, number] {
  const xMin = u.scales.x.min;
  const xMax = u.scales.x.max;
  if (xMin == null || xMax == null) return [0, 100];
  const xs = u.data[0];
  const ys = u.data[1] as (number | null)[];
  const epsilon = 1;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (x < xMin || x > xMax + epsilon) continue;
    const v = ys[i];
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return [0, 100];
  const observed = Math.max(max - min, 1);
  // 30% headroom keeps spikes from riding the edges and gives the
  // Y-range tween enough slack that mid-flight frames don't clip
  // historical samples that already sit at the new target's bounds.
  const pad = Math.max(observed * 0.3, 4);
  const lo = Math.max(0, Math.floor(min - pad));
  let hi = Math.ceil(max + pad);
  // Floor the visible span so a near-flat series doesn't render as a
  // hyper-zoomed strip where every jitter looks like a spike.
  if (hi - lo < 20) hi = lo + 20;
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
  offsetMs = 0,
  className,
}: LiveChartProps) {
  // Mirror props into refs so the long-lived RAF loop / uPlot range fn
  // reads the latest values without re-creating the plot each time the
  // brush moves.
  const windowMsRef = React.useRef(windowMs);
  const offsetMsRef = React.useRef(offsetMs);
  const pointsRef = React.useRef<ChartPoint[]>(points);
  React.useEffect(() => {
    windowMsRef.current = windowMs;
    offsetMsRef.current = offsetMs;
  }, [windowMs, offsetMs]);
  React.useEffect(() => {
    pointsRef.current = points;
    const nextLast = points.length > 0 ? points[points.length - 1] : null;
    const prevLast = prevLastSampleRef.current;
    if (
      nextLast &&
      prevLast &&
      nextLast.t !== prevLast.t &&
      prevLast.rt != null &&
      nextLast.rt != null &&
      prevLast.rt !== nextLast.rt
    ) {
      // If a tween is still in flight, start the next one from its
      // current displayed value so rapid-fire probes don't pop backwards
      // between transitions.
      const inflight = lastSampleAnimRef.current;
      let fromY = prevLast.rt;
      if (inflight) {
        const elapsed = performance.now() - inflight.startTime;
        const t = Math.min(1, elapsed / SAMPLE_ANIM_MS);
        const eased = 1 - Math.pow(1 - t, 3);
        fromY = inflight.fromY + (inflight.toY - inflight.fromY) * eased;
      }
      lastSampleAnimRef.current = {
        startTime: performance.now(),
        fromY,
        toY: nextLast.rt,
      };
    }
    prevLastSampleRef.current = nextLast ? { t: nextLast.t, rt: nextLast.rt } : null;
  }, [points]);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const plotRef = React.useRef<uPlot | null>(null);
  // "Collecting history" overlay — covers the portion of the visible
  // window that sits before the earliest sample we have. Sized in the
  // RAF loop against uPlot's plot bbox so it tracks the X scale
  // smoothly instead of re-rendering every frame.
  const emptyOverlayRef = React.useRef<HTMLDivElement>(null);
  const emptyLabelRef = React.useRef<HTMLSpanElement>(null);
  // When a fresh probe lands with a different rt than the previous
  // sample, tween the last sample's Y from old to new over
  // SAMPLE_ANIM_MS so the step grows in smoothly instead of snapping.
  // The path is already rebuilt every RAF tick (via setScale("x")), so
  // the tween advances on its own — the path builder just reads the
  // ref and overrides the y at idx1.
  const lastSampleAnimRef = React.useRef<{
    startTime: number;
    fromY: number;
    toY: number;
  } | null>(null);
  const prevLastSampleRef = React.useRef<{ t: number; rt: number | null } | null>(null);
  // Y-axis range tween. When the dynamic-fit target changes (a spike
  // enters or leaves the window, or the new sample expands the bounds),
  // we ease between the previous displayed range and the new target so
  // the chart doesn't snap. The `y.range` callback is invoked on every
  // redraw, and the RAF loop redraws via setScale("x") every frame —
  // so returning an interpolated [lo, hi] is enough to animate.
  const yAnimRef = React.useRef<{
    startTime: number;
    fromLo: number;
    fromHi: number;
    toLo: number;
    toHi: number;
  } | null>(null);
  const lastYTargetRef = React.useRef<{ lo: number; hi: number } | null>(null);
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

    // Custom rounded-step path. Same shape semantics as uPlot's stepped
    // builder with align: 1 (each value extends forward from its sample),
    // but the L-shaped corners are replaced with quadratic curves so the
    // line reads as a softened waveform rather than sharp 90° turns.
    // lineJoin: "round" alone is invisible at 1.5px stroke width — the
    // curvature has to be baked into the path itself.
    const dpr = window.devicePixelRatio || 1;
    const cornerRadius = 8 * dpr; // canvas px (positions are DPR-scaled)

    const roundedSteppedPath: uPlot.Series.PathBuilder = (
      u,
      seriesIdx,
      idx0,
      idx1,
    ) => {
      const xs = u.data[0];
      const ys = u.data[seriesIdx] as (number | null)[];
      const stroke = new Path2D();
      const fill = new Path2D();
      const bbox = (u as unknown as {
        bbox: { top: number; left: number; width: number; height: number };
      }).bbox;
      const plotBottom = bbox.top + bbox.height;

      let i = idx0;
      while (i <= idx1 && ys[i] == null) i++;
      if (i > idx1) return { stroke, fill };

      let prevPx = u.valToPos(xs[i], "x", true);
      let prevPy = u.valToPos(ys[i] as number, "y", true);
      stroke.moveTo(prevPx, prevPy);
      fill.moveTo(prevPx, plotBottom);
      fill.lineTo(prevPx, prevPy);

      // Track the Path2D's actual current pen position so a "step at the
      // last sample" (which leaves the pen at xPx + r) blends seamlessly
      // into the extension-to-now segment below — no sharp join.
      let penPx = prevPx;
      let penPy = prevPy;

      for (i = i + 1; i <= idx1; i++) {
        const yv = ys[i];
        if (yv == null) {
          fill.lineTo(penPx, plotBottom);
          let next = i + 1;
          while (next <= idx1 && ys[next] == null) next++;
          if (next > idx1) break;
          prevPx = u.valToPos(xs[next], "x", true);
          prevPy = u.valToPos(ys[next] as number, "y", true);
          stroke.moveTo(prevPx, prevPy);
          fill.moveTo(prevPx, plotBottom);
          fill.lineTo(prevPx, prevPy);
          penPx = prevPx;
          penPy = prevPy;
          i = next;
          continue;
        }
        const xPx = u.valToPos(xs[i], "x", true);
        let drawY: number = yv;
        if (i === idx1) {
          const anim = lastSampleAnimRef.current;
          if (anim) {
            const elapsed = performance.now() - anim.startTime;
            if (elapsed >= SAMPLE_ANIM_MS) {
              lastSampleAnimRef.current = null;
            } else {
              const t = elapsed / SAMPLE_ANIM_MS;
              const eased = 1 - Math.pow(1 - t, 3);
              drawY = anim.fromY + (anim.toY - anim.fromY) * eased;
            }
          }
        }
        const yPx = u.valToPos(drawY, "y", true);

        if (Math.abs(yPx - prevPy) < 0.5) {
          stroke.lineTo(xPx, prevPy);
          fill.lineTo(xPx, prevPy);
          penPx = xPx;
          penPy = prevPy;
        } else {
          const dx = xPx - prevPx;
          const dy = yPx - prevPy;
          const r = Math.min(cornerRadius, Math.abs(dx) / 2, Math.abs(dy) / 2);
          const sy = Math.sign(dy);
          // Horizontal in, curve down/up, vertical, curve back to horizontal.
          stroke.lineTo(xPx - r, prevPy);
          fill.lineTo(xPx - r, prevPy);
          stroke.quadraticCurveTo(xPx, prevPy, xPx, prevPy + sy * r);
          fill.quadraticCurveTo(xPx, prevPy, xPx, prevPy + sy * r);
          stroke.lineTo(xPx, yPx - sy * r);
          fill.lineTo(xPx, yPx - sy * r);
          stroke.quadraticCurveTo(xPx, yPx, xPx + r, yPx);
          fill.quadraticCurveTo(xPx, yPx, xPx + r, yPx);
          penPx = xPx + r;
          penPy = yPx;
        }
        prevPx = xPx;
        prevPy = yPx;
      }

      // Extend the path horizontally to "now" so we don't show a growing
      // dead zone between probes. Folded into the path builder (rather
      // than a drawSeries hook) so the join with the last step's rounded
      // corner stays smooth instead of seaming into a sharp 90°. Skip
      // when the last sample is null — a failed probe's gap is
      // meaningful and should remain visible.
      const lastY = ys[idx1];
      const scaleMax = u.scales.x.max;
      if (lastY != null && scaleMax != null) {
        const scaleMaxPx = u.valToPos(scaleMax, "x", true);
        if (scaleMaxPx > penPx) {
          stroke.lineTo(scaleMaxPx, penPy);
          fill.lineTo(scaleMaxPx, penPy);
          fill.lineTo(scaleMaxPx, plotBottom);
        } else {
          fill.lineTo(penPx, plotBottom);
        }
      } else {
        fill.lineTo(penPx, plotBottom);
      }
      fill.closePath();
      return { stroke, fill };
    };

    const opts: uPlot.Options = {
      width: Math.max(50, Math.floor(width)),
      height: Math.max(50, Math.floor(height)),
      padding: [16, 12, 0, 0],
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
        // Round the stepped path's corners. uPlot strokes series with
        // whatever join is on the ctx; default is "miter" (sharp). This
        // fires after the canvas is cleared but before any series draw,
        // so the join sticks for the series stroke that follows.
        drawClear: [
          (u) => {
            u.ctx.lineJoin = "round";
            u.ctx.lineCap = "round";
          },
        ],
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
          range: (u) => {
            const [targetLo, targetHi] = visibleRange(u);
            const lastTarget = lastYTargetRef.current;
            if (!lastTarget) {
              // Initial display — snap, don't animate from a placeholder.
              lastYTargetRef.current = { lo: targetLo, hi: targetHi };
              return [targetLo, targetHi];
            }
            if (targetLo !== lastTarget.lo || targetHi !== lastTarget.hi) {
              // Target moved. Start a new tween from the currently
              // displayed range so a mid-flight redirect doesn't pop
              // back to the previous target.
              const inflight = yAnimRef.current;
              let fromLo = lastTarget.lo;
              let fromHi = lastTarget.hi;
              if (inflight) {
                const elapsed = performance.now() - inflight.startTime;
                const t = Math.min(1, elapsed / Y_RANGE_ANIM_MS);
                const eased = 1 - Math.pow(1 - t, 3);
                fromLo = inflight.fromLo + (inflight.toLo - inflight.fromLo) * eased;
                fromHi = inflight.fromHi + (inflight.toHi - inflight.fromHi) * eased;
              }
              yAnimRef.current = {
                startTime: performance.now(),
                fromLo,
                fromHi,
                toLo: targetLo,
                toHi: targetHi,
              };
              lastYTargetRef.current = { lo: targetLo, hi: targetHi };
            }
            const anim = yAnimRef.current;
            if (anim) {
              const elapsed = performance.now() - anim.startTime;
              if (elapsed >= Y_RANGE_ANIM_MS) {
                yAnimRef.current = null;
                return [anim.toLo, anim.toHi];
              }
              const t = elapsed / Y_RANGE_ANIM_MS;
              const eased = 1 - Math.pow(1 - t, 3);
              const lo = anim.fromLo + (anim.toLo - anim.fromLo) * eased;
              const hi = anim.fromHi + (anim.toHi - anim.fromHi) * eased;
              // Never let the displayed range be tighter than the
              // target — otherwise an expanding range clips data while
              // the tween catches up (spikes/troughs fall off-canvas).
              // Effectively: snap on expand, animate on contract.
              return [Math.min(lo, targetLo), Math.max(hi, targetHi)];
            }
            return [targetLo, targetHi];
          },
        },
      },
      series: [
        {},
        {
          stroke: lineColor,
          width: 1.5,
          spanGaps: false,
          paths: roundedSteppedPath,
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
            // Read from the (tweened) scale rather than the raw target
            // so the min/max labels track the Y-range animation. Round
            // so labels don't show jittery fractional ms during the tween.
            const lo = u.scales.y.min;
            const hi = u.scales.y.max;
            if (lo == null || hi == null) return [];
            return [Math.round(lo), Math.round(hi)];
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
      const now = Date.now();
      if (plot) {
        const max = (now - offsetMsRef.current) / 1000;
        plot.setScale("x", {
          min: max - windowMsRef.current / 1000,
          max,
        });
      }
      // Empty-region overlay: positioned to the plot area's left edge,
      // width = fraction of the visible window that sits before the
      // earliest sample. Read uPlot's bbox so the overlay aligns with
      // the plot rectangle (inside top padding + right Y-axis gutter).
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
        const earliest = pts.length > 0 ? pts[0].t : visMax;
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
      {/* "No data here yet" treatment for the portion of the visible
          window that sits before the earliest buffered sample. Same
          visual language as the navigator below. */}
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
