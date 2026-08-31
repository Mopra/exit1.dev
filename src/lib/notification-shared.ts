import type { WebhookEvent } from '../api/types';
import { AlertCircle, AlertTriangle, CheckCircle, Clock, RefreshCw } from 'lucide-react';

export const ALL_NOTIFICATION_EVENTS: { value: WebhookEvent; label: string; icon: typeof AlertCircle }[] = [
  { value: 'website_down', label: 'Down', icon: AlertTriangle },
  { value: 'website_up', label: 'Up', icon: CheckCircle },
  { value: 'ssl_error', label: 'SSL Error', icon: AlertCircle },
  { value: 'ssl_warning', label: 'SSL Warning', icon: AlertCircle },
  { value: 'domain_expiring', label: 'Domain Expiring', icon: Clock },
  { value: 'domain_expired', label: 'Domain Expired', icon: AlertTriangle },
  { value: 'domain_renewed', label: 'Domain Renewed', icon: RefreshCw },
];

export const DEFAULT_NOTIFICATION_EVENTS: WebhookEvent[] = [
  'website_down', 'website_up', 'ssl_error', 'ssl_warning',
  'domain_expiring', 'domain_expired', 'domain_renewed',
];

export type NotificationPendingOverride = {
  enabled?: boolean | null;
  events?: WebhookEvent[] | null;
  recipients?: string[] | null;
};

// ---------------------------------------------------------------------------
// Delivery gate
// ---------------------------------------------------------------------------

/** Just enough of a settings document to answer the gate question. */
export type GateSettings = {
  enabled?: boolean;
  recipient?: string;
  recipients?: string[];
  events?: WebhookEvent[];
  perCheck?: Record<string, { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] }>;
  perFolder?: Record<string, { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] }>;
  checkFilter?: { mode?: 'all' | 'include'; defaultEvents?: WebhookEvent[] };
};

/** Folder inheritance: exact match first, then each parent path. */
function resolvePerFolderEntry(settings: GateSettings, folder?: string | null) {
  if (!folder || !settings.perFolder) return undefined;
  const exact = settings.perFolder[folder];
  if (exact) return exact;
  const parts = folder.split('/');
  while (parts.length > 1) {
    parts.pop();
    const entry = settings.perFolder[parts.join('/')];
    if (entry) return entry;
  }
  return undefined;
}

/**
 * Would this channel actually deliver `event` for this check?
 *
 * Mirrors the server gate in `functions/src/alert-helpers.ts`
 * (`emailEventAllowedForCheck`). Kept in step by hand: if the precedence rules
 * change on one side they must change on the other, or the UI will claim coverage
 * the alert path does not honour.
 *
 * The trap this exists to surface: `checkFilter.mode` defaults to `'include'`, so
 * a settings document with a valid recipient and every event ticked still delivers
 * nothing until checks are individually enabled or the mode is switched to 'all'.
 */
export function willDeliver(
  settings: GateSettings | null | undefined,
  check: { id: string; folder?: string | null },
  event: WebhookEvent,
): boolean {
  if (!settings) return false;
  if (settings.enabled === false) return false;

  const globalRecipients = settings.recipients?.length
    ? settings.recipients
    : settings.recipient ? [settings.recipient] : [];
  const perCheck = settings.perCheck?.[check.id];
  const perFolder = !perCheck ? resolvePerFolderEntry(settings, check.folder) : undefined;
  const recipientCount =
    globalRecipients.length + (perCheck?.recipients?.length ?? 0) + (perFolder?.recipients?.length ?? 0);
  if (recipientCount === 0) return false;

  const globalAllows = (settings.events ?? []).includes(event);

  const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
  if (perCheckEnabled === true) return perCheck?.events ? perCheck.events.includes(event) : globalAllows;
  if (perCheckEnabled === false) return false;

  const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
  if (perFolderEnabled === true) return perFolder?.events ? perFolder.events.includes(event) : globalAllows;
  if (perFolderEnabled === false) return false;

  if (settings.checkFilter?.mode === 'all') {
    const defaults = settings.checkFilter.defaultEvents;
    return defaults ? defaults.includes(event) : globalAllows;
  }
  return false;
}

export type NotificationUsageWindow = {
  count: number;
  max: number;
  windowStart: number;
  windowEnd: number;
};

export type NotificationUsage = {
  hourly: NotificationUsageWindow;
  monthly: NotificationUsageWindow;
};
