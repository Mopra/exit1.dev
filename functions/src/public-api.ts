import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, FieldPath, FieldValue } from "firebase-admin/firestore";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { Website, ApiKeyDoc, EmailSettings, WebhookSettings } from "./types";
import { normalizeEventList } from "./webhook-events";
import { BigQueryCheckHistoryRow, CheckStatsResult } from './bigquery';
import { FixedWindowRateLimiter, applyRateLimitHeaders, getClientIp } from "./rate-limit";
import { CONFIG, TIER_LIMITS } from "./config";
import { getUserTier, getMaxChecksForUser } from "./init";
import { getDefaultExpectedStatusCodes, getDefaultHttpMethod } from "./check-defaults";
import { CheckRegion } from "./check-region";
import { hasScope, API_SCOPES, type ApiScope } from "./api-scopes";
import { resolveBearerToken, buildWwwAuthenticate, MCP_TOKENS_COLLECTION } from "./mcp-oauth";
import {
  normalizeCheckType,
  getCanonicalUrlKeySafe,
  hashCanonicalUrl,
  ORDER_INDEX_GAP,
  withFirestoreRetry,
  getUserCheckStats,
  initializeUserCheckStats,
  refreshRateLimitWindows,
  notifySettingsEdit,
} from "./check-helpers";
import { notifyCheckEdit } from "./checks";
import { extractDomain, validateDomainForRdap } from "./rdap-client";
import { DEFAULT_ALERT_THRESHOLDS } from "./domain-intelligence";
import type { DomainExpiry } from "./types";
import {
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
  RESEND_API_KEY,
  RESEND_FROM,
  getResendCredentials,
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

// OAuth (agent) sessions get their own profile. The API-key numbers above are
// tuned for scripted polling — 1 request/minute per endpoint means an agent
// creating five checks during onboarding would sit through a five-minute
// cooldown mid-flow. Agent sessions are interactive, backed by a consented
// browser grant, and revocable per-connection, so the burst is worth allowing.
// Tier caps and per-user check-creation limits still apply underneath.
const AGENT_RATE_LIMITS = {
  ipPerMinute: 20,
  perKeyTotalPerMinute: 30,
  perEndpointPerMinute: 10,
  perKeyDaily: 1500,
  perUserDaily: 3000,
} as const;
const AGENT_WRITE_RATE_LIMITS = {
  perKeyWritePerMinute: 15,
  perKeyWriteDaily: 200,
  perUserWriteDaily: 400,
} as const;

type RateLimitProfile = typeof RATE_LIMITS | typeof AGENT_RATE_LIMITS;
type WriteRateLimitProfile = typeof WRITE_RATE_LIMITS | typeof AGENT_WRITE_RATE_LIMITS;

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
  // /v1/public/alerts/...
  if (segments[2] === 'alerts') {
    // /v1/public/alerts/email[/test]
    if (segments[3] === 'email') {
      if (segments.length === 5 && segments[4] === 'test') return 'alerts_email_test';
      if (segments.length === 4) return method === 'PATCH' ? 'alerts_email_update' : 'alerts_email_get';
    }
    // /v1/public/alerts/webhooks[/:id[/test]]
    if (segments[3] === 'webhooks') {
      if (segments.length === 6 && segments[5] === 'test') return 'alerts_webhook_test';
      if (segments.length === 5) return 'alerts_webhook_delete';
      if (segments.length === 4) return method === 'POST' ? 'alerts_webhook_create' : 'alerts_webhooks_list';
    }
    return 'alerts_default';
  }
  // /v1/public/account
  if (segments.length === 3 && segments[2] === 'account') {
    return 'account_get';
  }
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
  if (routeName.startsWith('alerts_')) {
    // Reads are GET-only; everything else touches a delivery channel.
    return method === 'GET' ? API_SCOPES.ALERTS_READ : API_SCOPES.ALERTS_WRITE;
  }
  if (routeName === 'account_get') return API_SCOPES.CHECKS_READ;
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
  if (obj.jsonPathOperator !== undefined) {
    const allowed = ['equals', 'not_equals', 'contains', 'exists'];
    if (typeof obj.jsonPathOperator !== 'string' || !allowed.includes(obj.jsonPathOperator)) {
      return { valid: false, error: `responseValidation.jsonPathOperator must be one of: ${allowed.join(', ')}` };
    }
    sanitized.jsonPathOperator = obj.jsonPathOperator;
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
  userId: string,
  limits: WriteRateLimitProfile
): boolean {
  const perMinute = writeRateLimiter.consume(`write:key:${keyDocId}`, limits.perKeyWritePerMinute);
  if (!perMinute.allowed) {
    applyRateLimitHeaders(res, perMinute);
    res.status(429).json({ error: `Write rate limit exceeded. Maximum ${limits.perKeyWritePerMinute} write operations per minute.` });
    return false;
  }

  const dailyKey = dailyWriteQuotaLimiter.consume(`write:daily:key:${keyDocId}`, limits.perKeyWriteDaily);
  if (!dailyKey.allowed) {
    applyRateLimitHeaders(res, dailyKey);
    res.status(429).json({ error: `Daily write quota exceeded for this credential. Limit: ${limits.perKeyWriteDaily} writes/day.` });
    return false;
  }

  const dailyUser = dailyWriteQuotaLimiter.consume(`write:daily:user:${userId}`, limits.perUserWriteDaily);
  if (!dailyUser.allowed) {
    applyRateLimitHeaders(res, dailyUser);
    res.status(429).json({ error: `Daily write quota exceeded. Limit: ${limits.perUserWriteDaily} writes/day across all credentials.` });
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
  path: string,
  isAgentSession = false
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

  const resolvedType = normalizeCheckType(type);

  // LLM checks are in admin-only preview and not yet exposed via the public API.
  if (resolvedType === 'llm') {
    res.status(403).json({ error: 'LLM checks are in preview and not available via the public API yet.' });
    return;
  }

  // DNS checks: any paid tier
  if (resolvedType === 'dns') {
    if (userTier === 'free') {
      res.status(403).json({ error: 'DNS monitoring requires a paid plan.' });
      return;
    }
  }

  // Domain-only checks: Nano+ (gated by `domainIntel` tier flag)
  if (resolvedType === 'domain' && !TIER_LIMITS[userTier].domainIntel) {
    res.status(403).json({ error: 'Domain Intelligence requires a Nano or Pro subscription.' });
    return;
  }

  // Tier-based max checks (honours the legacy Free cap)
  const maxChecks = await getMaxChecksForUser(userId, userTier);
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

  // Heartbeat-specific: generate token and synthetic URL.
  // Domain-only: validate the user's input as a domain and build a synthetic URL.
  let heartbeatToken: string | undefined;
  let domainExpirySeed: DomainExpiry | undefined;
  let effectiveUrl = url || '';
  if (resolvedType === 'heartbeat') {
    const crypto = await import('crypto');
    heartbeatToken = crypto.randomBytes(32).toString('hex');
    effectiveUrl = `heartbeat://${heartbeatToken}`;
  } else if (resolvedType === 'domain') {
    const inputDomain = extractDomain(typeof url === 'string' ? url : '');
    if (!inputDomain) {
      res.status(400).json({ error: 'Could not extract a domain. Send a bare domain like "example.com".' });
      return;
    }
    const validation = validateDomainForRdap(inputDomain);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error || 'Domain not supported' });
      return;
    }
    // Per-user, per-domain DI monitoring uniqueness — see addCheck for rationale.
    const existingMonitor = await firestore.collection('checks')
      .where('userId', '==', userId)
      .where('domainExpiry.enabled', '==', true)
      .where('domainExpiry.domain', '==', inputDomain)
      .limit(1)
      .get();
    if (!existingMonitor.empty) {
      const existing = existingMonitor.docs[0].data() as Website;
      res.status(409).json({ error: `Domain "${inputDomain}" is already monitored on check "${existing.name}"` });
      return;
    }
    effectiveUrl = `domain://${inputDomain}`;
    domainExpirySeed = {
      enabled: true,
      domain: inputDomain,
      status: 'unknown',
      lastCheckedAt: 0,
      nextCheckAt: now,
      consecutiveErrors: 0,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS,
      alertsSent: [],
    };
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
      // Domain-only checks live outside the uptime probe loop — keep
      // `nextCheckAt` null so `paginateDueChecks` skips them.
      nextCheckAt: resolvedType === 'domain' ? null : now,
      orderIndex: maxOrderIndex + ORDER_INDEX_GAP,
      type: resolvedType,
      // Attribution — lets us compare agent-onboarded accounts against the
      // normal funnel. Checks added in the dashboard carry no value here.
      createdVia: isAgentSession ? 'mcp' : 'api',
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
      ...(domainExpirySeed ? { domainExpiry: domainExpirySeed } : {}),
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

  const existingType = normalizeCheckType(existing.type);
  const targetType = normalizeCheckType(type ?? existing.type);

  // LLM checks are in admin-only preview and not yet exposed via the public API.
  if (targetType === 'llm') {
    res.status(403).json({ error: 'LLM checks are in preview and not available via the public API yet.' });
    return;
  }

  // Domain-only checks have a synthetic URL and no uptime probe — type changes
  // into or out of `domain` would leave the row in an inconsistent state.
  if (existingType === 'domain' && targetType !== 'domain') {
    res.status(400).json({ error: "Domain-only checks can't be converted to another type. Delete and re-create instead." });
    return;
  }
  if (existingType !== 'domain' && targetType === 'domain') {
    res.status(400).json({ error: "A check can't be converted into a domain-only check. Create a new domain entry instead." });
    return;
  }

  // Domain-only: force-preserve the existing synthetic URL — the registered
  // domain can't change via update (delete + re-create instead).
  const effectiveUrl = existingType === 'domain' ? existing.url : (url ?? existing.url);

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

  // Only reset check schedule when fields that affect check behavior change.
  // Domain-only checks aren't on the uptime schedule — keep `nextCheckAt` null.
  const requiresRecheck = existingType !== 'domain' && (
    url !== undefined || type !== undefined || checkFrequency !== undefined
    || httpMethod !== undefined || expectedStatusCodes !== undefined || requestHeaders !== undefined
    || requestBody !== undefined || responseValidation !== undefined || redirectValidation !== undefined
    || maxRedirects !== undefined || checkRegionOverride !== undefined || cacheControlNoCache !== undefined || pingPackets !== undefined
  );
  if (requiresRecheck) {
    updateData.lastChecked = 0;
    updateData.nextCheckAt = now;
  }

  // Skip url overwrite for domain-only checks (synthetic URL is read-only).
  if (url !== undefined && existingType !== 'domain') updateData.url = url;
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
// Alert channel handlers
//
// These exist so an agent can finish onboarding without the dashboard: configure
// where alerts go, then fire a real test so the user sees the thing work. They
// deliberately mirror the callable equivalents in email.ts / webhooks.ts —
// same tier limits, same duplicate rejection, same notifySettingsEdit fan-out —
// rather than reimplementing the rules.
// ============================================================

const ALERT_EMAIL_COLLECTION = 'emailSettings';
const WEBHOOKS_COLLECTION = 'webhooks';

async function handleGetEmailAlerts(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string
): Promise<void> {
  const doc = await firestore.collection(ALERT_EMAIL_COLLECTION).doc(userId).get();
  if (!doc.exists) {
    res.json({ data: null });
    return;
  }
  const data = doc.data() as EmailSettings;
  res.json({
    data: {
      enabled: !!data.enabled,
      recipients: getConfiguredEmailRecipients(data),
      events: data.events || [],
      emailFormat: data.emailFormat || 'html',
      updatedAt: data.updatedAt ?? null,
    },
  });
}

function getConfiguredEmailRecipients(settings: EmailSettings): string[] {
  if (Array.isArray(settings.recipients) && settings.recipients.length > 0) {
    return settings.recipients.filter((r) => typeof r === 'string' && r.trim().length > 0);
  }
  if (typeof settings.recipient === 'string' && settings.recipient.trim()) {
    return [settings.recipient.trim()];
  }
  return [];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_RECIPIENTS = 10;

async function handleUpdateEmailAlerts(
  req: Parameters<Parameters<typeof onRequest>[0]>[0],
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string
): Promise<void> {
  const body = req.body || {};
  const { recipients, enabled, events, emailFormat } = body;

  const update: Record<string, unknown> = { userId, updatedAt: Date.now() };

  if (recipients !== undefined) {
    if (!Array.isArray(recipients)) {
      res.status(400).json({ error: 'recipients must be an array of email addresses' });
      return;
    }
    if (recipients.length > MAX_EMAIL_RECIPIENTS) {
      res.status(400).json({ error: `At most ${MAX_EMAIL_RECIPIENTS} recipients are allowed` });
      return;
    }
    const cleaned = recipients
      .filter((r: unknown): r is string => typeof r === 'string')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    const invalid = cleaned.find((r) => !EMAIL_PATTERN.test(r));
    if (invalid) {
      res.status(400).json({ error: `"${invalid}" is not a valid email address` });
      return;
    }
    if (cleaned.length === 0) {
      res.status(400).json({ error: 'At least one recipient email is required' });
      return;
    }
    update.recipients = Array.from(new Set(cleaned));
  }

  if (events !== undefined) {
    if (!Array.isArray(events)) {
      res.status(400).json({ error: 'events must be an array' });
      return;
    }
    const normalized = normalizeEventList(events);
    if (normalized.length === 0) {
      res.status(400).json({ error: 'At least one valid event is required. Known events: website_down, website_up, website_error, ssl_error, ssl_warning, domain_expiring, domain_expired, domain_renewed' });
      return;
    }
    update.events = normalized;
  }

  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    update.enabled = enabled;
  }

  if (emailFormat !== undefined) {
    if (emailFormat !== 'html' && emailFormat !== 'text') {
      res.status(400).json({ error: "emailFormat must be 'html' or 'text'" });
      return;
    }
    update.emailFormat = emailFormat;
  }

  const docRef = firestore.collection(ALERT_EMAIL_COLLECTION).doc(userId);
  const existing = await docRef.get();

  // Creating settings from scratch needs both halves — enabling alerts with no
  // recipients, or recipients with no events, silently delivers nothing.
  if (!existing.exists) {
    if (!update.recipients) {
      res.status(400).json({ error: 'recipients is required when creating email alert settings' });
      return;
    }
    if (!update.events) {
      update.events = ['website_down', 'website_up'];
    }
    if (update.enabled === undefined) {
      update.enabled = true;
    }
    update.createdAt = Date.now();
  }

  await docRef.set(update, { merge: true });
  await notifySettingsEdit(userId);

  const saved = await docRef.get();
  const data = saved.data() as EmailSettings;
  res.json({
    data: {
      enabled: !!data.enabled,
      recipients: getConfiguredEmailRecipients(data),
      events: data.events || [],
      emailFormat: data.emailFormat || 'html',
    },
  });
}

async function handleTestEmailAlert(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string
): Promise<void> {
  const snap = await firestore.collection(ALERT_EMAIL_COLLECTION).doc(userId).get();
  if (!snap.exists) {
    res.status(412).json({ error: 'No email alert settings configured. PATCH /v1/public/alerts/email first.' });
    return;
  }
  const settings = snap.data() as EmailSettings;
  const recipients = getConfiguredEmailRecipients(settings);
  if (recipients.length === 0) {
    res.status(412).json({ error: 'No recipient emails configured' });
    return;
  }

  const { apiKey, fromAddress } = getResendCredentials();
  if (!apiKey) {
    res.status(503).json({ error: 'Email delivery is not configured' });
    return;
  }

  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  const format = settings.emailFormat || 'html';
  const subject = 'Test: Exit1 email alerts';
  const html = format === 'text' ? undefined : `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">Your Exit1 alerts are live</h2>
        <p style="margin:0 0 12px 0;color:#94a3b8">This is the test alert your AI assistant asked us to send. Real alerts will look like this and arrive the moment something goes down.</p>
        <a href="https://app.exit1.dev/checks" style="color:#38bdf8">Open your dashboard</a>
      </div>
    </div>`;
  const text = format === 'text'
    ? 'Your Exit1 alerts are live\n==========================\n\nThis is the test alert your AI assistant asked us to send. Real alerts will arrive the moment something goes down.\n\nDashboard: https://app.exit1.dev/checks'
    : undefined;

  const delivered: string[] = [];
  try {
    for (let i = 0; i < recipients.length; i++) {
      // Resend allows 2 req/sec — space the sends out.
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600));
      const response = format === 'text'
        ? await resend.emails.send({ from: fromAddress, to: recipients[i], subject, text: text! })
        : await resend.emails.send({ from: fromAddress, to: recipients[i], subject, html: html! });
      if (response.error) {
        logger.error('Public API test email failed', { userId, recipient: recipients[i], error: response.error });
        res.status(502).json({ error: response.error.message, delivered });
        return;
      }
      delivered.push(recipients[i]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send test email';
    logger.error('Public API test email threw', { userId, error });
    res.status(502).json({ error: message, delivered });
    return;
  }

  res.json({ data: { delivered, message: `Test alert sent to ${delivered.join(', ')}` } });
}

async function handleListWebhookAlerts(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string
): Promise<void> {
  const snap = await firestore.collection(WEBHOOKS_COLLECTION).where('userId', '==', userId).get();
  const data = snap.docs.map((doc) => {
    const w = doc.data() as WebhookSettings;
    return {
      id: doc.id,
      name: w.name,
      url: redactWebhookUrl(w.url),
      webhookType: w.webhookType || 'generic',
      events: w.events || [],
      enabled: !!w.enabled,
      createdAt: (w as unknown as { createdAt?: number }).createdAt ?? null,
    };
  });
  res.json({ data });
}

/**
 * Never echo a full webhook URL back over the API — Slack/Discord URLs are
 * bearer credentials, and a checks:read-level leak shouldn't hand them out.
 */
function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return '…';
  }
}

