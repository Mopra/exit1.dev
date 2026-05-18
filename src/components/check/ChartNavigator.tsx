"use client";

import * as React from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartPoint } from "@/lib/ws-protocol";

interface ChartNavigatorProps {
  points: ChartPoint[];
  /** Total time range the navigator displays (right edge = "now"). */
  bufferMs: number;
  /** Brush left edge: how far back from "now", in ms. */
  leftOffsetMs: number;
  /** Brush right edge: how far back from "now", in ms (0 = pinned to now). */
  rightOffsetMs: number;
  onBrushChange: (leftOffsetMs: number, rightOffsetMs: number) => void;
  /** Minimum brush width to prevent it collapsing into a sliver. */
  minWindowMs?: number;
  /**
   * Reserve this many px on the right for a current-time label, so the
   * navigator's right edge aligns with the LiveChart's plot area (which
   * has its own right-axis gutter). Default 0 means no gutter.
   */
  rightGutterPx?: number;
  className?: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

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

const DEFAULT_MIN_WINDOW_MS = 10_000;

type DragMode = "pan" | "left" | "right" | null;

/**
 * Compact overview chart with a draggable + resizable brush. The brush
 * is positioned in offsets-from-now, so as time advances the brush
 * stays at the same relative position visually (both the navigator
 * data and the "now" anchor slide together).
 */
export function ChartNavigator({
  points,
  bufferMs,
  leftOffsetMs,
  rightOffsetMs,
  onBrushChange,
  minWindowMs = DEFAULT_MIN_WINDOW_MS,
  rightGutterPx = 0,
  className,
}: ChartNavigatorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const plotRef = React.useRef<uPlot | null>(null);
  const bufferMsRef = React.useRef(bufferMs);
  const pointsRef = React.useRef<ChartPoint[]>(points);
  React.useEffect(() => {
    bufferMsRef.current = bufferMs;
  }, [bufferMs]);
  React.useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  // The brush is positioned via CSS percentages, computed on every
  // frame from the current offsets + buffer width. Storing as state
  // would force React renders at RAF rate; refs + a single rAF loop
  // is enough since we already drive the navigator's X scale that way.
  const overlayRef = React.useRef<HTMLDivElement>(null);
  // "Collecting history" overlay covering the portion of the buffer
  // we haven't filled with samples yet. Sized in the RAF loop so it
  // tracks the navigator's scrolling X scale smoothly instead of
  // jittering on React's render cadence.
  const emptyOverlayRef = React.useRef<HTMLDivElement>(null);
  const emptyLabelRef = React.useRef<HTMLSpanElement>(null);
  // Live clock at the right edge — Task-Manager-style "now" indicator
  // that lines up with the chart's right gutter. Updated in the same
  // RAF loop, deduped at minute granularity since we only render HH:MM.
  const clockRef = React.useRef<HTMLSpanElement>(null);
  const lastClockMinRef = React.useRef<number>(-1);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cs = getComputedStyle(container);
    const resolve = (token: string, fallback: string): string => {
      const v = cs.getPropertyValue(token).trim();
      return v || fallback;
    };
    const lineColor = resolve("--chart-1", "#a5b4fc");
    const axisColor = resolve("--muted-foreground", "#9ca3af");
    const withAlpha = (color: string, alpha: number): string => {
      const m = color.match(/^oklch\(([^)]+)\)$/i);
      if (m) return `oklch(${m[1]} / ${alpha})`;
      return `color-mix(in oklch, ${color} ${Math.round(alpha * 100)}%, transparent)`;
    };
    const fillTopColor = withAlpha(lineColor, 0.32);
    const fillBottomColor = withAlpha(lineColor, 0);

    const { width, height } = container.getBoundingClientRect();
    const steppedPath = uPlot.paths.stepped!({ align: 1 });

