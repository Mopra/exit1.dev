import React from "react";
import { geoEqualEarth, geoPath } from "d3-geo";
import { select } from "d3-selection";
import { zoom as d3Zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection } from "geojson";
import type { Website } from "@/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import worldTopoJsonRaw from "world-atlas/countries-110m.json?raw";

type CheckMapViewProps = {
  checks: Website[];
};

type MappableCheck = Website & {
  targetLatitude: number;
  targetLongitude: number;
};

type MarkerState = "UP" | "ERROR" | "DOWN" | "UNKNOWN";

type TopologyLike = {
  type: "Topology";
  objects: Record<string, unknown>;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type RegionKey = NonNullable<Website["checkRegion"]>;
type RegionMeta = { label: string; lat: number; lon: number };

// Approximate Cloud Functions regions (good enough for visual “source → target” pings).
const REGION_META: Record<RegionKey, RegionMeta> = {
  // Iowa, USA (GCP us-central1)
  "us-central1": { label: "us-central1", lat: 41.2619, lon: -95.8608 },
  // St. Ghislain, Belgium (GCP europe-west1)
  "europe-west1": { label: "europe-west1", lat: 50.4561, lon: 3.8247 },
  // Jurong West, Singapore (GCP asia-southeast1)
  "asia-southeast1": { label: "asia-southeast1", lat: 1.3521, lon: 103.8198 },
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function hashToUnit(s: string) {
  // Deterministic, fast, non-crypto hash in [0, 1).
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 forces unsigned 32-bit
  return ((h >>> 0) % 1000) / 1000;
}

function safeSvgId(raw: string) {
  // Ensure valid-ish id for <mpath href="#...">. Keep it deterministic.
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length ? cleaned : "id";
}

function arcPathD(
  start: { x: number; y: number },
  end: { x: number; y: number }
): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;

  // Perpendicular unit vector for control-point offset.
  const nx = -dy / dist;
  const ny = dx / dist;

  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;

  // Curvature scales with distance, with sane caps.
  const curve = clamp(dist * 0.22, 26, 140);
  const cx = mx + nx * curve;
  const cy = my + ny * curve;

  return `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`;
}

const CALLOUT_GAP = 12; // distance from pin to callout box

function MapHeader({ locationCount }: { locationCount?: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      {typeof locationCount === "number" ? (
        <Badge variant="outline">
          {locationCount} location{locationCount === 1 ? "" : "s"}
        </Badge>
      ) : null}
    </div>
  );
}

function toMappableChecks(checks: Website[]): MappableCheck[] {
  return checks
    .filter((c): c is MappableCheck => {
      return isFiniteNumber(c.targetLatitude) && isFiniteNumber(c.targetLongitude);
    })
    .map((c) => ({
      ...c,
      targetLatitude: c.targetLatitude,
      targetLongitude: c.targetLongitude,
    }));
}

function toMarkerState(c: Website): MarkerState {
  // Prefer detailedStatus (more granular), fall back to coarse status.
  if (c.detailedStatus === "DOWN" || c.status === "offline") return "DOWN";
  if (c.detailedStatus === "REACHABLE_WITH_ERROR") return "ERROR";
  if (c.detailedStatus === "UP" || c.detailedStatus === "REDIRECT" || c.status === "online") return "UP";
  return "UNKNOWN";
}

function fitPolygonForChecks(checks: MappableCheck[]): FeatureCollection | null {
  if (!checks.length) return null;

  // Compute a padded lat/lon bbox and fit the projection to that instead of the whole world.
  // This avoids showing the entire globe when checks are clustered (e.g. EU/US only).
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;

  for (const c of checks) {
    const lat = c.targetLatitude;
    const lon = c.targetLongitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }

  // If longitudes are spread too widely (e.g. across the antimeridian), fall back to world fit.
  // (Most real target distributions here are EU/US, so this stays simple and stable.)
  const lonSpan = maxLon - minLon;
  if (!Number.isFinite(lonSpan) || lonSpan > 180) return null;

  const latSpan = maxLat - minLat;

  // Ensure we don't zoom in absurdly hard for one point or very tight clusters.
  const MIN_LON_SPAN = 22; // degrees
  const MIN_LAT_SPAN = 14; // degrees

  const lonMid = (minLon + maxLon) / 2;
  const latMid = (minLat + maxLat) / 2;

  const lonSpanWithMin = Math.max(lonSpan, MIN_LON_SPAN);
  const latSpanWithMin = Math.max(latSpan, MIN_LAT_SPAN);

  // Add a little extra margin beyond the min spans.
  const lonPad = lonSpanWithMin * 0.12;
  const latPad = latSpanWithMin * 0.12;

  const left = clamp(lonMid - lonSpanWithMin / 2 - lonPad, -180, 180);
  const right = clamp(lonMid + lonSpanWithMin / 2 + lonPad, -180, 180);
  const bottom = clamp(latMid - latSpanWithMin / 2 - latPad, -85, 85);
  const top = clamp(latMid + latSpanWithMin / 2 + latPad, -85, 85);

  const bboxPolygon: Feature = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [left, bottom],
          [left, top],
          [right, top],
          [right, bottom],
          [left, bottom],
        ],
      ],
    },
  };

  return { type: "FeatureCollection", features: [bboxPolygon] };
}

