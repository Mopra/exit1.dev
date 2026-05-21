"use client";

import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartPoint, StateSegment } from "@/lib/ws-protocol";
import type { Tier } from "@/lib/probe-tiers";

interface PhaseStackChartProps {
  points: ChartPoint[];
  segments?: StateSegment[];
  windowMs?: number;
  /** Right-edge offset from "now" (ms). 0 = live. Matches LiveChart. */
  offsetMs?: number;
  /**
   * Drag-to-zoom callback. Mirrors LiveChart — offsets-from-now (ms) for
   * the left and right edges of the user's drag selection. Parent owns
   * the brush state; uPlot's scale is not modified.
   */
  onZoom?: (leftOffsetMs: number, rightOffsetMs: number) => void;
  /** Currently-selected probe timestamp (ms epoch), or null. Drives a
   *  vertical guide + ring at the matching sample. Mirrors LiveChart. */
  selectedT?: number | null;
  /** Click handler — fires with the nearest probe's timestamp. */
  onSelectProbe?: (t: number) => void;
  /** Per-probe row tier — amber/red dots at outlier probes. Mirrors
   *  the table's row tints. Only non-normal probes need to be present. */
  tierByT?: Map<number, Tier>;
  className?: string;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const Y_RANGE_ANIM_MS = 550;
const EMPTY_SEGMENTS: readonly StateSegment[] = [];

// Data fed to uPlot: [time, dns, dns+connect, dns+connect+tls,
// dns+connect+tls+ttfb]. Each column is the *top edge* of one band,
// so consecutive series stack from bottom (s1) to top (s4).
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
 * Phase totals for a probe. Missing fields default to 0 so a plain HTTP
 * probe (no TLS) still stacks cleanly. Returns null totals when the
 * probe has no phase data at all — the chart draws a gap there, same
 * contract LiveChart uses for a failed probe.
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
  const epsilon = 1;
  let max = -Infinity;
  // Match LiveChart's anchor-back-by-one: with stepped paths the value
  // at the sample immediately BEFORE the visible window extends forward
  // into the window. Include it when sizing the range so a tall anchor
  // doesn't push the visible portion off the top edge.
  let i0 = 0;
  while (i0 < xs.length && xs[i0] < xMin) i0++;
  const start = Math.max(0, i0 - 1);
  for (let i = start; i < xs.length; i++) {
    const x = xs[i];
    if (x > xMax + epsilon) break;
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

// Bottom-to-top stack order: DNS, Connect, TLS, TTFB. All four bands
// share a single cool-blue family so the chart reads as one image — but
// the lightness ladder runs near-white → deep blue, giving strong
// band-to-band separation. Brightest goes on the thinnest bands (DNS),
// darkest on the dominant area (TTFB), so the chart stays calm rather
// than glaring. Tokens live in --phase-* (style.css).
const PHASE_BANDS: PhaseBandSpec[] = [
  {
    key: 'dn',
    label: 'DNS',
    tokenFill: '--phase-dns',
    tokenFillAlpha: 0.95,
    tokenStroke: '--phase-dns',
    fallbackFill: '#e7eef8',
    fallbackStroke: '#e7eef8',
  },
  {
    key: 'cn',
    label: 'Connect',
    tokenFill: '--phase-connect',
    tokenFillAlpha: 0.9,
    tokenStroke: '--phase-connect',
    fallbackFill: '#a8c1e6',
    fallbackStroke: '#a8c1e6',
  },
  {
    key: 'tl',
    label: 'TLS',
    tokenFill: '--phase-tls',
    tokenFillAlpha: 0.85,
    tokenStroke: '--phase-tls',
    fallbackFill: '#6b8ed1',
    fallbackStroke: '#6b8ed1',
  },
  {
    key: 'ft',
    label: 'TTFB',
    tokenFill: '--phase-ttfb',
    tokenFillAlpha: 0.85,
    tokenStroke: '--phase-ttfb',
    fallbackFill: '#3b5bb5',
    fallbackStroke: '#3b5bb5',
  },
];

function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^oklch\(([^)]+)\)$/i);
  if (m) return `oklch(${m[1]} / ${alpha})`;
  return `color-mix(in oklch, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

interface SparkParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  // 0..3 → band color from bandColorsRef. -1 → white-hot fleck.
  band: number;
}

interface LeadingEdge {
  /** Canvas px x of the leading edge (= scaleMax projected). */
  x: number;
  /** Canvas px y of each band's top edge at the leading edge, length 4. */
  bandTopYs: number[];
  /** Canvas px y of the plot floor (y = 0 ms). */
  plotBottom: number;
}

export function PhaseStackChart({
  points,
  segments,
  windowMs = DEFAULT_WINDOW_MS,
  offsetMs = 0,
  onZoom,
  selectedT,
  onSelectProbe,
  tierByT,
  className,
}: PhaseStackChartProps) {
  const segmentsProp = segments ?? EMPTY_SEGMENTS;
  const windowMsRef = React.useRef(windowMs);
  const offsetMsRef = React.useRef(offsetMs);
  const pointsRef = React.useRef<ChartPoint[]>(points);
  const onZoomRef = React.useRef<PhaseStackChartProps["onZoom"]>(onZoom);
  const selectedTRef = React.useRef<number | null>(selectedT ?? null);
  const onSelectProbeRef =
    React.useRef<PhaseStackChartProps["onSelectProbe"]>(onSelectProbe);
  const tierByTRef = React.useRef<Map<number, Tier> | null>(tierByT ?? null);
  React.useEffect(() => {
    windowMsRef.current = windowMs;
    offsetMsRef.current = offsetMs;
  }, [windowMs, offsetMs]);
  React.useEffect(() => {
    pointsRef.current = points;
  }, [points]);
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

  const containerRef = React.useRef<HTMLDivElement>(null);
  const plotRef = React.useRef<uPlot | null>(null);
  const emptyOverlayRef = React.useRef<HTMLDivElement>(null);
  const emptyLabelRef = React.useRef<HTMLSpanElement>(null);

  // Sparks/glow overlay — separate canvas above uPlot's, sized to the
  // container in device pixels so we can paint in the same canvas-px
  // coords as uPlot returns from valToPos(..., true).
  const sparksCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  // CSS-resolved band stroke colors, read once on mount. Canvas APIs
  // don't resolve CSS vars, and we read these every RAF tick — caching
  // avoids a getComputedStyle storm.
  const bandColorsRef = React.useRef<string[]>([]);
  const tierColorRef = React.useRef<{ elevated: string; spike: string }>({
    elevated: "#f59e0b",
    spike: "#ef4444",
  });
  const particlesRef = React.useRef<SparkParticle[]>([]);
  const lastFrameTimeRef = React.useRef<number>(performance.now());

  // Y-range tween — matches LiveChart's behavior. The range fn is
  // invoked on every redraw, and the RAF loop redraws every frame via
  // setScale("x"), so returning an interpolated [lo, hi] is enough to
  // animate.
  const yAnimRef = React.useRef<{
    startTime: number;
    fromLo: number;
    fromHi: number;
    toLo: number;
    toHi: number;
  } | null>(null);
  const lastYTargetRef = React.useRef<{ lo: number; hi: number } | null>(null);

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
    bandColorsRef.current = resolvedBands.map((b) => b.stroke);
    tierColorRef.current = {
      elevated: resolve("--warning", "#f59e0b"),
      spike: resolve("--destructive", "#ef4444"),
    };

    const { width, height } = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cornerRadius = 8 * dpr;

    /**
     * Path builder for one stacked band. Returns a closed Path2D for
     * the fill (top edge stepped + rounded forward, extended to
     * scaleMax, then lower edge stepped + rounded in reverse back to
     * the start) and a separate Path2D for the stroke (top edge only,
     * also extended to scaleMax).
     *
     * `lowerSeriesIdx` is the data-column index of the band immediately
     * below; `null` for the bottommost band (DNS), whose lower edge is
     * the plot floor.
     *
     * Rounded corners on BOTH edges keep stacked bands seamless: band
     * N's reverse-stepped lower edge traces the exact same geometric
     * curve as band N-1's forward-stepped upper edge — same x's, same
     * y's, same radius formula — so the two strokes overlap pixel-for-
     * pixel where they meet. The radius is clamped against the
     * remaining horizontal travel so the pen never moves backward
     * (matters in the edge case where the rightmost extension is
     * shorter than the corner radius).
     *
     * The "extend to scaleMax" trick mirrors LiveChart: rather than
     * leaving a growing dead zone between the last probe and "now",
     * the last value extends horizontally to the right edge of the
     * visible window. Skipped when the last sample is null (a failed
     * probe's gap is meaningful and must stay visible).
     */
    const makeBandPath = (
      lowerSeriesIdx: number | null,
    ): uPlot.Series.PathBuilder => {
      return (u, seriesIdx, idx0, idx1) => {
        const xs = u.data[0];
        const ysUpper = u.data[seriesIdx] as (number | null)[];
        const ysLower = lowerSeriesIdx != null
          ? (u.data[lowerSeriesIdx] as (number | null)[])
          : null;
        const stroke = new Path2D();
        const fill = new Path2D();
        const bbox = (u as unknown as {
          bbox: { top: number; left: number; width: number; height: number };
        }).bbox;
        const plotBottom = bbox.top + bbox.height;
        const scaleMax = u.scales.x.max;
        const scaleMaxPx =
          scaleMax != null ? u.valToPos(scaleMax, "x", true) : null;

        const lowerPyAt = (i: number): number => {
          if (ysLower == null) return plotBottom;
          const v = ysLower[i];
          if (v == null) return plotBottom;
          return u.valToPos(v as number, "y", true);
        };

        let i = idx0;
        while (i <= idx1) {
          while (i <= idx1 && ysUpper[i] == null) i++;
          if (i > idx1) break;
          const runStart = i;
          while (i <= idx1 && ysUpper[i] != null) i++;
          const runEnd = i - 1;

          // ───────────────────────────────────────────────────────
          // Forward rounded-stepped TOP edge.
          // ───────────────────────────────────────────────────────
          const startXPx = u.valToPos(xs[runStart], "x", true);
          const startUpperPy = u.valToPos(
            ysUpper[runStart] as number,
            "y",
            true,
          );
          stroke.moveTo(startXPx, startUpperPy);
          fill.moveTo(startXPx, startUpperPy);

          let prevPx = startXPx;
          let prevPy = startUpperPy;
          let penPx = startXPx;
          let penPy = startUpperPy;
          for (let j = runStart + 1; j <= runEnd; j++) {
            const xPx = u.valToPos(xs[j], "x", true);
            const yPx = u.valToPos(ysUpper[j] as number, "y", true);
            if (Math.abs(yPx - prevPy) < 0.5) {
              stroke.lineTo(xPx, prevPy);
              fill.lineTo(xPx, prevPy);
              penPx = xPx;
              penPy = prevPy;
            } else {
              const dx = xPx - prevPx;
              const dy = yPx - prevPy;
              const r = Math.min(
                cornerRadius,
                Math.abs(dx) / 2,
                Math.abs(dy) / 2,
              );
              const sy = Math.sign(dy);
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

          // ───────────────────────────────────────────────────────
          // Extend horizontally to scaleMax ("now").
          // ───────────────────────────────────────────────────────
          let tipUpperX = penPx;
          if (scaleMaxPx != null && scaleMaxPx > penPx) {
            stroke.lineTo(scaleMaxPx, penPy);
            fill.lineTo(scaleMaxPx, penPy);
            tipUpperX = scaleMaxPx;
          }

          // ───────────────────────────────────────────────────────
          // Drop to lower edge, then walk it in REVERSE with rounded
          // corners. Same radius formula as forward — that's the
          // invariant that makes adjacent bands meet seamlessly.
          // ───────────────────────────────────────────────────────
          const tipLowerY = lowerPyAt(runEnd);
          fill.lineTo(tipUpperX, tipLowerY);

          let prevRevPx = tipUpperX;
          let prevRevPy = tipLowerY;
          for (let j = runEnd; j > runStart; j--) {
            const xPxJ = u.valToPos(xs[j], "x", true);
            const xPxJm1 = u.valToPos(xs[j - 1], "x", true);
            const yPxJm1 = lowerPyAt(j - 1);
            const yPxJ = prevRevPy;
            if (Math.abs(yPxJm1 - yPxJ) < 0.5) {
              fill.lineTo(xPxJm1, yPxJm1);
              prevRevPx = xPxJm1;
              prevRevPy = yPxJm1;
            } else {
              const dx = xPxJm1 - xPxJ;
              const dy = yPxJm1 - yPxJ;
              // Clamp against available horizontal room so the pen
              // never travels backward. In the typical case (we
              // extended to scaleMax, dx is one inter-sample step
              // wide) this clamp is a no-op.
              const maxAvail = Math.max(0, prevRevPx - xPxJ);
              const r = Math.min(
                cornerRadius,
                Math.abs(dx) / 2,
                Math.abs(dy) / 2,
                maxAvail,
              );
              const sy = Math.sign(dy);
              // Approach the corner from the right.
              if (prevRevPx > xPxJ + r) {
                fill.lineTo(xPxJ + r, prevRevPy);
              }
              // Round corner at (xPxJ, yPxJ): horizontal-going-left
              // turns into vertical.
              fill.quadraticCurveTo(xPxJ, yPxJ, xPxJ, yPxJ + sy * r);
              // Vertical run.
              fill.lineTo(xPxJ, yPxJm1 - sy * r);
              // Round corner at (xPxJ, yPxJm1): vertical turns into
              // horizontal-going-left.
              fill.quadraticCurveTo(xPxJ, yPxJm1, xPxJ - r, yPxJm1);
              prevRevPx = xPxJ - r;
              prevRevPy = yPxJm1;
            }
          }

          // Final horizontal back to the run's left edge.
          if (prevRevPx > startXPx) {
            fill.lineTo(startXPx, prevRevPy);
          }
          // closePath draws the left vertical from (startXPx,
          // V_lower[runStart]) back up to (startXPx, V_upper[runStart])
          // — the left edge of the run's first strip.
          fill.closePath();
        }

        return { stroke, fill };
      };
    };

    // One path builder per band. Bottom band (s1, DNS) closes to the
    // plot floor; each subsequent band closes to the series below it.
    // Drawn in declaration order — DNS first (deepest in canvas),
    // TTFB last (topmost). With per-band closed shapes the bands don't
    // overlap, so uPlot's `bands` feature isn't needed.
    const pathBuilders: uPlot.Series.PathBuilder[] = [
      makeBandPath(null),  // s1: DNS — close to plot floor
      makeBandPath(1),     // s2: +Connect — close to s1
      makeBandPath(2),     // s3: +TLS    — close to s2
      makeBandPath(3),     // s4: +TTFB   — close to s3
    ];

    const opts: uPlot.Options = {
      width: Math.max(50, Math.floor(width)),
      height: Math.max(50, Math.floor(height)),
      padding: [16, 0, 0, 0],
      cursor: {
        show: true,
        x: true,
        y: false,
        // Drag-to-zoom on X. setScale: false so uPlot doesn't fight the
        // parent-driven window — setSelect below feeds the new range up.
        drag: { x: true, y: false, setScale: false, dist: 8 },
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
          range: (u) => {
            const [targetLo, targetHi] = visibleStackRange(u);
            const lastTarget = lastYTargetRef.current;
            if (!lastTarget) {
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
                fromLo =
                  inflight.fromLo + (inflight.toLo - inflight.fromLo) * eased;
                fromHi =
                  inflight.fromHi + (inflight.toHi - inflight.fromHi) * eased;
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
              // Same expand/contract trick LiveChart uses: never let
              // the tweened range clip a freshly-expanded target.
              return [Math.min(lo, targetLo), Math.max(hi, targetHi)];
            }
            return [targetLo, targetHi];
          },
        },
      },
      // Series 0 = x. Series 1..4 = stacked phase bands (DNS, +Connect,
      // +TLS, +TTFB). Each gets a custom path builder that draws a
      // closed band shape between its top edge and the band below.
      series: [
        {},
        ...resolvedBands.map((b, idx) => ({
          stroke: b.stroke,
          width: 0.75,
          fill: b.fill,
          spanGaps: false,
          paths: pathBuilders[idx],
          points: { show: false },
        })),
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
            // Read from the (tweened) scale rather than the raw target
            // so the min/max labels track the Y-range animation.
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

      // ─────────────────────────────────────────────────────────────
      // Sparks + glow at the leading edge.
      //
      // Instead of LiveChart's single tip glow + sparks, the phase
      // chart paints a full-height "wall of fire" at the leading edge:
      //   - one glowing vertical segment per band, band-colored
      //   - sparks emitted from each band's top tip with that band's
      //     color, drifting leftward
      //   - a white-hot core dot at the topmost (total) tip
      //
      // The leading edge x is scaleMax projected. The band tops at
      // the leading edge follow the LAST phase-bearing sample's
      // cumulative values — those are the values the path builder
      // already extended horizontally to scaleMax, so they're what's
      // visually "touching" the right edge.
      //
      // Gated on isLive so panning back stops emission and lets
      // existing sparks die out cleanly.
      // ─────────────────────────────────────────────────────────────
      const sparks = sparksCanvasRef.current;
      const ctx = sparks?.getContext("2d") ?? null;
      if (sparks && ctx && plot) {
        const frameNow = performance.now();
        const dt = Math.min(64, frameNow - lastFrameTimeRef.current);
        lastFrameTimeRef.current = frameNow;
        const dtSec = dt / 1000;
        const dpr = window.devicePixelRatio || 1;
        const isLive = offsetMsRef.current === 0;
        const colors = bandColorsRef.current;
        const particles = particlesRef.current;

        ctx.clearRect(0, 0, sparks.width, sparks.height);

        // Resolve the current leading edge from the last phase-bearing
        // sample. Reads through the live `scales` so y positions track
        // the Y-range tween every frame.
        let leadingEdge: LeadingEdge | null = null;
        const pts = pointsRef.current;
        let lastIdx = -1;
        for (let k = pts.length - 1; k >= 0; k--) {
          const ph = phaseTotals(pts[k]);
          if (ph.total != null) {
            lastIdx = k;
            break;
          }
        }
        if (lastIdx >= 0) {
          const ph = phaseTotals(pts[lastIdx]);
          const scaleMax = plot.scales.x.max;
          if (scaleMax != null) {
            const bbox = (plot as unknown as {
              bbox: { top: number; left: number; width: number; height: number };
            }).bbox;
            const plotBottom = bbox.top + bbox.height;
            const dnsCum = ph.dn ?? 0;
            const cnCum = dnsCum + (ph.cn ?? 0);
            const tlCum = cnCum + (ph.tl ?? 0);
            const totalCum = ph.total ?? 0;
            leadingEdge = {
              x: plot.valToPos(scaleMax, "x", true),
              bandTopYs: [
                plot.valToPos(dnsCum, "y", true),
                plot.valToPos(cnCum, "y", true),
                plot.valToPos(tlCum, "y", true),
                plot.valToPos(totalCum, "y", true),
              ],
              plotBottom,
            };
          }
        }

        // Emit sparks along the full vertical extent of the leading
        // edge — the "wall of fire" where new data is being drawn.
        // Random y within the stack height; the band each y falls
        // into picks the spark's color. So a thicker band (more ms
        // contribution) gets proportionally more sparks — the trail's
        // color mix reads the same as the stack's color mix.
        //
        // Skipped when no leading edge (no phase data yet) or when
        // panned back (offsetMs > 0). Same gating as LiveChart's tip
        // sparks.
        if (isLive && leadingEdge) {
          // dt/3 keeps the per-second emission rate steady across
          // frame rates; cap protects against backlog frames. Single
          // emission point so the budget can be tighter than the
          // distributed variant.
          const emit = Math.min(8, Math.max(0, Math.floor(dt / 3)));
          const tipX = leadingEdge.x;
          const topOfStack = leadingEdge.bandTopYs[3];
          const stackHeight = leadingEdge.plotBottom - topOfStack;
          if (stackHeight > 0.5) {
            // Band boundaries in canvas px, top-to-bottom:
            //   [topOfStack, V_DCT, V_DC, V_D, plotBottom]
            // For each random y, walk the boundaries to find which
            // band owns it. Indices: 0=TTFB (top), 1=TLS, 2=Connect,
            // 3=DNS (bottom). Map back to bandIdx for color.
            const boundsTop = [
              leadingEdge.bandTopYs[3],  // top of TTFB band
              leadingEdge.bandTopYs[2],  // top of TLS band
              leadingEdge.bandTopYs[1],  // top of Connect band
              leadingEdge.bandTopYs[0],  // top of DNS band
              leadingEdge.plotBottom,    // bottom of DNS band
            ];
            const bandIdxForBoundary = [3, 2, 1, 0]; // boundsTop[i]..boundsTop[i+1] → bandIdxForBoundary[i]
            for (let e = 0; e < emit; e++) {
              const randomY =
                leadingEdge.plotBottom - Math.random() * stackHeight;
              // Locate the band: find first i where boundsTop[i+1] >= randomY.
              let bandIdx = -1;
              for (let i = 0; i < 4; i++) {
                if (randomY >= boundsTop[i] && randomY <= boundsTop[i + 1]) {
                  bandIdx = bandIdxForBoundary[i];
                  break;
                }
              }
              if (bandIdx < 0) continue;
              const hot = Math.random() < 0.22;
              particles.push({
                x: tipX + (Math.random() - 0.5) * 3.2 * dpr,
                y: randomY + (Math.random() - 0.5) * 3.2 * dpr,
                vx: -(28 + Math.random() * 60) * dpr,
                vy: (Math.random() - 0.5) * 35 * dpr,
                age: 0,
                life: (hot ? 320 : 450) + Math.random() * (hot ? 320 : 500),
                size: ((hot ? 0.5 : 0.7) + Math.random() * (hot ? 0.8 : 1.15)) * dpr,
                band: hot ? -1 : bandIdx,
              });
            }
          }
        }

        // Safety cap. Single emission point so the budget matches
        // LiveChart's tip-spark variant.
        if (particles.length > 400) {
          particles.splice(0, particles.length - 400);
        }

        // Integrate + bucket by color (one bucket per band + one for
        // hot/white). Drawing in groups lets us set fillStyle and
        // shadowColor once per group instead of per particle — those
        // are surprisingly expensive when toggled per draw call.
        //
        // References (not indices) — splicing dead particles mid-loop
        // shifts indices, so storing references sidesteps the
        // bookkeeping.
        const coolHits: SparkParticle[][] = [[], [], [], []];
        const hotHits: SparkParticle[] = [];
        for (let k = particles.length - 1; k >= 0; k--) {
          const p = particles[k];
          p.age += dt;
          if (p.age >= p.life) {
            particles.splice(k, 1);
            continue;
          }
          p.x += p.vx * dtSec;
          p.y += p.vy * dtSec;
          if (p.band === -1) hotHits.push(p);
          else coolHits[p.band].push(p);
        }

        const drawGroup = (
          group: SparkParticle[],
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
            const alpha = (1 - t) * (1 - t) * alphaCap;
            const r = p.size * (1 - t * 0.55);
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        };
        for (let bandIdx = 0; bandIdx < 4; bandIdx++) {
          const color = colors[bandIdx] ?? "#a5b4fc";
          drawGroup(coolHits[bandIdx], color, color, 5.5, 0.9);
        }
        // White sparks: tighter glow (white shadowBlur on dark bg
        // can over-bloom) but a higher alpha cap so they still pop.
        drawGroup(hotHits, "#ffffff", "#ffffff", 4, 1);

        // Glowing leading-edge "wall" — one segment per band.
        // Each segment uses its band color for both stroke and
        // shadow, giving the right edge a tall multi-colored neon
        // strip the height of the full stack.
        if (isLive && leadingEdge) {
          for (let bandIdx = 0; bandIdx < 4; bandIdx++) {
            const topY = leadingEdge.bandTopYs[bandIdx];
            const bottomY =
              bandIdx === 0
                ? leadingEdge.plotBottom
                : leadingEdge.bandTopYs[bandIdx - 1];
            // Skip degenerate (zero-height) segments — they'd render
            // as a single px with shadowBlur, which looks like a stray
            // smudge.
            if (Math.abs(topY - bottomY) < 0.5) continue;
            const color = colors[bandIdx] ?? "#a5b4fc";
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5 * dpr;
            ctx.shadowColor = color;
            ctx.shadowBlur = 8 * dpr;
            ctx.globalAlpha = 0.92;
            ctx.beginPath();
            ctx.moveTo(leadingEdge.x, bottomY);
            ctx.lineTo(leadingEdge.x, topY);
            ctx.stroke();
            ctx.restore();
          }

          // Tip dot + white-hot core at the topmost (total) tip.
          // Anchors the leading-edge wall visually — without it the
          // wall reads as just a colored bar rather than an active,
          // hot leading edge.
          const topY = leadingEdge.bandTopYs[3];
          const topColor = colors[3] ?? "#4451b7";
          ctx.save();
          ctx.shadowColor = topColor;
          ctx.shadowBlur = 12 * dpr;
          ctx.fillStyle = topColor;
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          ctx.arc(leadingEdge.x, topY, 2.6 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
          ctx.fillStyle = "rgba(255,255,255,0.97)";
          ctx.beginPath();
          ctx.arc(leadingEdge.x, topY, 1.1 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Tier markers — small amber/red dots at outlier probes,
        // anchored at the top of the stack so they ride above the
        // colored bands. Drawn before the selection ring so the active
        // selection remains the dominant cursor.
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
              const totals = phaseTotals(p);
              if (totals.total == null) continue;
              const color = tier === 'spike' ? tierColors.spike : tierColors.elevated;
              const xPx = plot.valToPos(sec, "x", true);
              const yPx = plot.valToPos(totals.total, "y", true);
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

        // Selection marker — vertical guide spanning the plot height
        // plus a ring at the top of the stack (total response time).
        // Anchored on the cumulative phase total rather than a per-band
        // y, since this chart's "value" at a probe is the stack height.
        const selT = selectedTRef.current;
        if (plot && selT != null) {
          const bbox = (plot as unknown as {
            bbox: { left: number; top: number; width: number; height: number };
          }).bbox;
          const scaleMin = plot.scales.x.min;
          const scaleMax = plot.scales.x.max;
          const selSec = selT / 1000;
          if (scaleMin != null && scaleMax != null && selSec >= scaleMin && selSec <= scaleMax) {
            const pts = pointsRef.current;
            let selPt: ChartPoint | null = null;
            for (let i = pts.length - 1; i >= 0; i--) {
              if (pts[i].t === selT) {
                selPt = pts[i];
                break;
              }
            }
            const xPx = plot.valToPos(selSec, "x", true);
            const markerColor = colors[3] ?? "#4451b7";
            ctx.save();
            ctx.strokeStyle = markerColor;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = 1 * dpr;
            ctx.beginPath();
            ctx.moveTo(xPx, bbox.top);
            ctx.lineTo(xPx, bbox.top + bbox.height);
            ctx.stroke();
            if (selPt) {
              const totals = phaseTotals(selPt);
              if (totals.total != null) {
                const yPx = plot.valToPos(totals.total, "y", true);
                ctx.globalAlpha = 1;
                ctx.lineWidth = 1.75 * dpr;
                ctx.strokeStyle = "#ffffff";
                ctx.shadowColor = markerColor;
                ctx.shadowBlur = 10 * dpr;
                ctx.beginPath();
                ctx.arc(xPx, yPx, 5 * dpr, 0, Math.PI * 2);
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.fillStyle = markerColor;
                ctx.globalAlpha = 0.9;
                ctx.beginPath();
                ctx.arc(xPx, yPx, 2 * dpr, 0, Math.PI * 2);
                ctx.fill();
              }
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

  // Click → select nearest probe, deferred so a parent double-click
  // (zoom-out) cancels the pending toggle. Mirrors LiveChart.
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
      aria-label="Response time phase breakdown chart"
      onClick={handleContainerClick}
      onDoubleClick={handleContainerDoubleClick}
    >
      {bands.length > 0 && bands.map((band) => (
        <div
          key={band.id}
          ref={(node) => {
            if (node) bandNodesRef.current.set(band.id, node);
            else bandNodesRef.current.delete(band.id);
          }}
          className={`live-chart-band live-chart-band-overlay live-chart-band-${band.kind}`}
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
      <canvas
        ref={sparksCanvasRef}
        className="live-chart-sparks"
        aria-hidden="true"
      />
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
