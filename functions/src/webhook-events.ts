import { WebhookEvent } from './types';

const KNOWN_EVENTS: readonly WebhookEvent[] = [
  'website_down',
  'website_up',
  'website_error',
  'ssl_error',
  'ssl_warning',
] as const;

const FALLBACK_MAP: Record<string, WebhookEvent> = {
  down: 'website_down',
  outage: 'website_down',
  offline: 'website_down',
  websitedown: 'website_down',
  site_down: 'website_down',
  up: 'website_up',
  recovery: 'website_up',
  online: 'website_up',
  websiteup: 'website_up',
  site_up: 'website_up',
  error: 'website_error',
  issue: 'website_error',
  problem: 'website_error',
  websiteerror: 'website_error',
  sslerror: 'ssl_error',
  certificateerror: 'ssl_error',
  certerror: 'ssl_error',
  sslexpired: 'ssl_error',
  sslwarning: 'ssl_warning',
  certificatewarning: 'ssl_warning',
  certwarning: 'ssl_warning',
  sslexpiring: 'ssl_warning',
};

const normalizeKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '') // drop separators for legacy labels like "Website Down"
    .replace(/[^a-z0-9]/g, '');

/**
 * Normalize a single webhook event value to the canonical enum used by the system.
 * Returns null if the value can't be mapped to a known event.
 */
export function normalizeEventValue(value?: string | null): WebhookEvent | null {
  if (!value) return null;

  // Already a canonical value
  if ((KNOWN_EVENTS as readonly string[]).includes(value as WebhookEvent)) {
    return value as WebhookEvent;
  }

  const key = normalizeKey(value);
  if (!key) return null;

  if (FALLBACK_MAP[key]) {
    return FALLBACK_MAP[key];
  }

  return null;
}

/**
 * Normalize an arbitrary array of event strings into canonical enum values.
 */
export function normalizeEventList(events: unknown): WebhookEvent[] {
  if (!Array.isArray(events)) {
    return [];
  }

  const deduped = new Set<WebhookEvent>();
  for (const raw of events) {
    if (typeof raw !== 'string') continue;
    const normalized = normalizeEventValue(raw);
    if (normalized) {
      deduped.add(normalized);
    }
  }

  return Array.from(deduped);
}

