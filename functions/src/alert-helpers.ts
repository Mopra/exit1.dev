import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Website, WebhookSettings, WebhookEvent, EmailSettings, SmsSettings } from './types';
import { Resend } from 'resend';
import { CONFIG } from './config';
import { getResendCredentials } from './env';
import { firestore } from './init';

// ============================================================================
// DATE FORMATTING
// ============================================================================

/**
 * Format a date in the check's configured timezone (IANA identifier).
 * When a non-UTC timezone is set, shows both local and UTC times:
 *   "Feb 6, 2026, 03:45:12 PM EST (20:45:12 UTC)"
 * Falls back to UTC-only when no timezone is set or the identifier is invalid.
 */
export function formatDateForCheck(date: Date, timezone?: string | null): string {
  const utcStr = date.toLocaleString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });

  if (!timezone) return utcStr;

  try {
    const localStr = date.toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
    // Compact UTC time-only for the parenthetical
    const utcTime = date.toLocaleTimeString('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    return `${localStr} (${utcTime} UTC)`;
  } catch {
    return utcStr;
  }
}

/**
 * Format a date (date-only, no time) in the check's configured timezone.
 */
export function formatDateOnlyForCheck(timestamp: number | undefined, timezone?: string | null): string {
  if (!timestamp) return 'Unknown';
  try {
    return new Date(timestamp).toLocaleDateString('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return new Date(timestamp).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

// Interface for cached settings to reduce Firestore reads
export interface AlertSettingsCache {
  email?: EmailSettings | null;
  sms?: SmsSettings | null;
  webhooks?: WebhookSettings[];
}

// Context for the alert run to share cache, throttle, and budget state
export interface AlertContext {
  settings?: AlertSettingsCache;
  throttleCache?: Set<string>;
  budgetCache?: Map<string, number>;
  emailMonthlyBudgetCache?: Map<string, number>;
  smsThrottleCache?: Set<string>;
  smsBudgetCache?: Map<string, number>;
  smsMonthlyBudgetCache?: Map<string, number>;
}

export type AlertResult = {
  delivered: boolean;
  reason?: 'flap' | 'settings' | 'missingRecipient' | 'throttle' | 'none' | 'error' | 'maintenance_mode' | 'system_health_gate';
  emailNeedsRetry?: boolean;
  smsNeedsRetry?: boolean;
};

export type SSLCertificateData = {
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  error?: string;
};

export interface DeliveryFailureMeta {
  failures: number;
  nextRetryAt: number;
  firstFailureAt: number;
  lastErrorCode?: number | string;
  lastErrorMessage?: string;
}

export type DeliveryState = 'ready' | 'skipped' | 'dropped';

export type WebhookRetryChannel = 'status' | 'ssl';

export interface WebhookAttemptContext {
  website: Website;
  eventType: WebhookEvent;
  channel: WebhookRetryChannel;
  previousStatus?: string;
  sslCertificate?: SSLCertificateData;
  deliveryId: string;
}

export type SerializedWebsite = Pick<Website, 'id' | 'userId' | 'name' | 'url' | 'status' | 'responseTime' | 'detailedStatus' | 'lastStatusCode'>;

export type WebhookSendFn = (webhook: WebhookSettings) => Promise<void>;
export type WebhookDispatchContext = Omit<WebhookAttemptContext, 'deliveryId'>;
export type EmailSendFn = () => Promise<void>;
export type SmsSendFn = () => Promise<void>;

// ============================================================================
// CONSTANTS
// ============================================================================

export const MAX_PARALLEL_NOTIFICATIONS = 20;
export const WEBHOOK_BATCH_DELAY_MS = 100;
export const PER_URL_SEND_DELAY_MS = 300;
export const ALERT_BACKOFF_INITIAL_MS = 5_000;
export const ALERT_BACKOFF_MAX_MS = 5 * 60 * 1000;
export const ALERT_BACKOFF_MAX_RATE_LIMIT_MS = 30 * 60 * 1000; // 30 min for 429 errors
export const ALERT_BACKOFF_JITTER_RATIO = 0.2; // +/- 20% jitter
export const ALERT_FAILURE_TIMEOUT_MS = 30 * 60 * 1000;
export const ALERT_MAX_FAILURES_BEFORE_DROP = 10;
export const WEBHOOK_RETRY_BATCH_SIZE = CONFIG.WEBHOOK_RETRY_BATCH_SIZE || 25;
export const WEBHOOK_RETRY_MAX_ATTEMPTS = CONFIG.WEBHOOK_RETRY_MAX_ATTEMPTS || 8;
export const WEBHOOK_CIRCUIT_BREAKER_THRESHOLD = CONFIG.WEBHOOK_CIRCUIT_BREAKER_THRESHOLD ?? 3;
// OPTIMIZATION: Reduced from 48 hours to 24 hours - most webhook failures are permanent
// (endpoint removed, auth changed), so reducing TTL saves memory and CPU for stale retries
export const WEBHOOK_RETRY_TTL_MS = CONFIG.WEBHOOK_RETRY_TTL_MS || (24 * 60 * 60 * 1000);
export const WEBHOOK_RETRY_DRAIN_INTERVAL_MS = CONFIG.WEBHOOK_RETRY_DRAIN_INTERVAL_MS || (30 * 1000);
export const LOG_SAMPLE_RATE = 0.05;
export const CACHE_PRUNE_INTERVAL_MS = 60_000;
export const ADMIN_STATUS_CACHE_TTL_MS = 60 * 60 * 1000;
export const ALERT_SETTINGS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes - match scheduler interval so disabled webhooks take effect quickly
// OPTIMIZATION: Reduced from 5000 to 3000 entries for ~40% memory reduction
// This still covers typical active user counts with headroom
export const ALERT_SETTINGS_CACHE_MAX = 3000;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const emitAlertMetric = (name: string, data: Record<string, unknown>) => {
  logger.debug('alert_metric', { name, ...data });
};

export const sampledInfo = (message: string, meta?: Record<string, unknown>) => {
  if (Math.random() < LOG_SAMPLE_RATE) {
    if (meta) {
      logger.info(message, meta);
    } else {
      logger.info(message);
    }
  } else {
    if (meta) {
      logger.debug(message, meta);
    } else {
      logger.debug(message);
    }
  }
};

export const getResendClient = () => {
  const { apiKey, fromAddress } = getResendCredentials();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  return {
    resend: new Resend(apiKey),
    fromAddress,
  };
};

/** Human-readable label for a status code (handles special sentinel values). */
export const formatStatusCode = (code: number | undefined): string | null => {
  if (code === undefined || code === null) return null;
  if (code === -1) return 'Timeout';
  if (code === 0) return 'Connection Error';
  if (code === 101) return 'WS Connected';
  return `HTTP ${code}`;
};

// ============================================================================
// RECIPIENT HELPERS
// ============================================================================

// Helper to get email recipients array from settings (supports both old and new format)
export function getEmailRecipients(settings: EmailSettings): string[] {
  if (settings.recipients && settings.recipients.length > 0) {
    return settings.recipients;
  }
  if (settings.recipient) {
    return [settings.recipient];
  }
  return [];
}

// Helper to get SMS recipients array from settings (supports both old and new format)
export function getSmsRecipients(settings: SmsSettings): string[] {
  if (settings.recipients && settings.recipients.length > 0) {
    return settings.recipients;
  }
  if (settings.recipient) {
    return [settings.recipient];
  }
  return [];
}

// Helper to resolve per-folder settings for a check (finds matching folder entry)
export function resolvePerFolder(
  settings: { perFolder?: Record<string, { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] }> },
  checkFolder?: string | null
): { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] } | undefined {
  if (!checkFolder || !settings.perFolder) return undefined;
  // Exact folder match first, then parent folder match
  const exact = settings.perFolder[checkFolder];
  if (exact) return exact;
  // Check parent folders (e.g. "Production/APIs" matches "Production")
  const parts = checkFolder.split('/');
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join('/');
    const entry = settings.perFolder[parent];
    if (entry) return entry;
  }
  return undefined;
}

