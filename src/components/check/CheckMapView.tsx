import React from "react";
import { geoContains, geoDistance, geoEqualEarth, geoGraticule10, geoPath } from "d3-geo";
import { select } from "d3-selection";
import { zoom as d3Zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection } from "geojson";
import type { Website } from "../../types";
import { CardContent } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { cn } from "../../lib/utils";
import { GlowCard } from "../ui/glow-card";
import {
  Activity,
  ArrowUpRight,
  Globe,
  Map as MapIcon,
  Maximize2,
  Minus,
  Plus,
} from "lucide-react";
import worldTopoJsonRaw from "world-atlas/countries-110m.json?raw";
import { useMobile } from "../../hooks/useMobile";

type CheckMapViewProps = {
  checks: Website[];
  hideHeader?: boolean;
  /** Fill the parent's height instead of keeping a fixed aspect ratio (dashboard widgets). */
  fill?: boolean;
  /** When set, the selected-check callout shows an "Open check" action. */
  onOpenCheck?: (checkId: string) => void;
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
type RegionMeta = { label: string; code: string; lat: number; lon: number };

const FRANKFURT: RegionMeta = { label: "Europe eu-1, Frankfurt, DE", code: "FRA", lat: 50.1109, lon: 8.6821 };
const BOSTON: RegionMeta = { label: "America us-1, Boston, US", code: "BOS", lat: 42.3601, lon: -71.0589 };

const REGION_META: Record<RegionKey, RegionMeta> = {
  // Legacy GCF regions are dormant; all checks routed through them resolve to vps-eu-1.
  "us-central1": FRANKFURT,
  "europe-west1": FRANKFURT,
  "asia-southeast1": FRANKFURT,
  "vps-eu-1": FRANKFURT,
  "vps-us-1": BOSTON,
};

function regionOf(c: Website): RegionMeta {
  return REGION_META[(c.checkRegion ?? "vps-eu-1") as RegionKey] ?? FRANKFURT;
}

type StateMeta = {
  label: string;
  fill: string;
  dot: string;
  text: string;
  border: string;
  soft: string;
  color: string;
};

// One table for every status-coloured surface on the map. `color` is a CSS
// token so SVG strokes and glows track the active theme.
const STATE_META: Record<MarkerState, StateMeta> = {
  UP: { label: "Online", fill: "fill-success", dot: "bg-success", text: "text-success", border: "border-success/25", soft: "bg-success/15", color: "var(--success)" },
  REDIRECT: { label: "Redirect", fill: "fill-primary", dot: "bg-primary", text: "text-primary", border: "border-primary/25", soft: "bg-primary/15", color: "var(--primary)" },
  ERROR: { label: "Degraded", fill: "fill-warning", dot: "bg-warning", text: "text-warning", border: "border-warning/25", soft: "bg-warning/15", color: "var(--warning)" },
  MAINTENANCE: { label: "Maintenance", fill: "fill-warning", dot: "bg-warning", text: "text-warning", border: "border-warning/25", soft: "bg-warning/15", color: "var(--warning)" },
  PAUSED: { label: "Paused", fill: "fill-warning/60", dot: "bg-warning/60", text: "text-warning/80", border: "border-warning/20", soft: "bg-warning/10", color: "var(--warning)" },
  DOWN: { label: "Offline", fill: "fill-destructive", dot: "bg-destructive", text: "text-destructive", border: "border-destructive/30", soft: "bg-destructive/15", color: "var(--destructive)" },
  UNKNOWN: { label: "Unknown", fill: "fill-muted-foreground/50", dot: "bg-muted-foreground/50", text: "text-muted-foreground", border: "border-muted-foreground/20", soft: "bg-muted-foreground/15", color: "var(--muted-foreground)" },
};

const STATE_ORDER: MarkerState[] = ["UP", "REDIRECT", "ERROR", "MAINTENANCE", "PAUSED", "DOWN", "UNKNOWN"];

// Calm states are drawn first so problems always sit on top of a pile.
const DRAW_PRIORITY: Record<MarkerState, number> = { PAUSED: 0, UNKNOWN: 1, UP: 2, REDIRECT: 3, MAINTENANCE: 4, ERROR: 5, DOWN: 6 };

type StateCounts = Record<MarkerState, number>;

function countStates(checks: Website[]): StateCounts {
  const counts: StateCounts = { UP: 0, REDIRECT: 0, ERROR: 0, MAINTENANCE: 0, PAUSED: 0, DOWN: 0, UNKNOWN: 0 };
  for (const c of checks) counts[toMarkerState(c)]++;
  return counts;
}

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

const CALLOUT_GAP = 14;
const MARKER_R = 8;
const MARKER_R_SELECTED = 11;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 12;

function toMarkerState(c: Website): MarkerState {
  // Match timeline widget status logic
  if (c.maintenanceMode) return "MAINTENANCE";
  if (c.disabled) return "PAUSED";
  if (c.detailedStatus === "DOWN" || c.status === "offline") return "DOWN";
  if ((c.detailedStatus as string) === "DEGRADED" || (c.status as string) === "degraded") return "ERROR";
  if (c.detailedStatus === "REACHABLE_WITH_ERROR") return "ERROR";
  if (c.detailedStatus === "REDIRECT") return "REDIRECT";
  if (c.detailedStatus === "UP" || c.status === "online") return "UP";
  return "UNKNOWN";
}

function formatLocation(c: Website): string {
  const parts = [c.targetCity, c.targetCountry].filter(Boolean);
  return parts.length ? parts.join(", ") : "Unknown";
}

function MapHeader({ checks }: { checks: Website[] }) {
  const isMobile = useMobile(768);
  const counts = React.useMemo(() => countStates(checks), [checks]);
  const shown = STATE_ORDER.filter((s) => s === "UP" || counts[s] > 0);

  return (
    <div className={cn("flex mb-4", isMobile ? "flex-col gap-3" : "items-center justify-between gap-4")}>
      <div className="flex items-center gap-2">
        <div className={cn("rounded-lg bg-primary/10 text-primary", isMobile ? "p-1.5" : "p-2")}>
          <MapIcon className={cn(isMobile ? "size-4" : "size-5")} />
        </div>
        <div>
          <h2 className={cn("font-semibold tracking-tight", isMobile ? "text-base" : "text-lg")}>Global Infrastructure</h2>
          <p className={cn("text-muted-foreground font-mono", isMobile ? "text-[10px]" : "text-xs")}>Where your endpoints live, and where we probe them from</p>
        </div>
      </div>

      <div className={cn("flex items-center gap-3", isMobile && "justify-between w-full")}>
        <div className={cn("items-center gap-4 px-3 py-1.5 rounded-full bg-muted/30 border border-border/50 backdrop-blur-sm", isMobile ? "flex flex-wrap gap-2" : "hidden sm:flex")}>
          {shown.map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <div className={cn("size-2 rounded-full", STATE_META[s].dot, s === "DOWN" && "animate-pulse")} style={{ boxShadow: `0 0 8px ${STATE_META[s].color}` }} />
              <span className={cn("text-[10px] font-bold font-mono uppercase", STATE_META[s].text)}>{counts[s]} {STATE_META[s].label}</span>
            </div>
          ))}
        </div>
        <Badge variant="outline" className={cn("font-mono bg-background/50", isMobile ? "text-[9px] px-2 py-0.5" : "text-[10px]")}>
          {checks.length} TOTAL
        </Badge>
      </div>
    </div>
  );
}

