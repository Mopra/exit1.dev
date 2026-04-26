import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, FieldPath, FieldValue } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { Website, ApiKeyDoc } from "./types";
import { BigQueryCheckHistoryRow, CheckStatsResult } from './bigquery';
import { FixedWindowRateLimiter, applyRateLimitHeaders, getClientIp } from "./rate-limit";
import { CONFIG, TIER_LIMITS } from "./config";
import { getUserTier } from "./init";
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from "./check-defaults";
import { CheckRegion } from "./check-region";
import { hasScope, API_SCOPES, type ApiScope } from "./api-scopes";
import {
  normalizeCheckType,
  getCanonicalUrlKeySafe,
  hashCanonicalUrl,
  ORDER_INDEX_GAP,
  withFirestoreRetry,
  getUserCheckStats,
  initializeUserCheckStats,
  refreshRateLimitWindows,
} from "./check-helpers";
import { notifyCheckEdit } from "./checks";
import {
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
  RESEND_API_KEY,
  RESEND_FROM,
} from "./env";

const firestore = getFirestore();
const API_KEYS_COLLECTION = 'apiKeys';
const API_KEY_USAGE_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const API_KEY_USAGE_CACHE_MAX = 5000;
const apiKeyUsageCache = new Map<string, { lastWriteAt: number }>();
const CHECKS_TOTAL_CACHE_TTL_MS = 10 * 60 * 1000;
const CHECKS_TOTAL_CACHE_MAX = 5000;
const checksTotalCache = new Map<string, { count: number; expiresAt: number }>();
// Multi-range stats cache - keyed by checkId::sortedRanges, TTL 1 hour
// Aggregated averages (uptime %, avg response time) shift negligibly over an hour
const STATS_MULTI_CACHE_TTL_MS = 60 * 60 * 1000;
const STATS_MULTI_CACHE_MAX = 2000;
const statsMultiCache = new Map<string, { data: Record<string, CheckStatsResult>; expiresAt: number }>();

// API key validation cache - reduces Firestore reads for repeated API calls
const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const API_KEY_CACHE_MAX = 5000;
interface CachedApiKey {
  keyDocId: string;
  userId: string;
  enabled: boolean;
  scopes: string[];
  expiresAt: number;
}
const apiKeyValidationCache = new Map<string, CachedApiKey>();

const getCachedApiKey = (hash: string): CachedApiKey | null => {
  const cached = apiKeyValidationCache.get(hash);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    apiKeyValidationCache.delete(hash);
    return null;
  }
  return cached;
};

const setCachedApiKey = (hash: string, keyDocId: string, userId: string, enabled: boolean, scopes: string[]): void => {
  apiKeyValidationCache.set(hash, {
    keyDocId,
    userId,
    enabled,
    scopes,
    expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
  });
  if (apiKeyValidationCache.size > API_KEY_CACHE_MAX) {
    apiKeyValidationCache.clear();
  }
};

const shouldWriteApiKeyUsage = (keyId: string, now: number): boolean => {
  const cached = apiKeyUsageCache.get(keyId);
  if (cached && now - cached.lastWriteAt < API_KEY_USAGE_DEBOUNCE_MS) {
    return false;
  }

  apiKeyUsageCache.set(keyId, { lastWriteAt: now });
  if (apiKeyUsageCache.size > API_KEY_USAGE_CACHE_MAX) {
    apiKeyUsageCache.clear();
  }

  return true;
};

const getCachedChecksTotal = (cacheKey: string): number | null => {
  const cached = checksTotalCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    checksTotalCache.delete(cacheKey);
    return null;
  }
  return cached.count;
};

const setCachedChecksTotal = (cacheKey: string, count: number): void => {
  checksTotalCache.set(cacheKey, { count, expiresAt: Date.now() + CHECKS_TOTAL_CACHE_TTL_MS });
  if (checksTotalCache.size > CHECKS_TOTAL_CACHE_MAX) {
    checksTotalCache.clear();
  }
};

const parseCursor = (cursor: string | undefined): { orderIndex: number; id: string } | null => {
  if (!cursor || typeof cursor !== 'string') {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as { orderIndex?: number; id?: string };
    if (typeof parsed.id !== 'string' || !parsed.id) {
      return null;
    }
    const orderIndex = typeof parsed.orderIndex === 'number' ? parsed.orderIndex : 0;
    return { orderIndex, id: parsed.id };
  } catch {
    return null;
  }
};

const buildCursor = (doc: QueryDocumentSnapshot): string => {
  const data = doc.data() as { orderIndex?: number };
  const orderIndex = typeof data.orderIndex === 'number' ? data.orderIndex : 0;
  return Buffer.from(JSON.stringify({ orderIndex, id: doc.id }), 'utf8').toString('base64');
};

// --- Rate limiters ---
// Read limits
const RATE_LIMITS = {
  ipPerMinute: 20,
  perKeyTotalPerMinute: 5,
  perEndpointPerMinute: 1,
  perKeyDaily: 500,
  perUserDaily: 2000,
} as const;
const ipGuardLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 20_000 });
const apiKeyLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 50_000 });
const dailyQuotaLimiter = new FixedWindowRateLimiter({ windowMs: 24 * 60 * 60 * 1000, maxKeys: 50_000 });

// Write-specific limits (layered on top of general limits)
const WRITE_RATE_LIMITS = {
  perKeyWritePerMinute: 2,
  perKeyWriteDaily: 100,
  perUserWriteDaily: 300,
} as const;
const writeRateLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 20_000 });
const dailyWriteQuotaLimiter = new FixedWindowRateLimiter({ windowMs: 24 * 60 * 60 * 1000, maxKeys: 20_000 });

// --- Idempotency ---
const IDEMPOTENCY_COLLECTION = 'api_idempotency_keys';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

// In-memory idempotency cache to reduce Firestore reads on rapid retries
const IDEMPOTENCY_CACHE_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_CACHE_MAX = 2000;
const idempotencyCache = new Map<string, { statusCode: number; body: unknown; expiresAt: number }>();

interface IdempotencyRecord {
  userId: string;
  key: string;
  method: string;
  path: string;
  statusCode: number;
  responseBody: string;
  createdAt: number;
  expiresAt: number;
}

async function checkIdempotency(
  userId: string,
  idempotencyKey: string,
  method: string,
  path: string
): Promise<{ hit: true; statusCode: number; body: unknown } | { hit: false } | { error: string }> {
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return { error: 'Idempotency-Key must be 1-256 alphanumeric characters, hyphens, or underscores' };
  }

  const docId = `${userId}_${idempotencyKey}`;

  // Check in-memory cache first
  const cached = idempotencyCache.get(docId);
  if (cached && cached.expiresAt > Date.now()) {
    return { hit: true, statusCode: cached.statusCode, body: cached.body };
  }

  const docRef = firestore.collection(IDEMPOTENCY_COLLECTION).doc(docId);
  const doc = await docRef.get();

  if (!doc.exists) {
    return { hit: false };
  }

  const record = doc.data() as IdempotencyRecord;

  // Expired — delete stale doc so create() in saveIdempotency succeeds cleanly
  if (record.expiresAt <= Date.now()) {
    await docRef.delete().catch(() => {});
    return { hit: false };
  }

  // Same key, different request — reject
  if (record.method !== method || record.path !== path) {
    return { error: 'Idempotency key already used for a different request' };
  }

  const body = JSON.parse(record.responseBody);

  // Populate in-memory cache
  idempotencyCache.set(docId, { statusCode: record.statusCode, body, expiresAt: Date.now() + IDEMPOTENCY_CACHE_TTL_MS });
  if (idempotencyCache.size > IDEMPOTENCY_CACHE_MAX) {
    idempotencyCache.clear();
  }

  return { hit: true, statusCode: record.statusCode, body };
}