const VALID_WEBHOOK_TYPES = ['slack', 'discord', 'teams', 'pumble', 'pagerduty', 'opsgenie', 'pushover', 'generic'];

async function handleCreateWebhookAlert(
  req: Parameters<Parameters<typeof onRequest>[0]>[0],
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string
): Promise<void> {
  const body = req.body || {};
  const { url, name, events, webhookType, secret } = body;

  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: 'Invalid webhook URL' });
    return;
  }
  if (parsedUrl.protocol !== 'https:') {
    res.status(400).json({ error: 'Webhook URL must use https' });
    return;
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    res.status(400).json({ error: 'name is required (max 100 characters)' });
    return;
  }
  if (webhookType !== undefined && (typeof webhookType !== 'string' || !VALID_WEBHOOK_TYPES.includes(webhookType))) {
    res.status(400).json({ error: `webhookType must be one of: ${VALID_WEBHOOK_TYPES.join(', ')}` });
    return;
  }

  const normalizedEvents = normalizeEventList(Array.isArray(events) && events.length > 0 ? events : ['website_down', 'website_up']);
  if (normalizedEvents.length === 0) {
    res.status(400).json({ error: 'At least one valid event is required' });
    return;
  }

  const userTier = await getUserTier(userId);
  const maxWebhooks = CONFIG.getMaxWebhooksForTier(userTier);

  const existing = await firestore.collection(WEBHOOKS_COLLECTION).where('userId', '==', userId).get();
  if (existing.size >= maxWebhooks) {
    res.status(409).json({ error: `You have reached the maximum of ${maxWebhooks} webhook${maxWebhooks === 1 ? '' : 's'} for your plan.` });
    return;
  }
  if (existing.docs.some((doc) => doc.data().url === url)) {
    res.status(409).json({ error: 'A webhook already exists for this URL' });
    return;
  }

  const now = Date.now();
  const docRef = await firestore.collection(WEBHOOKS_COLLECTION).add({
    url,
    name: name.trim(),
    userId,
    enabled: true,
    events: normalizedEvents,
    checkFilter: { mode: 'all' },
    secret: typeof secret === 'string' && secret ? secret : null,
    headers: {},
    webhookType: webhookType || inferWebhookType(url),
    createdAt: now,
    updatedAt: now,
  });

  await notifySettingsEdit(userId);

  res.status(201).json({
    data: {
      id: docRef.id,
      name: name.trim(),
      url: redactWebhookUrl(url),
      webhookType: webhookType || inferWebhookType(url),
      events: normalizedEvents,
      enabled: true,
    },
  });
}

