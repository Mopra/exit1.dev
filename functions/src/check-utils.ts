import * as logger from "firebase-functions/logger";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import dgram from "dgram";
import crypto from "crypto";
import { execFile } from "child_process";
import { Website } from "./types";
import { CONFIG } from "./config";
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from "./check-defaults";
import { insertCheckHistory, BigQueryCheckHistory } from './bigquery';
import { checkSecurityAndExpiry } from './security-utils.js';
import { buildTargetMetadataBestEffort, extractEdgeHints, TargetMetadata } from "./target-metadata";
import { cachedLookup } from "./dns-cache";
import dns from "dns/promises";
import { DnsRecordType } from "./types";
import { normalizeDnsValues } from "./dns-normalize";

async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  try {
    return await Promise.race([
      promise,
      new Promise<T | undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  } catch {
    return undefined;
  }
}

type CheckTimings = {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  totalMs: number;
};

type HttpRequestResult = {
  statusCode: number;
  statusMessage?: string;
  headers: Headers;
  bodySnippet?: string;
  timings: CheckTimings;
  url: string;
  usedMethod: string;
  usedRange: boolean;
  peerCertificate?: tls.PeerCertificate;
};

/**
 * Convert a raw Node.js TLS peer certificate into the app's SSL data format.
 * Mirrors the processing logic in checkSSLCertificate (security-utils.ts).
 */
const processPeerCertificate = (
  cert: tls.PeerCertificate,
  hostname: string
): {
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  error?: string;
} | null => {
  if (!cert || Object.keys(cert).length === 0) return null;
  const now = Date.now();
  const validFrom = new Date(cert.valid_from).getTime();
  const validTo = new Date(cert.valid_to).getTime();
  const daysUntilExpiry = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));
  const isValid = now >= validFrom && now <= validTo;

  return {
    valid: isValid,
    issuer: cert.issuer?.CN || cert.issuer?.O || "Unknown",
    subject: cert.subject?.CN || cert.subject?.O || hostname,
    validFrom,
    validTo,
    daysUntilExpiry,
    ...(!isValid ? { error: `Certificate expired ${Math.abs(daysUntilExpiry)} days ago` } : {}),
  };
};

type SocketCheckResult = {
  status: 'online' | 'offline' | 'degraded';
  responseTime: number;
  statusCode: number;
  error?: string;
  timings?: CheckTimings;
  detailedStatus?: 'UP' | 'DOWN' | 'DEGRADED';
  sslCertificate?: Website["sslCertificate"];
  securityMetadataLastChecked?: number;
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  targetMetadataLastChecked?: number;
  pingTtl?: number;
  pingPacketLoss?: number; // percentage 0-100
};

const parseSocketTarget = (rawUrl: string, protocol: 'tcp:' | 'udp:') => {
  const urlObj = new URL(rawUrl);
  if (urlObj.protocol !== protocol) {
    throw new Error(`Invalid protocol for ${protocol} check`);
  }
  if (!urlObj.hostname || !urlObj.port) {
    throw new Error('Host and port are required');
  }
  const port = Number(urlObj.port);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('Port must be between 1 and 65535');
  }
  return { hostname: urlObj.hostname, port };
};

const RANGE_HEADER_VALUE = "bytes=0-0";
const MAX_BODY_SNIPPET_BYTES = 8192;

const shouldRetryRange = (statusCode: number): boolean =>
  statusCode === 400 ||
  statusCode === 403 ||
  statusCode === 405 ||
  statusCode === 406 ||
  statusCode === 416 ||
  statusCode === 501;

const shouldFallbackToHead = (statusCode: number): boolean =>
  statusCode === 405 || statusCode === 501;

const getHttpsFallbackUrl = (rawUrl: string): string | null => {
  try {
    const urlObj = new URL(rawUrl);
    if (urlObj.protocol !== "http:") return null;
    urlObj.protocol = "https:";
    return urlObj.toString();
  } catch {
    return null;
  }
};

const shouldFallbackToHttps = (error: unknown): boolean => {
  const code = (error as { code?: string | number })?.code;
  if (typeof code === "string") {
    if (code.startsWith("HPE_")) {
      return true;
    }
    return [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EPIPE",
    ].includes(code);
  }
  if (error instanceof Error && (/timeout/i.test(error.message) || /parse error/i.test(error.message))) {
    return true;
  }
  return false;
};

const headersFromNode = (rawHeaders: http.IncomingHttpHeaders): Headers => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  return headers;
};

const readFirstChunk = (
  res: http.IncomingMessage,
  maxBytes: number,
  fallbackFirstByteAt: number
): Promise<{ snippet?: string; firstByteAt: number }> =>
  new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("error", onError);
    };

    const onData = (chunk: Buffer) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const slice = chunk.length > maxBytes ? chunk.subarray(0, maxBytes) : chunk;
      res.destroy();
      resolve({ snippet: new TextDecoder().decode(slice), firstByteAt: Date.now() });
    };

    const onEnd = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ snippet: undefined, firstByteAt: fallbackFirstByteAt });
    };

    const onError = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ snippet: undefined, firstByteAt: fallbackFirstByteAt });
    };

    res.once("data", onData);
    res.once("end", onEnd);
    res.once("error", onError);
  });