export default function CheckMapView({ checks }: CheckMapViewProps) {
  const mappable = React.useMemo(() => toMappableChecks(checks), [checks]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const [world, setWorld] = React.useState<FeatureCollection | null>(null);
  const [worldError, setWorldError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const mapGRef = React.useRef<SVGGElement | null>(null);
  const zoomBehaviorRef = React.useRef<ReturnType<typeof d3Zoom<SVGSVGElement, unknown>> | null>(null);
  const draggingRef = React.useRef(false);
  // Keep React state for "settled" UI only (e.g. the HTML callout position).
  // During pan/zoom we update the SVG transform imperatively to avoid re-rendering
  // hundreds of SVG nodes every frame.
  const [zoomTransform, setZoomTransform] = React.useState(() => zoomIdentity);
  const zoomTransformRef = React.useRef<ZoomTransform>(zoomIdentity);
  const [size, setSize] = React.useState<{ width: number; height: number }>({
    width: 900,
    height: 520,
  });

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const cw = Math.max(320, Math.floor(entry.contentRect.width));
      const ch = Math.max(320, Math.floor(entry.contentRect.height));

      // Use the full available space so the map can grow in both width and height.
      // (Projection + pins are still stable because viewBox matches these dimensions.)
      setSize({ width: cw, height: ch });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setWorldError(null);
        const topo = JSON.parse(worldTopoJsonRaw) as TopologyLike;

        const objects = topo?.objects;
        if (!objects || typeof objects !== "object") {
          throw new Error("Invalid world map data");
        }

        // world-atlas@2 uses `countries` but be defensive.
        const topoObject =
          (objects as Record<string, unknown>).countries ??
          (objects as Record<string, unknown>).land ??
          Object.values(objects as Record<string, unknown>)[0];

        if (!topoObject) throw new Error("World map has no geometries");

        const geo = feature(topo as never, topoObject as never) as unknown as FeatureCollection;
        if (!geo?.features?.length) throw new Error("World map has no features");

        if (!cancelled) setWorld(geo);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "Failed to load world map";
        setWorldError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // IMPORTANT: Hooks must not be called after conditional returns (React error #310).
  const projection = React.useMemo(() => {
    if (!world) return null;
    const p = geoEqualEarth();
    // Fit + center with small padding; keep it as large as possible.
    const pad = 8;
    const fitGeo = fitPolygonForChecks(mappable) ?? world;
    p.fitExtent(
      [
        [pad, pad],
        [Math.max(pad + 1, size.width - pad), Math.max(pad + 1, size.height - pad)],
      ],
      fitGeo as unknown as any
    );
    return p;
  }, [mappable, size.height, size.width, world]);

  const initialZoomTransform = React.useMemo(() => {
    // Start a bit zoomed out vs the fitted bounds so it doesn't feel overly tight.
    const k = 0.6;
    const tx = (1 - k) * (size.width / 2);
    const ty = (1 - k) * (size.height / 2);
    return zoomIdentity.translate(tx, ty).scale(k);
  }, [size.height, size.width]);

  React.useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    if (!projection) return;

    const behavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.7, 10])
      .filter((event: any) => {
        // Keep marker clicks reliable: don't start panning when mousing down on a marker.
        const target = event?.target as Element | null;
        if (event?.type === "mousedown" && target?.closest?.('circle[data-marker="true"]')) return false;

        // Match d3-zoom default filter behavior (incl. trackpad pinch-zoom on wheel+ctrlKey).
        return (!event?.ctrlKey || event?.type === "wheel") && !event?.button;
      })
      .on("start", () => {
        draggingRef.current = true;
      })
      .on("zoom", (event: any) => {
        const t = event.transform as ZoomTransform;
        zoomTransformRef.current = t;
        // Imperatively move the map group for smooth 60fps pan/zoom without React re-rendering.
        if (mapGRef.current) {
          mapGRef.current.setAttribute("transform", t.toString());
        }
      })
      .on("end", () => {
        // Allow any click events to flush first, then drop dragging state.
        window.setTimeout(() => {
          draggingRef.current = false;
        }, 0);
        // Sync the "settled" transform back into React state so the HTML callout snaps
        // into the correct place once the user stops dragging.
        setZoomTransform(zoomTransformRef.current);
      });

    zoomBehaviorRef.current = behavior;
    const svg = select(svgEl);
    svg.call(behavior as any);

    // Reset to the default transform whenever the fitted projection changes (new checks / resize).
    svg.call((behavior as any).transform, initialZoomTransform);
    zoomTransformRef.current = initialZoomTransform;
    if (mapGRef.current) mapGRef.current.setAttribute("transform", initialZoomTransform.toString());
    setZoomTransform(initialZoomTransform);

    return () => {
      svg.on(".zoom", null);
    };
  }, [initialZoomTransform, projection]);

  const path = React.useMemo(() => {
    if (!projection) return null;
    return geoPath(projection);
  }, [projection]);

  const selected = React.useMemo(() => {
    if (!selectedId) return null;
    return mappable.find((c) => c.id === selectedId) ?? null;
  }, [mappable, selectedId]);

  const selectedPoint = React.useMemo(() => {
    if (!selected || !projection) return null;
    const p = projection([selected.targetLongitude, selected.targetLatitude]);
    if (!p) return null;
    const [xRaw, yRaw] = p;

    const x = zoomTransform.applyX(xRaw);
    const y = zoomTransform.applyY(yRaw);

    // If the pin is near the top, show the callout below it instead.
    const placement: "top" | "bottom" = y < 90 ? "bottom" : "top";
    return { x, y, placement };
  }, [projection, selected, zoomTransform]);

  const pings = React.useMemo(() => {
    if (!projection) return [];

    // Guard against rendering an extreme number of SMIL animations.
    const MAX_PINGS = 150;
    const list = mappable.slice(0, MAX_PINGS);

    return list
      .map((c) => {
        const meta = REGION_META[(c.checkRegion ?? "us-central1") as RegionKey] ?? REGION_META["us-central1"];

        const src = projection([meta.lon, meta.lat]);
        const dst = projection([c.targetLongitude, c.targetLatitude]);
        if (!src || !dst) return null;

        const [sx, sy] = src;
        const [tx, ty] = dst;
        const d = arcPathD({ x: sx, y: sy }, { x: tx, y: ty });
        const id = `ping-path-${safeSvgId(c.id)}`;

        // Slightly vary speed per-check so the map doesn’t look synchronized.
        const u = hashToUnit(c.id);
        const dur = clamp(1.05 + u * 0.9, 1.05, 1.95);

        return {
          id,
          d,
          sx,
          sy,
          selected: selectedId === c.id,
          dur: `${dur}s`,
        };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
  }, [mappable, projection, selectedId]);

  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(Boolean(mq.matches));
    update();

    // Prefer modern event listeners; keep a defensive legacy fallback.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }

    // Safari < 14 uses addListener/removeListener (deprecated).
    const legacy = mq as unknown as {
      addListener?: (listener: () => void) => void;
      removeListener?: (listener: () => void) => void;
    };
    if (typeof legacy.addListener === "function") {
      legacy.addListener(update);
      return () => legacy.removeListener?.(update);
    }

    return;
  }, []);

  React.useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  if (checks.length === 0) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-3">
        <MapHeader />
        <Card className="flex-1 min-h-0">
          <CardContent className="text-sm text-muted-foreground">
            No checks yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mappable.length === 0) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-3">
        <MapHeader locationCount={0} />
        <Card className="flex-1 min-h-0">
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>No geo locations found on your checks yet.</p>
            <p>
              Geo data appears after checks run (it’s best-effort based on the
              target IP).
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!world && !worldError) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-3">
        <MapHeader locationCount={mappable.length} />
        <Card className="flex-1 min-h-0">
          <CardContent className="text-sm text-muted-foreground">
            Loading world map…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (worldError) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-3">
        <MapHeader locationCount={mappable.length} />
        <Card className="flex-1 min-h-0">
          <CardContent className="text-sm text-muted-foreground">
            {worldError}
          </CardContent>
        </Card>
      </div>
    );
  }

  // By here, the world map should be loaded; be defensive anyway.
  if (!projection || !path) {
    return (
      <div className="h-full min-h-0 flex flex-col gap-3">
        <MapHeader locationCount={mappable.length} />
        <Card className="flex-1 min-h-0">
          <CardContent className="text-sm text-muted-foreground">
            Preparing map…
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col gap-3">
      <MapHeader locationCount={mappable.length} />
      <Card className="flex-1 min-h-0 flex flex-col border-none">
        <CardContent className="flex-1 min-h-0 p-0">
          <div
            ref={containerRef}
            className="relative h-full w-full overflow-hidden"
            onClick={() => {
              if (draggingRef.current) return;
              setSelectedId(null);
            }}
          >
            {/* Responsive viewport: fill available space */}
            <div className="relative h-full w-full border border-border/60 rounded-lg overflow-hidden">
              <svg
                ref={svgRef}
                width="100%"
                height="100%"
                viewBox={`0 0 ${size.width} ${size.height}`}
                className="block w-full h-full cursor-grab active:cursor-grabbing"
              >
                <g ref={mapGRef} transform={zoomTransform.toString()}>
                  <g>
                    {(world?.features ?? []).map((f: Feature, idx: number) => (
                      <path
                        // GeoJSON features don’t have stable ids in this dataset; index is OK here.
                        key={idx}
                        d={path(f as unknown as any) ?? ""}
                        // Keep land very subtle; rely on brighter borders for readability.
                        fill="color-mix(in oklch, var(--color-foreground) 6%, var(--color-background))"
                        // Higher-contrast borders (requested) without changing the overall look.
                        stroke="color-mix(in oklch, var(--color-foreground) 78%, var(--color-background))"
                        strokeWidth={1.1}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>

                  {/* “Ping” animations (source region -> every target) */}
                  {!reduceMotion && pings.length ? (
                    <g className="pointer-events-none">
                      <defs>
                        {pings.map((p) => (
                          <path key={p.id} id={p.id} d={p.d} />
                        ))}
                      </defs>

                      {pings.map((p) => (
                        <g key={p.id}>
                          {/* Arc */}
                          <path
                            d={p.d}
                            fill="none"
                            stroke="var(--color-primary)"
                            strokeOpacity={p.selected ? 0.32 : 0.18}
                            strokeWidth={p.selected ? 2.6 : 2.1}
                            strokeLinecap="round"
                            vectorEffect="non-scaling-stroke"
                          />

                          {/* Source pulse */}
                          <circle cx={p.sx} cy={p.sy} r={3} fill="var(--color-primary)" opacity={0.25}>
                            <animate attributeName="r" values="2.5;10" dur={p.dur} repeatCount="indefinite" />
                            <animate attributeName="opacity" values="0.25;0" dur={p.dur} repeatCount="indefinite" />
                          </circle>

                          {/* Traveling dot */}
                          <circle r={3.25} fill="var(--color-primary)" opacity={p.selected ? 0.95 : 0.75}>
                            <animate attributeName="r" values="2.9;3.8;2.9" dur={p.dur} repeatCount="indefinite" />
                            <animateMotion dur={p.dur} repeatCount="indefinite" rotate="auto">
                              <mpath href={`#${p.id}`} />
                            </animateMotion>
                            {/* Fallback for older SVG implementations */}
                            <animateMotion dur={p.dur} repeatCount="indefinite" rotate="auto">
                              <mpath xlinkHref={`#${p.id}`} />
                            </animateMotion>
                          </circle>
                        </g>
                      ))}
                    </g>
                  ) : null}

                  <g>
                    {mappable.map((c) => {
                      const point = projection([c.targetLongitude, c.targetLatitude]);
                      if (!point) return null;

                      const [x, y] = point;
                      const isSelected = selectedId === c.id;
                      const state = toMarkerState(c);
                      return (
                        <circle
                          key={c.id}
                          data-marker="true"
                          cx={x}
                          cy={y}
                          r={isSelected ? 8 : 6}
                          onClick={(e) => {
                            if (draggingRef.current) return;
                            e.stopPropagation();
                            setSelectedId((prev) => (prev === c.id ? null : c.id));
                          }}
                          className={cn(
                            "cursor-pointer transition-all",
                            // Status-colored markers (requested): UP/ERROR/DOWN
                            state === "UP" && (isSelected ? "fill-emerald-500" : "fill-emerald-500/80"),
                            state === "ERROR" && (isSelected ? "fill-amber-500" : "fill-amber-500/80"),
                            state === "DOWN" && (isSelected ? "fill-destructive" : "fill-destructive/80"),
                            // Fallback (unknown / missing data)
                            state === "UNKNOWN" && (isSelected ? "fill-primary" : "fill-primary/80")
                          )}
                          stroke="var(--color-background)"
                          strokeWidth={2.5}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                  </g>
                </g>
              </svg>

              {/* On-map callout for the selected marker (drops out from the pin) */}
              {selected && selectedPoint ? (
                <div
                  className="absolute z-10"
                  style={{
                    left: selectedPoint.x,
                    top: selectedPoint.y,
                    transform:
                      selectedPoint.placement === "top"
                        ? `translate(-50%, calc(-100% - ${CALLOUT_GAP}px))`
                        : `translate(-50%, ${CALLOUT_GAP}px)`,
                  }}
                >
                  <div
                    className="relative pointer-events-auto"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Arrow */}
                    <div
                      className={cn(
                        "absolute left-1/2 size-3 -translate-x-1/2 rotate-45 border bg-background/75 backdrop-blur-md",
                        selectedPoint.placement === "top"
                          ? "-bottom-1 border-t-0 border-l-0"
                          : "-top-1 border-b-0 border-r-0"
                      )}
                    />

                    <div className="rounded-lg border bg-background/75 backdrop-blur-md shadow-lg px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium leading-tight truncate">
                          {selected.name}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            variant={
                              selected.status === "online"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {selected.status ?? "unknown"}
                          </Badge>
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {selected.url}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {selected.targetCity ? `${selected.targetCity}, ` : ""}
                        {selected.targetRegion ? `${selected.targetRegion}, ` : ""}
                        {selected.targetCountry ?? "Unknown"}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}


