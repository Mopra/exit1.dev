import React from "react";
import { geoEqualEarth, geoPath } from "d3-geo";
import { select } from "d3-selection";
import { zoom as d3Zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection } from "geojson";
import type { Website } from "../../types";
import { CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import { GlowCard } from "../ui/glow-card";
import {
  Activity,
  Map as MapIcon,
  Globe
} from "lucide-react";
import worldTopoJsonRaw from "world-atlas/countries-110m.json?raw";
import { useMobile } from "../../hooks/useMobile";

type CheckMapViewProps = {
  checks: Website[];
  hideHeader?: boolean;
};

type MappableCheck = Website & {
  targetLatitude: number;
  targetLongitude: number;
};

type MarkerState = "UP" | "ERROR" | "DOWN" | "REDIRECT" | "PAUSED" | "MAINTENANCE" | "UNKNOWN";

type TopologyLike = {
  type: "Topology";
  objects: Record<string, unknown>;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type RegionKey = NonNullable<Website["checkRegion"]>;
type RegionMeta = { label: string; lat: number; lon: number };

const REGION_META: Record<RegionKey, RegionMeta> = {
  "us-central1": { label: "US Central", lat: 41.2619, lon: -95.8608 },
  "europe-west1": { label: "Europe West (Belgium)", lat: 50.4561, lon: 3.8247 },
  "asia-southeast1": { label: "Asia Pacific", lat: 1.3521, lon: 103.8198 },
  "vps-eu-1": { label: "Europe Turbo (Beta)", lat: 51.1657, lon: 10.4515 },
};

// Marker state colors matching timeline widget
const MARKER_COLORS: Record<MarkerState, { base: string; selected: string; text: string; glow: string }> = {
  UP: { base: "fill-emerald-500", selected: "fill-emerald-400", text: "text-emerald-500", glow: "rgba(16,185,129,0.5)" },
  ERROR: { base: "fill-amber-500", selected: "fill-amber-400", text: "text-amber-500", glow: "rgba(245,158,11,0.5)" },
  DOWN: { base: "fill-destructive", selected: "fill-destructive/80", text: "text-destructive", glow: "rgba(239,68,68,0.5)" },
  REDIRECT: { base: "fill-sky-500", selected: "fill-sky-400", text: "text-sky-500", glow: "rgba(14,165,233,0.5)" },
  PAUSED: { base: "fill-amber-400", selected: "fill-amber-300", text: "text-amber-400", glow: "rgba(251,191,36,0.5)" },
  MAINTENANCE: { base: "fill-amber-500", selected: "fill-amber-400", text: "text-amber-500", glow: "rgba(245,158,11,0.5)" },
  UNKNOWN: { base: "fill-muted-foreground/40", selected: "fill-muted-foreground/60", text: "text-muted-foreground", glow: "rgba(100,100,100,0.3)" },
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function hashToUnit(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function safeSvgId(raw: string) {
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
  const nx = -dy / dist;
  const ny = dx / dist;
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const curve = clamp(dist * 0.22, 26, 140);
  const cx = mx + nx * curve;
  const cy = my + ny * curve;
  return `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`;
}

const CALLOUT_GAP = 1;

function toMarkerState(c: Website): MarkerState {
  // Match timeline widget status logic
  if (c.maintenanceMode) return "MAINTENANCE";
  if (c.disabled) return "PAUSED";
  if (c.detailedStatus === "DOWN" || c.status === "offline") return "DOWN";
  if (c.detailedStatus === "REACHABLE_WITH_ERROR") return "ERROR";
  if (c.detailedStatus === "REDIRECT") return "REDIRECT";
  if (c.detailedStatus === "UP" || c.status === "online") return "UP";
  return "UNKNOWN";
}

function MapHeader({ checks }: { checks: Website[] }) {
  const isMobile = useMobile(768);
  const stats = React.useMemo(() => {
    const up = checks.filter(c => toMarkerState(c) === "UP").length;
    const down = checks.filter(c => toMarkerState(c) === "DOWN").length;
    const error = checks.filter(c => toMarkerState(c) === "ERROR").length;
    const redirect = checks.filter(c => toMarkerState(c) === "REDIRECT").length;
    const paused = checks.filter(c => toMarkerState(c) === "PAUSED").length;
    return { up, down, error, redirect, paused, total: checks.length };
  }, [checks]);

  return (
    <div className={cn("flex mb-4", isMobile ? "flex-col gap-3" : "items-center justify-between gap-4")}>
      <div className="flex items-center gap-2">
        <div className={cn("rounded-lg bg-primary/10 text-primary", isMobile ? "p-1.5" : "p-2")}>
          <MapIcon className={cn(isMobile ? "size-4" : "size-5")} />
        </div>
        <div>
          <h2 className={cn("font-semibold tracking-tight", isMobile ? "text-base" : "text-lg")}>Global Infrastructure</h2>
          <p className={cn("text-muted-foreground font-mono", isMobile ? "text-[10px]" : "text-xs")}>Real-time status of your endpoints</p>
        </div>
      </div>

      <div className={cn("flex items-center gap-3", isMobile && "justify-between w-full")}>
        <div className={cn("items-center gap-4 px-3 py-1.5 rounded-full bg-muted/30 border border-border/50 backdrop-blur-sm", isMobile ? "flex flex-wrap gap-2" : "hidden sm:flex")}>
          <div className="flex items-center gap-1.5">
            <div className="size-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            <span className="text-[10px] font-bold font-mono text-emerald-500 uppercase">{stats.up} Up</span>
          </div>
          {stats.redirect > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="size-2 rounded-full bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]" />
              <span className="text-[10px] font-bold font-mono text-sky-500 uppercase">{stats.redirect} Redirect</span>
            </div>
          )}
          {stats.error > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="size-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
              <span className="text-[10px] font-bold font-mono text-amber-500 uppercase">{stats.error} Degraded</span>
            </div>
          )}
          {stats.paused > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="size-2 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]" />
              <span className="text-[10px] font-bold font-mono text-amber-400 uppercase">{stats.paused} Paused</span>
            </div>
          )}
          {stats.down > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="size-2 rounded-full bg-destructive shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
              <span className="text-[10px] font-bold font-mono text-destructive uppercase">{stats.down} Down</span>
            </div>
          )}
        </div>
        <Badge variant="outline" className={cn("font-mono bg-background/50", isMobile ? "text-[9px] px-2 py-0.5" : "text-[10px]")}>
          {stats.total} TOTAL
        </Badge>
      </div>
    </div>
  );
}