/** Match the platform detection the callable path and delivery pipeline use. */
function inferWebhookType(url: string): string {
  if (url.includes('hooks.slack.com')) return 'slack';
  if (url.includes('pumble.com')) return 'pumble';
  if (url.includes('discord.com') || url.includes('discordapp.com')) return 'discord';
  if (url.includes('.webhook.office.com') || url.includes('.logic.azure.com')) return 'teams';
  return 'generic';
}

async function handleDeleteWebhookAlert(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  webhookId: string
): Promise<void> {
  if (!isValidDocId(webhookId)) {
    res.status(400).json({ error: 'Invalid webhook ID format' });
    return;
  }
  const ref = firestore.collection(WEBHOOKS_COLLECTION).doc(webhookId);
  const doc = await ref.get();
  if (!doc.exists) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  if ((doc.data() as WebhookSettings).userId !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  await ref.delete();
  await notifySettingsEdit(userId);
  res.json({ data: { id: webhookId, deleted: true } });
}

async function handleTestWebhookAlert(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  webhookId: string
): Promise<void> {
  if (!isValidDocId(webhookId)) {
    res.status(400).json({ error: 'Invalid webhook ID format' });
    return;
  }
  const doc = await firestore.collection(WEBHOOKS_COLLECTION).doc(webhookId).get();
  if (!doc.exists) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  const webhook = doc.data() as WebhookSettings;
  if (webhook.userId !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const result = await deliverWebhookTest(webhook, webhookId, userId);
  if (!result.success) {
    res.status(502).json({ error: result.message });
    return;
  }
  res.json({ data: { message: result.message, status: result.status ?? null } });
}

async function deliverWebhookTest(
  webhook: WebhookSettings,
  webhookId: string,
  userId: string
): Promise<{ success: boolean; message: string; status?: number }> {
  const type = webhook.webhookType || inferWebhookType(webhook.url);

  // Pushover, PagerDuty and Opsgenie need bespoke envelopes; the public API keeps
  // to the formats it can build without the incident-specific helpers, and tells
  // the caller to use the dashboard for the rest.
  if (type === 'pushover' || type === 'pagerduty' || type === 'opsgenie') {
    return {
      success: false,
      message: `Test delivery for ${type} integrations is only available from the dashboard (https://app.exit1.dev/integrations).`,
    };
  }

  let payload: object;
  if (type === 'slack' || type === 'pumble') {
    payload = { text: '🔔 Exit1 test alert — your integration is working. Real alerts will arrive here.' };
  } else if (type === 'discord') {
    payload = { content: '🔔 **Exit1 test alert** — your integration is working. Real alerts will arrive here.' };
  } else if (type === 'teams') {
    payload = {
      type: 'message',
      summary: 'Exit1 test alert',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body: [
            { type: 'TextBlock', text: '✅ Exit1 test alert', weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: 'Your integration is working. Real alerts will arrive here.', wrap: true },
          ],
        },
      }],
    };
  } else {
    // Keep in lockstep with the real uptime payload in alert-webhook.ts and with
    // the testWebhook callable in webhooks.ts. The error field is `error`, NOT
    // `lastError` — integrators code against whatever the test sends.
    payload = {
      event: 'website_down',
      summary: '🚨 Test Website is DOWN',
      timestamp: Date.now(),
      website: {
        id: 'test-website-id',
        name: 'Test Website',
        url: 'https://example.com',
        type: 'website',
        status: 'offline',
        responseTime: 1500,
        responseTimeLimit: 5000,
        responseTimeExceeded: false,
        lastStatusCode: 503,
        statusCodeInfo: 'HTTP 503',
        error: 'Connection timeout',
        targetIp: '93.184.216.34',
      },
      previousStatus: 'online',
      userId,
      test: true,
    };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Exit1-Website-Monitor/1.0 (Test)',
    ...(webhook.headers || {}),
  };

  if (webhook.secret) {
    const { createHmac } = await import('crypto');
    headers['X-Exit1-Signature'] = `sha256=${createHmac('sha256', webhook.secret).update(JSON.stringify(payload)).digest('hex')}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return {
      success: response.ok,
      status: response.status,
      message: response.ok
        ? 'Test alert delivered'
        : `Webhook responded HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Public API webhook test failed', { userId, webhookId, error: message });
    return { success: false, message: `Failed to reach the webhook: ${message}` };
  }
}

