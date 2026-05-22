"use client";

import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartPoint, StateSegment } from "@/lib/ws-protocol";
import type { Tier } from "@/lib/probe-tiers";

interface LiveChartProps {
  points: ChartPoint[];
  /**
   * State segments (maintenance / disabled) overlayed as shaded bands.
   * Optional — defaults to empty so callers that don't pipe segments
   * through still render unchanged.
   */
  segments?: StateSegment[];
  windowMs?: number;
  /**
   * How far back from "now" the right edge of the visible window sits,
   * in ms. 0 (default) keeps the chart pinned to live. > 0 lets a
   * navigator/brush shift the view backwards while the buffer keeps
   * filling on the right.
   */
  offsetMs?: number;
  /**
   * Drag-to-zoom callback. Fired with offsets-from-now (ms) for the
   * left and right edges of the user's drag selection. Parent is
   * expected to update its brush state — uPlot's own scale is left
   * alone (setScale: false on the cursor drag config) so the chart
   * stays in sync with the parent-driven window.
   */
  onZoom?: (leftOffsetMs: number, rightOffsetMs: number) => void;
  /** Currently-selected probe timestamp (ms epoch), or null. Drives a
   *  persistent marker (vertical guide + ring) drawn at the probe's
   *  rendered position. Mirrors the highlight in the probe table. */
  selectedT?: number | null;
  /** Click handler. Receives the nearest probe's timestamp (ms epoch).
   *  Bubbles up to LiveCheck which toggles `selectedT`. */
  onSelectProbe?: (t: number) => void;
  /** Per-probe row tier (timestamp → 'elevated' | 'spike'). Drives the
   *  small amber/red outlier dots drawn over the line so the chart
   *  visually agrees with the table's row tints. Only probes that
   *  classify as non-normal need to be in the map. */
  tierByT?: Map<number, Tier>;
  className?: string;
}

type BandKind = 'down' | 'maintenance' | 'disabled';
interface Band {
  /** Stable React key. `kind|startMs` is unique because (a) each state
   *  kind has at most one open segment at a time per check, and (b) down
   *  runs are derived from points sorted by time. */
  id: string;
  kind: BandKind;
  /** Band start ms epoch (inclusive). */
  s: number;
  /** Band end ms epoch (exclusive), or null when the band extends to
   *  "now" (open maintenance/disabled segments). */
  e: number | null;
}