// Helper to get email recipients for a specific check (global + per-check + per-folder combined, deduplicated)
export function getEmailRecipientsForCheck(settings: EmailSettings, checkId: string, checkFolder?: string | null): string[] {
  const globalRecipients = getEmailRecipients(settings);
  const perCheck = settings.perCheck?.[checkId];
  const perCheckRecipients = perCheck?.recipients || [];
  const perFolder = resolvePerFolder(settings, checkFolder);
  const perFolderRecipients = perFolder?.recipients || [];

  // Combine global + per-folder + per-check recipients and deduplicate (case-insensitive)
  const allRecipients = [...globalRecipients, ...perFolderRecipients, ...perCheckRecipients];
  const seen = new Set<string>();
  const deduplicated: string[] = [];

  for (const email of allRecipients) {
    const lower = email.toLowerCase().trim();
    if (lower && !seen.has(lower)) {
      seen.add(lower);
      deduplicated.push(email.trim());
    }
  }

  return deduplicated;
}

// ============================================================================
// ADMIN & TIER RESOLUTION
// ============================================================================

const adminStatusCache = new Map<string, { value: boolean; expiresAt: number }>();

export const getCachedAdminStatus = async (userId: string): Promise<boolean> => {
  const now = Date.now();
  const cached = adminStatusCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const snap = await firestore.collection('users').doc(userId).get();
    const data = snap.exists ? (snap.data() as { admin?: boolean }) : undefined;
    const isAdmin = data?.admin === true;
    adminStatusCache.set(userId, { value: isAdmin, expiresAt: now + ADMIN_STATUS_CACHE_TTL_MS });
    return isAdmin;
  } catch (error) {
    logger.warn(`Failed to read admin status for ${userId}`, error);
    return false;
  }
};