async function saveIdempotency(
  userId: string,
  idempotencyKey: string,
  method: string,
  path: string,
  statusCode: number,
  responseBody: unknown
): Promise<void> {
  const docId = `${userId}_${idempotencyKey}`;
  const now = Date.now();
  const record: IdempotencyRecord = {
    userId,
    key: idempotencyKey,
    method,
    path,
    statusCode,
    responseBody: JSON.stringify(responseBody),
    createdAt: now,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  };

  // Use create() for atomic claim — if another request already saved, create() throws ALREADY_EXISTS.
  // This prevents the TOCTOU race between checkIdempotency and saveIdempotency.
  try {
    await firestore.collection(IDEMPOTENCY_COLLECTION).doc(docId).create(record);
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    if (code === 6) {
      // ALREADY_EXISTS — another concurrent request won the race; this is fine,
      // the check was already created successfully, just skip saving.
      return;
    }
    throw err;
  }

  idempotencyCache.set(docId, { statusCode, body: responseBody, expiresAt: now + IDEMPOTENCY_CACHE_TTL_MS });
  if (idempotencyCache.size > IDEMPOTENCY_CACHE_MAX) {
    idempotencyCache.clear();
  }
}

// --- Route helpers ---

function getRouteName(segments: string[], method: string): string {
  // /v1/public/checks/:id/history
  if (segments.length === 5 && segments[2] === 'checks' && segments[4] === 'history') {
    return 'checks_history';
  }
  // /v1/public/checks/:id/stats
  if (segments.length === 5 && segments[2] === 'checks' && segments[4] === 'stats') {
    return 'checks_stats';
  }
  // /v1/public/checks/:id/toggle
  if (segments.length === 5 && segments[2] === 'checks' && segments[4] === 'toggle') {
    return 'checks_toggle';
  }
  // /v1/public/checks/:id
  if (segments.length === 4 && segments[2] === 'checks') {
    if (method === 'PATCH') return 'checks_update';
    if (method === 'DELETE') return 'checks_delete';
    return 'checks_detail';
  }
  // /v1/public/checks
  if (segments.length === 3 && segments[2] === 'checks') {
    if (method === 'POST') return 'checks_create';
    return 'checks_list';
  }
  return 'default';
}

function getRequiredScope(method: string, routeName: string): ApiScope {
  if (routeName === 'checks_delete') return API_SCOPES.CHECKS_DELETE;
  if (method === 'POST' || method === 'PATCH') return API_SCOPES.CHECKS_WRITE;
  return API_SCOPES.CHECKS_READ;
}

// Helper function to safely parse BigQuery timestamp
function parseBigQueryTimestamp(
  timestamp: unknown,
  entryId: string,
  fallback: number = Date.now()
): number {
  try {
    if (!timestamp) {
      logger.warn(`Missing timestamp for entry ${entryId}, using fallback`);
      return fallback;
    }

    if (typeof timestamp === 'object' && timestamp !== null && 'value' in timestamp) {
      const value = (timestamp as { value: unknown }).value;
      if (typeof value === 'string' && value) {
        const parsed = new Date(value).getTime();
        if (!isNaN(parsed)) {
          return parsed;
        }
        logger.warn(`Invalid timestamp value for entry ${entryId}: ${value}`);
      }
    } else if (timestamp instanceof Date) {
      return timestamp.getTime();
    } else if (typeof timestamp === 'number') {
      if (!isNaN(timestamp) && timestamp > 0) {
        return timestamp;
      }
      logger.warn(`Invalid timestamp number for entry ${entryId}: ${timestamp}`);
    } else if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp).getTime();
      if (!isNaN(parsed)) {
        return parsed;
      }
      logger.warn(`Invalid timestamp string for entry ${entryId}: ${timestamp}`);
    } else {
      logger.warn(`Unexpected timestamp format for entry ${entryId}:`, typeof timestamp);
    }
  } catch (e) {
    logger.error(`Error parsing timestamp for entry ${entryId}:`, e);
  }
  return fallback;
}

async function hashApiKey(key: string): Promise<string> {
  const { createHash } = await import('crypto');
  const pepper = process.env.API_KEY_PEPPER || '';
  return createHash('sha256').update(pepper + key).digest('hex');
}

function parseDateParam(dateStr: string): number {
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.getTime();
  }

  const timestamp = Number(dateStr);
  if (!isNaN(timestamp) && timestamp > 0) {
    // Distinguish seconds (< 1e12) from milliseconds
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }

  throw new Error(`Invalid date format: ${dateStr}. Use ISO 8601 (2023-12-21T22:30:56Z) or Unix timestamp`);
}

function sanitizeCheck(doc: { id: string; [key: string]: unknown }) {
  return {
    id: doc.id,
    name: doc.name || doc.url,
    url: doc.url,
    status: doc.status,
    lastChecked: doc.lastChecked,
    responseTime: doc.responseTime ?? null,
    lastStatusCode: doc.lastStatusCode ?? null,
    disabled: !!doc.disabled,
    maintenanceMode: !!doc.maintenanceMode,
    maintenanceScheduledStart: doc.maintenanceScheduledStart || null,
    maintenanceRecurring: doc.maintenanceRecurring || null,
    sslCertificate: doc.sslCertificate || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// --- Input sanitization helpers for write endpoints ---

const BLOCKED_REQUEST_HEADERS = new Set([
  'host', 'authorization', 'cookie', 'set-cookie',
  'x-forwarded-for', 'x-real-ip', 'proxy-authorization',
  'transfer-encoding', 'content-length',
]);
const MAX_REQUEST_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_REQUEST_BODY_LENGTH = 65536; // 64KB

function validateRequestHeaders(headers: unknown): { valid: boolean; error?: string; sanitized?: Record<string, string> } {
  if (headers === undefined || headers === null) return { valid: true, sanitized: {} };
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    return { valid: false, error: 'requestHeaders must be a plain object' };
  }
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length > MAX_REQUEST_HEADERS) {
    return { valid: false, error: `requestHeaders cannot have more than ${MAX_REQUEST_HEADERS} entries` };
  }
  const sanitized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { valid: false, error: 'requestHeaders keys and values must be strings' };
    }
    if (BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) {
      return { valid: false, error: `Header "${key}" is not allowed` };
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      return { valid: false, error: `Header value for "${key}" exceeds max length (${MAX_HEADER_VALUE_LENGTH})` };
    }
    sanitized[key] = value;
  }
  return { valid: true, sanitized };
}

function validateResponseValidation(rv: unknown): { valid: boolean; error?: string; sanitized?: Record<string, unknown> } {
  if (rv === undefined || rv === null) return { valid: true, sanitized: {} };
  if (typeof rv !== 'object' || Array.isArray(rv)) {
    return { valid: false, error: 'responseValidation must be a plain object' };
  }
  const obj = rv as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  if (obj.containsText !== undefined) {
    if (!Array.isArray(obj.containsText) || !obj.containsText.every((v: unknown) => typeof v === 'string')) {
      return { valid: false, error: 'responseValidation.containsText must be an array of strings' };
    }
    if (obj.containsText.length > 10) {
      return { valid: false, error: 'responseValidation.containsText: max 10 entries' };
    }
    sanitized.containsText = obj.containsText;
  }
  if (obj.jsonPath !== undefined) {
    if (typeof obj.jsonPath !== 'string' || obj.jsonPath.length > 500) {
      return { valid: false, error: 'responseValidation.jsonPath must be a string (max 500 chars)' };
    }
    sanitized.jsonPath = obj.jsonPath;
  }
  if (obj.expectedValue !== undefined) {
    const ev = obj.expectedValue;
    if (typeof ev === 'string' && ev.length > 1000) {
      return { valid: false, error: 'responseValidation.expectedValue string exceeds max length (1000 chars)' };
    }
    if (typeof ev === 'object' && ev !== null) {
      const serialized = JSON.stringify(ev);
      if (serialized.length > 2000) {
        return { valid: false, error: 'responseValidation.expectedValue object is too large' };
      }
    }
    sanitized.expectedValue = ev;
  }
  return { valid: true, sanitized };
}

