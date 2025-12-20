import * as logger from "firebase-functions/logger";
import dns from "dns/promises";
import net from "net";

type IpWhoIsResponse = {
  success?: boolean;
  country?: unknown;
  region?: unknown;
  city?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  connection?: {
    asn?: unknown;
    org?: unknown;
    isp?: unknown;
  };
};

export type TargetGeo = {
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  asn?: string;
  org?: string;
  isp?: string;
};

export type TargetEdgeHints = {
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  headersJson?: string;
};

export type TargetMetadata = {
  hostname?: string;
  ip?: string;
  ipsJson?: string;
  ipFamily?: number;
  geo?: TargetGeo;
  edge?: TargetEdgeHints;
};

const GEOIP_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const GEOIP_TIMEOUT_MS = 1500;
const GEOIP_MAX_CONCURRENT = 20;

type CacheEntry = { value: TargetGeo; expiresAt: number };
const geoCache = new Map<string, CacheEntry>();
const geoInflight = new Map<string, Promise<TargetGeo | undefined>>();

let geoInFlightCount = 0;
const geoWaiters: Array<() => void> = [];

async function acquireGeoSlot(): Promise<void> {
  if (geoInFlightCount < GEOIP_MAX_CONCURRENT) {
    geoInFlightCount += 1;
    return;
  }
  await new Promise<void>((resolve) => geoWaiters.push(resolve));
  geoInFlightCount += 1;
}

function releaseGeoSlot() {
  geoInFlightCount = Math.max(0, geoInFlightCount - 1);
  const next = geoWaiters.shift();
  if (next) next();
}

function isProbablyPublicIp(ip: string): boolean {
  // Very small allowlist: skip private + loopback + link-local.
  if (net.isIP(ip) === 4) {
    if (ip.startsWith("10.")) return false;
    if (ip.startsWith("127.")) return false;
    if (ip.startsWith("169.254.")) return false;
    if (ip.startsWith("192.168.")) return false;
    const m = ip.split(".").map((n) => Number(n));
    if (m[0] === 172 && m[1] >= 16 && m[1] <= 31) return false;
    return true;
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return false;
    if (normalized.startsWith("fe80:")) return false; // link-local
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false; // ULA
    return true;
  }

  return false;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "Accept": "application/json" } });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function lookupGeoIpBestEffort(ip: string): Promise<TargetGeo | undefined> {
  if (!ip || !isProbablyPublicIp(ip)) return undefined;

  const cached = geoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const inflight = geoInflight.get(ip);
  if (inflight) return inflight;

  const p = (async () => {
    await acquireGeoSlot();
    try {
      const res = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, GEOIP_TIMEOUT_MS);
      if (!res.ok) return undefined;
      const json: unknown = await res.json();
      if (!json || typeof json !== "object") return undefined;
      const data = json as IpWhoIsResponse;
      if (data.success === false) return undefined;

      const geo: TargetGeo = {
        country: typeof data.country === "string" ? data.country : undefined,
        region: typeof data.region === "string" ? data.region : undefined,
        city: typeof data.city === "string" ? data.city : undefined,
        latitude: typeof data.latitude === "number" ? data.latitude : undefined,
        longitude: typeof data.longitude === "number" ? data.longitude : undefined,
        asn:
          typeof data.connection?.asn === "string"
            ? data.connection.asn
            : typeof data.connection?.asn === "number"
              ? `AS${data.connection.asn}`
              : undefined,
        org: typeof data.connection?.org === "string" ? data.connection.org : undefined,
        isp: typeof data.connection?.isp === "string" ? data.connection.isp : undefined,
      };

      geoCache.set(ip, { value: geo, expiresAt: Date.now() + GEOIP_TTL_MS });
      return geo;
    } catch (e) {
      // Best-effort only.
      logger.debug("GeoIP lookup failed", { ip, error: (e as Error)?.message ?? String(e) });
      return undefined;
    } finally {
      releaseGeoSlot();
    }
  })();

  geoInflight.set(ip, p);
  try {
    return await p;
  } finally {
    geoInflight.delete(ip);
  }
}

function getHeader(headers: Headers, name: string): string | undefined {
  const v = headers.get(name);
  return v ? String(v) : undefined;
}

function safeJsonStringify(value: unknown, maxLen = 4000): string | undefined {
  try {
    const s = JSON.stringify(value);
    if (!s) return undefined;
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  } catch {
    return undefined;
  }
}

export function extractEdgeHints(headers: Headers): TargetEdgeHints {
  const interesting: Record<string, string> = {};

  const pick = (k: string) => {
    const v = getHeader(headers, k);
    if (v) interesting[k.toLowerCase()] = v;
  };

  [
    "server",
    "via",
    "x-cache",
    "x-cache-hits",
    "x-served-by",
    "x-timer",
    "cf-ray",
    "cf-cache-status",
    "cf-apo-via",
    "x-amz-cf-pop",
    "x-amz-cf-id",
    "fly-request-id",
    "x-vercel-id",
    "x-edge-location",
  ].forEach(pick);

  const cfRay = interesting["cf-ray"];
  const cfPop = typeof cfRay === "string" && cfRay.includes("-") ? cfRay.split("-").pop() : undefined;
  const cloudFrontPop = interesting["x-amz-cf-pop"];

  const cdnProvider =
    cfRay ? "cloudflare" :
    cloudFrontPop ? "cloudfront" :
    interesting["x-served-by"] ? "fastly" :
    interesting["x-vercel-id"] ? "vercel" :
    interesting["fly-request-id"] ? "fly" :
    undefined;

  return {
    cdnProvider,
    edgePop: (cloudFrontPop || cfPop || undefined) as string | undefined,
    edgeRayId: cfRay,
    headersJson: safeJsonStringify(interesting),
  };
}

export async function resolveTarget(hostname: string): Promise<Pick<TargetMetadata, "ip" | "ipsJson" | "ipFamily">> {
  if (!hostname) return {};

  // Host can already be an IP address.
  const ipType = net.isIP(hostname);
  if (ipType === 4 || ipType === 6) {
    return { ip: hostname, ipsJson: safeJsonStringify([hostname]), ipFamily: ipType };
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    const uniq: Array<{ address: string; family: number }> = [];
    const seen = new Set<string>();
    for (const a of addresses) {
      if (!a?.address || typeof a.address !== "string") continue;
      if (seen.has(a.address)) continue;
      seen.add(a.address);
      uniq.push({ address: a.address, family: a.family });
      if (uniq.length >= 8) break; // cap
    }

    const primary =
      uniq.find((x) => x.family === 4)?.address ??
      uniq[0]?.address ??
      undefined;

    const primaryFamily =
      uniq.find((x) => x.address === primary)?.family ??
      uniq[0]?.family ??
      undefined;

    return {
      ip: primary,
      ipsJson: safeJsonStringify(uniq.map((x) => x.address)),
      ipFamily: primaryFamily,
    };
  } catch (e) {
    logger.debug("DNS lookup failed", { hostname, error: (e as Error)?.message ?? String(e) });
    return {};
  }
}

export async function buildTargetMetadataBestEffort(inputUrl: string): Promise<TargetMetadata> {
  try {
    const url = new URL(inputUrl);
    const hostname = url.hostname;
    const resolved = await resolveTarget(hostname);
    const geo = resolved.ip ? await lookupGeoIpBestEffort(resolved.ip) : undefined;
    return {
      hostname,
      ip: resolved.ip,
      ipsJson: resolved.ipsJson,
      ipFamily: resolved.ipFamily,
      geo,
    };
  } catch {
    return {};
  }
}


