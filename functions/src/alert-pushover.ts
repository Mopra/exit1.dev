// Helpers for the Pushover Messages API (https://pushover.net/api).
// Pushover is API-based (not user-hosted webhook-based), so we encode the
// user's app token + user/group key + per-message defaults as query params on
// the stored `url` field — same convention PagerDuty uses for routing_key.
// This keeps the WebhookSettings shape unchanged.

import { CheckSeverity, WebhookEvent } from './types';

export const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

// Pushover priority scale:
//   -2 lowest    — no notification, badge increments only
//   -1 low       — quiet (no sound/vibration)
//    0 normal    — default per device settings
//    1 high      — bypasses quiet hours, always alerts
//    2 emergency — repeated until acked; requires retry + expire params.
export type PushoverPriority = -2 | -1 | 0 | 1 | 2;

// Pushover emergency-priority bounds (from the API docs).
export const PUSHOVER_EMERGENCY_RETRY_MIN_SEC = 30;
export const PUSHOVER_EMERGENCY_EXPIRE_MAX_SEC = 10800; // 3 hours

// Built-in Pushover sounds (https://pushover.net/api#sounds). Users can
// upload custom sounds per account; we allow free-text fall-through.
export const PUSHOVER_SOUNDS = [
  'pushover', 'bike', 'bugle', 'cashregister', 'classical', 'cosmic',
  'falling', 'gamelan', 'incoming', 'intermission', 'magic', 'mechanical',
  'pianobar', 'siren', 'spacealarm', 'tugboat', 'alien', 'climb',
  'persistent', 'echo', 'updown', 'vibrate', 'none',
] as const;

export interface PushoverCredentials {
  token: string;
  user: string;
  device?: string;
  priority?: PushoverPriority;
  sound?: string;
  // Emergency-only: seconds between retries (min 30). Required if priority=2.
  retry?: number;
  // Emergency-only: seconds before Pushover stops retrying (max 10800).
  // Required if priority=2.
  expire?: number;
  // Auto-delete after this many seconds. Pushover rejects ttl with priority=2.
  ttl?: number;
}

const isPushoverPriority = (n: number): n is PushoverPriority =>
  n === -2 || n === -1 || n === 0 || n === 1 || n === 2;