function MapLegend() {
  return (
    <div className="absolute top-6 left-6 p-4 rounded-xl bg-background/60 border border-border/40 backdrop-blur-xl shadow-2xl z-20 hidden md:block w-48 overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent opacity-150" />
      <div className="relative">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
          <Activity className="size-3 text-primary" /> Live Traffic
        </h3>
        <div className="space-y-2.5">
          <div className="flex items-center gap-3">
            <div className="relative size-2.5">
              <div className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-40" />
              <div className="relative size-full rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            </div>
            <span className="text-[11px] font-medium text-foreground/80">Online</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative size-2.5">
              <div className="absolute inset-0 rounded-full bg-sky-500 animate-ping opacity-40" />
              <div className="relative size-full rounded-full bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]" />
            </div>
            <span className="text-[11px] font-medium text-foreground/80">Redirect</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative size-2.5">
              <div className="absolute inset-0 rounded-full bg-amber-500 animate-ping opacity-40" />
              <div className="relative size-full rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
            </div>
            <span className="text-[11px] font-medium text-foreground/80">Degraded</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative size-2.5">
              <div className="absolute inset-0 rounded-full bg-amber-400 animate-pulse opacity-40" />
              <div className="relative size-full rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]" />
            </div>
            <span className="text-[11px] font-medium text-foreground/80">Paused</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative size-2.5">
              <div className="absolute inset-0 rounded-full bg-destructive animate-pulse" />
              <div className="relative size-full rounded-full bg-destructive shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
            </div>
            <span className="text-[11px] font-medium text-foreground/80">Offline</span>
          </div>
          <div className="pt-2 mt-2 border-t border-border/30">
            <div className="flex items-center gap-3">
              <div className="h-0.5 w-6 bg-primary opacity-50 relative">
                <div className="absolute -top-[1.5px] right-0 size-1 rounded-full bg-primary" />
              </div>
              <span className="text-[10px] text-muted-foreground font-mono">Ping flow</span>
            </div>
          </div>
        </div>
      </div>
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

function fitPolygonForChecks(checks: MappableCheck[]): FeatureCollection | null {
  if (!checks.length) return null;
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
  const lonSpan = maxLon - minLon;
  if (!Number.isFinite(lonSpan) || lonSpan > 180) return null;
  const latSpan = maxLat - minLat;
  const MIN_LON_SPAN = 22;
  const MIN_LAT_SPAN = 14;
  const lonMid = (minLon + maxLon) / 2;
  const latMid = (minLat + maxLat) / 2;
  const lonSpanWithMin = Math.max(lonSpan, MIN_LON_SPAN);
  const latSpanWithMin = Math.max(latSpan, MIN_LAT_SPAN);
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
      coordinates: [[[left, bottom], [left, top], [right, top], [right, bottom], [left, bottom]]],
    },
  };
  return { type: "FeatureCollection", features: [bboxPolygon] };
}