function validateRequestBody(body: unknown): { valid: boolean; error?: string } {
  if (body === undefined || body === null || body === '') return { valid: true };
  if (typeof body !== 'string') return { valid: false, error: 'requestBody must be a string' };
  if (body.length > MAX_REQUEST_BODY_LENGTH) {
    return { valid: false, error: `requestBody exceeds max length (${MAX_REQUEST_BODY_LENGTH} chars)` };
  }
  return { valid: true };
}

function validateExpectedStatusCodes(codes: unknown): { valid: boolean; error?: string } {
  if (codes === undefined || codes === null) return { valid: true };
  if (!Array.isArray(codes)) return { valid: false, error: 'expectedStatusCodes must be an array' };
  for (const code of codes) {
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 100 || code > 599) {
      return { valid: false, error: 'expectedStatusCodes must contain integers between 100 and 599' };
    }
  }
  return { valid: true };
}

// --- Write rate limit helper ---

function enforceWriteRateLimit(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  keyDocId: string,
  userId: string
): boolean {
  const perMinute = writeRateLimiter.consume(`write:key:${keyDocId}`, WRITE_RATE_LIMITS.perKeyWritePerMinute);
  if (!perMinute.allowed) {
    applyRateLimitHeaders(res, perMinute);
    res.status(429).json({ error: 'Write rate limit exceeded. Maximum 2 write operations per minute.' });
    return false;
  }

  const dailyKey = dailyWriteQuotaLimiter.consume(`write:daily:key:${keyDocId}`, WRITE_RATE_LIMITS.perKeyWriteDaily);
  if (!dailyKey.allowed) {
    applyRateLimitHeaders(res, dailyKey);
    res.status(429).json({ error: 'Daily write quota exceeded for this API key. Limit: 100 writes/day.' });
    return false;
  }

  const dailyUser = dailyWriteQuotaLimiter.consume(`write:daily:user:${userId}`, WRITE_RATE_LIMITS.perUserWriteDaily);
  if (!dailyUser.allowed) {
    applyRateLimitHeaders(res, dailyUser);
    res.status(429).json({ error: 'Daily write quota exceeded. Limit: 300 writes/day across all API keys.' });
    return false;
  }

  return true;
}

// --- Firestore doc ID validation ---
const VALID_DOC_ID = /^[a-zA-Z0-9_-]{1,128}$/;
function isValidDocId(id: string): boolean {
  return VALID_DOC_ID.test(id);
}

// --- Verify check ownership helper ---

