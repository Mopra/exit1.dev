// Helpers for the Pushover Messages API (https://pushover.net/api).
// Pushover is API-based (not user-hosted webhook-based), so we encode the
// user's app token + user/group key + per-message defaults as query params on
// the stored `url` field — same convention PagerDuty uses for routing_key.
// This keeps the WebhookSettings shape unchanged.

import { WebhookEvent } from './types';

export const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

// Pushover priority scale:
//   -2 lowest    — no notification, badge increments only
//   -1 low       — quiet (no sound/vibration)
//    0 normal    — default per device settings
//    1 high      — bypasses quiet hours, always alerts
//    2 emergency — repeated until acked; requires retry/expire/callback.
// We omit priority 2 from the UI because it requires additional fields and
// receipt-tracking infra that doesn't fit the simple form flow.
export type PushoverPriority = -2 | -1 | 0 | 1;

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
}

const isPushoverPriority = (n: number): n is PushoverPriority =>
  n === -2 || n === -1 || n === 0 || n === 1;

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
    return { token, user, device, priority, sound };
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
  return u.toString();
}

// Map exit1 event types to Pushover priority. Critical events bump to high
// priority (1) so they bypass quiet hours, regardless of the user's chosen
// default — uptime tools are useless if you sleep through outages. Warnings
// and recoveries stay at the user's chosen baseline.
export function mapEventToPushoverPriority(
  event: WebhookEvent,
  defaultPriority: PushoverPriority,
): PushoverPriority {
  const isCritical =
    event === 'website_down' ||
    event === 'website_error' ||
    event === 'ssl_error' ||
    event === 'domain_expired' ||
    event === 'dns_record_missing' ||
    event === 'dns_resolution_failed';
  if (isCritical && defaultPriority < 1) {
    return 1;
  }
  return defaultPriority;
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
  return params;
}