// Parse a positive integer query param, returning undefined when missing,
// malformed, or non-positive. Used for retry/expire/ttl which all need
// positive integers per the Pushover API.
function parsePositiveIntParam(u: URL, name: string): number | undefined {
  const raw = u.searchParams.get(name);
  if (raw === null) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

// Pull the credentials the user encoded into the webhook URL
// (e.g. https://api.pushover.net/1/messages.json?token=abc&user=xyz&priority=1).
export function extractPushoverCredentials(url: string): PushoverCredentials | null {
  try {
    const u = new URL(url);
    const token = (u.searchParams.get('token') || '').trim();
    const user = (u.searchParams.get('user') || '').trim();
    if (!token || !user) return null;

    const device = (u.searchParams.get('device') || '').trim() || undefined;
    const sound = (u.searchParams.get('sound') || '').trim() || undefined;
    let priority: PushoverPriority | undefined;
    const rawPriority = u.searchParams.get('priority');
    if (rawPriority !== null) {
      const n = parseInt(rawPriority, 10);
      if (Number.isFinite(n) && isPushoverPriority(n)) priority = n;
    }
    const retry = parsePositiveIntParam(u, 'retry');
    const expire = parsePositiveIntParam(u, 'expire');
    const ttl = parsePositiveIntParam(u, 'ttl');
    return { token, user, device, priority, sound, retry, expire, ttl };
  } catch {
    return null;
  }
}

// Build the canonical Pushover URL we store for a webhook. Used by both the
// frontend (when constructing on form submit, via duplicated logic) and the
// backend (for safe normalization on save if we ever add it).
export function buildPushoverUrl(creds: PushoverCredentials): string {
  const u = new URL(PUSHOVER_API_URL);
  u.searchParams.set('token', creds.token);
  u.searchParams.set('user', creds.user);
  if (creds.device) u.searchParams.set('device', creds.device);
  if (creds.priority !== undefined) u.searchParams.set('priority', String(creds.priority));
  if (creds.sound) u.searchParams.set('sound', creds.sound);
  if (creds.retry !== undefined) u.searchParams.set('retry', String(creds.retry));
  if (creds.expire !== undefined) u.searchParams.set('expire', String(creds.expire));
  if (creds.ttl !== undefined) u.searchParams.set('ttl', String(creds.ttl));
  return u.toString();
}

// Map exit1 event types to Pushover priority.
//
// When the check has an explicit severity (P1–P5, INCLUDING an explicit P3),
// it maps one-to-one onto Pushover's scale for critical events:
//   P1 → Emergency (2), P2 → High (1), P3 → Normal (0), P4 → Low (-1),
//   P5 → Lowest (-2).
// This is what lets a user mark their VPS as "page me until I ack" (P1) and a
// dev site as "don't wake me" (P4/P5) on a single integration. The mapped
// level is a HARD CAP for every alert the check emits — a P3 check never
// sends anything above Normal (no quiet-hours bypass), including SSL/domain
// expiry and DNS events. Non-critical events (recoveries, warnings) are
// additionally capped at High: a recovery at Emergency would page the user
// until acked for a site that's back up.
//
// Severity unset (null/undefined — the "use default priority" state) keeps
// the legacy default-based mapping:
// - Critical events (outages, errors, expired) are always sent at least at
//   High so users who never made an explicit choice don't sleep through
//   them — uptime tools are useless otherwise. They use the user's default
//   if it's already High or Emergency.
// - Non-critical events follow the user's default, capped at High.
export function mapEventToPushoverPriority(
  event: WebhookEvent,
  defaultPriority: PushoverPriority,
  severity?: CheckSeverity | null,
): PushoverPriority {
  const isCritical =
    event === 'website_down' ||
    event === 'website_error' ||
    event === 'ssl_error' ||
    event === 'domain_expired' ||
    event === 'dns_record_missing' ||
    event === 'dns_resolution_failed';
  if (severity != null) {
    const base = (3 - severity) as PushoverPriority;
    return isCritical ? base : (Math.min(base, 1) as PushoverPriority);
  }
  if (isCritical) {
    return defaultPriority < 1 ? 1 : defaultPriority;
  }
  return defaultPriority > 1 ? 1 : defaultPriority;
}

// Pushover caps title at 250 chars and message body at 1024 chars (UTF-8).
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

export interface PushoverMessageOpts {
  credentials: PushoverCredentials;
  title: string;
  message: string;
  priority: PushoverPriority;
  url?: string;
  urlTitle?: string;
  // Unix timestamp in SECONDS (Pushover expects seconds, not milliseconds).
  timestampSec?: number;
}

// Build the form-encoded body Pushover expects. Returns a URLSearchParams
// instance — pass `.toString()` as the fetch body with
// Content-Type: application/x-www-form-urlencoded.
export function buildPushoverFormBody(opts: PushoverMessageOpts): URLSearchParams {
  const params = new URLSearchParams();
  params.set('token', opts.credentials.token);
  params.set('user', opts.credentials.user);
  params.set('title', truncate(opts.title, 250));
  params.set('message', truncate(opts.message, 1024));
  params.set('priority', String(opts.priority));
  if (opts.credentials.device) params.set('device', opts.credentials.device);
  if (opts.credentials.sound) params.set('sound', opts.credentials.sound);
  if (opts.url) params.set('url', truncate(opts.url, 512));
  if (opts.urlTitle) params.set('url_title', truncate(opts.urlTitle, 100));
  if (opts.timestampSec) params.set('timestamp', String(opts.timestampSec));

  if (opts.priority === 2) {
    // Pushover requires retry + expire for emergency messages and rejects the
    // request without them. Fall back to safe defaults (retry every 60s for
    // up to an hour) if the user didn't configure them.
    const retry = Math.max(
      PUSHOVER_EMERGENCY_RETRY_MIN_SEC,
      opts.credentials.retry ?? 60,
    );
    const expireRaw = opts.credentials.expire ?? 3600;
    const expire = Math.max(
      PUSHOVER_EMERGENCY_RETRY_MIN_SEC,
      Math.min(PUSHOVER_EMERGENCY_EXPIRE_MAX_SEC, expireRaw),
    );
    params.set('retry', String(retry));
    params.set('expire', String(expire));
    // Pushover rejects requests that combine priority=2 with ttl — skip ttl here.
  } else if (opts.credentials.ttl !== undefined && opts.credentials.ttl > 0) {
    params.set('ttl', String(opts.credentials.ttl));
  }

  return params;
}
