import * as logger from "firebase-functions/logger";
import http from "http";
import https from "https";
import net from "net";
import dgram from "dgram";
import { randomUUID } from 'crypto';
import { Website } from "./types";
import { CONFIG } from "./config";
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from "./check-defaults";
import { insertCheckHistory, BigQueryCheckHistory } from './bigquery';
import { checkSecurityAndExpiry } from './security-utils.js';
import { buildTargetMetadataBestEffort, extractEdgeHints, TargetMetadata } from "./target-metadata";

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
};

type SocketCheckResult = {
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  timings?: CheckTimings;
  detailedStatus?: 'UP' | 'DOWN';
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
const MAX_REDIRECTS = 5;
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

const performHttpRequestWithRedirects = async ({
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
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  let redirects = 0;

  while (redirects <= MAX_REDIRECTS) {
    const result = await performHttpRequest({
      url: currentUrl,
      method: currentMethod,
      headers,
      body: currentBody,
      useRange,
      readBody,
      totalTimeoutMs,
    });

    const status = result.statusCode;
    const location = result.headers.get("location");
    const isRedirect =
      (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && location;

    if (!isRedirect || !location) {
      return result;
    }

    if (currentMethod !== "GET" && currentMethod !== "HEAD") {
      return result;
    }

    currentUrl = new URL(location, currentUrl).toString();
    if (status === 303) {
      currentMethod = "GET";
      currentBody = undefined;
    }
    redirects += 1;
  }

  return await performHttpRequest({
    url: currentUrl,
    method: currentMethod,
    headers,
    body: currentBody,
    useRange,
    readBody,
    totalTimeoutMs,
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

const shouldRefreshTargetMetadata = (website: Website, now: number): boolean => {
  const lastChecked = website.targetMetadataLastChecked;
  if (typeof lastChecked !== "number") {
    return true;
  }
  const hasGeo =
    typeof website.targetLatitude === "number" &&
    typeof website.targetLongitude === "number";
  const ttl = hasGeo ? CONFIG.TARGET_METADATA_TTL_MS : CONFIG.TARGET_METADATA_RETRY_MS;
  return now - lastChecked >= ttl;
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

// NEW: Helper to create record without inserting immediately
export const createCheckHistoryRecord = (website: Website, checkResult: {
  status: 'online' | 'offline' | 'disabled';
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
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
}): BigQueryCheckHistory => {
  const now = Date.now();
  
  // DEBUG: Log all fields of checkResult to understand what's being passed
  logger.info('createCheckHistoryRecord: input data', {
    websiteId: website.id,
    checkResultKeys: Object.keys(checkResult),
    status: checkResult.status,
    statusCode: checkResult.statusCode,
    responseTime: checkResult.responseTime,
    hasTimings: 'timings' in checkResult,
    timingsValue: checkResult.timings,
    timingsType: typeof checkResult.timings,
    hasTargetHostname: 'targetHostname' in checkResult,
    targetHostname: checkResult.targetHostname,
    targetIp: checkResult.targetIp,
    targetCountry: checkResult.targetCountry,
  });
  
  return {
    id: `${website.id}_${now}_${randomUUID()}`,
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
    cdn_provider: checkResult.cdnProvider,
    edge_pop: checkResult.edgePop,
    edge_ray_id: checkResult.edgeRayId,
    edge_headers_json: checkResult.edgeHeadersJson,
  };
};

// Store a check history record in BigQuery (caller controls frequency)
export const storeCheckHistory = async (website: Website, checkResult: {
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
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
  // DEBUG: Log what data we're receiving
  logger.info('storeCheckHistory called', {
    websiteId: website.id,
    status: checkResult.status,
    statusCode: checkResult.statusCode,
    responseTime: checkResult.responseTime,
    hasTimings: !!checkResult.timings,
    timings: checkResult.timings ? {
      dnsMs: checkResult.timings.dnsMs,
      connectMs: checkResult.timings.connectMs,
      tlsMs: checkResult.timings.tlsMs,
      ttfbMs: checkResult.timings.ttfbMs,
      totalMs: checkResult.timings.totalMs,
    } : null,
    hasTargetHostname: !!checkResult.targetHostname,
    targetHostname: checkResult.targetHostname,
    targetIp: checkResult.targetIp,
    targetCountry: checkResult.targetCountry,
  });
  
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

  // SAFE EXECUTION: Run security checks BEFORE starting the HTTP timer.
  // This prevents slow SSL checks from eating into the website response timeout.
  // We wrap this in a try/catch to ensure that a failure in security checks 
  // (which are secondary) doesn't prevent the primary uptime check from running.
  try {
    // OPTIMIZATION: Check for cached security metadata
    // If we have fresh data (< 30d old), use it instead of performing a live check.
    // This drastically reduces execution time and prevents rate limiting from registrars.
    const securityTtlMs = CONFIG.SECURITY_METADATA_TTL_MS;
    const sslFresh = website.sslCertificate?.lastChecked && (now - website.sslCertificate.lastChecked < securityTtlMs);
    if (sslFresh) {
      securityChecks = {
        sslCertificate: website.sslCertificate
      };
    } else {
      // Cache miss or stale: perform live check
      // This will happen on new monitors or if the background job failed/hasn't run yet
      // Add timeout wrapper for defense-in-depth (internal timeouts exist but this adds extra safety)
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
  } catch (error) {
    // Log error but continue with HTTP check
    // We don't want a failure in RDAP/SSL lookup to prevent the basic uptime check
    logger.warn(`Security check failed for ${website.url}`, {
      websiteId: website.id,
      url: website.url,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: number | string })?.code,
      stack: error instanceof Error ? error.stack : undefined
    });
  }

  // Kick off best-effort DNS + GeoIP (don’t include this in responseTime; also lets timeouts still report target info).
  const cachedTargetMeta = buildCachedTargetMetadata(website);
  const refreshTargetMeta = shouldRefreshTargetMetadata(website, now);
  const targetMetaPromise = refreshTargetMeta
    ? buildTargetMetadataBestEffort(website.url)
    : Promise.resolve(cachedTargetMeta);

  const startTime = Date.now();
  const totalTimeoutMs = CONFIG.getAdaptiveTimeout(website);

  try {
    const sslCertificate = securityChecks.sslCertificate;
    
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

    const runRequest = async (url: string, useRange: boolean, readBody: boolean, method: string, body?: string) =>
      performHttpRequestWithRedirects({
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
        logger.info(`HTTP request failed; retrying with HTTPS for ${website.url}`, {
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
      logger.info(`Range GET rejected (${httpResult.statusCode}); retrying without Range for ${requestUrl}`, {
        websiteId: website.id,
        url: requestUrl,
        statusCode: httpResult.statusCode,
        originalUrl: website.url,
      });
      httpResult = await runRequest(requestUrl, false, shouldReadBody, requestedMethod, requestBody);
    }

    if (requestedMethod === "GET" && shouldFallbackToHead(httpResult.statusCode)) {
      logger.info(`GET returned ${httpResult.statusCode}; retrying with HEAD for ${requestUrl}`, {
        websiteId: website.id,
        url: requestUrl,
        statusCode: httpResult.statusCode,
        originalUrl: website.url,
      });
      httpResult = await runRequest(requestUrl, false, false, "HEAD");
    }

    const responseTime = httpResult.timings.totalMs;
    const targetMetaRaw = await targetMetaPromise;
    const targetMeta = mergeTargetMetadata(cachedTargetMeta, targetMetaRaw);
    const edge = extractEdgeHints(httpResult.headers);
    
    // Read only the first chunk for validation to avoid full body downloads
    const responseBody = httpResult.bodySnippet;
    
    // Check if status code is in expected range (for logging purposes)
    const expectedCodes = website.expectedStatusCodes?.length
      ? website.expectedStatusCodes
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
      logger.info(`Validation failed for ${website.url}: statusCodeValid=${statusCodeValid}, bodyValidationPassed=${bodyValidationPassed}`);
    }
    
    // Determine status based on status code categorization
    const detailedStatus = categorizeStatusCode(httpResult.statusCode);
    
    // For backward compatibility, map to online/offline
    // UP and REDIRECT are considered online, REACHABLE_WITH_ERROR and DOWN are considered offline
    const isOnline = detailedStatus === 'UP' || detailedStatus === 'REDIRECT';

    // Provide a useful, stable error string for non-UP HTTP responses.
    // This helps users understand issues like 502/504 even when we apply transient suppression higher up.
    const error =
      detailedStatus === 'DOWN'
        ? `HTTP ${httpResult.statusCode}${httpResult.statusMessage ? `: ${httpResult.statusMessage}` : ''}`
        : undefined;

    logger.info("Check timing details", {
      websiteId: website.id,
      url: website.url,
      method: httpResult.usedMethod,
      range: httpResult.usedRange,
      dnsMs: httpResult.timings.dnsMs,
      connectMs: httpResult.timings.connectMs,
      tlsMs: httpResult.timings.tlsMs,
      ttfbMs: httpResult.timings.ttfbMs,
      totalMs: httpResult.timings.totalMs,
    });
    
    // DEBUG: Log target metadata before return
    logger.info("Check target metadata", {
      websiteId: website.id,
      url: website.url,
      refreshedMeta: refreshTargetMeta,
      targetHostname: targetMeta.hostname,
      targetIp: targetMeta.ip,
      hasGeo: !!targetMeta.geo,
      targetCountry: targetMeta.geo?.country,
      targetCity: targetMeta.geo?.city,
      cdnProvider: edge.cdnProvider,
      edgePop: edge.edgePop,
    });
    
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
  const refreshTargetMeta = shouldRefreshTargetMetadata(website, now);
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

export async function checkUdpEndpoint(website: Website): Promise<SocketCheckResult> {
  const now = Date.now();
  const cachedTargetMeta = buildCachedTargetMetadata(website);
  const refreshTargetMeta = shouldRefreshTargetMetadata(website, now);
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
