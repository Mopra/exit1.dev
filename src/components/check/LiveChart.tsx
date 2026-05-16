"use client";

import * as React from "react";
import * as Recharts from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { ChartPoint } from "@/lib/ws-protocol";

interface LiveChartProps {
  points: ChartPoint[];
  /**
   * Span of time the X axis should always show, even when there are few
   * points. Defaults to 1h. Without this, recharts auto-fits and a
   * sparsely-populated chart looks zoomed-in.
   */
  windowMs?: number;
  className?: string;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

const CHART_CONFIG: ChartConfig = {
  rt: { label: "Response Time (ms)", color: "var(--chart-5)" },
};

function formatClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function LiveChart({
  points,
  windowMs = DEFAULT_WINDOW_MS,
  className,
}: LiveChartProps) {
  // Re-tick on a steady cadence so the right edge of the window slides
  // forward even when no new points are arriving. Without this the chart
  // looks stuck during quiet periods.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const xDomain = React.useMemo<[number, number]>(
    () => [now - windowMs, now],
    [now, windowMs],
  );

  // recharts wants ms-typed numbers on the X axis. Project ChartPoint
  // onto a plain {t, rt, sc, st} row. Nulls stay as nulls so the line
  // renders a gap rather than dropping to zero.
  const data = React.useMemo(
    () =>
      points.map((p) => ({
        t: p.t,
        rt: p.rt,
        sc: p.sc,
        st: p.st,
      })),
    [points],
  );

  if (points.length === 0) {
    return (
      <div
        className={`flex h-full w-full items-center justify-center text-sm text-muted-foreground ${className ?? ""}`}
      >
        Waiting for the first probe…
      </div>
    );
  }

  return (
    <ChartContainer
      config={CHART_CONFIG}
      className={`h-full w-full bg-transparent ${className ?? ""}`}
    >
      <Recharts.LineChart
        data={data}
        margin={{ top: 10, right: 16, bottom: 10, left: 8 }}
      >
        <Recharts.CartesianGrid strokeDasharray="3 3" strokeOpacity={0.3} />
        <Recharts.XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={xDomain}
          tickFormatter={formatClock}
          tick={{ fontSize: 11 }}
          minTickGap={32}
          allowDataOverflow
        />
        <Recharts.YAxis
          tickFormatter={(v: number) => `${v}ms`}
          tick={{ fontSize: 11 }}
          width={56}
          domain={[0, "auto"]}
          allowDecimals={false}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => formatClock(Number(value))}
              formatter={(value, _name, item) => {
                const row = item?.payload as { sc?: number; st?: "up" | "down" } | undefined;
                const sc = row?.sc != null ? ` (${row.sc})` : "";
                return [`${value}ms${sc}`, "Response time"];
              }}
            />
          }
        />
        <Recharts.Line
          dataKey="rt"
          name="rt"
          type="monotone"
          stroke="var(--color-rt)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
          connectNulls={false}
        />
      </Recharts.LineChart>
    </ChartContainer>
  );
}

export default LiveChart;