const performHttpRequest = async ({
  url,
  method,
  headers,
  body,
  useRange,
  readBody,
  totalTimeoutMs,
}: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  useRange: boolean;
  readBody: boolean;
  totalTimeoutMs: number;
}): Promise<HttpRequestResult> => {
  const urlObj = new URL(url);
  const transport = urlObj.protocol === "https:" ? https : http;
  const usedMethod = method.toUpperCase();
  const requestHeaders: Record<string, string> = { ...headers };

  if (useRange && usedMethod === "GET") {
    requestHeaders.Range = RANGE_HEADER_VALUE;
  }

  const startTime = Date.now();
  let dnsAt: number | undefined;
  let connectAt: number | undefined;
  let secureAt: number | undefined;
  let responseAt: number | undefined;
  let firstByteAt: number | undefined;
  let totalTimeoutId: NodeJS.Timeout | undefined;
  let currentStage: "DNS" | "CONNECT" | "TLS" | "TTFB" = "DNS";
  let capturedCert: tls.PeerCertificate | undefined;

  const setStage = (stage: "DNS" | "CONNECT" | "TLS" | "TTFB") => {
    currentStage = stage;
  };

  const clearTimers = () => {
    if (totalTimeoutId) clearTimeout(totalTimeoutId);
  };

  return await new Promise<HttpRequestResult>((resolve, reject) => {
    const abortWithStage = (stage: string, timeoutMs: number) => {
      const err = new Error(`${stage} timeout after ${timeoutMs}ms`);
      (err as Error & { stage?: string }).stage = stage;
      req.destroy(err);
    };

    totalTimeoutId = setTimeout(() => abortWithStage(currentStage, totalTimeoutMs), totalTimeoutMs);

    const req = transport.request(
      {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: usedMethod,
        headers: requestHeaders,
        agent: false,
        lookup: cachedLookup as unknown as typeof import("dns").lookup,
      },
      async (res) => {
        responseAt = Date.now();

        let bodySnippet: string | undefined;
        if (readBody) {
          const chunkResult = await readFirstChunk(res, MAX_BODY_SNIPPET_BYTES, responseAt);
          firstByteAt = chunkResult.firstByteAt;
          bodySnippet = chunkResult.snippet;
        } else {
          firstByteAt = responseAt;
          res.destroy();
        }

        clearTimers();

        const ttfbStart = secureAt ?? connectAt ?? dnsAt ?? startTime;
        const timings: CheckTimings = {
          dnsMs: dnsAt ? dnsAt - startTime : 0,
          connectMs: connectAt && (dnsAt || startTime) ? connectAt - (dnsAt || startTime) : undefined,
          tlsMs: secureAt && connectAt ? secureAt - connectAt : undefined,
          ttfbMs: firstByteAt ? firstByteAt - ttfbStart : undefined,
          totalMs: Date.now() - startTime,
        };

        resolve({
          statusCode: res.statusCode || 0,
          statusMessage: res.statusMessage,
          headers: headersFromNode(res.headers),
          bodySnippet,
          timings,
          url,
          usedMethod,
          usedRange: Boolean(useRange && usedMethod === "GET"),
          peerCertificate: capturedCert,
        });
      }
    );

    req.on("socket", (socket) => {
      socket.once("lookup", () => {
        dnsAt = Date.now();
        setStage("CONNECT");
      });

      socket.once("connect", () => {
        connectAt = Date.now();
        if (urlObj.protocol === "https:") {
          setStage("TLS");
        } else {
          setStage("TTFB");
        }
      });

      socket.once("secureConnect", () => {
        secureAt = Date.now();
        setStage("TTFB");
        const cert = (socket as tls.TLSSocket).getPeerCertificate();
        if (cert && Object.keys(cert).length > 0) {
          capturedCert = cert;
        }
      });
    });

    req.on("error", (error) => {
      clearTimers();
      reject(error);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
};

const hasTargetGeo = (geo?: TargetMetadata["geo"]): boolean => {
  if (!geo) return false;
  return Boolean(
    geo.country ||
    geo.region ||
    geo.city ||
    typeof geo.latitude === "number" ||
    typeof geo.longitude === "number" ||
    geo.asn ||
    geo.org ||
    geo.isp
  );
};

const buildCachedTargetMetadata = (website: Website): TargetMetadata => {
  let parsedHostname: string | undefined;
  try {
    parsedHostname = new URL(website.url).hostname;
  } catch {
    parsedHostname = undefined;
  }

  const geo: TargetMetadata["geo"] = {
    country: website.targetCountry,
    region: website.targetRegion,
    city: website.targetCity,
    latitude: website.targetLatitude,
    longitude: website.targetLongitude,
    asn: website.targetAsn,
    org: website.targetOrg,
    isp: website.targetIsp,
  };

  return {
    hostname: website.targetHostname ?? parsedHostname,
    ip: website.targetIp,
    ipsJson: website.targetIpsJson,
    ipFamily: website.targetIpFamily,
    geo: hasTargetGeo(geo) ? geo : undefined,
  };
};

const shouldRefreshTargetMetadata = (website: Website): boolean => {
  // Only do inline refresh for checks that have NEVER had metadata populated.
  // Routine refreshes (7-day TTL, 1-hour missing-geo retry) are handled by
  // the background refreshTargetMetadata scheduled function.
  return typeof website.targetMetadataLastChecked !== "number";
};

const mergeTargetMetadata = (base: TargetMetadata, incoming: TargetMetadata): TargetMetadata => {
  const baseGeo = base.geo;
  const incomingGeo = incoming.geo;

  const mergedGeo: TargetMetadata["geo"] = {
    country: incomingGeo?.country ?? baseGeo?.country,
    region: incomingGeo?.region ?? baseGeo?.region,
    city: incomingGeo?.city ?? baseGeo?.city,
    latitude: incomingGeo?.latitude ?? baseGeo?.latitude,
    longitude: incomingGeo?.longitude ?? baseGeo?.longitude,
    asn: incomingGeo?.asn ?? baseGeo?.asn,
    org: incomingGeo?.org ?? baseGeo?.org,
    isp: incomingGeo?.isp ?? baseGeo?.isp,
  };

  return {
    hostname: incoming.hostname ?? base.hostname,
    ip: incoming.ip ?? base.ip,
    ipsJson: incoming.ipsJson ?? base.ipsJson,
    ipFamily: incoming.ipFamily ?? base.ipFamily,
    geo: hasTargetGeo(mergedGeo) ? mergedGeo : undefined,
  };
};

// Lightweight monotonic counter for BigQuery history record IDs.
// Only needs to be unique within a single scheduler invocation batch.
// Combined with website.id + timestamp, this guarantees uniqueness.
let historyIdCounter = 0;
const nextHistoryId = () => (++historyIdCounter).toString(36);

// NEW: Helper to create record without inserting immediately
export const createCheckHistoryRecord = (website: Website, checkResult: {
  status: 'online' | 'offline' | 'degraded' | 'disabled';
  responseTime?: number;
  statusCode?: number;
  error?: string;
  timings?: {
    dnsMs?: number;
    connectMs?: number;
    tlsMs?: number;
    ttfbMs?: number;
    totalMs: number;
  };
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  pingTtl?: number;
  pingPacketLoss?: number;
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
  redirectLocation?: string;
}, maintenance?: boolean): BigQueryCheckHistory => {
  const now = Date.now();

  return {
    id: `${website.id}_${now}_${nextHistoryId()}`,
    website_id: website.id,
    user_id: website.userId,
    timestamp: now,
    status: checkResult.status,
    response_time: checkResult.responseTime,
    status_code: checkResult.statusCode,
    error: checkResult.error,
    dns_ms: checkResult.timings?.dnsMs,
    connect_ms: checkResult.timings?.connectMs,
    tls_ms: checkResult.timings?.tlsMs,
    ttfb_ms: checkResult.timings?.ttfbMs,
    target_hostname: checkResult.targetHostname,
    target_ip: checkResult.targetIp,
    target_ips_json: checkResult.targetIpsJson,
    target_ip_family: checkResult.targetIpFamily,
    target_country: checkResult.targetCountry,
    target_region: checkResult.targetRegion,
    target_city: checkResult.targetCity,
    target_latitude: checkResult.targetLatitude,
    target_longitude: checkResult.targetLongitude,
    target_asn: checkResult.targetAsn,
    target_org: checkResult.targetOrg,
    target_isp: checkResult.targetIsp,
    ping_ttl: checkResult.pingTtl,
    ping_packet_loss: checkResult.pingPacketLoss,
    cdn_provider: checkResult.cdnProvider,
    edge_pop: checkResult.edgePop,
    edge_ray_id: checkResult.edgeRayId,
    edge_headers_json: checkResult.edgeHeadersJson,
    redirect_location: checkResult.redirectLocation,
    dns_records_json: website.type === 'dns' ? checkResult.targetIpsJson : undefined,
    ...(maintenance ? { maintenance: true } : {}),
  };
};

// Store a check history record in BigQuery (caller controls frequency)
export const storeCheckHistory = async (website: Website, checkResult: {
  status: 'online' | 'offline' | 'degraded';
  responseTime: number;
  statusCode: number;
  error?: string;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DEGRADED' | 'DOWN';
  timings?: {
    dnsMs?: number;
    connectMs?: number;
    tlsMs?: number;
    ttfbMs?: number;
    totalMs: number;
  };
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
}) => {
  try {
    // Use helper to create record (DRY principle)
    const record = createCheckHistoryRecord(website, checkResult);
    // Enqueue to BigQuery buffer - retries happen during flush, not here
    await insertCheckHistory(record);
  } catch (error) {
    // Log but don't throw - history storage failure shouldn't break checks
    // BigQuery buffer will retry on flush, but enqueue errors are rare programming errors
    logger.error(`Failed to enqueue check history for website ${website.id}`, {
      websiteId: website.id,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: number | string })?.code
    });
  }
};

// Function to categorize status codes
export function categorizeStatusCode(statusCode: number): 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' {
  if (statusCode >= 200 && statusCode < 300) return 'UP';
  if (statusCode >= 300 && statusCode < 400) return 'REDIRECT';
  if (statusCode === 401 || statusCode === 403) return 'UP';
  if (statusCode >= 400 && statusCode < 600) return 'DOWN';
  return 'DOWN';
}

/**
 * Execute DNS record queries for a DNS monitoring check.
 * Queries each configured record type, normalizes results, and returns them.
 * Does NOT compare against baseline — that happens in the scheduler/processOneCheck.
 */
export async function checkDnsEndpoint(website: Website): Promise<SocketCheckResult> {
  const domain = website.url;
  const recordTypes = website.dnsMonitoring?.recordTypes ?? ['A'];
  const timeoutMs = CONFIG.DNS_QUERY_TIMEOUT_MS;
  const resolver = new dns.Resolver();
  resolver.setServers(['8.8.8.8', '1.1.1.1']); // Use public DNS for consistency

  const overallStart = Date.now();
  const results: Record<string, { values: string[]; responseTimeMs: number; timedOut?: boolean }> = {};
  let hardFailure = false;
  let softFailure = false;
  let failureError: string | undefined;

  const queryPromises = (recordTypes as DnsRecordType[]).map(async (rt) => {
    const queryStart = Date.now();
    try {
      const values = await awaitWithTimeout(resolveDnsRecord(resolver, domain, rt), timeoutMs);
      if (values === undefined) {
        // Timeout: values are unknown, NOT empty. Caller must skip drift comparison
        // for this record type. Do not conflate with ENODATA.
        return { rt, values: [], responseTimeMs: timeoutMs, failure: false, timedOut: true, error: undefined };
      }
      const normalized = normalizeDnsValues(rt, values);
      return { rt, values: normalized, responseTimeMs: Date.now() - queryStart, failure: false, timedOut: false, error: undefined };
    } catch (err) {
      const elapsed = Date.now() - queryStart;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('ENODATA') || errMsg.includes('ENOENT')) {
        // No data for this record type — normal for subdomains (e.g. no SOA, no MX)
        return { rt, values: [], responseTimeMs: elapsed, failure: false, timedOut: false, error: undefined };
      } else if (errMsg.includes('ENOTFOUND')) {
        // Domain itself does not exist — this IS a real failure
        return { rt, values: [], responseTimeMs: elapsed, failure: 'hard', timedOut: false, error: `Domain not found (NXDOMAIN): ${domain}` };
      } else {
        // SERVFAIL, REFUSED, etc. — DNS issue, not domain issue
        return { rt, values: [], responseTimeMs: elapsed, failure: 'soft', timedOut: false, error: `DNS query failed for ${rt}: ${errMsg}` };
      }
    }
  });

  const settled = await Promise.all(queryPromises);

  for (const res of settled) {
    results[res.rt] = {
      values: res.values,
      responseTimeMs: res.responseTimeMs,
      ...(res.timedOut ? { timedOut: true } : {}),
    };
    if (res.failure === 'hard') {
      hardFailure = true;
      failureError = res.error;
    } else if (res.failure === 'soft') {
      softFailure = true;
      failureError = res.error;
    }
  }

  const totalMs = Date.now() - overallStart;
  const status = hardFailure ? 'offline' : softFailure ? 'degraded' : 'online';

  return {
    status,
    responseTime: totalMs,
    statusCode: status === 'online' ? 200 : 0,
    error: failureError,
    detailedStatus: status === 'online' ? 'UP' : status === 'degraded' ? 'DEGRADED' : 'DOWN',
    timings: { totalMs, dnsMs: totalMs },
    // Stash DNS results in targetIpsJson for the scheduler to read
    targetIpsJson: JSON.stringify(results),
  };
}