    const opts: uPlot.Options = {
      width: Math.max(50, Math.floor(width)),
      height: Math.max(40, Math.floor(height)),
      padding: [4, 0, 0, 0],
      cursor: { show: false },
      legend: { show: false },
      scales: {
        x: {
          time: true,
          range: () => {
            const n = Date.now() / 1000;
            return [n - bufferMsRef.current / 1000, n];
          },
        },
        y: {
          range: (u) => {
            const ys = u.data[1] as (number | null)[];
            let min = Infinity;
            let max = -Infinity;
            for (const v of ys) {
              if (v == null) continue;
              if (v < min) min = v;
              if (v > max) max = v;
            }
            if (min === Infinity) return [0, 100];
            const pad = Math.max((max - min) * 0.15, 1);
            return [Math.max(0, min - pad), max + pad];
          },
        },
      },
      series: [
        {},
        {
          stroke: lineColor,
          width: 1,
          spanGaps: false,
          paths: steppedPath,
          points: { show: false },
          fill: (u) => {
            const ctx = u.ctx;
            const bbox = (u as unknown as {
              bbox: { top: number; height: number };
            }).bbox;
            const grad = ctx.createLinearGradient(
              0,
              bbox.top,
              0,
              bbox.top + bbox.height,
            );
            grad.addColorStop(0, fillTopColor);
            grad.addColorStop(1, fillBottomColor);
            return grad;
          },
        },
      ],
      axes: [
        {
          stroke: axisColor,
          grid: { show: false },
          ticks: { show: false },
          show: false,
          size: 0,
        },
        { show: false, size: 0 },
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
        const n = now / 1000;
        plot.setScale("x", { min: n - bufferMsRef.current / 1000, max: n });
      }
      const clock = clockRef.current;
      if (clock) {
        const min = Math.floor(now / 60_000);
        if (min !== lastClockMinRef.current) {
          lastClockMinRef.current = min;
          clock.textContent = formatClock(now);
        }
      }
      const overlay = emptyOverlayRef.current;
      if (overlay) {
        const buf = bufferMsRef.current;
        const pts = pointsRef.current;
        const earliest = pts.length > 0 ? pts[0].t : now;
        // Distance (ms) from the navigator's left edge (now - buf) to
        // the first sample we have. Capped at 0 when the buffer is full.
        const emptyMs = Math.max(0, Math.min(buf, earliest - (now - buf)));
        const widthPct = pts.length === 0 ? 100 : (emptyMs / buf) * 100;
        overlay.style.width = `${widthPct}%`;
        const label = emptyLabelRef.current;
        if (label) {
          // Hide the label when the empty strip is too narrow to read it
          // (about 90px). Avoids a half-clipped pill once the buffer is
          // mostly filled.
          const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0;
          const emptyPx = (widthPct / 100) * containerWidth;
          label.style.opacity = emptyPx > 90 ? "1" : "0";
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
        height: Math.max(40, Math.floor(height)),
      });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Brush position as percentages of the navigator width. Right edge of
  // navigator = "now" (0 offset); left edge = "now - bufferMs".
  const leftPct = (1 - leftOffsetMs / bufferMs) * 100;
  const rightPct = (1 - rightOffsetMs / bufferMs) * 100;
  const widthPct = Math.max(0, rightPct - leftPct);

  const dragModeRef = React.useRef<DragMode>(null);
  const dragStartRef = React.useRef<{
    pointerX: number;
    leftOffsetMs: number;
    rightOffsetMs: number;
    containerWidth: number;
  } | null>(null);

  const onPointerDown = (
    mode: DragMode,
    e: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (mode == null) return;
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragModeRef.current = mode;
    dragStartRef.current = {
      pointerX: e.clientX,
      leftOffsetMs,
      rightOffsetMs,
      containerWidth: container.getBoundingClientRect().width,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const mode = dragModeRef.current;
    const start = dragStartRef.current;
    if (!mode || !start) return;
    const dxPx = e.clientX - start.pointerX;
    // Drag right (+dxPx) → smaller offsets-from-now (move toward "now").
    const dxMs = -(dxPx / start.containerWidth) * bufferMs;

    let nextLeft = start.leftOffsetMs;
    let nextRight = start.rightOffsetMs;

    if (mode === "pan") {
      nextLeft += dxMs;
      nextRight += dxMs;
      // Pan without changing width; clamp to buffer edges.
      const width = start.leftOffsetMs - start.rightOffsetMs;
      if (nextRight < 0) {
        nextRight = 0;
        nextLeft = width;
      }
      if (nextLeft > bufferMs) {
        nextLeft = bufferMs;
        nextRight = bufferMs - width;
      }
    } else if (mode === "left") {
      nextLeft = Math.min(
        bufferMs,
        Math.max(start.rightOffsetMs + minWindowMs, start.leftOffsetMs + dxMs),
      );
    } else if (mode === "right") {
      nextRight = Math.max(
        0,
        Math.min(start.leftOffsetMs - minWindowMs, start.rightOffsetMs + dxMs),
      );
    }

    onBrushChange(nextLeft, nextRight);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragModeRef.current) return;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragModeRef.current = null;
    dragStartRef.current = null;
  };

  return (
    <div className={`relative h-full w-full ${className ?? ""}`}>
      {/* Navigator chart + brush; sits in the left portion so its right
          edge lines up with the main chart's plot-area right edge. */}
      <div
        className="absolute top-0 bottom-0 left-0"
        style={{ right: `${rightGutterPx}px` }}
      >
        <div ref={containerRef} className="relative h-full w-full" />
        <div
          ref={overlayRef}
          className="pointer-events-none absolute inset-0"
          aria-hidden="false"
        >
        {/* Dim the regions OUTSIDE the brush so the active slice pops. */}
        <div
          className="absolute top-0 bottom-0 left-0 bg-background/60"
          style={{ width: `${leftPct}%` }}
        />
        <div
          className="absolute top-0 bottom-0 bg-background/60"
          style={{ left: `${rightPct}%`, right: 0 }}
        />
        {/* "No data here yet" treatment for the portion of the buffer we
            haven't collected. Layered above the dim so the hatching is
            visible regardless of where the brush sits. */}
        <div
          ref={emptyOverlayRef}
          className="pointer-events-none absolute top-0 bottom-0 left-0 flex items-center justify-center overflow-hidden border-r border-muted-foreground/20 bg-muted/15"
          style={{
            backgroundImage:
              "repeating-linear-gradient(135deg, transparent 0 5px, rgba(148,163,184,0.18) 5px 6px)",
          }}
          aria-hidden="true"
        >
          <span
            ref={emptyLabelRef}
            className="rounded bg-background/80 px-2 py-0.5 text-[9px] uppercase tracking-[0.15em] text-muted-foreground/80 transition-opacity"
            style={{ opacity: 0 }}
          >
            Collecting history
          </span>
        </div>
        {/* Brush body — pan on drag. */}
        <div
          className="pointer-events-auto absolute top-0 bottom-0 cursor-grab rounded-md border border-primary/60 bg-primary/10 active:cursor-grabbing"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          onPointerDown={(e) => onPointerDown("pan", e)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="slider"
          aria-label="Time window"
          aria-valuemin={0}
          aria-valuemax={bufferMs}
          aria-valuenow={leftOffsetMs - rightOffsetMs}
        />
        {/* Left handle. */}
        <div
          className="pointer-events-auto absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize"
          style={{ left: `${leftPct}%` }}
          onPointerDown={(e) => onPointerDown("left", e)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Resize window start"
        >
          <div className="mx-auto my-1.5 h-[calc(100%-0.75rem)] w-px bg-primary" />
        </div>
        {/* Right handle. */}
        <div
          className="pointer-events-auto absolute top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize"
          style={{ left: `${rightPct}%` }}
          onPointerDown={(e) => onPointerDown("right", e)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Resize window end"
        >
          <div className="mx-auto my-1.5 h-[calc(100%-0.75rem)] w-px bg-primary" />
        </div>
        </div>
      </div>
      {/* Live clock — sits in the right gutter that matches the main
          chart's Y-axis column, anchoring the navigator's right edge to
          "now" the way Task Manager's mini-chart does. */}
      {rightGutterPx > 0 && (
        <div
          className="pointer-events-none absolute top-0 bottom-0 right-0 flex items-center justify-end pl-2 pr-3"
          style={{ width: `${rightGutterPx}px` }}
          aria-hidden="true"
        >
          <span
            ref={clockRef}
            className="font-mono text-[11px] tabular-nums text-muted-foreground"
          />
        </div>
      )}
    </div>
  );
}

export default ChartNavigator;