export const resolveSmsTier = async (website: Website): Promise<'nano' | 'free'> => {
  const isPaidTier = website.userTier === 'nano' || (website.userTier as unknown) === 'premium';
  if (isPaidTier) {
    return 'nano';
  }
  const isAdmin = await getCachedAdminStatus(website.userId);
  return isAdmin ? 'nano' : 'free';
};

// ============================================================================
// ALERT SETTINGS CACHE
// ============================================================================

const alertSettingsCache = new Map<string, { value: AlertSettingsCache; expiresAt: number }>();

export const fetchAlertSettingsFromFirestore = async (userId: string): Promise<AlertSettingsCache> => {
  const firestore = getFirestore();
  const [emailDoc, smsDoc, webhooksSnapshot] = await Promise.all([
    firestore.collection('emailSettings').doc(userId).get(),
    firestore.collection('smsSettings').doc(userId).get(),
    firestore.collection('webhooks').where('userId', '==', userId).where('enabled', '==', true).get(),
  ]);

  return {
    email: emailDoc.exists ? (emailDoc.data() as EmailSettings) : null,
    sms: smsDoc.exists ? (smsDoc.data() as SmsSettings) : null,
    webhooks: webhooksSnapshot.docs.map(doc => doc.data() as WebhookSettings),
  };
};

export const getCachedAlertSettings = (userId: string): AlertSettingsCache | null => {
  const cached = alertSettingsCache.get(userId);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    alertSettingsCache.delete(userId);
    return null;
  }
  return cached.value;
};

export const setCachedAlertSettings = (userId: string, settings: AlertSettingsCache): void => {
  alertSettingsCache.set(userId, {
    value: settings,
    expiresAt: Date.now() + ALERT_SETTINGS_CACHE_TTL_MS,
  });

  if (alertSettingsCache.size > ALERT_SETTINGS_CACHE_MAX) {
    alertSettingsCache.clear();
  }
};

export const resolveAlertSettings = async (userId: string, context?: AlertContext): Promise<AlertSettingsCache> => {
  if (context?.settings) {
    return context.settings;
  }

  const cached = getCachedAlertSettings(userId);
  if (cached) {
    if (context) {
      context.settings = cached;
    }
    return cached;
  }

  const settings = await fetchAlertSettingsFromFirestore(userId);
  if (context) {
    context.settings = settings;
  }
  setCachedAlertSettings(userId, settings);
  return settings;
};