/**
 * Resolve a single DNS record type using the Node dns/promises API.
 */
async function resolveDnsRecord(
  resolver: dns.Resolver,
  domain: string,
  recordType: DnsRecordType,
): Promise<unknown[]> {
  switch (recordType) {
    case 'A':
      return resolver.resolve4(domain);
    case 'AAAA':
      return resolver.resolve6(domain);
    case 'CNAME':
      return resolver.resolveCname(domain);
    case 'MX':
      return resolver.resolveMx(domain);
    case 'TXT':
      return resolver.resolveTxt(domain);
    case 'NS':
      return resolver.resolveNs(domain);
    case 'SOA': {
      const soa = await resolver.resolveSoa(domain);
      return [soa]; // Wrap in array for consistent handling
    }
    default:
      return [];
  }
}

// Unified function to check both websites and REST endpoints with advanced validation
export async function checkRestEndpoint(
  website: Website,
  options?: { disableRange?: boolean }
): Promise<{
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  responseBody?: string;
  timings?: CheckTimings;
  usedMethod?: string;
  usedRange?: boolean;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  // Best-effort target metadata (DNS + GeoIP + CDN edge hints)
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  targetMetadataLastChecked?: number;
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
  securityMetadataLastChecked?: number;
  redirectLocation?: string;
  redirectChain?: string[];
}> {
  // Initialize with empty values to ensure safety
  let securityChecks: { 
    sslCertificate?: {
      valid: boolean;
      issuer?: string;
      subject?: string;
      validFrom?: number;
      validTo?: number;
      daysUntilExpiry?: number;
      error?: string;
    };
  } = {};

  const now = Date.now();
  let securityMetadataLastChecked: number | undefined;

  // OPTIMIZATION (Step 5): For HTTPS URLs with stale SSL cache, we capture the certificate
  // from the HTTP request's TLS socket instead of opening a separate TLS connection.
  // This eliminates one full TLS handshake (DNS + TCP + TLS) per SSL refresh cycle.
  // For non-HTTPS URLs, we still run the separate check (it returns immediately for HTTP).
  const isHttpsUrl = website.url.toLowerCase().startsWith('https://');
  const securityTtlMs = CONFIG.SECURITY_METADATA_TTL_MS;
  const sslFresh = Boolean(website.sslCertificate?.lastChecked && (now - website.sslCertificate.lastChecked < securityTtlMs));

  try {
    if (sslFresh) {
      securityChecks = {
        sslCertificate: website.sslCertificate
      };
    } else if (!isHttpsUrl) {
      // Non-HTTPS URL: run separate SSL check (returns immediately for non-HTTPS URLs)
      const SECURITY_CHECK_TIMEOUT_MS = 15000; // 15s total
      try {
        securityChecks = await Promise.race([
          checkSecurityAndExpiry(website.url),
          new Promise<typeof securityChecks>((_, reject) =>
            setTimeout(() => reject(new Error('Security check timeout')), SECURITY_CHECK_TIMEOUT_MS)
          )
        ]);
        securityMetadataLastChecked = now;
      } catch (timeoutError) {
        if (timeoutError instanceof Error && timeoutError.message === 'Security check timeout') {
          logger.warn(`Security check timed out after ${SECURITY_CHECK_TIMEOUT_MS}ms for ${website.url}`, {
            websiteId: website.id,
            url: website.url,
            error: 'Security check timeout',
            code: 'TIMEOUT'
          });
        } else {
          throw timeoutError; // Re-throw other errors to be caught by outer catch
        }
      }
    }
    // For HTTPS URLs with stale SSL: cert will be extracted from the HTTP socket below.
  } catch (error) {
    // Log error but continue with HTTP check
    // We don't want a failure in RDAP/SSL lookup to prevent the basic uptime check
    logger.warn(`Security check failed for ${website.url}`, {
      websiteId: website.id,
      url: website.url,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: number | string })?.code,
    });
  }

  // Kick off best-effort DNS + GeoIP (don’t include this in responseTime; also lets timeouts still report target info).
  const cachedTargetMeta = buildCachedTargetMetadata(website);
  const refreshTargetMeta = shouldRefreshTargetMetadata(website);
  const targetMetaPromise = refreshTargetMeta
    ? buildTargetMetadataBestEffort(website.url)
    : Promise.resolve(cachedTargetMeta);

  const startTime = Date.now();
  const totalTimeoutMs = CONFIG.getAdaptiveTimeout(website);

  try {
    // Determine default values based on website type
    // Default to 'website' type if not specified (for backward compatibility)
    const websiteType = website.type || 'website';
    const defaultMethod = getDefaultHttpMethod();
    const defaultStatusCodes = getDefaultExpectedStatusCodes(websiteType);
    
    // Prepare request options
    const requestHeaders: Record<string, string> = {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
      ...website.requestHeaders
    };

    if (website.cacheControlNoCache === true) {
      requestHeaders['Cache-Control'] = 'no-cache';
      requestHeaders['Pragma'] = 'no-cache';
    }

    const requestedMethod = (website.httpMethod || defaultMethod).toString().toUpperCase();
    const hasBody =
      ['POST', 'PUT', 'PATCH'].includes(requestedMethod) && Boolean(website.requestBody);
    const requestBody = hasBody ? website.requestBody : undefined;
    if (hasBody) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const disableRange = options?.disableRange === true;
    const shouldReadBody = Boolean(website.responseValidation);
    const shouldUseRange =
      !disableRange && requestedMethod === "GET" && !website.responseValidation;
    if (!shouldUseRange) {
      delete requestHeaders.Range;
      delete requestHeaders.range;
    }

    const httpsFallbackUrl = getHttpsFallbackUrl(website.url);
    let requestUrl = website.url;

    // Step 11: No redirect following. A 3xx response means the server is reachable (online).
    // Surfacing the redirect status + Location header is more informative than silently following.
    const runRequest = async (url: string, useRange: boolean, readBody: boolean, method: string, body?: string) =>
      performHttpRequest({
        url,
        method,
        headers: requestHeaders,
        body,
        useRange,
        readBody,
        totalTimeoutMs,
      });

    let httpResult: HttpRequestResult;
    try {
      httpResult = await runRequest(requestUrl, shouldUseRange, shouldReadBody, requestedMethod, requestBody);
    } catch (error) {
      if (httpsFallbackUrl && shouldFallbackToHttps(error)) {
        logger.debug(`HTTP request failed; retrying with HTTPS for ${website.url}`, {
          websiteId: website.id,
          url: website.url,
          httpsUrl: httpsFallbackUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        requestUrl = httpsFallbackUrl;
        httpResult = await runRequest(requestUrl, shouldUseRange, shouldReadBody, requestedMethod, requestBody);
      } else {
        throw error;
      }
    }

    if (shouldUseRange && shouldRetryRange(httpResult.statusCode)) {
      logger.debug(`Range GET rejected (${httpResult.statusCode}); retrying without Range for ${requestUrl}`, {
        websiteId: website.id,
        url: requestUrl,
        statusCode: httpResult.statusCode,
        originalUrl: website.url,
      });
      httpResult = await runRequest(requestUrl, false, shouldReadBody, requestedMethod, requestBody);
    }

    if (requestedMethod === "GET" && shouldFallbackToHead(httpResult.statusCode)) {
      logger.debug(`GET returned ${httpResult.statusCode}; retrying with HEAD for ${requestUrl}`, {
        websiteId: website.id,
        url: requestUrl,
        statusCode: httpResult.statusCode,
        originalUrl: website.url,
      });
      httpResult = await runRequest(requestUrl, false, false, "HEAD");
    }

    // Step 11b: Follow redirect chain when maxRedirects > 0.
    // Uses a wall-clock deadline so the total time for all hops is bounded.
    const maxRedirects = website.maxRedirects ?? 0;
    const redirectChain: string[] = [];
    if (maxRedirects > 0) {
      const redirectDeadline = Date.now() + totalTimeoutMs;
      let hops = 0;
      let currentResult = httpResult;
      while (hops < maxRedirects && currentResult.statusCode >= 300 && currentResult.statusCode < 400) {
        const location = currentResult.headers.get("location");
        if (!location) break; // No Location header — stop following
        // Resolve relative redirects against the current URL
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentResult.url).href;
        } catch {
          break; // Malformed URL — stop following
        }
        // SSRF guard: only follow http/https and block private/internal IPs
        const parsed = new URL(nextUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') break;
        const hn = parsed.hostname.toLowerCase();
        if (hn === 'localhost' || hn === '0.0.0.0' || hn === '[::1]') break;
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hn)) {
          const p = hn.split('.').map(Number);
          if (p[0] === 127 || p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
            || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0) break;
        }
        // Check wall-clock deadline before making another request
        const remaining = redirectDeadline - Date.now();
        if (remaining <= 0) break;
        redirectChain.push(nextUrl);
        hops++;
        currentResult = await runRequest(nextUrl, false, shouldReadBody, "GET");
      }
      if (redirectChain.length > 0) {
        httpResult = currentResult;
        logger.debug(`Followed ${redirectChain.length} redirect(s) for ${website.url}`, {
          websiteId: website.id,
          chain: redirectChain,
          finalStatus: httpResult.statusCode,
        });
      }
    }

    // OPTIMIZATION (Step 5): Extract SSL cert from HTTP socket for HTTPS URLs with stale cache.
    // This avoids opening a separate TLS connection just to read the certificate.
    if (!sslFresh && isHttpsUrl && CONFIG.ENABLE_SECURITY_LOOKUPS && !securityChecks.sslCertificate && httpResult.peerCertificate) {
      const urlHostname = new URL(website.url).hostname;
      const processed = processPeerCertificate(httpResult.peerCertificate, urlHostname);
      if (processed) {
        securityChecks = { sslCertificate: processed };
        securityMetadataLastChecked = now;
      }
    }
    const sslCertificate = securityChecks.sslCertificate;

    const responseTime = httpResult.timings.totalMs;
    const targetMetaRaw = await targetMetaPromise;
    const targetMeta = mergeTargetMetadata(cachedTargetMeta, targetMetaRaw);
    const edge = extractEdgeHints(httpResult.headers);
    
    // Read only the first chunk for validation to avoid full body downloads
    const responseBody = httpResult.bodySnippet;
    
    // Check if status code is in expected range
    const hasCustomExpectedCodes = !!website.expectedStatusCodes?.length;
    const expectedCodes = hasCustomExpectedCodes
      ? website.expectedStatusCodes!
      : defaultStatusCodes;
    const statusCodeValid = expectedCodes.includes(httpResult.statusCode);
    
    // Validate response body if specified (for logging purposes)
    let bodyValidationPassed = true;
    if (responseBody && website.responseValidation) {
      const validation = website.responseValidation;
      
      // Check for required text in response
      if (validation.containsText && validation.containsText.length > 0) {
        bodyValidationPassed = validation.containsText.every(text => 
          responseBody!.toLowerCase().includes(text.toLowerCase())
        );
      }
      
      // JSONPath validation (if implemented)
      if (validation.jsonPath && validation.expectedValue !== undefined) {
        try {
          JSON.parse(responseBody); // Validate JSON format
          // TODO: Implement JSONPath validation
          // For now, we'll skip this validation
        } catch {
          bodyValidationPassed = false;
        }
      }
    }
    
    // Log validation results for debugging
    if (!statusCodeValid || !bodyValidationPassed) {
      logger.debug(`Validation failed for ${website.url}: statusCodeValid=${statusCodeValid}, bodyValidationPassed=${bodyValidationPassed}`);
    }
    
    // Determine status based on status code categorization.
    // Always compute the raw categorization for redirect detection,
    // then optionally override to UP for custom expected status codes.
    const rawDetailedStatus = categorizeStatusCode(httpResult.statusCode);
    const detailedStatus = (hasCustomExpectedCodes && statusCodeValid)
      ? 'UP' as const
      : rawDetailedStatus;
    // Step 11: Capture redirect Location header for UI display
    // Use rawDetailedStatus so we capture Location even when detailedStatus is overridden to UP
    const redirectLocation = rawDetailedStatus === 'REDIRECT'
      ? httpResult.headers.get("location") || undefined
      : undefined;

    // Redirect validation (for redirect check type)
    let redirectValidationPassed = true;
    let redirectValidationError = '';

    if (website.type === 'redirect') {
      const validation = website.redirectValidation;

      if (redirectChain.length > 0) {
        // We followed the redirect chain — validate the final destination URL
        const finalUrl = redirectChain[redirectChain.length - 1];
        if (validation?.expectedTarget) {
          if (validation.matchMode === 'exact') {
            redirectValidationPassed = finalUrl === validation.expectedTarget;
          } else {
            redirectValidationPassed = finalUrl.toLowerCase()
              .includes(validation.expectedTarget.toLowerCase());
          }
          if (!redirectValidationPassed) {
            redirectValidationError = `Redirect chain ended at ${finalUrl}, expected ${validation.expectedTarget}`;
          }
        }
        // If the chain ended but the final response is still a redirect (hit maxRedirects limit),
        // and there's still a Location header, flag it
        if (redirectValidationPassed && rawDetailedStatus === 'REDIRECT') {
          const remainingLocation = httpResult.headers.get("location");
          if (remainingLocation) {
            redirectValidationPassed = false;
            redirectValidationError = `Redirect chain hit limit of ${maxRedirects} hops; next redirect would go to ${remainingLocation}`;
          }
        }
      } else {
        // Original behaviour: no redirect following
        const actualTarget = redirectLocation;

        // Use rawDetailedStatus for redirect validation so custom expectedStatusCodes
        // don't interfere with redirect type checks
        if (rawDetailedStatus !== 'REDIRECT') {
          redirectValidationPassed = false;
          redirectValidationError = `Expected redirect but got HTTP ${httpResult.statusCode}`;
        } else if (!actualTarget) {
          redirectValidationPassed = false;
          redirectValidationError = 'Redirect response missing Location header';
        } else if (validation?.expectedTarget) {
          if (validation.matchMode === 'exact') {
            redirectValidationPassed = actualTarget === validation.expectedTarget;
          } else {
            // Default: contains (case-insensitive)
            redirectValidationPassed = actualTarget.toLowerCase()
              .includes(validation.expectedTarget.toLowerCase());
          }
          if (!redirectValidationPassed) {
            redirectValidationError = `Redirect target mismatch: got ${actualTarget}, expected ${validation.expectedTarget}`;
          }
        }
      }
    }

    // For backward compatibility, map to online/offline
    // If user explicitly configured expectedStatusCodes and the response matches, treat as online
    // regardless of categorizeStatusCode (e.g. user expects 404 → should be UP, not DOWN).
    // Otherwise fall back to categorization: UP/REDIRECT are online, others are offline.
    const statusBasedOnline = hasCustomExpectedCodes
      ? statusCodeValid
      : (detailedStatus === 'UP' || detailedStatus === 'REDIRECT');
    const isOnline = statusBasedOnline && statusCodeValid && bodyValidationPassed && redirectValidationPassed;

    // Provide a useful, stable error string for non-UP HTTP responses or validation failures.
    // This helps users understand issues like 502/504 even when we apply transient suppression higher up.
    let error: string | undefined;
    if (!redirectValidationPassed) {
      error = redirectValidationError;
    } else if (detailedStatus === 'DOWN' && !statusCodeValid) {
      error = `HTTP ${httpResult.statusCode}${httpResult.statusMessage ? `: ${httpResult.statusMessage}` : ''}`;
    } else if (!statusCodeValid) {
      error = `Unexpected status code: ${httpResult.statusCode}`;
    } else if (!bodyValidationPassed) {
      error = 'Response validation failed: expected text not found in response';
    }

    return {
      status: isOnline ? 'online' : 'offline',
      responseTime,
      statusCode: httpResult.statusCode,
      error,
      responseBody,
      timings: httpResult.timings,
      usedMethod: httpResult.usedMethod,
      usedRange: httpResult.usedRange,
      sslCertificate,
      detailedStatus,
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
      securityMetadataLastChecked,
      cdnProvider: edge.cdnProvider,
      edgePop: edge.edgePop,
      edgeRayId: edge.edgeRayId,
      edgeHeadersJson: edge.headersJson,
      redirectLocation,
      ...(redirectChain.length > 0 ? { redirectChain } : {}),
    };

  } catch (error) {
    const responseTime = Date.now() - startTime;

    const targetMetaRaw = await awaitWithTimeout(targetMetaPromise, 250);
    const targetMeta = targetMetaRaw
      ? mergeTargetMetadata(cachedTargetMeta, targetMetaRaw)
      : cachedTargetMeta;
    
    // Distinguish between timeout errors and connection errors
    const timeoutStage = error instanceof Error ? (error as Error & { stage?: string }).stage : undefined;
    const isTimeout = Boolean(timeoutStage) || (error instanceof Error && error.name === 'AbortError');
    const errorMessage = isTimeout
      ? (error instanceof Error ? error.message : `Request timed out after ${totalTimeoutMs}ms`)
      : (error instanceof Error ? error.message : 'Unknown error');
    
    // For timeouts, use statusCode -1 to distinguish from connection errors (statusCode 0)
    // Timeouts are less definitive - the site might be slow but still responding
    // Connection errors (statusCode 0) indicate the site is likely down
    const timeoutStatusCode = isTimeout ? -1 : 0;
    
    // Timeouts are treated as DOWN per uptime rules
    const timeoutDetailedStatus = 'DOWN';
    
    return {
      status: 'offline',
      responseTime,
      statusCode: timeoutStatusCode,
      error: errorMessage,
      // Include timing data even for errors - totalMs is the only meaningful value here
      timings: { totalMs: responseTime },
      sslCertificate: securityChecks.sslCertificate,
      detailedStatus: timeoutDetailedStatus,
      targetHostname: targetMeta?.hostname,
      targetIp: targetMeta?.ip,
      targetIpsJson: targetMeta?.ipsJson,
      targetIpFamily: targetMeta?.ipFamily,
      targetCountry: targetMeta?.geo?.country,
      targetRegion: targetMeta?.geo?.region,
      targetCity: targetMeta?.geo?.city,
      targetLatitude: targetMeta?.geo?.latitude,
      targetLongitude: targetMeta?.geo?.longitude,
      targetAsn: targetMeta?.geo?.asn,
      targetOrg: targetMeta?.geo?.org,
      targetIsp: targetMeta?.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
      securityMetadataLastChecked,
    };
  }
}