async function getOwnedCheck(
  checkId: string,
  userId: string,
  res: Parameters<Parameters<typeof onRequest>[0]>[1]
): Promise<Website | null> {
  if (!isValidDocId(checkId)) {
    res.status(400).json({ error: 'Invalid check ID format' });
    return null;
  }
  const doc = await firestore.collection('checks').doc(checkId).get();
  if (!doc.exists) {
    res.status(404).json({ error: 'Check not found' });
    return null;
  }
  const data = doc.data() as Website;
  if (data.userId !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return { ...data, id: doc.id };
}

// ============================================================
// Write endpoint handlers
// ============================================================

async function handleCreateCheck(
  req: Parameters<Parameters<typeof onRequest>[0]>[0],
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  keyDocId: string,
  path: string
): Promise<void> {
  // Idempotency key required for POST
  const idempotencyKey = req.header('Idempotency-Key') || '';
  if (!idempotencyKey) {
    res.status(400).json({ error: 'Idempotency-Key header is required for POST requests' });
    return;
  }
  const idempResult = await checkIdempotency(userId, idempotencyKey, 'POST', path);
  if ('error' in idempResult) {
    res.status(422).json({ error: idempResult.error });
    return;
  }
  if (idempResult.hit) {
    res.status(idempResult.statusCode).json(idempResult.body);
    return;
  }

  const body = req.body || {};
  const {
    url, name, checkFrequency, type = 'website',
    httpMethod, expectedStatusCodes,
    requestHeaders = {}, requestBody = '',
    responseValidation = {},
    redirectValidation,
    maxRedirects,
    responseTimeLimit, downConfirmationAttempts,
    cacheControlNoCache, checkRegionOverride,
    pingPackets, timezone,
  } = body;

  if (maxRedirects !== undefined && maxRedirects !== null && (typeof maxRedirects !== 'number' || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10)) {
    res.status(400).json({ error: 'maxRedirects must be an integer between 0 and 10' });
    return;
  }

  // Heartbeat checks don't need a user-provided URL
  const resolvedTypeForUrlCheck = normalizeCheckType(type);
  if (resolvedTypeForUrlCheck !== 'heartbeat' && (!url || typeof url !== 'string')) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 200)) {
    res.status(400).json({ error: 'name must be a string (max 200 characters)' });
    return;
  }
  if (checkFrequency !== undefined && checkFrequency !== null && (typeof checkFrequency !== 'number' || !Number.isFinite(checkFrequency) || checkFrequency <= 0)) {
    res.status(400).json({ error: 'checkFrequency must be a positive number (minutes)' });
    return;
  }
  if (cacheControlNoCache !== undefined && cacheControlNoCache !== null && typeof cacheControlNoCache !== 'boolean') {
    res.status(400).json({ error: 'cacheControlNoCache must be a boolean' });
    return;
  }
  if (type !== undefined && type !== null && typeof type !== 'string') {
    res.status(400).json({ error: 'type must be a string' });
    return;
  }

  const now = Date.now();
  const userTier = await getUserTier(userId);
  let stats = await getUserCheckStats(userId);
  if (!stats) {
    stats = await initializeUserCheckStats(userId);
  } else {
    stats = refreshRateLimitWindows(stats, now);
  }

  // DNS checks: Nano and Scale only
  const resolvedType = normalizeCheckType(type);
  if (resolvedType === 'dns') {
    if (userTier === 'free') {
      res.status(403).json({ error: 'DNS monitoring is available on Nano and Scale plans only.' });
      return;
    }
  }

  // Tier-based max checks
  const maxChecks = CONFIG.getMaxChecksForTier(userTier);
  if (stats.checkCount >= maxChecks) {
    stats = await initializeUserCheckStats(userId);
    if (stats.checkCount >= maxChecks) {
      res.status(409).json({ error: `Maximum of ${maxChecks} checks reached for your plan.` });
      return;
    }
  }

  // Check-creation rate limits (per-minute / per-hour / per-day)
  if (stats.checksAddedLastMinute >= CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE) {
    res.status(429).json({ error: `Rate limit: max ${CONFIG.RATE_LIMIT_CHECKS_PER_MINUTE} checks/minute.` });
    return;
  }
  if (stats.checksAddedLastHour >= CONFIG.RATE_LIMIT_CHECKS_PER_HOUR) {
    res.status(429).json({ error: `Rate limit: max ${CONFIG.RATE_LIMIT_CHECKS_PER_HOUR} checks/hour.` });
    return;
  }
  if (stats.checksAddedLastDay >= CONFIG.RATE_LIMIT_CHECKS_PER_DAY) {
    res.status(429).json({ error: `Rate limit: max ${CONFIG.RATE_LIMIT_CHECKS_PER_DAY} checks/day.` });
    return;
  }

  // Heartbeat-specific: generate token and synthetic URL
  let heartbeatToken: string | undefined;
  let effectiveUrl = url || '';
  if (resolvedType === 'heartbeat') {
    const crypto = await import('crypto');
    heartbeatToken = crypto.randomBytes(32).toString('hex');
    effectiveUrl = `heartbeat://${heartbeatToken}`;
  }

  // URL validation
  const urlValidation = CONFIG.validateUrl(effectiveUrl, resolvedType);
  if (!urlValidation.valid) {
    res.status(400).json({ error: `URL validation failed: ${urlValidation.reason}` });
    return;
  }

  const websiteType: Website["type"] = resolvedType === "rest_endpoint" ? "rest" : resolvedType;
  const isHttpCheck = resolvedType === "website" || resolvedType === "rest_endpoint" || resolvedType === "redirect";
  const resolvedHttpMethod = isHttpCheck ? (httpMethod || getDefaultHttpMethod()) : undefined;
  const resolvedExpectedStatusCodes =
    isHttpCheck
      ? Array.isArray(expectedStatusCodes) && expectedStatusCodes.length > 0
        ? expectedStatusCodes
        : getDefaultExpectedStatusCodes(websiteType)
      : undefined;

  // Validate redirect validation fields
  let validatedRedirectValidation: { expectedTarget: string; matchMode: 'contains' | 'exact' } | undefined;
  if (resolvedType === 'redirect' && redirectValidation && typeof redirectValidation === 'object') {
    const rv = redirectValidation as Record<string, unknown>;
    if (rv.expectedTarget && typeof rv.expectedTarget === 'string') {
      const matchMode = rv.matchMode === 'exact' ? 'exact' as const : 'contains' as const;
      validatedRedirectValidation = {
        expectedTarget: String(rv.expectedTarget).slice(0, 2000),
        matchMode,
      };
    }
  }

  // DNS-specific fields
  let dnsMonitoring: Record<string, unknown> | undefined;
  if (resolvedType === 'dns') {
    const { recordTypes: dnsRecordTypes = ['A'] } = body;
    const validDnsTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA'];
    const sanitizedTypes = Array.isArray(dnsRecordTypes)
      ? dnsRecordTypes.filter((t: unknown) => typeof t === 'string' && validDnsTypes.includes(t as string))
      : ['A'];
    if (sanitizedTypes.length === 0) {
      res.status(400).json({ error: 'At least one valid DNS record type is required (A, AAAA, CNAME, MX, TXT, NS, SOA)' });
      return;
    }
    if (sanitizedTypes.length > 7) {
      res.status(400).json({ error: 'Maximum 7 DNS record types per check' });
      return;
    }

    const minDnsInterval = CONFIG.getMinDnsCheckIntervalMinutesForTier(userTier);
    const freq = checkFrequency ?? CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES;
    if (freq < minDnsInterval) {
      res.status(400).json({ error: `DNS check interval too short. Minimum for your plan: ${minDnsInterval} minutes.` });
      return;
    }

    dnsMonitoring = {
      recordTypes: sanitizedTypes,
      baseline: {},
      lastResult: {},
      changes: [],
      autoAccept: false,
      autoAcceptConsecutiveCount: 0,
    };
  }

  // Validate complex fields before any writes
  const headersResult = validateRequestHeaders(requestHeaders);
  if (!headersResult.valid) {
    res.status(400).json({ error: headersResult.error });
    return;
  }
  const validatedHeaders = headersResult.sanitized!;

  const rvResult = validateResponseValidation(responseValidation);
  if (!rvResult.valid) {
    res.status(400).json({ error: rvResult.error });
    return;
  }
  const validatedResponseValidation = rvResult.sanitized!;

  const bodyResult = validateRequestBody(requestBody);
  if (!bodyResult.valid) {
    res.status(400).json({ error: bodyResult.error });
    return;
  }

  const codesResult = validateExpectedStatusCodes(expectedStatusCodes);
  if (!codesResult.valid) {
    res.status(400).json({ error: codesResult.error });
    return;
  }

  // REST endpoint validation
  if (resolvedType === 'rest_endpoint') {
    if (!resolvedHttpMethod || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(resolvedHttpMethod)) {
      res.status(400).json({ error: 'Invalid HTTP method. Must be one of: GET, POST, PUT, PATCH, DELETE, HEAD' });
      return;
    }
    if (['POST', 'PUT', 'PATCH'].includes(resolvedHttpMethod) && requestBody) {
      try { JSON.parse(requestBody); } catch {
        res.status(400).json({ error: 'Request body must be valid JSON' });
        return;
      }
    }
    if (!Array.isArray(resolvedExpectedStatusCodes) || resolvedExpectedStatusCodes.length === 0) {
      res.status(400).json({ error: 'Expected status codes must be a non-empty array' });
      return;
    }
  }

  // Field validations
  if (responseTimeLimit !== undefined && responseTimeLimit !== null) {
    if (typeof responseTimeLimit !== 'number' || !Number.isFinite(responseTimeLimit) || responseTimeLimit <= 0) {
      res.status(400).json({ error: 'responseTimeLimit must be a positive number in milliseconds' });
      return;
    }
    if (responseTimeLimit > CONFIG.RESPONSE_TIME_LIMIT_MAX_MS) {
      res.status(400).json({ error: `responseTimeLimit cannot exceed ${CONFIG.RESPONSE_TIME_LIMIT_MAX_MS}ms` });
      return;
    }
  }

  if (downConfirmationAttempts !== undefined && downConfirmationAttempts !== null) {
    if (typeof downConfirmationAttempts !== 'number' || !Number.isFinite(downConfirmationAttempts) || downConfirmationAttempts < 1 || downConfirmationAttempts > 99) {
      res.status(400).json({ error: 'downConfirmationAttempts must be a number between 1 and 99' });
      return;
    }
  }

  // Duplicate detection - use safe version to avoid uncaught URL parse errors
  const canonicalUrl = getCanonicalUrlKeySafe(effectiveUrl);
  if (!canonicalUrl) {
    res.status(400).json({ error: 'Invalid URL format' });
    return;
  }
  const urlHash = hashCanonicalUrl(canonicalUrl);
  if (stats.urlHashes?.[urlHash]) {
    res.status(409).json({ error: 'A check already exists for this URL' });
    return;
  }

  // Check frequency
  const finalCheckFrequency = checkFrequency || CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES;
  const freqValidation = CONFIG.validateCheckFrequencyForTier(finalCheckFrequency, userTier);
  if (!freqValidation.valid) {
    res.status(400).json({ error: freqValidation.reason || 'Check frequency not allowed for your plan' });
    return;
  }

  // Region choice is gated to tiers with regionChoice = true (Pro/Agency).
  // Free + Nano are locked to vps-eu-1 regardless of what they pass.
  const effectiveRegionOverride: CheckRegion | undefined | null =
    TIER_LIMITS[userTier].regionChoice ? checkRegionOverride : "vps-eu-1";
  const VALID_REGIONS_ADD: CheckRegion[] = ["vps-eu-1", "vps-us-1"];
  if (effectiveRegionOverride !== undefined && effectiveRegionOverride !== null) {
    if (!VALID_REGIONS_ADD.includes(effectiveRegionOverride)) {
      res.status(400).json({ error: `Invalid region. Must be one of: ${VALID_REGIONS_ADD.join(", ")}` });
      return;
    }
  }
  const checkRegion: CheckRegion = effectiveRegionOverride ?? "vps-eu-1";

  const maxOrderIndex = stats.maxOrderIndex;
  const docRef = await withFirestoreRetry(() =>
    firestore.collection("checks").add({
      url: effectiveUrl,
      name: name || effectiveUrl,
      userId,
      userTier,
      checkRegion,
      ...(effectiveRegionOverride ? { checkRegionOverride: effectiveRegionOverride } : {}),
      checkFrequency: finalCheckFrequency,
      consecutiveFailures: 0,
      lastFailureTime: null,
      disabled: false,
      immediateRecheckEnabled: true,
      createdAt: now,
      updatedAt: now,
      downtimeCount: 0,
      lastDowntime: null,
      status: "unknown",
      lastChecked: 0,
      nextCheckAt: now,
      orderIndex: maxOrderIndex + ORDER_INDEX_GAP,
      type: resolvedType,
      ...(isHttpCheck
        ? {
          httpMethod: resolvedHttpMethod,
          expectedStatusCodes: resolvedExpectedStatusCodes,
          requestHeaders: validatedHeaders,
          requestBody: requestBody || '',
          responseValidation: validatedResponseValidation,
          cacheControlNoCache: cacheControlNoCache === true,
          ...(validatedRedirectValidation ? { redirectValidation: validatedRedirectValidation } : {}),
          ...(typeof maxRedirects === 'number' ? { maxRedirects } : {}),
        }
        : {}),
      ...(dnsMonitoring ? { dnsMonitoring } : {}),
      ...(typeof responseTimeLimit === 'number' ? { responseTimeLimit } : {}),
      ...(typeof downConfirmationAttempts === 'number' ? { downConfirmationAttempts } : {}),
      ...(typeof pingPackets === 'number' && pingPackets >= 1 && pingPackets <= 5 ? { pingPackets } : {}),
      ...(typeof timezone === 'string' && timezone ? { timezone } : {}),
      ...(resolvedType === 'heartbeat' ? {
        heartbeatToken,
        lastPingAt: null,
        lastPingMetadata: null,
      } : {}),
    })
  );

  // Update user stats
  await firestore.collection("user_check_stats").doc(userId).set({
    checkCount: stats.checkCount + 1,
    maxOrderIndex: maxOrderIndex + ORDER_INDEX_GAP,
    lastCheckAddedAt: now,
    checksAddedLastMinute: stats.checksAddedLastMinute + 1,
    checksAddedLastHour: stats.checksAddedLastHour + 1,
    checksAddedLastDay: stats.checksAddedLastDay + 1,
    lastMinuteWindowStart: stats.lastMinuteWindowStart,
    lastHourWindowStart: stats.lastHourWindowStart,
    lastDayWindowStart: stats.lastDayWindowStart,
    [`urlHashes.${urlHash}`]: docRef.id,
  }, { merge: true });

  await notifyCheckEdit(docRef.id, 'added');
  const responsePayload = { data: { id: docRef.id } };
  await saveIdempotency(userId, idempotencyKey, 'POST', path, 201, responsePayload);
  res.status(201).json(responsePayload);
}