// ============================================================================
// WEBHOOK FILTERING
// ============================================================================

import { normalizeEventList } from './webhook-events';

export const filterWebhooksForEvent = (
  webhooks: WebhookSettings[] | undefined,
  eventType: WebhookEvent,
  checkId: string,
  checkFolder?: string | null
) => {
  if (!webhooks?.length) {
    return [];
  }
  return webhooks.filter(webhook => {
    const allowedEvents = new Set(normalizeEventList(webhook.events));
    return allowedEvents.has(eventType) && webhookAppliesToCheck(webhook, checkId, checkFolder);
  });
};

export const webhookAppliesToCheck = (webhook: WebhookSettings, checkId: string, checkFolder?: string | null) => {
  const filter = webhook.checkFilter;
  if (!filter || filter.mode !== 'include') {
    return true;
  }
  // Match by explicit check ID
  if (Array.isArray(filter.checkIds) && filter.checkIds.length > 0 && filter.checkIds.includes(checkId)) {
    return true;
  }
  // Match by folder path (exact match or child folder)
  if (checkFolder && Array.isArray(filter.folderPaths) && filter.folderPaths.length > 0) {
    return filter.folderPaths.some(fp => checkFolder === fp || checkFolder.startsWith(fp + '/'));
  }
  return false;
};

// ============================================================================
// SSL ALERT STATE HELPER
// ============================================================================

// Helper to determine SSL alert state: 'ok' | 'warning' | 'error'
export function getSSLAlertState(sslCertificate: SSLCertificateData | null | undefined): 'ok' | 'warning' | 'error' {
  if (!sslCertificate) return 'ok'; // No SSL data means no alert state
  if (!sslCertificate.valid) return 'error';
  if (sslCertificate.daysUntilExpiry !== undefined && sslCertificate.daysUntilExpiry <= 30) return 'warning';
  return 'ok';
}

// ============================================================================
// DELIVERY BACKOFF & FAILURE TRACKING
// ============================================================================

export const applyJitter = (delay: number): number => {
  const jitter = delay * ALERT_BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(ALERT_BACKOFF_INITIAL_MS, Math.round(delay + jitter));
};

export const calculateDeliveryBackoff = (failures: number, isRateLimited = false): number => {
  if (failures <= 0) return applyJitter(ALERT_BACKOFF_INITIAL_MS);
  const maxBackoff = isRateLimited ? ALERT_BACKOFF_MAX_RATE_LIMIT_MS : ALERT_BACKOFF_MAX_MS;
  const delay = ALERT_BACKOFF_INITIAL_MS * Math.pow(2, failures - 1);
  return applyJitter(Math.min(delay, maxBackoff));
};

export const evaluateDeliveryState = (
  tracker: Map<string, DeliveryFailureMeta>,
  key: string
): DeliveryState => {
  const meta = tracker.get(key);
  if (!meta) {
    return 'ready';
  }

  const now = Date.now();
  const exceededFailures = meta.failures >= ALERT_MAX_FAILURES_BEFORE_DROP;
  const exceededTimeout = now - meta.firstFailureAt >= ALERT_FAILURE_TIMEOUT_MS;

  if (exceededFailures || exceededTimeout) {
    tracker.delete(key);
    logger.error(
      `Dropping alert delivery target ${key} after ${meta.failures} failures (${meta.lastErrorMessage || 'unknown error'})`
    );
    emitAlertMetric('delivery_dropped', { key, failures: meta.failures });
    return 'dropped';
  }

  if (now < meta.nextRetryAt) {
    return 'skipped';
  }

  return 'ready';
};

export const markDeliverySuccess = (
  tracker: Map<string, DeliveryFailureMeta>,
  key: string
) => {
  if (tracker.has(key)) {
    tracker.delete(key);
  }
};