export async function checkTcpEndpoint(website: Website): Promise<SocketCheckResult> {
  const now = Date.now();
  const cachedTargetMeta = buildCachedTargetMetadata(website);
  const refreshTargetMeta = shouldRefreshTargetMetadata(website);
  const targetMetaPromise = refreshTargetMeta
    ? buildTargetMetadataBestEffort(website.url)
    : Promise.resolve(cachedTargetMeta);
  const startTime = Date.now();

  try {
    const { hostname, port } = parseSocketTarget(website.url, "tcp:");
    const connectStart = Date.now();
    const timeoutMs = CONFIG.getAdaptiveTimeout(website);

    const socketResult = await new Promise<SocketCheckResult>((resolve) => {
      let settled = false;
      const socket = net.createConnection({ host: hostname, port });

      const finalize = (result: SocketCheckResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finalize({
          status: 'offline',
          responseTime: Date.now() - startTime,
          statusCode: -1,
          error: `TCP connect timed out after ${timeoutMs}ms`,
          detailedStatus: 'DOWN',
          timings: {
            connectMs: Date.now() - connectStart,
            totalMs: Date.now() - startTime,
          },
        });
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.end();
        finalize({
          status: 'online',
          responseTime: Date.now() - startTime,
          statusCode: 0,
          detailedStatus: 'UP',
          timings: {
            connectMs: Date.now() - connectStart,
            totalMs: Date.now() - startTime,
          },
        });
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        finalize({
          status: 'offline',
          responseTime: Date.now() - startTime,
          statusCode: 0,
          error: error instanceof Error ? error.message : String(error),
          detailedStatus: 'DOWN',
          timings: {
            connectMs: Date.now() - connectStart,
            totalMs: Date.now() - startTime,
          },
        });
      });
    });

    const targetMetaRaw = await targetMetaPromise;
    const targetMeta = mergeTargetMetadata(cachedTargetMeta, targetMetaRaw);
    return {
      ...socketResult,
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const targetMetaRaw = await awaitWithTimeout(targetMetaPromise, 250);
    const targetMeta = targetMetaRaw
      ? mergeTargetMetadata(cachedTargetMeta, targetMetaRaw)
      : cachedTargetMeta;
    return {
      status: 'offline',
      responseTime,
      statusCode: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
      detailedStatus: 'DOWN',
      timings: { totalMs: responseTime },
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  }
}

/**
 * Lightweight TCP-only check for the alternating light-check optimization (Step 9).
 * Connects to the target's port without TLS or HTTP — just verifies the port is open.
 * Returns only online/offline + connect time. No metadata, no SSL, no geo.
 */
export async function checkTcpQuick(
  url: string
): Promise<{ status: 'online' | 'offline'; responseTime: number }> {
  const parsed = new URL(url);
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:' ? 443 : 80;
  const hostname = parsed.hostname;
  const timeout = CONFIG.TCP_LIGHT_CHECK_TIMEOUT_MS;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: hostname, port });

    const finalize = (status: 'online' | 'offline') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, responseTime: Date.now() - startTime });
    };

    const timer = setTimeout(() => finalize('offline'), timeout);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      finalize('online');
    });

    socket.once('error', () => {
      clearTimeout(timer);
      finalize('offline');
    });
  });
}

