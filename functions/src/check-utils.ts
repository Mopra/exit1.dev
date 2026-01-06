import * as logger from "firebase-functions/logger";
import { randomUUID } from 'crypto';
import { Website } from "./types";
import { CONFIG } from "./config";
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from "./check-defaults";
import { insertCheckHistory, BigQueryCheckHistory } from './bigquery';
import { checkSecurityAndExpiry } from './security-utils';
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
  return now - lastChecked >= CONFIG.TARGET_METADATA_TTL_MS;
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
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
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
  return {
    id: `${website.id}_${now}_${randomUUID()}`,
    website_id: website.id,
    user_id: website.userId,
    timestamp: now,
    status: checkResult.status,
    response_time: checkResult.responseTime,
    status_code: checkResult.statusCode,
    error: checkResult.error,
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
  if (statusCode >= 400 && statusCode < 600) return 'REACHABLE_WITH_ERROR';
  return 'DOWN';
}

// Unified function to check both websites and REST endpoints with advanced validation
export async function checkRestEndpoint(website: Website): Promise<{
  status: 'online' | 'offline';
  responseTime: number;
  statusCode: number;
  error?: string;
  responseBody?: string;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
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
    domainExpiry?: {
      valid: boolean;
      registrar?: string;
      domainName?: string;
      expiryDate?: number;
      daysUntilExpiry?: number;
      error?: string;
    };
  } = {};

  const now = Date.now();
  let securityMetadataLastChecked: number | undefined;

  // SAFE EXECUTION: Run security checks BEFORE starting the HTTP timer.
  // This prevents slow RDAP/SSL checks from eating into the website response timeout.
  // We wrap this in a try/catch to ensure that a failure in security checks 
  // (which are secondary) doesn't prevent the primary uptime check from running.
  try {
    // OPTIMIZATION: Check for cached security metadata
    // If we have fresh data (< 30d old), use it instead of performing a live check.
    // This drastically reduces execution time and prevents rate limiting from registrars.
    const securityTtlMs = CONFIG.SECURITY_METADATA_TTL_MS;
    const sslFresh = website.sslCertificate?.lastChecked && (now - website.sslCertificate.lastChecked < securityTtlMs);
    // Domain expiry data is less critical to be minute-perfect, so we accept it if present
    // (often populated by the weekly background job)
    const domainFresh = website.domainExpiry?.lastChecked && (now - website.domainExpiry.lastChecked < securityTtlMs);

    if (sslFresh && domainFresh) {
      securityChecks = {
        sslCertificate: website.sslCertificate,
        domainExpiry: website.domainExpiry
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
  const controller = new AbortController();
  const timeoutMs = CONFIG.getAdaptiveTimeout(website);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const sslCertificate = securityChecks.sslCertificate;
    const domainExpiry = securityChecks.domainExpiry;
    
    // Determine default values based on website type
    // Default to 'website' type if not specified (for backward compatibility)
    const websiteType = website.type || 'website';
    const defaultMethod = getDefaultHttpMethod(websiteType);
    const defaultStatusCodes = getDefaultExpectedStatusCodes(websiteType);
    
    // Prepare request options
    const requestOptions: RequestInit = {
      method: website.httpMethod || defaultMethod,
      signal: controller.signal,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': '*/*',
        'Cache-Control': 'no-cache',
        ...website.requestHeaders
      }
    };
    
    // Add request body for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(website.httpMethod || 'GET') && website.requestBody) {
      requestOptions.body = website.requestBody;
      requestOptions.headers = {
        ...requestOptions.headers,
        'Content-Type': 'application/json'
      };
    }
    
    const response = await fetch(website.url, requestOptions);
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    const targetMetaRaw = await targetMetaPromise;
    const targetMeta = mergeTargetMetadata(cachedTargetMeta, targetMetaRaw);
    const edge = extractEdgeHints(response.headers);
    
    // Get response body for validation (only for small responses to avoid memory issues)
    let responseBody: string | undefined;
    
    // OPTIMIZATION: Only read body if validation is configured
    if (website.responseValidation && response.body) {
      const maxBytes = 10000; // 10KB hard limit
      
      // Use streaming read with hard limit regardless of content-length header
      // This prevents memory issues from spoofed headers
      const bodyController = new AbortController();
      const bodyTimeout = setTimeout(() => bodyController.abort(), 5000); // 5s max for body read
      
      try {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          totalBytes += value.length;
          if (totalBytes > maxBytes) {
            reader.cancel();
            clearTimeout(bodyTimeout);
            logger.warn(`Response body exceeded ${maxBytes} bytes for ${website.url}, truncating`, {
              websiteId: website.id,
              url: website.url,
              error: `Body size limit exceeded (${totalBytes} bytes)`,
              code: 'SIZE_LIMIT'
            });
            break;
          }
          
          chunks.push(value);
        }
        
        clearTimeout(bodyTimeout);
        
        if (chunks.length > 0) {
          responseBody = new TextDecoder().decode(Buffer.concat(chunks));
        }
      } catch (err) {
        clearTimeout(bodyTimeout);
        if (err instanceof Error && err.name === 'AbortError') {
          logger.warn(`Response body read timeout for ${website.url}`, {
            websiteId: website.id,
            url: website.url,
            error: 'Body read timeout after 5s',
            code: 'TIMEOUT'
          });
        } else {
          logger.warn(`Failed to read response body for ${website.url}`, {
            websiteId: website.id,
            url: website.url,
            error: err instanceof Error ? err.message : String(err),
            code: (err as { code?: number | string })?.code
          });
        }
      }
    }
    
    // Check if status code is in expected range (for logging purposes)
    const expectedCodes = website.expectedStatusCodes?.length
      ? website.expectedStatusCodes
      : defaultStatusCodes;
    const statusCodeValid = expectedCodes.includes(response.status);
    
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
    const detailedStatus = categorizeStatusCode(response.status);
    
    // For backward compatibility, map to online/offline
    // UP and REDIRECT are considered online, REACHABLE_WITH_ERROR and DOWN are considered offline
    const isOnline = detailedStatus === 'UP' || detailedStatus === 'REDIRECT';

    // Provide a useful, stable error string for non-UP HTTP responses.
    // This helps users understand issues like 502/504 even when we apply transient suppression higher up.
    const error =
      detailedStatus === 'REACHABLE_WITH_ERROR'
        ? `HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ''}`
        : undefined;
    
    return {
      status: isOnline ? 'online' : 'offline',
      responseTime,
      statusCode: response.status,
      error,
      responseBody,
      sslCertificate,
      domainExpiry,
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
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;

    const targetMetaRaw = await awaitWithTimeout(targetMetaPromise, 250);
    const targetMeta = targetMetaRaw
      ? mergeTargetMetadata(cachedTargetMeta, targetMetaRaw)
      : cachedTargetMeta;
    
    // Distinguish between timeout errors and connection errors
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    const errorMessage = isTimeout 
      ? `Request timed out after ${timeoutMs}ms` 
      : (error instanceof Error ? error.message : 'Unknown error');
    
    // For timeouts, use statusCode -1 to distinguish from connection errors (statusCode 0)
    // Timeouts are less definitive - the site might be slow but still responding
    // Connection errors (statusCode 0) indicate the site is likely down
    const timeoutStatusCode = isTimeout ? -1 : 0;
    
    // For timeouts, use REACHABLE_WITH_ERROR instead of DOWN to indicate uncertainty
    // This prevents false positives for slow but healthy sites
    const timeoutDetailedStatus = isTimeout ? 'REACHABLE_WITH_ERROR' : 'DOWN';
    
    return {
      status: 'offline',
      responseTime,
      statusCode: timeoutStatusCode,
      error: errorMessage,
      sslCertificate: securityChecks.sslCertificate,
      domainExpiry: securityChecks.domainExpiry,
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