function MapLegend({ counts, probes, unmapped }: { counts: StateCounts; probes: RegionMeta[]; unmapped: number }) {
  const shown = STATE_ORDER.filter((s) => counts[s] > 0);
  return (
    <div className="absolute top-4 left-4 p-3.5 rounded-xl bg-background/70 border border-border/40 backdrop-blur-xl shadow-2xl z-20 hidden md:block w-52">
      <h3 className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2.5 flex items-center gap-2">
        <Activity className="size-3 text-primary" /> On this map
      </h3>
      <div className="space-y-2">
        {shown.map((s) => (
          <div key={s} className="flex items-center gap-2.5">
            <div className={cn("size-2.5 rounded-full shrink-0", STATE_META[s].dot, s === "DOWN" && "animate-pulse")} style={{ boxShadow: `0 0 8px ${STATE_META[s].color}` }} />
            <span className="text-[11px] font-medium text-foreground/80 flex-1">{STATE_META[s].label}</span>
            <span className={cn("text-[11px] font-mono font-bold tabular-nums", STATE_META[s].text)}>{counts[s]}</span>
          </div>
        ))}
      </div>
      <div className="pt-2.5 mt-2.5 border-t border-border/30 space-y-2">
        {probes.length > 0 && (
          <div className="flex items-center gap-2.5">
            <div className="size-2.5 shrink-0 rotate-45 rounded-[2px] bg-primary ring-2 ring-primary/25" />
            <span className="text-[10px] text-muted-foreground font-mono">Probe {probes.map((p) => p.code).join(" · ")}</span>
          </div>
        )}
        <div className="flex items-center gap-2.5">
          <div className="h-px w-2.5 shrink-0 bg-primary/70" />
          <span className="text-[10px] text-muted-foreground font-mono">Check path</span>
        </div>
        {unmapped > 0 && (
          <p className="text-[10px] text-muted-foreground/70 leading-snug">
            {unmapped} {unmapped === 1 ? "check has" : "checks have"} no location yet
          </p>
        )}
      </div>
    </div>
  );
}

function MapControls({ onZoomIn, onZoomOut, onReset }: { onZoomIn: () => void; onZoomOut: () => void; onReset: () => void }) {
  const btn = "flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer";
  return (
    <div className="absolute bottom-4 right-4 z-20 flex flex-col overflow-hidden rounded-lg border border-border/50 bg-background/70 backdrop-blur-xl shadow-lg divide-y divide-border/40" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={btn} onClick={onZoomIn} aria-label="Zoom in" title="Zoom in"><Plus className="size-4" /></button>
      <button type="button" className={btn} onClick={onZoomOut} aria-label="Zoom out" title="Zoom out"><Minus className="size-4" /></button>
      <button type="button" className={btn} onClick={onReset} aria-label="Fit all checks" title="Fit all checks"><Maximize2 className="size-3.5" /></button>
    </div>
  );
}

function toMappableChecks(checks: Website[]): MappableCheck[] {
  return checks.filter((c): c is MappableCheck => isFiniteNumber(c.targetLatitude) && isFiniteNumber(c.targetLongitude));
}