export async function checkUdpEndpoint(website: Website): Promise<SocketCheckResult> {
  const now = Date.now();
  const cachedTargetMeta = buildCachedTargetMetadata(website);
  const refreshTargetMeta = shouldRefreshTargetMetadata(website);
  const targetMetaPromise = refreshTargetMeta
    ? buildTargetMetadataBestEffort(website.url)
    : Promise.resolve(cachedTargetMeta);
  const startTime = Date.now();

  try {
    const { hostname, port } = parseSocketTarget(website.url, "udp:");
    const timeoutMs = CONFIG.getAdaptiveTimeout(website);
    const socketType = hostname.includes(":") ? "udp6" : "udp4";

    const socketResult = await new Promise<SocketCheckResult>((resolve) => {
      let settled = false;
      const socket = dgram.createSocket(socketType);

      const finalize = (result: SocketCheckResult) => {
        if (settled) return;
        settled = true;
        socket.close();
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finalize({
          status: 'online',
          responseTime: Date.now() - startTime,
          statusCode: 0,
          detailedStatus: 'UP',
          timings: {
            totalMs: Date.now() - startTime,
          },
        });
      }, timeoutMs);

      socket.once("message", () => {
        clearTimeout(timeout);
        finalize({
          status: 'online',
          responseTime: Date.now() - startTime,
          statusCode: 0,
          detailedStatus: 'UP',
          timings: {
            totalMs: Date.now() - startTime,
          },
        });
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        finalize({
          status: 'offline',
          responseTime: Date.now() - startTime,
          statusCode: 0,
          error: error instanceof Error ? error.message : String(error),
          detailedStatus: 'DOWN',
          timings: {
            totalMs: Date.now() - startTime,
          },
        });
      });

      socket.connect(port, hostname, () => {
        socket.send(Buffer.alloc(0), (error) => {
          if (error) {
            clearTimeout(timeout);
            finalize({
              status: 'offline',
              responseTime: Date.now() - startTime,
              statusCode: 0,
              error: error instanceof Error ? error.message : String(error),
              detailedStatus: 'DOWN',
              timings: {
                totalMs: Date.now() - startTime,
              },
            });
          }
        });
      });
    });

    const targetMetaRaw = await targetMetaPromise;
    const targetMeta = mergeTargetMetadata(cachedTargetMeta, targetMetaRaw);
    return {
      ...socketResult,
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const targetMetaRaw = await awaitWithTimeout(targetMetaPromise, 250);
    const targetMeta = targetMetaRaw
      ? mergeTargetMetadata(cachedTargetMeta, targetMetaRaw)
      : cachedTargetMeta;
    return {
      status: 'offline',
      responseTime,
      statusCode: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
      detailedStatus: 'DOWN',
      timings: { totalMs: responseTime },
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  }
}

// ── ICMP Ping Check ──

/** Strict hostname/IP validation to prevent command injection. */
const VALID_PING_HOST = /^[a-zA-Z0-9]([a-zA-Z0-9\-.]*[a-zA-Z0-9])?$/;

/**
 * Extract hostname from a ping:// URL.
 * Accepts: ping://example.com, ping://1.2.3.4
 */
const parsePingTarget = (rawUrl: string): string => {
  const urlObj = new URL(rawUrl);
  if (urlObj.protocol !== 'ping:') {
    throw new Error('Invalid protocol for ping check');
  }
  // URL parser puts hostname after ping:// into the pathname when protocol is non-standard.
  // Try hostname first, fall back to pathname.
  const host = urlObj.hostname || urlObj.pathname.replace(/^\/+/, '');
  if (!host) {
    throw new Error('Missing hostname for ping check');
  }
  if (!VALID_PING_HOST.test(host)) {
    throw new Error('Invalid hostname for ping check');
  }
  return host;
};

export async function checkPingEndpoint(website: Website): Promise<SocketCheckResult> {
  const now = Date.now();
  const cachedTargetMeta = buildCachedTargetMetadata(website);
  const refreshTargetMeta = shouldRefreshTargetMetadata(website);
  const targetMetaPromise = refreshTargetMeta
    ? buildTargetMetadataBestEffort(website.url)
    : Promise.resolve(cachedTargetMeta);
  const startTime = Date.now();

  try {
    const host = parsePingTarget(website.url);
    const timeoutS = Math.ceil(CONFIG.getAdaptiveTimeout(website) / 1000);
    // Number of ICMP packets: user setting (1-5), default 3 for resilience against transient loss
    const packetCount = Math.min(5, Math.max(1, website.pingPackets ?? 3));

    // Use execFile (no shell) for safety.
    // With multiple packets, ping exits with code 0 if ANY packet is received.
    // Total worst-case time = packetCount * timeoutS (each lost packet waits timeoutS).
    const processTimeoutS = packetCount * timeoutS + 2;
    const pingResult = await new Promise<SocketCheckResult>((resolve) => {
      const proc = execFile(
        'ping',
        ['-c', String(packetCount), '-W', String(timeoutS), host],
        { timeout: processTimeoutS * 1000 },
        (error, stdout) => {
          const elapsed = Date.now() - startTime;

          // Parse packet loss from summary: "3 packets transmitted, 2 received, 33.3% packet loss"
          const lossMatch = stdout?.match(/([\d.]+)%\s*packet loss/);
          const packetLoss = lossMatch ? parseFloat(lossMatch[1]) : undefined;

          if (error) {
            // With multi-packet, ping exits non-zero only if ALL packets were lost (100% loss)
            resolve({
              status: 'offline',
              responseTime: elapsed,
              statusCode: 0,
              error: `Ping failed: ${error.message}`,
              detailedStatus: 'DOWN',
              timings: { totalMs: elapsed },
              pingPacketLoss: packetLoss ?? 100,
            });
            return;
          }

          // Parse avg RTT from summary: "rtt min/avg/max/mdev = 0.1/0.5/0.9/0.1 ms"
          const rttSummaryMatch = stdout.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
          const avgRtt = rttSummaryMatch ? parseFloat(rttSummaryMatch[2]) : undefined;

          // Fallback: parse single time= from last reply if summary parsing fails
          const rttMatch = stdout.match(/time[=<]([\d.]+)\s*ms/);
          const rtt = avgRtt ?? (rttMatch ? parseFloat(rttMatch[1]) : elapsed);

          // Parse TTL from ping output: "ttl=54" or "ttl=128"
          const ttlMatch = stdout.match(/ttl=(\d+)/i);
          const ttl = ttlMatch ? parseInt(ttlMatch[1], 10) : undefined;

          resolve({
            status: 'online',
            responseTime: Math.round(rtt * 100) / 100,
            statusCode: 0,
            detailedStatus: 'UP',
            timings: { totalMs: elapsed },
            pingTtl: ttl,
            pingPacketLoss: packetLoss ?? 0,
          });
        }
      );

      // Safety: kill process if it somehow hangs beyond our timeout
      setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
      }, (processTimeoutS + 1) * 1000);
    });

    const targetMetaRaw = await targetMetaPromise;
    const targetMeta = mergeTargetMetadata(cachedTargetMeta, targetMetaRaw);
    return {
      ...pingResult,
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const targetMetaRaw = await awaitWithTimeout(targetMetaPromise, 250);
    const targetMeta = targetMetaRaw
      ? mergeTargetMetadata(cachedTargetMeta, targetMetaRaw)
      : cachedTargetMeta;
    return {
      status: 'offline',
      responseTime,
      statusCode: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
      detailedStatus: 'DOWN',
      timings: { totalMs: responseTime },
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  }
}

// ── WebSocket Check ──

const parseWebSocketTarget = (rawUrl: string): { hostname: string; port: number; path: string; secure: boolean } => {
  const urlObj = new URL(rawUrl);
  const secure = urlObj.protocol === 'wss:';
  if (urlObj.protocol !== 'ws:' && urlObj.protocol !== 'wss:') {
    throw new Error('Invalid protocol for WebSocket check');
  }
  const hostname = urlObj.hostname;
  if (!hostname) {
    throw new Error('Missing hostname for WebSocket check');
  }
  const defaultPort = secure ? 443 : 80;
  const port = urlObj.port ? Number(urlObj.port) : defaultPort;
  const path = (urlObj.pathname || '/') + (urlObj.search || '');
  return { hostname, port, path, secure };
};

export async function checkWebSocketEndpoint(website: Website): Promise<SocketCheckResult> {
  const now = Date.now();
  const cachedTargetMeta = buildCachedTargetMetadata(website);
  const refreshTargetMeta = shouldRefreshTargetMetadata(website);
  const targetMetaPromise = refreshTargetMeta
    ? buildTargetMetadataBestEffort(website.url)
    : Promise.resolve(cachedTargetMeta);
  const startTime = Date.now();

  try {
    const { hostname, port, path, secure } = parseWebSocketTarget(website.url);
    const timeoutMs = CONFIG.getAdaptiveTimeout(website);

    // Generate WebSocket key per RFC 6455
    const wsKey = crypto.randomBytes(16).toString('base64');

    const wsResult = await new Promise<SocketCheckResult>((resolve) => {
      let settled = false;
      const finalize = (result: SocketCheckResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timeout = setTimeout(() => {
        finalize({
          status: 'offline',
          responseTime: Date.now() - startTime,
          statusCode: -1,
          error: `WebSocket handshake timed out after ${timeoutMs}ms`,
          detailedStatus: 'DOWN',
          timings: { totalMs: Date.now() - startTime },
        });
        req.destroy();
      }, timeoutMs);

      const options = {
        hostname,
        port,
        path,
        method: 'GET' as const,
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': wsKey,
          'Sec-WebSocket-Version': '13',
          'Host': port === 80 || port === 443 ? hostname : `${hostname}:${port}`,
        },
        timeout: timeoutMs,
      };

      const handler = (res: http.IncomingMessage) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;

        if (res.statusCode === 101) {
          finalize({
            status: 'online',
            responseTime: elapsed,
            statusCode: 101,
            detailedStatus: 'UP',
            timings: { totalMs: elapsed },
          });
        } else {
          finalize({
            status: 'offline',
            responseTime: elapsed,
            statusCode: res.statusCode || 0,
            error: `WebSocket upgrade failed: HTTP ${res.statusCode}`,
            detailedStatus: 'DOWN',
            timings: { totalMs: elapsed },
          });
        }
        res.socket?.destroy();
      };

      const req = secure
        ? https.request({ ...options, rejectUnauthorized: true }, handler)
        : http.request(options, handler);

      req.on('upgrade', (_res: http.IncomingMessage, socket: net.Socket) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;
        finalize({
          status: 'online',
          responseTime: elapsed,
          statusCode: 101,
          detailedStatus: 'UP',
          timings: { totalMs: elapsed },
        });
        socket.destroy();
      });

      req.on('error', (error: Error) => {
        clearTimeout(timeout);
        finalize({
          status: 'offline',
          responseTime: Date.now() - startTime,
          statusCode: 0,
          error: error.message,
          detailedStatus: 'DOWN',
          timings: { totalMs: Date.now() - startTime },
        });
      });

      req.on('timeout', () => {
        req.destroy();
      });

      req.end();
    });

    const targetMetaRaw = await targetMetaPromise;
    const targetMeta = mergeTargetMetadata(cachedTargetMeta, targetMetaRaw);
    return {
      ...wsResult,
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const targetMetaRaw = await awaitWithTimeout(targetMetaPromise, 250);
    const targetMeta = targetMetaRaw
      ? mergeTargetMetadata(cachedTargetMeta, targetMetaRaw)
      : cachedTargetMeta;
    return {
      status: 'offline',
      responseTime,
      statusCode: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
      detailedStatus: 'DOWN',
      timings: { totalMs: responseTime },
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      targetIpsJson: targetMeta.ipsJson,
      targetIpFamily: targetMeta.ipFamily,
      targetCountry: targetMeta.geo?.country,
      targetRegion: targetMeta.geo?.region,
      targetCity: targetMeta.geo?.city,
      targetLatitude: targetMeta.geo?.latitude,
      targetLongitude: targetMeta.geo?.longitude,
      targetAsn: targetMeta.geo?.asn,
      targetOrg: targetMeta.geo?.org,
      targetIsp: targetMeta.geo?.isp,
      targetMetadataLastChecked: refreshTargetMeta ? now : undefined,
    };
  }
}