async function handleUpdateCheck(
  req: Parameters<Parameters<typeof onRequest>[0]>[0],
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  checkId: string
): Promise<void> {
  const existing = await getOwnedCheck(checkId, userId, res);
  if (!existing) return;

  const body = req.body || {};
  const {
    url, name, checkFrequency, type, httpMethod,
    expectedStatusCodes, requestHeaders, requestBody,
    responseValidation, redirectValidation, maxRedirects,
    immediateRecheckEnabled,
    downConfirmationAttempts, responseTimeLimit,
    cacheControlNoCache, checkRegionOverride,
    pingPackets, timezone,
  } = body;

  // Type-check primitive fields
  if (url !== undefined && url !== null && typeof url !== 'string') {
    res.status(400).json({ error: 'url must be a string' });
    return;
  }
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 200)) {
    res.status(400).json({ error: 'name must be a string (max 200 characters)' });
    return;
  }
  if (checkFrequency !== undefined && checkFrequency !== null && (typeof checkFrequency !== 'number' || !Number.isFinite(checkFrequency) || checkFrequency <= 0)) {
    res.status(400).json({ error: 'checkFrequency must be a positive number (minutes)' });
    return;
  }
  if (cacheControlNoCache !== undefined && cacheControlNoCache !== null && typeof cacheControlNoCache !== 'boolean') {
    res.status(400).json({ error: 'cacheControlNoCache must be a boolean' });
    return;
  }
  if (immediateRecheckEnabled !== undefined && immediateRecheckEnabled !== null && typeof immediateRecheckEnabled !== 'boolean') {
    res.status(400).json({ error: 'immediateRecheckEnabled must be a boolean' });
    return;
  }
  if (type !== undefined && type !== null && typeof type !== 'string') {
    res.status(400).json({ error: 'type must be a string' });
    return;
  }
  if (maxRedirects !== undefined && maxRedirects !== null && (typeof maxRedirects !== 'number' || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10)) {
    res.status(400).json({ error: 'maxRedirects must be an integer between 0 and 10' });
    return;
  }

  const userTier = await getUserTier(userId);

  // Region choice is gated to tiers with regionChoice = true (Pro/Agency).
  // Free + Nano are locked to vps-eu-1 regardless of what they pass.
  const effectiveRegionOverride =
    TIER_LIMITS[userTier].regionChoice ? checkRegionOverride : "vps-eu-1";
  const VALID_REGIONS: CheckRegion[] = ["vps-eu-1", "vps-us-1"];
  if (effectiveRegionOverride !== undefined && effectiveRegionOverride !== null) {
    if (!VALID_REGIONS.includes(effectiveRegionOverride)) {
      res.status(400).json({ error: `Invalid region. Must be one of: ${VALID_REGIONS.join(", ")}` });
      return;
    }
  }

  // Field validations
  if (responseTimeLimit !== undefined && responseTimeLimit !== null) {
    if (typeof responseTimeLimit !== 'number' || !Number.isFinite(responseTimeLimit) || responseTimeLimit <= 0) {
      res.status(400).json({ error: 'responseTimeLimit must be a positive number in milliseconds' });
      return;
    }
    if (responseTimeLimit > CONFIG.RESPONSE_TIME_LIMIT_MAX_MS) {
      res.status(400).json({ error: `responseTimeLimit cannot exceed ${CONFIG.RESPONSE_TIME_LIMIT_MAX_MS}ms` });
      return;
    }
  }

  if (downConfirmationAttempts !== undefined && downConfirmationAttempts !== null) {
    if (typeof downConfirmationAttempts !== 'number' || !Number.isFinite(downConfirmationAttempts) || downConfirmationAttempts < 1 || downConfirmationAttempts > 99) {
      res.status(400).json({ error: 'downConfirmationAttempts must be between 1 and 99' });
      return;
    }
  }

  const effectiveUrl = url ?? existing.url;
  const targetType = normalizeCheckType(type ?? existing.type);

  const urlValidation = CONFIG.validateUrl(effectiveUrl, targetType);
  if (!urlValidation.valid) {
    res.status(400).json({ error: `URL validation failed: ${urlValidation.reason}` });
    return;
  }

  // Validate complex fields
  const headersResult = validateRequestHeaders(requestHeaders);
  if (!headersResult.valid) {
    res.status(400).json({ error: headersResult.error });
    return;
  }

  const rvResult = validateResponseValidation(responseValidation);
  if (!rvResult.valid) {
    res.status(400).json({ error: rvResult.error });
    return;
  }

  const bodyResult = validateRequestBody(requestBody);
  if (!bodyResult.valid) {
    res.status(400).json({ error: bodyResult.error });
    return;
  }

  const codesResult = validateExpectedStatusCodes(expectedStatusCodes);
  if (!codesResult.valid) {
    res.status(400).json({ error: codesResult.error });
    return;
  }

  if (targetType === 'rest_endpoint') {
    const effectiveMethod = httpMethod ?? existing.httpMethod ?? getDefaultHttpMethod();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(effectiveMethod)) {
      res.status(400).json({ error: 'Invalid HTTP method' });
      return;
    }
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(effectiveMethod)) {
      try { JSON.parse(requestBody); } catch {
        res.status(400).json({ error: 'Request body must be valid JSON' });
        return;
      }
    }
    if (expectedStatusCodes && (!Array.isArray(expectedStatusCodes) || expectedStatusCodes.length === 0)) {
      res.status(400).json({ error: 'Expected status codes must be a non-empty array' });
      return;
    }
  }

  // Duplicate detection (URL hash) - use safe version to avoid uncaught URL parse errors
  const canonicalUrl = getCanonicalUrlKeySafe(effectiveUrl);
  if (!canonicalUrl) {
    res.status(400).json({ error: 'Invalid URL format' });
    return;
  }
  const newUrlHash = hashCanonicalUrl(canonicalUrl);
  const oldCanonicalUrl = getCanonicalUrlKeySafe(existing.url);
  const oldUrlHash = oldCanonicalUrl ? hashCanonicalUrl(oldCanonicalUrl) : null;
  const urlChanged = oldUrlHash !== newUrlHash;

  let stats = await getUserCheckStats(userId);
  if (!stats) {
    stats = await initializeUserCheckStats(userId);
  }
  const existingCheckId = stats.urlHashes?.[newUrlHash];
  if (existingCheckId && existingCheckId !== checkId) {
    res.status(409).json({ error: 'A check already exists for this URL' });
    return;
  }

  // Check frequency validation
  if (checkFrequency !== undefined) {
    const freqValidation = CONFIG.validateCheckFrequencyForTier(checkFrequency, userTier);
    if (!freqValidation.valid) {
      res.status(400).json({ error: freqValidation.reason || 'Check frequency not allowed for your plan' });
      return;
    }
  }

  // Build update payload
  const now = Date.now();
  const updateData: Record<string, unknown> = {
    updatedAt: now,
  };

  // Only reset check schedule when fields that affect check behavior change
  const requiresRecheck = url !== undefined || type !== undefined || checkFrequency !== undefined
    || httpMethod !== undefined || expectedStatusCodes !== undefined || requestHeaders !== undefined
    || requestBody !== undefined || responseValidation !== undefined || redirectValidation !== undefined
    || maxRedirects !== undefined || checkRegionOverride !== undefined || cacheControlNoCache !== undefined || pingPackets !== undefined;
  if (requiresRecheck) {
    updateData.lastChecked = 0;
    updateData.nextCheckAt = now;
  }

  if (url !== undefined) updateData.url = url;
  if (name !== undefined) updateData.name = name;
  if (checkFrequency !== undefined) updateData.checkFrequency = checkFrequency;
  if (immediateRecheckEnabled !== undefined) updateData.immediateRecheckEnabled = immediateRecheckEnabled;
  if (downConfirmationAttempts !== undefined) updateData.downConfirmationAttempts = downConfirmationAttempts;
  if (responseTimeLimit !== undefined) updateData.responseTimeLimit = responseTimeLimit;
  if (type !== undefined) updateData.type = targetType;
  if (httpMethod !== undefined) updateData.httpMethod = httpMethod;
  if (expectedStatusCodes !== undefined) updateData.expectedStatusCodes = expectedStatusCodes;
  if (requestHeaders !== undefined) updateData.requestHeaders = headersResult.sanitized!;
  if (requestBody !== undefined) updateData.requestBody = requestBody;
  if (responseValidation !== undefined) updateData.responseValidation = rvResult.sanitized!;
  if (redirectValidation !== undefined) {
    if (redirectValidation && typeof redirectValidation === 'object') {
      const rv = redirectValidation as Record<string, unknown>;
      if (rv.expectedTarget && typeof rv.expectedTarget === 'string') {
        updateData.redirectValidation = {
          expectedTarget: String(rv.expectedTarget).slice(0, 2000),
          matchMode: rv.matchMode === 'exact' ? 'exact' : 'contains',
        };
      } else {
        updateData.redirectValidation = null;
      }
    } else {
      updateData.redirectValidation = null;
    }
  }
  if (maxRedirects !== undefined) updateData.maxRedirects = typeof maxRedirects === 'number' ? maxRedirects : null;
  if (cacheControlNoCache !== undefined) updateData.cacheControlNoCache = cacheControlNoCache === true;
  if (typeof pingPackets === 'number' && pingPackets >= 1 && pingPackets <= 5) updateData.pingPackets = pingPackets;
  if (timezone !== undefined) updateData.timezone = timezone || null;

  if (effectiveRegionOverride !== undefined) {
    updateData.checkRegionOverride = effectiveRegionOverride;
    if (effectiveRegionOverride !== null) {
      updateData.checkRegion = effectiveRegionOverride;
    }
  }

  await withFirestoreRetry(() => firestore.collection("checks").doc(checkId).update(updateData));
  await notifyCheckEdit(checkId, 'modified');

  // Update URL hash index if URL changed
  if (urlChanged) {
    const hashUpdate: Record<string, unknown> = {
      [`urlHashes.${newUrlHash}`]: checkId,
    };
    if (oldUrlHash) {
      hashUpdate[`urlHashes.${oldUrlHash}`] = FieldValue.delete();
    }
    await firestore.collection("user_check_stats").doc(userId).set(hashUpdate, { merge: true });
  }

  res.json({ data: { success: true } });
}