function fitPolygonForChecks(checks: MappableCheck[]): FeatureCollection | null {
  if (!checks.length) return null;
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  // Include both target locations and source region locations
  for (const c of checks) {
    const meta = regionOf(c);
    for (const [lat, lon] of [[c.targetLatitude, c.targetLongitude], [meta.lat, meta.lon]]) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
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

type PlacedMarker = {
  check: MappableCheck;
  state: MarkerState;
  /** Projected (untransformed) map position of the real location. */
  x: number;
  y: number;
  /** Screen-pixel offset used to fan out checks that share a location. */
  dx: number;
  dy: number;
  groupSize: number;
};

// Vogel (sunflower) spiral: evenly packs any number of co-located markers
// around their shared point without a fixed ring size.
function spreadOffset(i: number, n: number): { dx: number; dy: number } {
  if (n <= 1) return { dx: 0, dy: 0 };
  const r = 13 * Math.sqrt(i + 0.5);
  const theta = i * 2.39996323;
  return { dx: r * Math.cos(theta), dy: r * Math.sin(theta) };
}

function MapShell({ checks, hideHeader, isMobile, children }: { checks: Website[]; hideHeader: boolean; isMobile: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("h-full flex flex-col", hideHeader ? "" : (isMobile ? "min-h-[400px]" : "min-h-[500px]"))}>
      {!hideHeader && <MapHeader checks={checks} />}
      <GlowCard magic className="flex-1 min-h-0 flex flex-col items-center justify-center border-none md:max-h-[800px]">
        <div className={cn("text-center space-y-4", isMobile ? "p-4" : "p-8")}>{children}</div>
      </GlowCard>
    </div>
  );
}

export default function CheckMapView({ checks, hideHeader = false, fill = false, onOpenCheck }: CheckMapViewProps) {
  const isMobile = useMobile(768);
  const uid = safeSvgId(React.useId());
  const mappable = React.useMemo(() => toMappableChecks(checks), [checks]);
  const counts = React.useMemo(() => countStates(mappable), [mappable]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [world, setWorld] = React.useState<FeatureCollection | null>(null);
  const [worldError, setWorldError] = React.useState<string | null>(null);
  // Callback ref: the container mounts late (after the world and checks load).
  const [containerEl, setContainerEl] = React.useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = React.useState(false);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const mapGRef = React.useRef<SVGGElement | null>(null);
  const zoomBehaviorRef = React.useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const draggingRef = React.useRef(false);
  const hasAppliedInitialZoom = React.useRef(false);
  const animFrameRef = React.useRef<number | null>(null);
  const [zoomTransform, setZoomTransform] = React.useState(() => zoomIdentity);
  const zoomTransformRef = React.useRef<ZoomTransform>(zoomIdentity);

  // Initialize size - will be updated by ResizeObserver immediately
  const [size, setSize] = React.useState<{ width: number; height: number }>(() => {
    if (typeof window === "undefined") return { width: 900, height: 520 };
    return { width: window.innerWidth, height: window.innerHeight };
  });

  React.useEffect(() => {
    const el = containerEl;
    if (!el) return;
    const apply = (w: number, h: number) => {
      if (w < 1 || h < 1) return;
      setSize({ width: Math.floor(w), height: Math.floor(h) });
      setMeasured(true);
    };
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => {
        const r = el.getBoundingClientRect();
        apply(r.width, r.height);
      };
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      apply(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerEl]);

  React.useEffect(() => {
    try {
      setWorldError(null);
      const topo = JSON.parse(worldTopoJsonRaw) as TopologyLike;
      const objects = topo?.objects as Record<string, unknown>;
      const topoObject = objects.countries ?? objects.land ?? Object.values(objects)[0];
      setWorld(feature(topo as never, topoObject as never) as unknown as FeatureCollection);
    } catch (e) {
      setWorldError(e instanceof Error ? e.message : "Failed to load map");
    }
  }, []);

  // Live status updates replace the checks array constantly; key the
  // geometry work on locations only so it doesn't redo on every ping.
  const geoKey = React.useMemo(
    () => mappable.map((c) => `${c.id}:${c.targetLatitude},${c.targetLongitude}:${c.checkRegion ?? ""}`).join("|"),
    [mappable]
  );
  const mappableRef = React.useRef(mappable);
  mappableRef.current = mappable;

  const projection = React.useMemo(() => {
    if (!world) return null;
    const p = geoEqualEarth();
    const pad = 12;
    const fitGeo = fitPolygonForChecks(mappableRef.current) ?? world;
    p.fitExtent([[pad, pad], [Math.max(pad + 1, size.width - pad), Math.max(pad + 1, size.height - pad)]], fitGeo);
    return p;
  }, [geoKey, size.height, size.width, world]);

  const path = React.useMemo(() => (projection ? geoPath(projection) : null), [projection]);

  // Country path strings are the heaviest thing on the map; build them once
  // per projection instead of on every zoom frame.
  const countryPaths = React.useMemo(() => {
    if (!world || !path) return [];
    return world.features.map((f, idx) => ({ idx, d: path(f) ?? "", name: ((f.properties as { name?: string } | null)?.name) || "Unknown" }));
  }, [world, path]);

  const sphereD = React.useMemo(() => (path ? path({ type: "Sphere" }) ?? "" : ""), [path]);
  const graticuleD = React.useMemo(() => (path ? path(geoGraticule10()) ?? "" : ""), [path]);

  // Which country polygon each check sits in (true point-in-polygon, not
  // name matching, so "Niger" no longer collects checks in Nigeria).
  const countryOfCheck = React.useMemo(() => {
    const map = new Map<string, number>();
    if (!world) return map;
    for (const c of mappableRef.current) {
      const pt: [number, number] = [c.targetLongitude, c.targetLatitude];
      const idx = world.features.findIndex((f) => geoContains(f, pt));
      if (idx >= 0) map.set(c.id, idx);
    }
    return map;
  }, [geoKey, world]);

  const activeCountries = React.useMemo(() => new Set(countryOfCheck.values()), [countryOfCheck]);

  const probes = React.useMemo(() => {
    const seen = new Map<string, RegionMeta>();
    for (const c of mappable) {
      const r = regionOf(c);
      seen.set(r.code, r);
    }
    return [...seen.values()];
  }, [mappable]);

  // Calculate the bounding box of all markers and probe regions in projected space.
  const markerBounds = React.useMemo(() => {
    if (!mappable.length || !projection) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of mappable) {
      const r = regionOf(c);
      for (const lonLat of [[c.targetLongitude, c.targetLatitude], [r.lon, r.lat]] as [number, number][]) {
        const p = projection(lonLat);
        if (!p) continue;
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    if (!Number.isFinite(minX)) return null;
    return {
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      width: Math.max(maxX - minX, 1),
      height: Math.max(maxY - minY, 1),
    };
  }, [mappable, projection]);

  const initialZoomTransform = React.useMemo(() => {
    if (markerBounds) {
      const padding = isMobile ? 0.12 : 0.16;
      const availableWidth = size.width * (1 - padding * 2);
      const availableHeight = size.height * (1 - padding * 2);
      const baseScale = Math.min(availableWidth / markerBounds.width, availableHeight / markerBounds.height);
      const k = clamp(baseScale, 1, isMobile ? 3.5 : 3.0);
      const tx = size.width / 2 - markerBounds.center.x * k;
      const ty = size.height / 2 - markerBounds.center.y * k;
      return zoomIdentity.translate(tx, ty).scale(k);
    }
    return zoomIdentity;
  }, [size.height, size.width, isMobile, markerBounds]);

  // Set up zoom behavior (only when projection becomes available)
  React.useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !projection) return;
    const behavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .filter((event: MouseEvent & WheelEvent & TouchEvent) => {
        const target = event?.target as Element | null;
        if ((event?.type === "mousedown" || event?.type === "touchstart") && target?.closest?.('[data-marker="true"]')) return false;
        return (!event?.ctrlKey || event?.type === "wheel") && !event?.button;
      })
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        // Only a real pan or zoom counts as dragging, so a plain click on
        // the map still closes the callout.
        if (event?.sourceEvent) draggingRef.current = true;
        const t = event.transform as ZoomTransform;
        zoomTransformRef.current = t;
        setZoomTransform(t);
        if (mapGRef.current) mapGRef.current.setAttribute("transform", t.toString());
      })
      .on("end", () => {
        window.setTimeout(() => { draggingRef.current = false; }, 0);
      });
    zoomBehaviorRef.current = behavior;
    const svg = select(svgEl);
    svg.call(behavior);
    // Keep the current view if the behavior is rebuilt (resize, new checks).
    svg.call(behavior.transform, zoomTransformRef.current);
    return () => { svg.on(".zoom", null); };
  }, [projection]);

  // Apply initial zoom transform only once when first available
  React.useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !zoomBehaviorRef.current || hasAppliedInitialZoom.current || !measured) return;
    if (!markerBounds && mappable.length > 0) return;
    hasAppliedInitialZoom.current = true;
    select(svgEl).call(zoomBehaviorRef.current.transform, initialZoomTransform);
  }, [initialZoomTransform, markerBounds, mappable.length, measured]);

  const [reduceMotion, setReduceMotion] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const animateTo = React.useCallback((target: ZoomTransform) => {
    const svgEl = svgRef.current;
    const behavior = zoomBehaviorRef.current;
    if (!svgEl || !behavior) return;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    const svg = select(svgEl);
    const from = zoomTransformRef.current;
    if (reduceMotion) {
      svg.call(behavior.transform, target);
      return;
    }
    const start = performance.now();
    const duration = 320;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      // Interpolate the zoom level geometrically so it feels even.
      const k = from.k * Math.pow(target.k / from.k, e);
      const x = from.x + (target.x - from.x) * e;
      const y = from.y + (target.y - from.y) * e;
      svg.call(behavior.transform, zoomIdentity.translate(x, y).scale(k));
      animFrameRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    animFrameRef.current = requestAnimationFrame(step);
  }, [reduceMotion]);

  React.useEffect(() => () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); }, []);

  const zoomBy = React.useCallback((factor: number) => {
    const cur = zoomTransformRef.current;
    const k = clamp(cur.k * factor, MIN_ZOOM, MAX_ZOOM);
    const cx = size.width / 2;
    const cy = size.height / 2;
    const x = cx - (cx - cur.x) * (k / cur.k);
    const y = cy - (cy - cur.y) * (k / cur.k);
    animateTo(zoomIdentity.translate(x, y).scale(k));
  }, [animateTo, size.height, size.width]);

  const markers = React.useMemo<PlacedMarker[]>(() => {
    if (!projection) return [];
    const groups = new Map<string, MappableCheck[]>();
    for (const c of mappable) {
      const key = `${c.targetLatitude.toFixed(2)},${c.targetLongitude.toFixed(2)}`;
      const g = groups.get(key);
      if (g) g.push(c); else groups.set(key, [c]);
    }
    const out: PlacedMarker[] = [];
    for (const group of groups.values()) {
      // Worst status in the middle of the spiral, where it's easiest to see.
      group.sort((a, b) => DRAW_PRIORITY[toMarkerState(b)] - DRAW_PRIORITY[toMarkerState(a)] || a.id.localeCompare(b.id));
      group.forEach((c, i) => {
        const p = projection([c.targetLongitude, c.targetLatitude]);
        if (!p) return;
        out.push({ check: c, state: toMarkerState(c), x: p[0], y: p[1], ...spreadOffset(i, group.length), groupSize: group.length });
      });
    }
    out.sort((a, b) => DRAW_PRIORITY[a.state] - DRAW_PRIORITY[b.state]);
    return out;
  }, [mappable, projection]);

  const selectedMarker = React.useMemo(() => (selectedId ? markers.find((m) => m.check.id === selectedId) ?? null : null), [markers, selectedId]);
  const hoveredMarker = React.useMemo(() => (hoveredId ? markers.find((m) => m.check.id === hoveredId) ?? null : null), [markers, hoveredId]);

  const toScreen = React.useCallback((m: PlacedMarker) => ({
    x: zoomTransform.applyX(m.x) + m.dx,
    y: zoomTransform.applyY(m.y) + m.dy,
  }), [zoomTransform]);

  const selectedPoint = React.useMemo(() => {
    if (!selectedMarker) return null;
    const { x, y } = toScreen(selectedMarker);
    const threshold = isMobile ? 180 : 230;
    return { x, y, placement: (y < threshold ? "bottom" : "top") as "bottom" | "top" };
  }, [selectedMarker, toScreen, isMobile]);

  // Great-circle paths from the probe region to each target.
  const pings = React.useMemo(() => {
    if (!path) return [];
    return mappable.slice(0, 150).flatMap((c) => {
      const r = regionOf(c);
      const src: [number, number] = [r.lon, r.lat];
      const dst: [number, number] = [c.targetLongitude, c.targetLatitude];
      if (geoDistance(src, dst) < 0.01) return []; // same metro as the probe
      const d = path({ type: "LineString", coordinates: [src, dst] });
      if (!d) return [];
      const u = hashToUnit(c.id);
      return [{ checkId: c.id, id: `${uid}-p-${safeSvgId(c.id)}`, d, dur: `${(2.2 + u * 1.6).toFixed(2)}s`, begin: `${(u * 2).toFixed(2)}s` }];
    });
  }, [geoKey, path, uid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Status changes far more often than geometry, so read it at render time.
  const stateById = React.useMemo(() => new Map(mappable.map((c) => [c.id, toMarkerState(c)] as const)), [mappable]);

  React.useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  const [hoveredCountryIdx, setHoveredCountryIdx] = React.useState<number | null>(null);
  const [countryHoverPos, setCountryHoverPos] = React.useState<{ x: number; y: number } | null>(null);

  const trackCountryHover = (idx: number, e: React.MouseEvent) => {
    if (isMobile) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHoveredCountryIdx(idx);
    setCountryHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  if (checks.length === 0) {
    return (
      <MapShell checks={[]} hideHeader={hideHeader} isMobile={isMobile}>
        <div className={cn("rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4 border border-border/50 shadow-inner", isMobile ? "size-12" : "size-16")}>
          <Globe className={cn("text-muted-foreground/50", isMobile ? "size-6" : "size-8")} />
        </div>
        <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg")}>No data points available</h3>
        <p className={cn("text-muted-foreground max-w-sm mx-auto", isMobile ? "text-xs" : "text-sm")}>Once you add checks and they begin monitoring, their geographic locations will be visualized here.</p>
      </MapShell>
    );
  }

  if (mappable.length === 0) {
    return (
      <MapShell checks={checks} hideHeader={hideHeader} isMobile={isMobile}>
        <div className={cn("rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4 border border-border/50 shadow-inner", isMobile ? "size-12" : "size-16")}>
          <Activity className={cn("text-muted-foreground/50", isMobile ? "size-6" : "size-8")} />
        </div>
        <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg")}>Resolving Geo Locations</h3>
        <p className={cn("text-muted-foreground max-w-sm mx-auto", isMobile ? "text-xs" : "text-sm")}>Identifying targets of your checks. This happens automatically during the first check runs.</p>
      </MapShell>
    );
  }

  if (worldError) {
    return (
      <MapShell checks={checks} hideHeader={hideHeader} isMobile={isMobile}>
        <div className="text-destructive space-y-4">
          <div className={cn("rounded-2xl bg-destructive/10 flex items-center justify-center mx-auto mb-4 border border-destructive/20 shadow-inner", isMobile ? "size-12" : "size-16")}>
            <Activity className={cn(isMobile ? "size-6" : "size-8")} />
          </div>
          <h3 className={cn("font-semibold", isMobile ? "text-base" : "text-lg")}>Map Error</h3>
          <p className={cn("opacity-80 max-w-sm mx-auto", isMobile ? "text-xs" : "text-sm")}>{worldError}</p>
        </div>
      </MapShell>
    );
  }

  if (!world || !projection || !path) {
    return (
      <MapShell checks={checks} hideHeader={hideHeader} isMobile={isMobile}>
        <div className={cn("animate-spin border-4 border-primary border-t-transparent rounded-full mx-auto", isMobile ? "size-10" : "size-12")} />
        <p className={cn("text-muted-foreground font-mono uppercase tracking-widest", isMobile ? "text-xs" : "text-sm")}>Loading map...</p>
      </MapShell>
    );
  }

  const k = zoomTransform.k;
  const inv = 1 / k;
  const selected = selectedMarker?.check ?? null;
  const selectedState = selectedMarker?.state ?? "UNKNOWN";
  const sm = STATE_META[selectedState];
  const glowId = `${uid}-glow`;
  const unmapped = checks.length - mappable.length;

  const hoveredCountryChecks = hoveredCountryIdx != null && !selected && !hoveredMarker
    ? mappable.filter((c) => countryOfCheck.get(c.id) === hoveredCountryIdx)
    : [];

  return (
    <div className="flex flex-col h-full">
      {!hideHeader && <MapHeader checks={checks} />}
      <GlowCard magic accent="blue" className={cn("flex flex-col border border-border/50 shadow-2xl relative w-full", fill ? "flex-1 min-h-0" : cn("md:max-h-[800px]", isMobile ? "aspect-[4/3]" : "aspect-video"))}>
        <CardContent className="flex-1 min-h-0 p-0 relative">
          <div ref={setContainerEl} className={cn("relative h-full w-full overflow-hidden", !fill && "md:max-h-[800px]")} onClick={() => { if (!draggingRef.current) setSelectedId(null); }}>
            <MapLegend counts={counts} probes={probes} unmapped={unmapped} />
            <MapControls onZoomIn={() => zoomBy(1.6)} onZoomOut={() => zoomBy(1 / 1.6)} onReset={() => animateTo(initialZoomTransform)} />
            <div className="relative h-full w-full overflow-hidden">
              <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} className={cn("relative z-0 block w-full h-full select-none", isMobile ? "touch-none" : "cursor-grab active:cursor-grabbing")}>
                <defs>
                  <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="2" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                <g ref={mapGRef} transform={zoomTransform.toString()}>
                  {/* Globe outline and graticule give the ocean some structure */}
                  <path d={sphereD} fill="color-mix(in oklab, var(--color-foreground) 1.5%, var(--color-background))" stroke="color-mix(in oklab, var(--color-foreground) 14%, var(--color-background))" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <path d={graticuleD} fill="none" stroke="color-mix(in oklab, var(--color-foreground) 6%, var(--color-background))" strokeWidth={0.6} vectorEffect="non-scaling-stroke" className="pointer-events-none" />
                  <g>
                    {countryPaths.map((cp) => {
                      const active = activeCountries.has(cp.idx);
                      return (
                        <path
                          key={cp.idx}
                          d={cp.d}
                          fill={active
                            ? "color-mix(in oklab, var(--color-primary) 10%, var(--color-background))"
                            : "color-mix(in oklab, var(--color-foreground) 5%, var(--color-background))"}
                          stroke="color-mix(in oklab, var(--color-foreground) 22%, var(--color-background))"
                          strokeWidth={0.6}
                          vectorEffect="non-scaling-stroke"
                          className={cn("transition-[fill] duration-300", active ? "hover:fill-primary/20" : "hover:fill-foreground/[0.08]")}
                          onMouseEnter={(e) => trackCountryHover(cp.idx, e)}
                          onMouseMove={(e) => trackCountryHover(cp.idx, e)}
                          onMouseLeave={() => { setHoveredCountryIdx(null); setCountryHoverPos(null); }}
                        />
                      );
                    })}
                  </g>

                  {/* Check paths: probe region to target, coloured by status */}
                  <g className="pointer-events-none">
                    {pings.map((p) => {
                      const isSel = selectedId === p.checkId || hoveredId === p.checkId;
                      const dim = (selectedId || hoveredId) && !isSel;
                      const state = stateById.get(p.checkId) ?? "UNKNOWN";
                      const color = STATE_META[state].color;
                      return (
                        <g key={p.id}>
                          <path id={p.id} d={p.d} fill="none" stroke={color} strokeOpacity={isSel ? 0.85 : dim ? 0.08 : 0.3} strokeWidth={isSel ? 1.8 : 1.1} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                          {!reduceMotion && state !== "PAUSED" && !dim && (
                            <circle r={2.2 * inv} fill={color} opacity={0} filter={`url(#${glowId})`}>
                              <animateMotion dur={p.dur} begin={p.begin} repeatCount="indefinite"><mpath href={`#${p.id}`} /></animateMotion>
                              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur={p.dur} begin={p.begin} repeatCount="indefinite" />
                            </circle>
                          )}
                        </g>
                      );
                    })}
                  </g>

                  {/* Probe regions */}
                  <g className="pointer-events-none">
                    {probes.map((r) => {
                      const pt = projection([r.lon, r.lat]);
                      if (!pt) return null;
                      const s = 5 * inv;
                      return (
                        <g key={r.code} transform={`translate(${pt[0]} ${pt[1]})`}>
                          {!reduceMotion && (
                            <circle r={6 * inv} fill="none" stroke="var(--color-primary)" strokeWidth={1} vectorEffect="non-scaling-stroke">
                              <animate attributeName="r" values={`${6 * inv};${22 * inv}`} dur="2.4s" repeatCount="indefinite" />
                              <animate attributeName="stroke-opacity" values="0.6;0" dur="2.4s" repeatCount="indefinite" />
                            </circle>
                          )}
                          <rect x={-s} y={-s} width={s * 2} height={s * 2} rx={1.2 * inv} transform="rotate(45)" fill="var(--color-primary)" stroke="var(--color-background)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" filter={`url(#${glowId})`} />
                          <text
                            x={10 * inv}
                            y={-8 * inv}
                            fontSize={10 * inv}
                            className="fill-primary font-mono font-bold"
                            stroke="var(--color-background)"
                            strokeWidth={3 * inv}
                            paintOrder="stroke"
                            letterSpacing={0.5 * inv}
                          >
                            {r.code}
                          </text>
                        </g>
                      );
                    })}
                  </g>

                  {/* Leader lines for fanned-out co-located checks */}
                  <g className="pointer-events-none">
                    {markers.filter((m) => m.groupSize > 1).map((m) => (
                      <line key={`l-${m.check.id}`} x1={m.x} y1={m.y} x2={m.x + m.dx * inv} y2={m.y + m.dy * inv} stroke="var(--color-muted-foreground)" strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    ))}
                  </g>

                  {/* Target markers */}
                  <g>
                    {markers.map((m) => {
                      const isSelected = selectedId === m.check.id;
                      const isHovered = hoveredId === m.check.id;
                      const meta = STATE_META[m.state];
                      const cx = m.x + m.dx * inv;
                      const cy = m.y + m.dy * inv;
                      const r = (isSelected || isHovered ? MARKER_R_SELECTED : MARKER_R) * inv;
                      return (
                        <g key={m.check.id}>
                          {m.state === "DOWN" && !reduceMotion && (
                            <circle cx={cx} cy={cy} r={r} className="pointer-events-none fill-destructive">
                              <animate attributeName="r" values={`${r};${r * 2.6}`} dur="1.6s" repeatCount="indefinite" />
                              <animate attributeName="opacity" values="0.5;0" dur="1.6s" repeatCount="indefinite" />
                            </circle>
                          )}
                          {isSelected && (
                            <circle cx={cx} cy={cy} r={r + 4 * inv} fill="none" stroke={meta.color} strokeOpacity={0.6} strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="pointer-events-none" />
                          )}
                          <circle
                            data-marker="true"
                            role="button"
                            tabIndex={0}
                            aria-label={`${m.check.name}: ${meta.label}`}
                            cx={cx}
                            cy={cy}
                            r={r}
                            onClick={(e) => { e.stopPropagation(); setSelectedId((prev) => (prev === m.check.id ? null : m.check.id)); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(m.check.id); } }}
                            onMouseEnter={() => { setHoveredId(m.check.id); setHoveredCountryIdx(null); }}
                            onMouseLeave={() => setHoveredId((prev) => (prev === m.check.id ? null : prev))}
                            className={cn("cursor-pointer outline-none transition-[r] duration-150", meta.fill)}
                            style={{ filter: m.state === "PAUSED" || m.state === "UNKNOWN" ? undefined : `drop-shadow(0 0 4px ${meta.color})` }}
                            stroke="var(--color-background)"
                            strokeWidth={2}
                            vectorEffect="non-scaling-stroke"
                          />
                        </g>
                      );
                    })}
                  </g>
                </g>
              </svg>

              {/* Marker hover label */}
              {hoveredMarker && hoveredMarker.check.id !== selectedId && !isMobile && (() => {
                const { x, y } = toScreen(hoveredMarker);
                const meta = STATE_META[hoveredMarker.state];
                return (
                  <div className="absolute z-20 pointer-events-none" style={{ left: x, top: y - MARKER_R_SELECTED - 8, transform: "translate(-50%, -100%)" }}>
                    <div className="flex items-center gap-2 whitespace-nowrap rounded-md border border-border/50 bg-background/95 backdrop-blur-xl px-2.5 py-1.5 shadow-xl">
                      <div className={cn("size-1.5 rounded-full", meta.dot)} />
                      <span className="text-[11px] font-semibold max-w-[220px] truncate">{hoveredMarker.check.name}</span>
                      {hoveredMarker.check.responseTime != null && hoveredMarker.state !== "PAUSED" && (
                        <span className="text-[10px] font-mono text-muted-foreground">{hoveredMarker.check.responseTime}ms</span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {selected && selectedPoint && (
                <div
                  className="absolute z-30 animate-in fade-in zoom-in-95 duration-200"
                  style={{
                    left: isMobile ? "50%" : selectedPoint.x,
                    top: isMobile ? "auto" : selectedPoint.y,
                    bottom: isMobile ? "1rem" : "auto",
                    transform: isMobile
                      ? "translateX(-50%)"
                      : selectedPoint.placement === "top"
                        ? `translate(-50%, calc(-100% - ${CALLOUT_GAP}px))`
                        : `translate(-50%, ${CALLOUT_GAP}px)`,
                  }}
                >
                  <div className="relative pointer-events-auto" onClick={(e) => e.stopPropagation()}>
                    <div className={cn("rounded-xl border bg-background/90 backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.35)] overflow-hidden", isMobile ? "w-[calc(100vw-2rem)] max-w-sm mx-auto" : "w-[300px]", sm.border)}>
                      <div className={cn("h-1 w-full", sm.dot)} />
                      <div className={cn(isMobile ? "p-3" : "p-4")}>
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="min-w-0 flex-1">
                            <h4 className="font-bold truncate leading-tight mb-0.5 text-sm">{selected.name}</h4>
                            <div className="flex items-center gap-1.5 overflow-hidden">
                              <Globe className="text-muted-foreground shrink-0 size-3" />
                              <span className="text-muted-foreground truncate text-[11px] font-mono">{selected.url.replace(/^https?:\/\//, "")}</span>
                            </div>
                          </div>
                          <Badge className={cn("shrink-0 font-mono py-0 px-2 text-[10px] h-5 uppercase", sm.soft, sm.text, sm.border)} variant="outline">
                            {sm.label}
                          </Badge>
                        </div>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 pt-3 border-t border-border/40">
                          <div>
                            <dt className="text-muted-foreground uppercase tracking-widest font-bold mb-1 text-[9px]">Latency</dt>
                            <dd className="flex items-baseline gap-1">
                              <span className="font-mono font-bold text-sm">{selected.responseTime ?? "---"}</span>
                              <span className="text-muted-foreground text-[10px]">ms</span>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground uppercase tracking-widest font-bold mb-1 text-[9px]">Status code</dt>
                            <dd className="font-mono font-bold text-sm">{selected.lastStatusCode ?? "---"}</dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-muted-foreground uppercase tracking-widest font-bold mb-1 text-[9px]">Location</dt>
                            <dd className="font-medium truncate text-[11px]" title={formatLocation(selected)}>{formatLocation(selected)}</dd>
                          </div>
                          <div className="min-w-0">
                            <dt className="text-muted-foreground uppercase tracking-widest font-bold mb-1 text-[9px]">Probed from</dt>
                            <dd className="font-medium truncate text-[11px]" title={regionOf(selected).label}>{regionOf(selected).label.split(", ").slice(1).join(", ")}</dd>
                          </div>
                        </dl>
                        {(selected.lastChecked || onOpenCheck) && (
                          <div className="mt-3 flex items-center justify-between gap-2">
                            {selected.lastChecked ? (
                              <span className="text-muted-foreground font-mono text-[10px]">Checked {new Date(selected.lastChecked).toLocaleTimeString()}</span>
                            ) : <span />}
                            {onOpenCheck && (
                              <button
                                type="button"
                                onClick={() => onOpenCheck(selected.id)}
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors cursor-pointer"
                              >
                                Open check <ArrowUpRight className="size-3" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Country hover tooltip */}
              {hoveredCountryChecks.length > 0 && countryHoverPos && hoveredCountryIdx != null && (() => {
                const c = countStates(hoveredCountryChecks);
                const withLatency = hoveredCountryChecks.filter((x) => isFiniteNumber(x.responseTime) && toMarkerState(x) !== "PAUSED");
                const avg = withLatency.length ? withLatency.reduce((s, x) => s + (x.responseTime as number), 0) / withLatency.length : 0;
                const flipX = countryHoverPos.x > size.width - 230;
                return (
                  <div
                    className="absolute z-20 pointer-events-none animate-in fade-in duration-150"
                    style={{ left: countryHoverPos.x + (flipX ? -12 : 12), top: countryHoverPos.y + 12, transform: flipX ? "translateX(-100%)" : undefined }}
                  >
                    <div className="rounded-lg border border-border/50 bg-background/95 backdrop-blur-xl shadow-xl p-3 min-w-[200px]">
                      <div className="flex items-center gap-2 mb-2">
                        <Globe className="size-3.5 text-primary" />
                        <h4 className="font-bold text-xs">{countryPaths[hoveredCountryIdx]?.name}</h4>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-muted-foreground">Checks</span>
                          <span className="font-mono font-bold">{hoveredCountryChecks.length}</span>
                        </div>
                        {STATE_ORDER.filter((s) => c[s] > 0).map((s) => (
                          <div key={s} className="flex items-center justify-between text-[10px]">
                            <div className="flex items-center gap-1.5">
                              <div className={cn("size-1.5 rounded-full", STATE_META[s].dot)} />
                              <span className="text-muted-foreground">{STATE_META[s].label}</span>
                            </div>
                            <span className={cn("font-mono font-bold", STATE_META[s].text)}>{c[s]}</span>
                          </div>
                        ))}
                        {avg > 0 && (
                          <div className="flex items-center justify-between text-[10px] pt-1.5 mt-1.5 border-t border-border/30">
                            <span className="text-muted-foreground">Avg response</span>
                            <span className="font-mono font-bold">{Math.round(avg)}ms</span>
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