/**
 * Account snapshot. Exists so an agent can plan inside the user's plan instead of
 * discovering limits by hitting 409s halfway through onboarding.
 */
async function handleGetAccount(
  res: Parameters<Parameters<typeof onRequest>[0]>[1],
  userId: string,
  scopes: string[]
): Promise<void> {
  const [tier, stats, webhookSnap, emailSnap] = await Promise.all([
    getUserTier(userId),
    getUserCheckStats(userId),
    firestore.collection(WEBHOOKS_COLLECTION).where('userId', '==', userId).count().get(),
    firestore.collection(ALERT_EMAIL_COLLECTION).doc(userId).get(),
  ]);

  const tierLimits = TIER_LIMITS[tier];
  const emailSettings = emailSnap.exists ? (emailSnap.data() as EmailSettings) : null;
  // Report the effective cap for THIS user, not a hardcoded tier number — this
  // endpoint is what the MCP server and agents plan against, so an inaccurate
  // figure makes them either stop short or plan past a limit they'll hit.
  const maxChecks = await getMaxChecksForUser(userId, tier);

  res.json({
    data: {
      tier,
      scopes,
      limits: {
        maxChecks,
        minCheckIntervalMinutes: tierLimits.minCheckIntervalMinutes,
        maxWebhooks: CONFIG.getMaxWebhooksForTier(tier),
        maxApiKeys: CONFIG.getMaxApiKeysForTier(tier),
        regionChoice: !!tierLimits.regionChoice,
        domainIntel: !!tierLimits.domainIntel,
      },
      usage: {
        checks: stats?.checkCount ?? 0,
        webhooks: webhookSnap.data().count,
      },
      alerts: {
        emailConfigured: !!emailSettings && getConfiguredEmailRecipients(emailSettings).length > 0,
        emailEnabled: !!emailSettings?.enabled,
        webhookCount: webhookSnap.data().count,
      },
      dashboardUrl: 'https://app.exit1.dev/checks',
      // Agent-onboarded users never see the pricing page, so a free account
      // hits its cap and 5-minute interval floor with no signal that a faster
      // plan exists. Give the agent something concrete to hand off with.
      upgradeUrl: tier === 'free' ? 'https://app.exit1.dev/billing' : null,
    },
  });
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
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization, Idempotency-Key');
  res.set('Access-Control-Expose-Headers', 'RateLimit, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, WWW-Authenticate');
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

    // Two credential types resolve to the same principal shape: long-lived API
    // keys (X-Api-Key) and OAuth access tokens minted for MCP clients (Bearer).
    // Everything downstream sees only { userId, scopes, principalId }.
    const apiKey = (req.header('x-api-key') || req.header('X-Api-Key') || '').trim();
    const authHeader = (req.header('authorization') || req.header('Authorization') || '').trim();
    const bearerToken = /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';

    if (!apiKey && !bearerToken) {
      res.set('WWW-Authenticate', buildWwwAuthenticate());
      res.status(401).json({ error: 'Missing credentials. Send X-Api-Key or an OAuth Bearer token.' });
      return;
    }

    let principalId: string;
    let userId: string;
    let keyScopes: string[];
    let isAgentSession = false;

    if (bearerToken) {
      const resolved = await resolveBearerToken(bearerToken);
      if (!resolved) {
        res.set('WWW-Authenticate', buildWwwAuthenticate('The access token is invalid or expired'));
        res.status(401).json({ error: 'Invalid or expired access token' });
        return;
      }
      principalId = resolved.tokenDocId;
      userId = resolved.userId;
      keyScopes = resolved.scopes;
      isAgentSession = true;
    } else {
      const hash = await hashApiKey(apiKey);
      let keyEnabled: boolean;

      const cachedKey = getCachedApiKey(hash);
      if (cachedKey) {
        principalId = cachedKey.keyDocId;
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
        principalId = keyDoc.id;
        userId = key.userId;
        keyEnabled = key.enabled;
        keyScopes = key.scopes || [];

        setCachedApiKey(hash, principalId, userId, keyEnabled, keyScopes);
      }

      if (!keyEnabled) {
        res.status(401).json({ error: 'API key disabled' });
        return;
      }
    }

    const keyDocId = principalId;
    const limits: RateLimitProfile = isAgentSession ? AGENT_RATE_LIMITS : RATE_LIMITS;
    const writeLimits: WriteRateLimitProfile = isAgentSession ? AGENT_WRITE_RATE_LIMITS : WRITE_RATE_LIMITS;

    // Daily quota checks
    const dailyKeyQuota = dailyQuotaLimiter.consume(`daily:key:${keyDocId}`, limits.perKeyDaily);
    if (!dailyKeyQuota.allowed) {
      applyRateLimitHeaders(res, dailyKeyQuota);
      res.status(429).json({
        error: `Daily quota exceeded for this credential. Limit: ${limits.perKeyDaily} requests/day. Resets at midnight UTC.`,
        quotaLimit: limits.perKeyDaily,
        quotaReset: dailyKeyQuota.resetAtMs
      });
      logger.warn(`Credential ${keyDocId} exceeded daily quota (${limits.perKeyDaily} req/day)`);
      return;
    }

    const dailyUserQuota = dailyQuotaLimiter.consume(`daily:user:${userId}`, limits.perUserDaily);
    if (!dailyUserQuota.allowed) {
      applyRateLimitHeaders(res, dailyUserQuota);
      res.status(429).json({
        error: `Daily user quota exceeded. Limit: ${limits.perUserDaily} requests/day across all credentials. Resets at midnight UTC.`,
        quotaLimit: limits.perUserDaily,
        quotaReset: dailyUserQuota.resetAtMs
      });
      logger.warn(`User ${userId} exceeded daily quota (${limits.perUserDaily} req/day)`);
      return;
    }

    const reqPath = (req.path || req.url || '').replace(/\/+$/, '');
    const segments = reqPath.split('?')[0].split('/').filter(Boolean);

    // Post-auth rate limits
    const globalKeyDecision = apiKeyLimiter.consume(`key:${keyDocId}:total`, limits.perKeyTotalPerMinute);
    if (!globalKeyDecision.allowed) {
      applyRateLimitHeaders(res, globalKeyDecision);
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    const routeName = getRouteName(segments, req.method);
    const endpointDecision = apiKeyLimiter.consume(`key:${keyDocId}:route:${routeName}`, limits.perEndpointPerMinute);
    applyRateLimitHeaders(res, endpointDecision);
    if (!endpointDecision.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }

    // Track usage (best-effort). Only API keys live in the apiKeys collection —
    // an OAuth principal id is a token doc, so writing there would 404-loop.
    const usageNow = Date.now();
    if (shouldWriteApiKeyUsage(keyDocId, usageNow)) {
      const usageCollection = isAgentSession ? MCP_TOKENS_COLLECTION : API_KEYS_COLLECTION;
      const usagePayload = isAgentSession
        ? { lastUsedAt: usageNow }
        : { lastUsedAt: usageNow, lastUsedPath: reqPath };
      firestore.collection(usageCollection).doc(keyDocId).update(usagePayload).catch(() => {});
    }

    // --- Scope enforcement ---
    const requiredScope = getRequiredScope(req.method, routeName);
    if (!hasScope(keyScopes, requiredScope)) {
      if (isAgentSession) {
        res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${requiredScope}"`);
      }
      res.status(403).json({ error: `Credential does not have the required scope: ${requiredScope}` });
      return;
    }

    // --- Method validation ---
    const isWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Write rate limits (layered on top of general limits)
    if (isWrite && !enforceWriteRateLimit(res, keyDocId, userId, writeLimits)) {
      return;
    }

    // ============== ALERT CHANNEL ROUTES ==============

    const isAlertRoute = segments.length >= 4 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'alerts';
    if (isAlertRoute) {
      // PATCH /v1/public/alerts/email
      if (req.method === 'PATCH' && segments.length === 4 && segments[3] === 'email') {
        await handleUpdateEmailAlerts(req, res, userId);
        return;
      }
      // POST /v1/public/alerts/email/test
      if (req.method === 'POST' && segments.length === 5 && segments[3] === 'email' && segments[4] === 'test') {
        await handleTestEmailAlert(res, userId);
        return;
      }
      // GET /v1/public/alerts/email
      if (req.method === 'GET' && segments.length === 4 && segments[3] === 'email') {
        await handleGetEmailAlerts(res, userId);
        return;
      }
      // POST /v1/public/alerts/webhooks
      if (req.method === 'POST' && segments.length === 4 && segments[3] === 'webhooks') {
        await handleCreateWebhookAlert(req, res, userId);
        return;
      }
      // GET /v1/public/alerts/webhooks
      if (req.method === 'GET' && segments.length === 4 && segments[3] === 'webhooks') {
        await handleListWebhookAlerts(res, userId);
        return;
      }
      // POST /v1/public/alerts/webhooks/:id/test
      if (req.method === 'POST' && segments.length === 6 && segments[3] === 'webhooks' && segments[5] === 'test') {
        await handleTestWebhookAlert(res, userId, segments[4]);
        return;
      }
      // DELETE /v1/public/alerts/webhooks/:id
      if (req.method === 'DELETE' && segments.length === 5 && segments[3] === 'webhooks') {
        await handleDeleteWebhookAlert(res, userId, segments[4]);
        return;
      }

      res.status(404).json({ error: `No alerts endpoint matches ${req.method} ${reqPath}` });
      return;
    }

    // GET /v1/public/account
    if (req.method === 'GET' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'account') {
      await handleGetAccount(res, userId, keyScopes.length > 0 ? keyScopes : [API_SCOPES.CHECKS_READ]);
      return;
    }

    // ============== WRITE ROUTES ==============

    // POST /v1/public/checks - Create check
    if (req.method === 'POST' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      await handleCreateCheck(req, res, userId, keyDocId, reqPath, isAgentSession);
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