export const recordDeliveryFailure = (
  tracker: Map<string, DeliveryFailureMeta>,
  key: string,
  error: unknown
) => {
  const now = Date.now();
  const previous = tracker.get(key);
  const failures = (previous?.failures ?? 0) + 1;
  const meta: DeliveryFailureMeta = {
    failures,
    nextRetryAt: now + calculateDeliveryBackoff(failures),
    firstFailureAt: previous?.firstFailureAt ?? now,
    lastErrorCode: (error as { code?: number | string })?.code,
    lastErrorMessage: (error as Error)?.message || String(error),
  };
  tracker.set(key, meta);

  if (failures === 1 || failures === 3 || failures === 5 || failures >= ALERT_MAX_FAILURES_BEFORE_DROP) {
    logger.warn(
      `Alert delivery target ${key} failed ${failures} time(s); next retry in ${meta.nextRetryAt - now}ms`,
      { code: meta.lastErrorCode }
    );
  }

  emitAlertMetric('delivery_failure', { key, failures, code: meta.lastErrorCode });
};

// ============================================================================
// TRACKER KEY HELPERS
// ============================================================================

export const getWebhookTrackerKey = (webhook: WebhookSettings) =>
  `webhook:${webhook.userId}:${webhook.id || webhook.url}`;

export const getEmailTrackerKey = (userId: string, checkId: string, eventType: WebhookEvent) =>
  `email:${userId}:${checkId}:${eventType}`;

export const getSmsTrackerKey = (userId: string, checkId: string, eventType: WebhookEvent) =>
  `sms:${userId}:${checkId}:${eventType}`;

export const getGuardKey = (prefix: string, identifier: string) => `${prefix}:${identifier}`;

// ============================================================================
// ERROR CLASSIFICATION HELPERS
// ============================================================================

export const getRetryErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'unknown error');

// Extract HTTP status code from error message (e.g., "HTTP 429: Too Many Requests")
export const extractHttpStatus = (error: unknown): number | null => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(/HTTP (\d{3}):/);
  return match ? parseInt(match[1], 10) : null;
};

// HTTP 4xx errors that should NOT be retried (permanent client errors)
export const isNonRetryableError = (error: unknown): boolean => {
  const status = extractHttpStatus(error);
  if (!status) return false;
  // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 405 Method Not Allowed, 410 Gone
  // Don't include 429 (rate limit) - that's retryable with longer backoff
  return [400, 401, 403, 404, 405, 410].includes(status);
};

// HTTP 429 Too Many Requests - retryable but needs longer backoff
export const isRateLimitError = (error: unknown): boolean => {
  const status = extractHttpStatus(error);
  return status === 429;
};

export const isAlreadyExistsError = (error: unknown): boolean => {
  const err = error as { code?: number | string; status?: string; message?: string };
  const codeString = typeof err.code === 'number' ? String(err.code) : err.code;
  const message = (err.message || err.status || '').toUpperCase();
  return codeString === '6' || codeString === 'ALREADY_EXISTS' || message.includes('ALREADY EXISTS');
};

// ============================================================================
// WEBSITE SERIALIZATION (for retry records)
// ============================================================================

export const serializeWebsiteForRetry = (website: Website): SerializedWebsite => ({
  id: website.id,
  userId: website.userId,
  name: website.name,
  url: website.url,
  status: website.status,
  responseTime: website.responseTime,
  detailedStatus: website.detailedStatus,
  lastStatusCode: website.lastStatusCode,
});

export const hydrateWebsiteFromRetry = (website: SerializedWebsite): Website => ({
  id: website.id,
  userId: website.userId,
  name: website.name,
  url: website.url,
  status: website.status,
  responseTime: website.responseTime,
  detailedStatus: website.detailedStatus,
  lastStatusCode: website.lastStatusCode,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
});

// ============================================================================
// DELIVERY ID GENERATION
// ============================================================================

export const createWebhookDeliveryId = (webhook: WebhookSettings, website: Website, eventType: WebhookEvent): string => {
  return `${webhook.userId}:${website.id}:${eventType}:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

// ============================================================================
// THROTTLE WINDOW HELPERS
// ============================================================================

export function getThrottleWindowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}