async function handleDeleteCheck(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  checkId: string
): Promise<void> {
  const existing = await getOwnedCheck(checkId, userId, res);
  if (!existing) return;

  // Remove from status pages
  const statusPagesSnapshot = await firestore
    .collection("status_pages")
    .where("userId", "==", userId)
    .where("checkIds", "array-contains", checkId)
    .get();

  if (!statusPagesSnapshot.empty) {
    const batch = firestore.batch();
    statusPagesSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, {
        checkIds: FieldValue.arrayRemove(checkId),
        updatedAt: Date.now(),
      });
    });
    await batch.commit();
  }

  // Remove URL hash
  const urlToDelete = existing.url;
  const canonicalUrlToDelete = urlToDelete ? getCanonicalUrlKeySafe(urlToDelete) : null;
  const urlHashToDelete = canonicalUrlToDelete ? hashCanonicalUrl(canonicalUrlToDelete) : null;

  await withFirestoreRetry(() => firestore.collection("checks").doc(checkId).delete());
  await notifyCheckEdit(checkId, 'removed');

  const statsUpdate: Record<string, unknown> = {
    checkCount: FieldValue.increment(-1),
  };
  if (urlHashToDelete) {
    statsUpdate[`urlHashes.${urlHashToDelete}`] = FieldValue.delete();
  }
  await firestore.collection("user_check_stats").doc(userId).set(statsUpdate, { merge: true });

  res.json({ data: { success: true } });
}

async function handleToggleCheck(
  req: Parameters<Parameters<typeof onRequest>[0]>[0],
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  checkId: string
): Promise<void> {
  const existing = await getOwnedCheck(checkId, userId, res);
  if (!existing) return;

  const body = req.body || {};
  const { disabled, reason } = body;

  if (typeof disabled !== 'boolean') {
    res.status(400).json({ error: 'disabled must be a boolean' });
    return;
  }
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
    res.status(400).json({ error: 'reason must be a string (max 500 characters)' });
    return;
  }

  const now = Date.now();
  const disabledReason = (typeof reason === 'string' && reason) ? reason : "Disabled via API";
  const updateData: Record<string, unknown> = {
    disabled,
    updatedAt: now,
  };

  if (disabled) {
    updateData.disabledAt = now;
    updateData.disabledReason = disabledReason;
  } else {
    updateData.disabledAt = null;
    updateData.disabledReason = null;
    updateData.consecutiveFailures = 0;
    updateData.lastFailureTime = null;
    updateData.lastChecked = 0;
    updateData.nextCheckAt = now;
    updateData.status = "unknown";
  }

  await withFirestoreRetry(() => firestore.collection("checks").doc(checkId).update(updateData));
  await notifyCheckEdit(checkId, 'modified');

  // If disabling, record history + send notification
  if (disabled) {
    try {
      const { handleCheckDisabled } = await import('./check-events.js');
      const { flushBigQueryInserts } = await import('./bigquery.js');
      const website: Website = { ...existing, id: checkId };
      await handleCheckDisabled(website, disabledReason, now);
      await flushBigQueryInserts();
    } catch (e) {
      logger.warn('Failed to handle check disabled side-effects via API', e);
    }
  }

  res.json({
    data: {
      success: true,
      disabled,
      message: disabled ? "Check disabled" : "Check enabled",
    },
  });
}

