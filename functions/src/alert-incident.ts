// Helpers for incident-management webhook presets (PagerDuty Events API v2, Opsgenie Alert API).
// These targets need shaped payloads, severity/priority mapping, and incident dedup keys
// so down → up / expired → renewed transitions auto-resolve in the upstream tool.

import { WebhookEvent } from './types';

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';
export const OPSGENIE_ALERTS_URL = 'https://api.opsgenie.com/v2/alerts';

export type PagerDutySeverity = 'info' | 'warning' | 'error' | 'critical';
export type PagerDutyAction = 'trigger' | 'resolve' | 'acknowledge';
export type OpsgeniePriority = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

// Pull the routing_key the user encoded into the webhook URL
// (e.g. https://events.pagerduty.com/v2/enqueue?routing_key=abc123).
export function extractPagerDutyRoutingKey(url: string): string | null {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('routing_key');
    return key && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

interface PagerDutyEnvelopeOpts {
  routingKey: string;
  eventAction: PagerDutyAction;
  dedupKey: string;
  summary: string;
  severity: PagerDutySeverity;
  source: string;
  timestamp?: number;
  customDetails?: Record<string, unknown>;
  links?: Array<{ href: string; text: string }>;
}

export function buildPagerDutyEnvelope(opts: PagerDutyEnvelopeOpts): object {
  // resolve / acknowledge only need the dedup_key — payload fields are ignored
  if (opts.eventAction !== 'trigger') {
    return {
      routing_key: opts.routingKey,
      event_action: opts.eventAction,
      dedup_key: opts.dedupKey,
    };
  }

  // PagerDuty caps summary at 1024 chars
  const summary = opts.summary.length > 1024 ? opts.summary.slice(0, 1021) + '...' : opts.summary;

  const envelope: Record<string, unknown> = {
    routing_key: opts.routingKey,
    event_action: 'trigger',
    dedup_key: opts.dedupKey,
    payload: {
      summary,
      severity: opts.severity,
      source: opts.source,
      timestamp: opts.timestamp ? new Date(opts.timestamp).toISOString() : new Date().toISOString(),
      ...(opts.customDetails ? { custom_details: opts.customDetails } : {}),
    },
  };
  if (opts.links && opts.links.length > 0) {
    envelope.links = opts.links;
  }
  return envelope;
}

interface OpsgenieDeliveryOpts {
  baseUrl: string;
  message: string;
  alias: string;
  description?: string;
  priority?: OpsgeniePriority;
  source: string;
  tags?: string[];
  details?: Record<string, string>;
  isResolve?: boolean;
}

export interface OpsgenieDelivery {
  url: string;
  body: object;
}

// Normalize whatever the user pasted into the canonical /v2/alerts URL.
function normalizeOpsgenieBaseUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.replace(/\/+$/, '');
    if (!path.endsWith('/v2/alerts')) {
      return OPSGENIE_ALERTS_URL;
    }
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return OPSGENIE_ALERTS_URL;
  }
}

export function buildOpsgenieDelivery(opts: OpsgenieDeliveryOpts): OpsgenieDelivery {
  const base = normalizeOpsgenieBaseUrl(opts.baseUrl);

  if (opts.isResolve) {
    return {
      url: `${base}/${encodeURIComponent(opts.alias)}/close?identifierType=alias`,
      body: { source: opts.source, note: 'Auto-resolved by Exit1' },
    };
  }

  // Opsgenie caps message at 130 chars
  const message = opts.message.length > 130 ? opts.message.slice(0, 127) + '...' : opts.message;

  const body: Record<string, unknown> = {
    message,
    alias: opts.alias,
    source: opts.source,
  };
  if (opts.description) body.description = opts.description;
  if (opts.priority) body.priority = opts.priority;
  if (opts.tags && opts.tags.length > 0) body.tags = opts.tags;
  if (opts.details && Object.keys(opts.details).length > 0) body.details = opts.details;

  return { url: base, body };
}

// Dedup family: down/up share an incident; SSL, domain, DNS each track separately.
export function getIncidentFamily(event: WebhookEvent): 'uptime' | 'ssl' | 'domain' | 'dns' {
  switch (event) {
    case 'website_down':
    case 'website_up':
    case 'website_error':
      return 'uptime';
    case 'ssl_error':
    case 'ssl_warning':
      return 'ssl';
    case 'domain_expired':
    case 'domain_expiring':
    case 'domain_renewed':
      return 'domain';
    case 'dns_record_changed':
    case 'dns_record_missing':
    case 'dns_resolution_failed':
      return 'dns';
  }
}

export function getIncidentDedupKey(websiteId: string, event: WebhookEvent): string {
  return `exit1-${websiteId}-${getIncidentFamily(event)}`;
}

export function mapEventToPagerDuty(event: WebhookEvent): {
  action: PagerDutyAction;
  severity: PagerDutySeverity;
} {
  switch (event) {
    case 'website_down': return { action: 'trigger', severity: 'critical' };
    case 'website_up': return { action: 'resolve', severity: 'info' };
    case 'website_error': return { action: 'trigger', severity: 'error' };
    case 'ssl_error': return { action: 'trigger', severity: 'error' };
    case 'ssl_warning': return { action: 'trigger', severity: 'warning' };
    case 'domain_expired': return { action: 'trigger', severity: 'critical' };
    case 'domain_expiring': return { action: 'trigger', severity: 'warning' };
    case 'domain_renewed': return { action: 'resolve', severity: 'info' };
    case 'dns_record_changed': return { action: 'trigger', severity: 'warning' };
    case 'dns_record_missing': return { action: 'trigger', severity: 'error' };
    case 'dns_resolution_failed': return { action: 'trigger', severity: 'error' };
  }
}

export function mapEventToOpsgenie(event: WebhookEvent): {
  priority: OpsgeniePriority;
  isResolve: boolean;
} {
  switch (event) {
    case 'website_down': return { priority: 'P1', isResolve: false };
    case 'website_up': return { priority: 'P5', isResolve: true };
    case 'website_error': return { priority: 'P2', isResolve: false };
    case 'ssl_error': return { priority: 'P2', isResolve: false };
    case 'ssl_warning': return { priority: 'P3', isResolve: false };
    case 'domain_expired': return { priority: 'P1', isResolve: false };
    case 'domain_expiring': return { priority: 'P3', isResolve: false };
    case 'domain_renewed': return { priority: 'P5', isResolve: true };
    case 'dns_record_changed': return { priority: 'P3', isResolve: false };
    case 'dns_record_missing': return { priority: 'P2', isResolve: false };
    case 'dns_resolution_failed': return { priority: 'P2', isResolve: false };
  }
}