/**
 * Walk points front-to-back collapsing consecutive `st === 'down'` samples
 * into a single Band. The band's end is the timestamp of the first 'up'
 * sample after the run (clean exit); a run that runs off the tail of the
 * buffer (no 'up' yet) is left open (`e: null`) so the RAF renderer
 * extends the band to "now" — matches the visual contract for an
 * unresolved outage. Same treatment that `disabled` / `maintenance` open
 * segments get.
 */
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

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const SAMPLE_ANIM_MS = 650;
const Y_RANGE_ANIM_MS = 550;
// Stable empty default so a caller passing `undefined` doesn't reseat
// the `segmentsProp` reference every render and bust the bands memo.
const EMPTY_SEGMENTS: readonly StateSegment[] = [];

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
  // Locate the first sample at or after xMin so we can include the
  // sample immediately before it: with a stepped path, that anchor
  // value is drawn as a horizontal segment from xMin up to the first
  // in-window sample. Skipping it lets that segment sit above or below
  // the plot area when the off-screen sample's value falls outside the
  // visible min/max.
  let i0 = 0;
  while (i0 < xs.length && xs[i0] < xMin) i0++;
  const start = Math.max(0, i0 - 1);
  for (let i = start; i < xs.length; i++) {
    const x = xs[i];
    if (x > xMax + epsilon) break;
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

interface PhaseSnapshot {
  dn: number | null;
  cn: number | null;
  tl: number | null;
  ft: number | null;
}

interface TooltipState {
  visible: boolean;
  // canvas-relative px (CSS pixels, NOT device pixels)
  left: number;
  top: number;
  time: string;
  rt: number | null;
  sc: number | null;
  // Phase timings — only present for HTTP probes. When all four are
  // null the tooltip omits the breakdown rows entirely (TCP/UDP/ICMP
  // probes etc.).
  phases: PhaseSnapshot | null;
}

const TOOLTIP_INITIAL: TooltipState = {
  visible: false,
  left: 0,
  top: 0,
  time: "",
  rt: null,
  sc: null,
  phases: null,
};

/** Phase swatch tokens — kept in sync with PhaseStackChart.PHASE_BANDS. */
const PHASE_TOOLTIP_ROWS: Array<{
  key: 'dn' | 'cn' | 'tl' | 'ft';
  label: string;
  swatch: string;
}> = [
  { key: 'dn', label: 'DNS', swatch: 'var(--phase-dns, #e7eef8)' },
  { key: 'cn', label: 'Connect', swatch: 'var(--phase-connect, #a8c1e6)' },
  { key: 'tl', label: 'TLS', swatch: 'var(--phase-tls, #6b8ed1)' },
  { key: 'ft', label: 'TTFB', swatch: 'var(--phase-ttfb, #3b5bb5)' },
];

export function LiveChart({
  points,
  segments,
  windowMs = DEFAULT_WINDOW_MS,
  offsetMs = 0,
  onZoom,
  selectedT,
  onSelectProbe,
  tierByT,
  className,
}: LiveChartProps) {
  const segmentsProp = segments ?? EMPTY_SEGMENTS;
  // Mirror props into refs so the long-lived RAF loop / uPlot range fn
  // reads the latest values without re-creating the plot each time the
  // brush moves.
  const windowMsRef = React.useRef(windowMs);
  const offsetMsRef = React.useRef(offsetMs);
  const pointsRef = React.useRef<ChartPoint[]>(points);
  const onZoomRef = React.useRef<LiveChartProps["onZoom"]>(onZoom);
  const selectedTRef = React.useRef<number | null>(selectedT ?? null);
  const onSelectProbeRef =
    React.useRef<LiveChartProps["onSelectProbe"]>(onSelectProbe);
  const tierByTRef = React.useRef<Map<number, Tier> | null>(tierByT ?? null);
  React.useEffect(() => {
    windowMsRef.current = windowMs;
    offsetMsRef.current = offsetMs;
  }, [windowMs, offsetMs]);
  React.useEffect(() => {
    onZoomRef.current = onZoom;
  }, [onZoom]);
  React.useEffect(() => {
    selectedTRef.current = selectedT ?? null;
  }, [selectedT]);
  React.useEffect(() => {
    onSelectProbeRef.current = onSelectProbe;
  }, [onSelectProbe]);
  React.useEffect(() => {
    tierByTRef.current = tierByT ?? null;
  }, [tierByT]);
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
  // The actual rendered line tip in canvas px, written by the path
  // builder after the extension-to-scaleMax step. Sparks + core glow
  // read from this rather than recomputing from data — that keeps the
  // effect glued to what was *drawn*, even when uPlot's idx1 culls a
  // fresh sample due to clock skew (the line then ends at sample N-2,
  // and recomputing from `points[length-1]` would land the dot at the
  // wrong y).
  const lineTipPxRef = React.useRef<{ x: number; y: number } | null>(null);
  // Particle system canvas. Overlays the uPlot canvas, sized to the
  // container in device pixels (matches uPlot's canvas-px coords so we
  // can pass `lineTipPxRef`'s values straight through).
  const sparksCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  // Line color resolved from CSS vars in the mount effect — the RAF
  // loop reads from here because canvas APIs don't resolve CSS vars.
  const lineColorRef = React.useRef<string>("#a5b4fc");
  // Tier dot colors — matched to the table row tints (--warning amber
  // for elevated, --destructive red for spike). Resolved alongside
  // lineColor below so they participate in dark-mode token overrides.
  const tierColorRef = React.useRef<{ elevated: string; spike: string }>({
    elevated: "#f59e0b",
    spike: "#ef4444",
  });
  // Mutable particle pool — kept in a ref so React doesn't re-render
  // on every frame. Each particle is in canvas-px space.
  const particlesRef = React.useRef<
    Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      age: number;
      life: number;
      size: number;
      // 0 = line color, 1 = white. Sampling at emit time avoids per-
      // frame churn and lets us batch draws by color (one save/restore
      // pair per color group instead of per particle).
      hot: boolean;
    }>
  >([]);
  // Last frame timestamp for dt-based particle integration. Tying
  // velocities to wall time (not frames) keeps the trail consistent
  // when the browser drops frames or runs at non-60fps.
  const lastFrameTimeRef = React.useRef<number>(performance.now());
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

  // Bands list — down runs derived from `points`, plus state segments
  // passed in via the `segments` prop. Recomputed on prop change; the
  // RAF loop reads through `bandsRef` so it never needs the dep array
  // refresh.
  const bands = React.useMemo<Band[]>(() => {
    const out = computeDownRuns(points);
    for (const seg of segmentsProp) {
      out.push({
        id: `${seg.k}|${seg.s}`,
        kind: seg.k,
        s: seg.s,
        e: seg.e,
      });
    }
    return out;
  }, [points, segmentsProp]);
  const bandsRef = React.useRef<Band[]>(bands);
  React.useEffect(() => {
    bandsRef.current = bands;
  }, [bands]);
  // Map of band id → DOM node. Callback refs register on mount and
  // unregister on unmount so removed bands don't leak references.
  const bandNodesRef = React.useRef<Map<string, HTMLDivElement>>(new Map());

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
    lineColorRef.current = lineColor;
    tierColorRef.current = {
      elevated: resolve("--warning", "#f59e0b"),
      spike: resolve("--destructive", "#ef4444"),
    };

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
      if (i > idx1) {
        lineTipPxRef.current = null;
        return { stroke, fill };
      }

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
      let tipX = penPx;
      if (lastY != null && scaleMax != null) {
        const scaleMaxPx = u.valToPos(scaleMax, "x", true);
        if (scaleMaxPx > penPx) {
          stroke.lineTo(scaleMaxPx, penPy);
          fill.lineTo(scaleMaxPx, penPy);
          fill.lineTo(scaleMaxPx, plotBottom);
          tipX = scaleMaxPx;
        } else {
          fill.lineTo(penPx, plotBottom);
        }
      } else {
        fill.lineTo(penPx, plotBottom);
      }
      fill.closePath();
      // Record the rendered line tip for the leading-edge glow. Null
      // for null-tail (failed probe) so the glow hides over the gap.
      lineTipPxRef.current = lastY != null ? { x: tipX, y: penPy } : null;
      return { stroke, fill };
    };

    const opts: uPlot.Options = {
      width: Math.max(50, Math.floor(width)),
      height: Math.max(50, Math.floor(height)),
      padding: [16, 0, 0, 0],
      // Crosshair: keep only the vertical guide; styled near-invisible by
      // CSS below. Drag-to-zoom is enabled on X with setScale: false so
      // uPlot doesn't fight the parent-driven window — the setSelect
      // hook below translates the px selection back to ms-from-now and
      // calls onZoom; the parent updates its brush state, and the
      // chart's window follows via the windowMs/offsetMs props.
      cursor: {
        show: true,
        x: true,
        y: false,
        drag: { x: true, y: false, setScale: false, dist: 8 },
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
        // Drag-to-zoom. uPlot fires setSelect on drag release. Translate
        // the px selection to ms-from-now and bubble up; the parent owns
        // the visible window. Clear the selection rectangle immediately
        // so it doesn't linger after the brush updates.
        setSelect: [
          (u) => {
            const sel = u.select;
            if (!sel || sel.width < 4) return;
            const cb = onZoomRef.current;
            if (!cb) return;
            const leftVal = u.posToVal(sel.left, "x");
            const rightVal = u.posToVal(sel.left + sel.width, "x");
            const now = Date.now();
            const leftOffsetMs = now - leftVal * 1000;
            const rightOffsetMs = now - rightVal * 1000;
            cb(leftOffsetMs, rightOffsetMs);
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
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
            // Phase fields aren't in u.data (the uPlot columns are kept
            // minimal). Look up by idx against the live points buffer —
            // toUplotData iterates points in order so the indices align.
            const pts = pointsRef.current;
            const p = pts[idx];
            const hasPhase = !!p && (
              typeof p.dn === 'number' ||
              typeof p.cn === 'number' ||
              typeof p.tl === 'number' ||
              typeof p.ft === 'number'
            );
            const phases: PhaseSnapshot | null = hasPhase
              ? {
                  dn: typeof p.dn === 'number' ? p.dn : null,
                  cn: typeof p.cn === 'number' ? p.cn : null,
                  tl: typeof p.tl === 'number' ? p.tl : null,
                  ft: typeof p.ft === 'number' ? p.ft : null,
                }
              : null;
            setTooltip({
              visible: true,
              left: xPx,
              top: yPx,
              time: formatClock(t * 1000, true),
              rt,
              sc,
              phases,
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
          size: 30,
          gap: 4,
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
      // State-segment + down-run bands. Same plot-bbox-relative
      // positioning as the empty overlay so they track the X scale every
      // frame without React renders. A band whose [s, e] sits entirely
      // outside the visible window is hidden; partially-overlapping
      // bands are clipped to the window edges so the strip doesn't
      // overflow into the Y-axis gutter.
      //
      // Gated on bands.length so the no-bands case (no down runs, no
      // state segments — which is also the case when the VPS hasn't
      // shipped segment support yet) is a literal no-op and can't
      // perturb timing or layout for the rest of the loop.
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
            // Open bands extend to "now"; for closed bands the recorded
            // end is authoritative.
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
          // Defensive: a partial-resize or transient bbox shouldn't kill
          // the RAF loop and freeze the chart. Log once and continue —
          // the next frame will recompute against a fresh bbox.
          console.warn('[LiveChart] band positioning failed:', err);
        }
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
      // Spark/thruster effect at the line's leading edge.
      //
      // Particles spawn at the rendered tip, drift backward (left, with
      // vertical jitter), and fade out — visually reading as embers
      // trailing a rocket. The core hot dot stays pinned to the tip.
      //
      // Emission is gated on isLive + a non-null tip so panning back or
      // looking at a failed-probe gap stops the engine but lets in-flight
      // particles die out naturally for a clean tail-off.
      const sparks = sparksCanvasRef.current;
      const ctx = sparks?.getContext("2d") ?? null;
      if (sparks && ctx) {
        const frameNow = performance.now();
        const dt = Math.min(64, frameNow - lastFrameTimeRef.current);
        lastFrameTimeRef.current = frameNow;
        const dtSec = dt / 1000;
        const dpr = window.devicePixelRatio || 1;
        const tip = lineTipPxRef.current;
        const isLive = offsetMsRef.current === 0;
        const lineColor = lineColorRef.current;
        const particles = particlesRef.current;

        if (isLive && tip) {
          // ~1-2 sparks per 16ms frame — enough density to read as a
          // continuous trail without crowding. Capped to keep a backlog
          // frame from emitting a burst.
          const emit = Math.min(5, Math.max(0, Math.floor(dt / 8)));
          for (let i = 0; i < emit; i++) {
            // ~30% of sparks burn white — reads as hotter flecks
            // mixed into the line-colored trail.
            const hot = Math.random() < 0.3;
            particles.push({
              x: tip.x + (Math.random() - 0.5) * 3.2 * dpr,
              y: tip.y + (Math.random() - 0.5) * 3.2 * dpr,
              // Mix of slow + fast sparks gives the trail visible depth
              // — fast ones streak ahead, slow ones linger near the tip.
              vx: -(32 + Math.random() * 68) * dpr,
              vy: (Math.random() - 0.5) * 40 * dpr,
              age: 0,
              // White sparks burn out faster — keeps them feeling like
              // brief flecks rather than persistent stars in the trail.
              life: (hot ? 320 : 450) + Math.random() * (hot ? 320 : 500),
              // White sparks slightly smaller so they don't dominate.
              size: ((hot ? 0.5 : 0.7) + Math.random() * (hot ? 0.8 : 1.15)) * dpr,
              hot,
            });
          }
        }

        // Safety cap. RAF pauses on hidden tabs so backlog growth is
        // unlikely, but a stray runaway is cheap to guard against.
        if (particles.length > 200) {
          particles.splice(0, particles.length - 200);
        }

        ctx.clearRect(0, 0, sparks.width, sparks.height);
        // Integrate + bucket by color in one pass. Drawing in two
        // color passes (line-color, then white) lets us set fillStyle/
        // shadowColor once per group — those are surprisingly costly
        // when toggled per-particle.
        //
        // The buckets hold particle REFERENCES, not array indices. Earlier
        // versions pushed indices, which became stale the moment a
        // particle splice happened mid-loop — splicing a particle at
        // position i shifts everything > i down by one, so any index
        // already pushed for a higher-position particle now points past
        // the end and drawGroup explodes with `undefined.age`. References
        // sidestep the bookkeeping entirely.
        type Particle = (typeof particles)[number];
        const coolHits: Particle[] = [];
        const hotHits: Particle[] = [];
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          p.age += dt;
          if (p.age >= p.life) {
            particles.splice(i, 1);
            continue;
          }
          p.x += p.vx * dtSec;
          p.y += p.vy * dtSec;
          (p.hot ? hotHits : coolHits).push(p);
        }
        const drawGroup = (
          group: Particle[],
          fill: string,
          shadow: string,
          blur: number,
          alphaCap: number,
        ) => {
          if (group.length === 0) return;
          ctx.save();
          ctx.fillStyle = fill;
          ctx.shadowColor = shadow;
          ctx.shadowBlur = blur * dpr;
          for (const p of group) {
            const t = p.age / p.life;
            // ease-out alpha — sparks linger then drop off, mirroring
            // ember behavior.
            const alpha = (1 - t) * (1 - t) * alphaCap;
            const r = p.size * (1 - t * 0.55);
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        };
        drawGroup(coolHits, lineColor, lineColor, 5.5, 0.92);
        // White sparks get tighter glow (white shadowBlur on a dark bg
        // can over-bloom and read as fog) but a higher alpha cap so
        // they still pop as the hotter flecks.
        drawGroup(hotHits, "#ffffff", "#ffffff", 4, 1);

        if (isLive && tip) {
          ctx.save();
          // Outer halo — the line-colored bloom around the tip.
          ctx.shadowColor = lineColor;
          ctx.shadowBlur = 14 * dpr;
          ctx.fillStyle = lineColor;
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 2.9 * dpr, 0, Math.PI * 2);
          ctx.fill();
          // White-hot core — full bright so it reads as the engine.
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
          ctx.fillStyle = "rgba(255,255,255,0.97)";
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 1.25 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Tier markers — small filled dots for any probe the table
        // would highlight as elevated (amber) or spike (red). Drawn
        // before the selection marker so the active selection ring
        // remains the dominant on-chart cursor. Iterated over the
        // points array (sorted by t) so we can early-exit past the
        // right edge of the visible scale.
        const tierMap = tierByTRef.current;
        if (plot && tierMap && tierMap.size > 0) {
          const scaleMin = plot.scales.x.min;
          const scaleMax = plot.scales.x.max;
          if (scaleMin != null && scaleMax != null) {
            const pts = pointsRef.current;
            const tierColors = tierColorRef.current;
            ctx.save();
            const radius = 3 * dpr;
            const ringRadius = 4 * dpr;
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i];
              const sec = p.t / 1000;
              if (sec < scaleMin) continue;
              if (sec > scaleMax) break;
              const tier = tierMap.get(p.t);
              if (!tier) continue;
              if (p.rt == null) continue;
              const color = tier === 'spike' ? tierColors.spike : tierColors.elevated;
              const xPx = plot.valToPos(sec, "x", true);
              const yPx = plot.valToPos(p.rt, "y", true);
              // Thin contrast ring so the dot stays legible against
              // the line and any tier tint underneath.
              ctx.globalAlpha = 0.9;
              ctx.fillStyle = "rgba(0,0,0,0.55)";
              ctx.beginPath();
              ctx.arc(xPx, yPx, ringRadius, 0, Math.PI * 2);
              ctx.fill();
              ctx.globalAlpha = 1;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(xPx, yPx, radius, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }
        }

        // Selection marker — vertical guide + ring at the chosen
        // probe. Drawn last so it sits above the sparks/tip. The marker
        // sits on its own sample's y, so it always anchors visibly to
        // a real data point even when the live tip is somewhere else.
        const selT = selectedTRef.current;
        if (plot && selT != null) {
          const bbox = (plot as unknown as {
            bbox: { left: number; top: number; width: number; height: number };
          }).bbox;
          const scaleMin = plot.scales.x.min;
          const scaleMax = plot.scales.x.max;
          const selSec = selT / 1000;
          if (scaleMin != null && scaleMax != null && selSec >= scaleMin && selSec <= scaleMax) {
            // Find the probe with the matching timestamp — selectedT is
            // copied from the WS buffer so this lookup is exact, not
            // approximate. Out-of-buffer (probe aged out) falls through
            // and we skip drawing.
            const pts = pointsRef.current;
            let selPt: ChartPoint | null = null;
            for (let i = pts.length - 1; i >= 0; i--) {
              if (pts[i].t === selT) {
                selPt = pts[i];
                break;
              }
            }
            const xPx = plot.valToPos(selSec, "x", true);
            ctx.save();
            // Vertical guide — hair-thin, semi-transparent so the data
            // underneath stays readable.
            ctx.strokeStyle = lineColor;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = 1 * dpr;
            ctx.beginPath();
            ctx.moveTo(xPx, bbox.top);
            ctx.lineTo(xPx, bbox.top + bbox.height);
            ctx.stroke();
            if (selPt && selPt.rt != null) {
              const yPx = plot.valToPos(selPt.rt, "y", true);
              // Ring — solid stroke around a transparent fill so the
              // selected sample reads as "highlighted" without obscuring
              // its value.
              ctx.globalAlpha = 1;
              ctx.lineWidth = 1.75 * dpr;
              ctx.strokeStyle = "#ffffff";
              ctx.shadowColor = lineColor;
              ctx.shadowBlur = 10 * dpr;
              ctx.beginPath();
              ctx.arc(xPx, yPx, 5 * dpr, 0, Math.PI * 2);
              ctx.stroke();
              ctx.shadowBlur = 0;
              ctx.fillStyle = lineColor;
              ctx.globalAlpha = 0.9;
              ctx.beginPath();
              ctx.arc(xPx, yPx, 2 * dpr, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }
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
    const sizeSparks = (width: number, height: number) => {
      const sparks = sparksCanvasRef.current;
      if (!sparks) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(50, Math.floor(width * dpr));
      const h = Math.max(50, Math.floor(height * dpr));
      if (sparks.width !== w) sparks.width = w;
      if (sparks.height !== h) sparks.height = h;
      sparks.style.width = `${Math.floor(width)}px`;
      sparks.style.height = `${Math.floor(height)}px`;
    };
    // Initial sizing — the RO doesn't fire on mount, so without this
    // the sparks canvas would sit at its 300×150 default until the
    // user resized the window.
    const { width: w0, height: h0 } = container.getBoundingClientRect();
    sizeSparks(w0, h0);
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const plot = plotRef.current;
      if (plot) {
        plot.setSize({
          width: Math.max(50, Math.floor(width)),
          height: Math.max(50, Math.floor(height)),
        });
      }
      sizeSparks(width, height);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Click → select nearest probe. Deferred by ~220ms so a double-click
  // (used by the parent for zoom-out) cancels the pending selection
  // instead of toggling it twice. The dblclick listener below cancels
  // the timer; if no dblclick arrives, the selection fires.
  const clickTimerRef = React.useRef<number | null>(null);
  const handleContainerClick = React.useCallback(() => {
    const cb = onSelectProbeRef.current;
    if (!cb) return;
    const plot = plotRef.current;
    if (!plot) return;
    const idx = plot.cursor.idx;
    if (idx == null || idx < 0) return;
    const p = pointsRef.current[idx];
    if (!p) return;
    if (clickTimerRef.current != null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      cb(p.t);
    }, 220);
  }, []);
  const handleContainerDoubleClick = React.useCallback(() => {
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }, []);
  React.useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) window.clearTimeout(clickTimerRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full live-chart ${className ?? ""}`}
      aria-label="Response time chart"
      onClick={handleContainerClick}
      onDoubleClick={handleContainerDoubleClick}
    >
      {/* State-segment + down-run bands. Rendered as siblings of the
          uPlot canvas; positions are imperatively maintained by the RAF
          loop, so React only commits the band set when the underlying
          data changes (band entering/leaving the buffer). Skipped
          entirely when there are no bands so the unused branch can't
          perturb React's reconciliation against the imperatively-added
          uPlot wrapper sibling. */}
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
      <canvas
        ref={sparksCanvasRef}
        className="live-chart-sparks"
        aria-hidden="true"
      />
      {tooltip.visible && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-xl border border-white/10 bg-card/70 px-3 py-2 text-sm backdrop-blur-md shadow-xl shadow-black/40"
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
          {tooltip.phases && (
            <div className="mt-1.5 pt-1.5 border-t border-white/5 flex flex-col gap-0.5">
              {PHASE_TOOLTIP_ROWS.map((row) => {
                const v = tooltip.phases![row.key];
                return (
                  <div
                    key={row.key}
                    className="flex items-center justify-between gap-3 font-mono tabular-nums text-xs"
                  >
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span
                        className="h-2 w-2 rounded-sm"
                        style={{ backgroundColor: row.swatch }}
                      />
                      {row.label}
                    </span>
                    <span className="text-foreground">
                      {typeof v === 'number' ? `${v} ms` : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default LiveChart;