async function handleRegenerateHeartbeatToken(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  checkId: string,
): Promise<void> {
  const checkDoc = await firestore.collection('checks').doc(checkId).get();
  if (!checkDoc.exists) {
    res.status(404).json({ error: 'Check not found' });
    return;
  }

  const check = checkDoc.data()!;
  if (check.userId !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  if (check.type !== 'heartbeat') {
    res.status(400).json({ error: 'Only heartbeat checks have tokens' });
    return;
  }

  const crypto = await import('crypto');
  const newToken = crypto.randomBytes(32).toString('hex');
  const newUrl = `heartbeat://${newToken}`;

  await firestore.collection('checks').doc(checkId).update({
    heartbeatToken: newToken,
    url: newUrl,
    updatedAt: Date.now(),
  });

  await notifyCheckEdit(checkId, 'modified');

  res.status(200).json({
    heartbeatToken: newToken,
  });
}

async function handleAcceptBaseline(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  checkId: string,
): Promise<void> {
  const doc = await firestore.collection('checks').doc(checkId).get();
  if (!doc.exists) {
    res.status(404).json({ error: 'Check not found' });
    return;
  }
  const data = doc.data() as Website;
  if (data.userId !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (data.type !== 'dns' || !data.dnsMonitoring) {
    res.status(400).json({ error: 'This endpoint is only for DNS checks' });
    return;
  }

  const lastResult = data.dnsMonitoring.lastResult;
  if (!lastResult || Object.keys(lastResult).length === 0) {
    res.status(400).json({ error: 'No DNS results to accept — wait for the first check to run' });
    return;
  }

  const now = Date.now();
  const newBaseline: Record<string, { values: string[]; capturedAt: number }> = {};
  for (const [rt, result] of Object.entries(lastResult)) {
    newBaseline[rt] = { values: result.values, capturedAt: now };
  }

  await doc.ref.update({
    'dnsMonitoring.baseline': newBaseline,
    'dnsMonitoring.changes': [],
    'dnsMonitoring.autoAcceptConsecutiveCount': 0,
    status: 'online',
    detailedStatus: 'UP',
    consecutiveFailures: 0,
  });

  res.status(200).json({ message: 'Baseline accepted', baseline: newBaseline });
}

// ============================================================
// Main request handler
// ============================================================

export const publicApi = onRequest({
  secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV, RESEND_API_KEY, RESEND_FROM],
}, async (req, res) => {
  // CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Idempotency-Key');
  res.set('Access-Control-Expose-Headers', 'RateLimit, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    // Pre-auth IP guard
    const clientIp = getClientIp(req);
    const ipDecision = ipGuardLimiter.consume(`ip:${clientIp}`, RATE_LIMITS.ipPerMinute);
    applyRateLimitHeaders(res, ipDecision);
    if (!ipDecision.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    const apiKey = (req.header('x-api-key') || req.header('X-Api-Key') || '').trim();
    if (!apiKey) {
      res.status(401).json({ error: 'Missing X-Api-Key' });
      return;
    }

    const hash = await hashApiKey(apiKey);

    // Auth: resolve API key
    let keyDocId: string;
    let userId: string;
    let keyEnabled: boolean;
    let keyScopes: string[];

    const cachedKey = getCachedApiKey(hash);
    if (cachedKey) {
      keyDocId = cachedKey.keyDocId;
      userId = cachedKey.userId;
      keyEnabled = cachedKey.enabled;
      keyScopes = cachedKey.scopes;
    } else {
      const keySnap = await firestore
        .collection(API_KEYS_COLLECTION)
        .where('hash', '==', hash)
        .limit(1)
        .get();

      if (keySnap.empty) {
        res.status(401).json({ error: 'Invalid API key' });
        return;
      }

      const keyDoc = keySnap.docs[0];
      const key = keyDoc.data() as ApiKeyDoc;
      keyDocId = keyDoc.id;
      userId = key.userId;
      keyEnabled = key.enabled;
      keyScopes = key.scopes || [];

      setCachedApiKey(hash, keyDocId, userId, keyEnabled, keyScopes);
    }

    if (!keyEnabled) {
      res.status(401).json({ error: 'API key disabled' });
      return;
    }

    // Daily quota checks
    const dailyKeyQuota = dailyQuotaLimiter.consume(`daily:key:${keyDocId}`, RATE_LIMITS.perKeyDaily);
    if (!dailyKeyQuota.allowed) {
      applyRateLimitHeaders(res, dailyKeyQuota);
      res.status(429).json({
        error: 'Daily API key quota exceeded. Limit: 500 requests/day. Resets at midnight UTC.',
        quotaLimit: RATE_LIMITS.perKeyDaily,
        quotaReset: dailyKeyQuota.resetAtMs
      });
      logger.warn(`API key ${keyDocId} exceeded daily quota (${RATE_LIMITS.perKeyDaily} req/day)`);
      return;
    }

    const dailyUserQuota = dailyQuotaLimiter.consume(`daily:user:${userId}`, RATE_LIMITS.perUserDaily);
    if (!dailyUserQuota.allowed) {
      applyRateLimitHeaders(res, dailyUserQuota);
      res.status(429).json({
        error: 'Daily user quota exceeded. Limit: 2000 requests/day across all API keys. Resets at midnight UTC.',
        quotaLimit: RATE_LIMITS.perUserDaily,
        quotaReset: dailyUserQuota.resetAtMs
      });
      logger.warn(`User ${userId} exceeded daily quota (${RATE_LIMITS.perUserDaily} req/day)`);
      return;
    }

    const reqPath = (req.path || req.url || '').replace(/\/+$/, '');
    const segments = reqPath.split('?')[0].split('/').filter(Boolean);

    // Post-auth rate limits
    const globalKeyDecision = apiKeyLimiter.consume(`key:${keyDocId}:total`, RATE_LIMITS.perKeyTotalPerMinute);
    if (!globalKeyDecision.allowed) {
      applyRateLimitHeaders(res, globalKeyDecision);
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    const routeName = getRouteName(segments, req.method);
    const endpointDecision = apiKeyLimiter.consume(`key:${keyDocId}:route:${routeName}`, RATE_LIMITS.perEndpointPerMinute);
    applyRateLimitHeaders(res, endpointDecision);
    if (!endpointDecision.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    // Track usage (best-effort)
    const usageNow = Date.now();
    if (shouldWriteApiKeyUsage(keyDocId, usageNow)) {
      firestore.collection(API_KEYS_COLLECTION).doc(keyDocId).update({ lastUsedAt: usageNow, lastUsedPath: reqPath }).catch(() => {});
    }

    // --- Scope enforcement ---
    const requiredScope = getRequiredScope(req.method, routeName);
    if (!hasScope(keyScopes, requiredScope)) {
      res.status(403).json({ error: `API key does not have the required scope: ${requiredScope}` });
      return;
    }

    // --- Method validation ---
    const isWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Write rate limits (layered on top of general limits)
    if (isWrite && !enforceWriteRateLimit(res, keyDocId, userId)) {
      return;
    }

    // ============== WRITE ROUTES ==============

    // POST /v1/public/checks - Create check
    if (req.method === 'POST' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      await handleCreateCheck(req, res, userId, keyDocId, reqPath);
      return;
    }

    // PATCH /v1/public/checks/:id - Update check
    if (req.method === 'PATCH' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      await handleUpdateCheck(req, res, userId, segments[3]);
      return;
    }

    // DELETE /v1/public/checks/:id - Delete check
    if (req.method === 'DELETE' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      await handleDeleteCheck(res, userId, segments[3]);
      return;
    }

    // POST /v1/public/checks/:id/toggle - Enable/disable check
    if (req.method === 'POST' && segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'toggle') {
      await handleToggleCheck(req, res, userId, segments[3]);
      return;
    }

    // POST /v1/public/checks/:id/accept-baseline - Accept DNS baseline
    if (req.method === 'POST' && segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'accept-baseline') {
      await handleAcceptBaseline(res, userId, segments[3]);
      return;
    }

    // POST /v1/public/checks/:id/regenerate-token - Regenerate heartbeat token
    if (req.method === 'POST' && segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'regenerate-token') {
      await handleRegenerateHeartbeatToken(res, userId, segments[3]);
      return;
    }

    // ============== READ ROUTES ==============

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed for this endpoint' });
      return;
    }

    // GET /v1/public/checks
    if (segments.length === 3 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      const limit = Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 100);
      const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
      const statusFilter = String(req.query.status || 'all');
      const cursorParam = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const cursor = parseCursor(cursorParam);
      const includeTotal = String(req.query.includeTotal || 'true') !== 'false';

      let countQuery = firestore.collection('checks')
        .where('userId', '==', userId);
      let baseQuery = firestore.collection('checks')
        .where('userId', '==', userId)
        .orderBy('orderIndex', 'asc')
        .orderBy(FieldPath.documentId(), 'asc');

      if (statusFilter !== 'all') {
        countQuery = countQuery.where('status', '==', statusFilter);
        baseQuery = baseQuery.where('status', '==', statusFilter);
      }

      let total: number | null = null;
      if (includeTotal) {
        const totalCacheKey = `${userId}::${statusFilter}`;
        const cachedTotal = getCachedChecksTotal(totalCacheKey);
        if (cachedTotal !== null) {
          total = cachedTotal;
        } else {
          const totalSnap = await countQuery.count().get();
          total = totalSnap.data().count;
          setCachedChecksTotal(totalCacheKey, total);
        }
      }

      let dataQuery = baseQuery;
      if (cursor) {
        dataQuery = dataQuery.startAfter(cursor.orderIndex, cursor.id);
      } else if (page > 1) {
        dataQuery = dataQuery.offset((page - 1) * limit);
      }

      const snap = await dataQuery.limit(limit).get();
      const data = snap.docs.map(d => sanitizeCheck({ id: d.id, ...d.data() }));
      const lastDoc = snap.docs[snap.docs.length - 1];
      const nextCursor = lastDoc ? buildCursor(lastDoc) : null;

      const totalPages = total !== null ? Math.ceil(total / limit) : null;
      const hasNext = cursor
        ? snap.docs.length === limit
        : total !== null
          ? page < (totalPages || 0)
          : snap.docs.length === limit;

      res.json({
        data,
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNext,
          hasPrev: cursor ? true : page > 1,
          nextCursor,
        }
      });
      return;
    }

    // GET /v1/public/checks/:id
    if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      const checkId = segments[3];
      if (!isValidDocId(checkId)) {
        res.status(400).json({ error: 'Invalid check ID format' });
        return;
      }
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.json({ data: sanitizeCheck({ ...data, id: doc.id }) });
      return;
    }

    // GET /v1/public/checks/:id/history
    if (segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'history') {
      const checkId = segments[3];
      if (!isValidDocId(checkId)) {
        res.status(400).json({ error: 'Invalid check ID format' });
        return;
      }
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const limit = Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 200);
      const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
      const startDate = req.query.from ? parseDateParam(String(req.query.from)) : undefined;
      const endDate = req.query.to ? parseDateParam(String(req.query.to)) : undefined;
      const statusFilter = String(req.query.status || 'all');
      const searchTerm = String(req.query.q || '');

      const { getCheckHistory } = await import('./bigquery.js');

      const history = await getCheckHistory(
        checkId,
        userId,
        limit + 1,
        (page - 1) * limit,
        startDate,
        endDate,
        statusFilter,
        searchTerm
      );

      const historyArray = Array.isArray(history) ? history : [];
      if (!Array.isArray(history)) {
        logger.warn(`BigQuery returned non-array history for check ${checkId}, type: ${typeof history}`);
      }

      const hasNext = historyArray.length > limit;
      const trimmedHistory = hasNext ? historyArray.slice(0, limit) : historyArray;

      res.json({
        data: trimmedHistory.map((entry: BigQueryCheckHistoryRow) => {
          const timestampValue = parseBigQueryTimestamp(entry.timestamp, entry.id || 'unknown');
          return {
            id: entry.id || '',
            websiteId: entry.website_id || checkId,
            userId: entry.user_id || userId,
            timestamp: timestampValue,
            status: entry.status || 'unknown',
            responseTime: entry.response_time ?? undefined,
            statusCode: entry.status_code ?? undefined,
            error: entry.error ?? undefined,
            redirectLocation: entry.redirect_location ?? undefined,
            createdAt: timestampValue
          };
        }),
        meta: {
          page,
          limit,
          total: null,
          totalPages: null,
          hasNext,
          hasPrev: page > 1
        }
      });
      return;
    }

    // GET /v1/public/checks/:id/stats
    if (segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'stats') {
      const checkId = segments[3];
      if (!isValidDocId(checkId)) {
        res.status(400).json({ error: 'Invalid check ID format' });
        return;
      }
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const rangesParam = typeof req.query.ranges === 'string' ? req.query.ranges.trim() : '';

      if (rangesParam) {
        const { getCheckStatsMultiRange, ALLOWED_RANGES } = await import('./bigquery.js');
        const requested = rangesParam.split(',').map(r => r.trim()).filter(Boolean);

        const invalid = requested.filter(r => !ALLOWED_RANGES.includes(r));
        if (invalid.length) {
          res.status(400).json({ error: `Invalid ranges: ${invalid.join(', ')}. Allowed: ${ALLOWED_RANGES.join(', ')}` });
          return;
        }
        if (requested.length > 5) {
          res.status(400).json({ error: 'Maximum 5 ranges per request' });
          return;
        }

        const endDate = req.query.to ? parseDateParam(String(req.query.to)) : undefined;

        const cacheKey = `${checkId}::${[...requested].sort().join(',')}`;
        const cached = statsMultiCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          res.json({ data: cached.data });
          return;
        }

        const stats = await getCheckStatsMultiRange(checkId, userId, requested, endDate);

        if (!req.query.to) {
          statsMultiCache.set(cacheKey, { data: stats, expiresAt: Date.now() + STATS_MULTI_CACHE_TTL_MS });
          if (statsMultiCache.size > STATS_MULTI_CACHE_MAX) {
            statsMultiCache.clear();
          }
        }

        res.json({ data: stats });
        return;
      }

      const startDate = req.query.from ? parseDateParam(String(req.query.from)) : undefined;
      const endDate = req.query.to ? parseDateParam(String(req.query.to)) : undefined;

      const { getCheckStats } = await import('./bigquery.js');
      const stats = await getCheckStats(checkId, userId, startDate, endDate);

      res.json({ data: stats });
      return;
    }

    res.status(404).json({ error: 'Not found' });
  } catch (e: unknown) {
    logger.error('publicApi error', e);
    res.status(500).json({ error: 'Internal error' });
  }
});