export default function CheckMapView({ checks, hideHeader = false }: CheckMapViewProps) {
  const isMobile = useMobile(768);
  const mappable = React.useMemo(() => toMappableChecks(checks), [checks]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [world, setWorld] = React.useState<FeatureCollection | null>(null);
  const [worldError, setWorldError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const mapGRef = React.useRef<SVGGElement | null>(null);
  const zoomBehaviorRef = React.useRef<ReturnType<typeof d3Zoom<SVGSVGElement, unknown>> | null>(null);
  const draggingRef = React.useRef(false);
  const [zoomTransform, setZoomTransform] = React.useState(() => zoomIdentity);
  const zoomTransformRef = React.useRef<ZoomTransform>(zoomIdentity);
  
  // Initialize size - will be updated by ResizeObserver immediately
  const [size, setSize] = React.useState<{ width: number; height: number }>(() => {
    if (typeof window === "undefined") return { width: 900, height: 520 };
    // Use viewport dimensions as initial guess
    return { width: window.innerWidth, height: window.innerHeight };
  });

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const cw = Math.max(320, Math.floor(rect.width));
      const ch = Math.max(320, Math.floor(rect.height));
      setSize({ width: cw, height: ch });
    };
    
    // Set initial size immediately
    updateSize();
    
    if (typeof ResizeObserver === "undefined") {
      // Fallback for browsers without ResizeObserver
      const handleResize = () => {
        updateSize();
      };
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }
    
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const cw = Math.max(320, Math.floor(entry.contentRect.width));
      const ch = Math.max(320, Math.floor(entry.contentRect.height));
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
        const topoObject = (objects as Record<string, unknown>).countries ?? (objects as Record<string, unknown>).land ?? Object.values(objects as Record<string, unknown>)[0];
        const geo = feature(topo as never, topoObject as never) as unknown as FeatureCollection;
        if (!cancelled) setWorld(geo);
      } catch (e) {
        if (!cancelled) setWorldError(e instanceof Error ? e.message : "Failed to load map");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const projection = React.useMemo(() => {
    if (!world) return null;
    const p = geoEqualEarth();
    const pad = 12;
    const fitGeo = fitPolygonForChecks(mappable) ?? world;
    p.fitExtent([[pad, pad], [Math.max(pad + 1, size.width - pad), Math.max(pad + 1, size.height - pad)]], fitGeo as any);
    return p;
  }, [mappable, size.height, size.width, world]);

  // Calculate the bounding box and center of all data markers
  const markerBounds = React.useMemo(() => {
    if (!mappable.length || !projection) return null;
    
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let count = 0;
    
    for (const check of mappable) {
      if (isFiniteNumber(check.targetLatitude) && isFiniteNumber(check.targetLongitude)) {
        minLat = Math.min(minLat, check.targetLatitude);
        maxLat = Math.max(maxLat, check.targetLatitude);
        minLon = Math.min(minLon, check.targetLongitude);
        maxLon = Math.max(maxLon, check.targetLongitude);
        count++;
      }
    }
    
    if (count === 0) return null;
    
    // Calculate center
    const avgLat = (minLat + maxLat) / 2;
    const avgLon = (minLon + maxLon) / 2;
    const centerProjected = projection([avgLon, avgLat]);
    
    if (!centerProjected) return null;
    
    // Calculate bounding box in screen coordinates
    const corners = [
      projection([minLon, minLat]),
      projection([maxLon, minLat]),
      projection([minLon, maxLat]),
      projection([maxLon, maxLat])
    ].filter(Boolean) as [number, number][];
    
    if (corners.length === 0) return null;
    
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    
    for (const [x, y] of corners) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    
    const width = maxX - minX;
    const height = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    return {
      center: { x: centerX, y: centerY },
      width,
      height,
      bounds: { minX, maxX, minY, maxY }
    };
  }, [mappable, projection]);

  const initialZoomTransform = React.useMemo(() => {
    const padding = isMobile ? 0.08 : 0.12; // Moderate padding (8-12% of viewport)
    const paddingX = size.width * padding;
    const paddingY = size.height * padding;
    const availableWidth = size.width - paddingX * 2;
    const availableHeight = size.height - paddingY * 2;
    
    if (markerBounds) {
      // Calculate zoom level to fit all markers in the view
      const scaleX = availableWidth / markerBounds.width;
      const scaleY = availableHeight / markerBounds.height;
      // Use the smaller scale to ensure all markers fit, and increase the multiplier to zoom in more
      const baseScale = Math.min(scaleX, scaleY);
      const zoomMultiplier = isMobile ? 1.5 : 1.8; // Moderate zoom multiplier
      const k = Math.min(baseScale * zoomMultiplier, isMobile ? 4.5 : 3.5); // Moderate max zoom cap
      
      // Center the map on the center of all markers
      const tx = size.width / 2 - markerBounds.center.x * k;
      const ty = size.height / 2 - markerBounds.center.y * k;
      return zoomIdentity.translate(tx, ty).scale(k);
    } else {
      // Fallback to original positioning if no markers
      const k = isMobile ? 2.5 : 1.3;
      if (isMobile) {
        const translateDivisor = 1.5;
        const tx = (1 - k) * (size.width / translateDivisor);
        const ty = (1 - k) * (size.height / translateDivisor);
        return zoomIdentity.translate(tx, ty).scale(k);
      } else {
        const tx = (1 - k) * (size.width / 2);
        const ty = (1 - k) * (size.height / 2);
        return zoomIdentity.translate(tx, ty).scale(k);
      }
    }
  }, [size.height, size.width, isMobile, markerBounds]);

  React.useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !projection) return;
    const behavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 12])
      .filter((event: any) => {
        const target = event?.target as Element | null;
        // Handle both mouse and touch events
        if ((event?.type === "mousedown" || event?.type === "touchstart") && target?.closest?.('circle[data-marker="true"]')) return false;
        // Allow touch events and wheel events, filter out button clicks
        return (!event?.ctrlKey || event?.type === "wheel") && !event?.button;
      })
      .on("start", () => { draggingRef.current = true; })
      .on("zoom", (event: any) => {
        const t = event.transform as ZoomTransform;
        zoomTransformRef.current = t;
        setZoomTransform(t);
        if (mapGRef.current) mapGRef.current.setAttribute("transform", t.toString());
      })
      .on("end", () => {
        window.setTimeout(() => { draggingRef.current = false; }, 0);
        setZoomTransform(zoomTransformRef.current);
      });
    zoomBehaviorRef.current = behavior;
    const svg = select(svgEl);
    svg.call(behavior as any);
    svg.call((behavior as any).transform, initialZoomTransform);
    zoomTransformRef.current = initialZoomTransform;
    if (mapGRef.current) mapGRef.current.setAttribute("transform", initialZoomTransform.toString());
    setZoomTransform(initialZoomTransform);
    return () => { svg.on(".zoom", null); };
  }, [initialZoomTransform, projection]);

  const path = React.useMemo(() => projection ? geoPath(projection) : null, [projection]);
  const selected = React.useMemo(() => selectedId ? mappable.find((c) => c.id === selectedId) ?? null : null, [mappable, selectedId]);

  const selectedPoint = React.useMemo(() => {
    if (!selected || !projection) return null;
    const p = projection([selected.targetLongitude, selected.targetLatitude]);
    if (!p) return null;
    const x = zoomTransform.applyX(p[0]);
    const y = zoomTransform.applyY(p[1]);
    const threshold = isMobile ? 180 : 120;
    return { x, y, placement: y < threshold ? "bottom" : "top" as const };
  }, [projection, selected, zoomTransform, isMobile]);

  const pings = React.useMemo(() => {
    if (!projection) return [];
    return mappable.slice(0, 100).map((c) => {
      const meta = REGION_META[(c.checkRegion ?? "us-central1") as RegionKey] ?? REGION_META["us-central1"];
      const src = projection([meta.lon, meta.lat]);
      const dst = projection([c.targetLongitude, c.targetLatitude]);
      if (!src || !dst) return null;
      const d = arcPathD({ x: src[0], y: src[1] }, { x: dst[0], y: dst[1] });
      const u = hashToUnit(c.id);
      return { id: `p-${safeSvgId(c.id)}`, d, sx: src[0], sy: src[1], selected: selectedId === c.id, dur: `${clamp(1.2 + u * 1.5, 1.2, 2.5)}s` };
    }).filter((x): x is NonNullable<typeof x> => Boolean(x));
  }, [mappable, projection, selectedId]);

  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  React.useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  const [hoveredCountry, setHoveredCountry] = React.useState<string | null>(null);
  const [countryHoverPos, setCountryHoverPos] = React.useState<{ x: number; y: number } | null>(null);
  const [hoveredFeature, setHoveredFeature] = React.useState<Feature | null>(null);

  // Get checks within a hovered country feature using geographic bounds
  const getChecksInFeature = React.useCallback((feature: Feature | null): MappableCheck[] => {
    if (!feature || !feature.geometry) return [];

    // For now, show all checks and let the user see the country name
    // In the future, we could use point-in-polygon detection
    const countryName = (feature.properties as any)?.name || "Unknown";

    // Try to match checks by country name (case-insensitive, partial match)
    return mappable.filter(check => {
      if (!check.targetCountry) return false;
      const checkCountry = check.targetCountry.toLowerCase();
      const featureCountry = countryName.toLowerCase();

      // Direct match or partial match
      return checkCountry === featureCountry ||
        featureCountry.includes(checkCountry) ||
        checkCountry.includes(featureCountry);
    });
  }, [mappable]);

  if (checks.length === 0) {
    return (
      <div className={cn("h-full flex flex-col", hideHeader ? "" : (isMobile ? "min-h-[400px]" : "min-h-[500px]"))}>
        {!hideHeader && <MapHeader checks={[]} />}
        <GlowCard magic className="flex-1 min-h-0 flex flex-col items-center justify-center border-none md:max-h-[800px]">
          <div className={cn("text-center space-y-4", isMobile ? "p-4" : "p-8")}>
            <div className={cn("rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4 border border-border/50 shadow-inner", isMobile ? "size-12" : "size-16")}>
              <Globe className={cn("text-muted-foreground/50", isMobile ? "size-6" : "size-8")} />
            </div>
            <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg")}>No data points available</h3>
            <p className={cn("text-muted-foreground max-w-sm mx-auto", isMobile ? "text-xs" : "text-sm")}>Once you add checks and they begin monitoring, their geographic locations will be visualized here.</p>
          </div>
        </GlowCard>
      </div>
    );
  }

  if (mappable.length === 0) {
    return (
      <div className={cn("h-full flex flex-col", hideHeader ? "" : (isMobile ? "min-h-[400px]" : "min-h-[500px]"))}>
        {!hideHeader && <MapHeader checks={checks} />}
        <GlowCard magic className="flex-1 min-h-0 flex flex-col items-center justify-center border-none md:max-h-[800px]">
          <div className={cn("text-center space-y-4", isMobile ? "p-4" : "p-8")}>
            <div className={cn("rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4 border border-border/50 shadow-inner", isMobile ? "size-12" : "size-16")}>
              <Activity className={cn("text-muted-foreground/50", isMobile ? "size-6" : "size-8")} />
            </div>
            <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg")}>Resolving Geo Locations</h3>
            <p className={cn("text-muted-foreground max-w-sm mx-auto", isMobile ? "text-xs" : "text-sm")}>Identifying targets of your checks. This happens automatically during the first check runs.</p>
          </div>
        </GlowCard>
      </div>
    );
  }

  if (!world && !worldError) {
    return (
      <div className={cn("h-full flex flex-col", hideHeader ? "" : (isMobile ? "min-h-[400px]" : "min-h-[500px]"))}>
        {!hideHeader && <MapHeader checks={checks} />}
        <GlowCard magic className="flex-1 min-h-0 flex flex-col items-center justify-center border-none md:max-h-[800px]">
          <div className={cn("text-center space-y-4", isMobile ? "p-4" : "p-8")}>
            <div className={cn("animate-spin border-4 border-primary border-t-transparent rounded-full mx-auto", isMobile ? "size-10" : "size-12")} />
            <p className={cn("text-muted-foreground font-mono uppercase tracking-widest", isMobile ? "text-xs" : "text-sm")}>Initializing Engine...</p>
          </div>
        </GlowCard>
      </div>
    );
  }

  if (worldError) {
    return (
      <div className={cn("h-full flex flex-col", hideHeader ? "" : (isMobile ? "min-h-[400px]" : "min-h-[500px]"))}>
        {!hideHeader && <MapHeader checks={checks} />}
        <GlowCard magic className="flex-1 min-h-0 flex flex-col items-center justify-center border-none md:max-h-[800px]">
          <div className={cn("text-center space-y-4 text-destructive", isMobile ? "p-4" : "p-8")}>
            <div className={cn("rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto mb-4 border border-destructive/20 shadow-inner", isMobile ? "size-12" : "size-16")}>
              <Activity className={cn(isMobile ? "size-6" : "size-8")} />
            </div>
            <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg")}>Map Error</h3>
            <p className={cn("text-destructive opacity-80 max-w-sm mx-auto", isMobile ? "text-xs" : "text-sm")}>{worldError}</p>
          </div>
        </GlowCard>
      </div>
    );
  }

  if (!projection || !path) {
    return (
      <div className={cn("h-full flex flex-col", hideHeader ? "" : (isMobile ? "min-h-[400px]" : "min-h-[500px]"))}>
        {!hideHeader && <MapHeader checks={checks} />}
        <GlowCard magic className="flex-1 min-h-0 flex flex-col items-center justify-center border-none md:max-h-[800px]">
          <div className={cn("text-center space-y-4", isMobile ? "p-4" : "p-8")}>
            <div className={cn("animate-pulse bg-primary/20 rounded-full mx-auto shadow-[0_0_20px_rgba(var(--color-primary),0.3)]", isMobile ? "size-10" : "size-12")} />
            <p className={cn("text-muted-foreground font-mono uppercase tracking-widest", isMobile ? "text-xs" : "text-sm")}>Projecting Map...</p>
          </div>
        </GlowCard>
      </div>
    );
  }

  const selectedState = selected ? toMarkerState(selected) : "UNKNOWN";

  return (
    <div className={cn("flex flex-col h-full", hideHeader ? "" : (isMobile ? "h-auto" : "h-auto"))}>
      {!hideHeader && <MapHeader checks={checks} />}
      <GlowCard magic accent="blue" className={cn("flex flex-col border border-border/50 shadow-2xl relative w-full md:max-h-[800px]", isMobile ? "aspect-[4/3]" : "aspect-video")}>
        <CardContent className="flex-1 min-h-0 p-0 relative">
          <div ref={containerRef} className="relative h-full w-full overflow-hidden md:max-h-[800px]" onClick={() => { if (!draggingRef.current) setSelectedId(null); }}>
            <MapLegend />
            <div className="relative h-full w-full overflow-hidden">

              <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} className={cn("relative z-0 block w-full h-full", isMobile ? "touch-none" : "cursor-grab active:cursor-grabbing")}>
                <defs>
                  <filter id="m-glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="1.5" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                </defs>
                <g ref={mapGRef} transform={zoomTransform.toString()}>
                  <g>
                    {(world?.features ?? []).map((f: Feature, idx: number) => {
                      const countryName = (f.properties as any)?.name || "Unknown";
                      return (
                        <path
                          key={idx}
                          d={path?.(f as any) ?? ""}
                          fill="color-mix(in oklch, var(--color-foreground) 4%, var(--color-background))"
                          stroke="color-mix(in oklch, var(--color-foreground) 35%, var(--color-background))"
                          strokeWidth={0.8}
                          vectorEffect="non-scaling-stroke"
                          className="transition-colors duration-500 hover:fill-foreground/5"
                          onMouseEnter={(e) => {
                            setHoveredCountry(countryName);
                            setHoveredFeature(f);
                            const rect = svgRef.current?.getBoundingClientRect();
                            if (rect) {
                              setCountryHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                            }
                          }}
                          onMouseMove={(e) => {
                            const rect = svgRef.current?.getBoundingClientRect();
                            if (rect) {
                              setCountryHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                            }
                          }}
                          onMouseLeave={() => {
                            setHoveredCountry(null);
                            setHoveredFeature(null);
                            setCountryHoverPos(null);
                          }}
                        />
                      );
                    })}
                  </g>
                  {!reduceMotion && (() => {
                    const zoomScale = zoomTransform.k;
                    const inverseScale = 1 / zoomScale;
                    const baseStrokeWidth = 1.2;
                    const baseSelectedStrokeWidth = 2;
                    const baseCircleRadius = 2.5;
                    const baseAnimMin = 2;
                    const baseAnimMax = 8;
                    return (
                      <g className="pointer-events-none">
                        <defs>{pings.map((p) => <path key={p.id} id={p.id} d={p.d} />)}</defs>
                        {pings.map((p) => (
                          <g key={p.id}>
                            <path d={p.d} fill="none" stroke="var(--color-primary)" strokeOpacity={p.selected ? 0.35 : 0.12} strokeWidth={(p.selected ? baseSelectedStrokeWidth : baseStrokeWidth) * inverseScale} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                            <circle cx={p.sx} cy={p.sy} r={baseCircleRadius * inverseScale} fill="var(--color-primary)" opacity={0.3}>
                              <animate attributeName="r" values={`${baseAnimMin * inverseScale};${baseAnimMax * inverseScale}`} dur={p.dur} repeatCount="indefinite" />
                              <animate attributeName="opacity" values="0.4;0" dur={p.dur} repeatCount="indefinite" />
                            </circle>
                            <circle r={baseCircleRadius * inverseScale} fill="var(--color-primary)" opacity={p.selected ? 1 : 0.8} filter="url(#m-glow)">
                              <animateMotion dur={p.dur} repeatCount="indefinite" rotate="auto"><mpath href={`#${p.id}`} /></animateMotion>
                            </circle>
                          </g>
                        ))}
                      </g>
                    );
                  })()}
                  <g>
                    {mappable.map((c) => {
                      const point = projection?.([c.targetLongitude, c.targetLatitude]);
                      if (!point) return null;
                      const [x, y] = point;
                      const isSelected = selectedId === c.id;
                      const st = toMarkerState(c);
                      // Scale markers inversely with zoom to maintain consistent visual size
                      const zoomScale = zoomTransform.k;
                      const inverseScale = 1 / zoomScale;
                      const baseMarkerRadius = isSelected ? 16 : 12;
                      const markerRadius = baseMarkerRadius * inverseScale;
                      const strokeWidth = (isSelected ? 2.5 : 2) * inverseScale;
                      return (
                        <g key={c.id}>
                          <circle data-marker="true" cx={x} cy={y} r={markerRadius} onClick={(e) => { e.stopPropagation(); setSelectedId(prev => prev === c.id ? null : c.id); }} className={cn("cursor-pointer transition-all duration-300", isSelected ? MARKER_COLORS[st].selected : MARKER_COLORS[st].base)} stroke="var(--color-background)" strokeWidth={strokeWidth} vectorEffect="non-scaling-stroke" />
                        </g>
                      );
                    })}
                  </g>
                </g>
              </svg>
              {selected && selectedPoint && (
                <div 
                  className="absolute z-30 transition-all duration-400 ease-out animate-in fade-in zoom-in-95" 
                  style={{ 
                    left: isMobile ? '50%' : selectedPoint.x, 
                    top: isMobile ? 'auto' : selectedPoint.y,
                    bottom: isMobile ? '4rem' : 'auto',
                    transform: isMobile 
                      ? 'translateX(-50%)' 
                      : selectedPoint.placement === "top" 
                        ? `translate(-50%, calc(-100% - ${CALLOUT_GAP}px))` 
                        : `translate(-50%, ${CALLOUT_GAP}px)`
                  }}
                >
                  <div className="relative pointer-events-auto group/callout" onClick={e => e.stopPropagation()}>
                    <div className={cn("rounded-2xl border bg-background/80 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.3)] overflow-hidden transition-all duration-300", isMobile ? "w-[calc(100vw-2rem)] max-w-sm mx-auto" : "min-w-[280px]", selectedState === "UP" ? "border-emerald-500/20" : selectedState === "REDIRECT" ? "border-sky-500/20" : selectedState === "ERROR" ? "border-amber-500/20" : selectedState === "PAUSED" ? "border-amber-400/20" : selectedState === "DOWN" ? "border-destructive/20" : "border-muted-foreground/20")}>
                      <div className={cn("h-1.5 w-full", selectedState === "UP" ? "bg-emerald-500" : selectedState === "REDIRECT" ? "bg-sky-500" : selectedState === "ERROR" ? "bg-amber-500" : selectedState === "PAUSED" ? "bg-amber-400" : selectedState === "DOWN" ? "bg-destructive" : "bg-muted-foreground/40")} />
                      <div className={cn(isMobile ? "p-3" : "p-4")}>
                        <div className={cn("flex items-start justify-between mb-3", isMobile ? "gap-2" : "gap-3")}>
                          <div className="min-w-0 flex-1">
                            <h4 className={cn("font-bold truncate leading-tight mb-0.5", isMobile ? "text-xs" : "text-sm")}>{selected.name}</h4>
                            <div className="flex items-center gap-1.5 overflow-hidden">
                              <Globe className={cn("text-muted-foreground shrink-0", isMobile ? "size-2.5" : "size-3")} />
                              <span className={cn("text-muted-foreground truncate italic", isMobile ? "text-[10px]" : "text-[11px]")}>{selected.url.replace(/^https?:\/\//, '')}</span>
                            </div>
                          </div>
                          <Badge className={cn("shrink-0 font-mono py-0 px-2", isMobile ? "text-[9px] h-4" : "text-[10px] h-5", selectedState === "UP" ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/20" : selectedState === "REDIRECT" ? "bg-sky-500/15 text-sky-500 border-sky-500/20" : selectedState === "ERROR" ? "bg-amber-500/15 text-amber-500 border-amber-500/20" : selectedState === "PAUSED" ? "bg-amber-400/15 text-amber-400 border-amber-400/20" : selectedState === "DOWN" ? "bg-destructive/15 text-destructive border-destructive/20" : "bg-muted-foreground/15 text-muted-foreground border-muted-foreground/20")} variant="outline">
                            {selectedState === "UP" ? "ONLINE" : selectedState === "REDIRECT" ? "REDIRECT" : selectedState === "ERROR" ? "DEGRADED" : selectedState === "PAUSED" ? "PAUSED" : selectedState === "DOWN" ? "OFFLINE" : "UNKNOWN"}
                          </Badge>
                        </div>
                        <div className={cn("grid pt-3 border-t border-border/40", isMobile ? "grid-cols-2 gap-3" : "grid-cols-2 gap-4")}>
                          <div>
                            <span className={cn("block text-muted-foreground uppercase tracking-widest font-bold mb-1", isMobile ? "text-[9px]" : "text-[10px]")}>Latency</span>
                            <div className="flex items-baseline gap-1">
                              <span className={cn("font-mono font-bold", isMobile ? "text-xs" : "text-sm")}>{selected.responseTime ?? '---'}</span>
                              <span className={cn("text-muted-foreground", isMobile ? "text-[9px]" : "text-[10px]")}>ms</span>
                            </div>
                          </div>
                          <div>
                            <span className={cn("block text-muted-foreground uppercase tracking-widest font-bold mb-1", isMobile ? "text-[9px]" : "text-[10px]")}>Location</span>
                            <div className={cn("flex items-center gap-1 font-medium truncate", isMobile ? "text-[10px]" : "text-[11px]")}>{selected.targetCountry ?? "Global"}</div>
                          </div>
                        </div>
                        {selected.lastChecked && (
                          <div className={cn("mt-3 text-muted-foreground flex items-center justify-between font-mono bg-muted/30 px-2 py-1 rounded", isMobile ? "text-[9px]" : "text-[10px]")}>
                            <span>LAST CHECKED</span>
                            <span>{new Date(selected.lastChecked).toLocaleTimeString()}</span>
                          </div>
                        )}
                      </div>
                      {!isMobile && (
                        <div className={cn("absolute left-1/2 size-4 -translate-x-1/2 rotate-45 border bg-background/80 backdrop-blur-xl", selectedPoint.placement === "top" ? "-bottom-2 border-t-0 border-l-0" : "-top-2 border-b-0 border-r-0", selectedState === "UP" ? "border-emerald-500/20" : selectedState === "REDIRECT" ? "border-sky-500/20" : selectedState === "ERROR" ? "border-amber-500/20" : selectedState === "PAUSED" ? "border-amber-400/20" : selectedState === "DOWN" ? "border-destructive/20" : "border-muted-foreground/20")} />
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Country hover tooltip */}
              {hoveredCountry && countryHoverPos && hoveredFeature && !selected && (() => {
                const countryChecks = getChecksInFeature(hoveredFeature);
                if (!countryChecks || countryChecks.length === 0) return null;

                const stats = {
                  up: countryChecks.filter((c: MappableCheck) => toMarkerState(c) === "UP").length,
                  redirect: countryChecks.filter((c: MappableCheck) => toMarkerState(c) === "REDIRECT").length,
                  error: countryChecks.filter((c: MappableCheck) => toMarkerState(c) === "ERROR").length,
                  paused: countryChecks.filter((c: MappableCheck) => toMarkerState(c) === "PAUSED").length,
                  down: countryChecks.filter((c: MappableCheck) => toMarkerState(c) === "DOWN").length,
                };
                const avgResponseTime = countryChecks.reduce((sum: number, c: MappableCheck) => sum + (c.responseTime || 0), 0) / countryChecks.length;

                return (
                  <div
                    className="absolute z-20 pointer-events-none animate-in fade-in duration-200"
                    style={{
                      left: countryHoverPos.x + 12,
                      top: countryHoverPos.y + 12,
                    }}
                  >
                    <div className="rounded-lg border border-border/50 bg-background/95 backdrop-blur-xl shadow-xl p-3 min-w-[200px]">
                      <div className="flex items-center gap-2 mb-2">
                        <Globe className="size-3.5 text-primary" />
                        <h4 className="font-bold text-xs">{hoveredCountry}</h4>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-muted-foreground">Total Checks</span>
                          <span className="font-mono font-bold">{countryChecks.length}</span>
                        </div>
                        {stats.up > 0 && (
                          <div className="flex items-center justify-between text-[10px]">
                            <div className="flex items-center gap-1.5">
                              <div className="size-1.5 rounded-full bg-emerald-500" />
                              <span className="text-muted-foreground">Online</span>
                            </div>
                            <span className="font-mono font-bold text-emerald-500">{stats.up}</span>
                          </div>
                        )}
                        {stats.redirect > 0 && (
                          <div className="flex items-center justify-between text-[10px]">
                            <div className="flex items-center gap-1.5">
                              <div className="size-1.5 rounded-full bg-sky-500" />
                              <span className="text-muted-foreground">Redirect</span>
                            </div>
                            <span className="font-mono font-bold text-sky-500">{stats.redirect}</span>
                          </div>
                        )}
                        {stats.error > 0 && (
                          <div className="flex items-center justify-between text-[10px]">
                            <div className="flex items-center gap-1.5">
                              <div className="size-1.5 rounded-full bg-amber-500" />
                              <span className="text-muted-foreground">Degraded</span>
                            </div>
                            <span className="font-mono font-bold text-amber-500">{stats.error}</span>
                          </div>
                        )}
                        {stats.paused > 0 && (
                          <div className="flex items-center justify-between text-[10px]">
                            <div className="flex items-center gap-1.5">
                              <div className="size-1.5 rounded-full bg-amber-400" />
                              <span className="text-muted-foreground">Paused</span>
                            </div>
                            <span className="font-mono font-bold text-amber-400">{stats.paused}</span>
                          </div>
                        )}
                        {stats.down > 0 && (
                          <div className="flex items-center justify-between text-[10px]">
                            <div className="flex items-center gap-1.5">
                              <div className="size-1.5 rounded-full bg-destructive" />
                              <span className="text-muted-foreground">Offline</span>
                            </div>
                            <span className="font-mono font-bold text-destructive">{stats.down}</span>
                          </div>
                        )}
                        {avgResponseTime > 0 && (
                          <div className="flex items-center justify-between text-[10px] pt-1.5 mt-1.5 border-t border-border/30">
                            <span className="text-muted-foreground">Avg Response</span>
                            <span className="font-mono font-bold">{Math.round(avgResponseTime)}ms</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </CardContent>
      </GlowCard>
    </div>
  );
}
