import type { WebhookEvent } from '../api/types';
import { AlertCircle, AlertTriangle, CheckCircle, Clock, RefreshCw } from 'lucide-react';
import { getAncestorPaths } from './folder-utils';

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

/**
 * Folder inheritance: exact match first, then the nearest parent. Built on the
 * canonical folder-path helpers so this read side agrees with the Emails page's
 * write side about what a path's ancestors are.
 */
function resolvePerFolderEntry(settings: GateSettings, folder?: string | null) {
  if (!folder || !settings.perFolder) return undefined;
  const exact = settings.perFolder[folder];
  if (exact) return exact;
  // getAncestorPaths is outermost-first; the gate wants nearest-first.
  for (const ancestor of getAncestorPaths(folder).reverse()) {
    const entry = settings.perFolder[ancestor];
    if (entry) return entry;
  }
  return undefined;
}

/** Non-empty, trimmed recipients only, so `['']` does not count as an address. */
const usable = (list?: string[]) => (list ?? []).map((r) => r.trim()).filter(Boolean);

/**
 * Would this channel actually deliver `event` for this check?
 *
 * Mirrors the server gate in `functions/src/email-gate.ts` (`eventAllowedForCheck`).
 * Kept in step by hand: if the precedence rules change on one side they must change
 * on the other, or the UI will claim coverage the alert path does not honour.
 *
 * The trap this exists to surface: `checkFilter.mode` used to default to `'include'`,
 * so a settings document with a valid recipient and every event ticked still
 * delivered nothing until checks were individually enabled or the mode was switched
 * to 'all'.
 */
export function willDeliver(
  settings: GateSettings | null | undefined,
  check: { id: string; folder?: string | null },
  event: WebhookEvent,
): boolean {
  if (!settings) return false;
  if (settings.enabled === false) return false;

  const perCheck = settings.perCheck?.[check.id];
  // Folder recipients count whether or not the check has its own entry; the
  // per-check entry decides whether to send, not who else is copied. This used to
  // be gated on `!perCheck`, which disagreed with the server and showed the
  // "nobody will be told" banner to users who were covered via a folder address.
  const folderEntry = resolvePerFolderEntry(settings, check.folder);
  const globalRecipients = usable(settings.recipients).length
    ? usable(settings.recipients)
    : usable(settings.recipient ? [settings.recipient] : []);
  const recipientCount =
    globalRecipients.length
    + usable(perCheck?.recipients).length
    + usable(folderEntry?.recipients).length;
  if (recipientCount === 0) return false;

  const globalAllows = (settings.events ?? []).includes(event);

  const perCheckEnabled = perCheck && 'enabled' in perCheck ? perCheck.enabled : undefined;
  if (perCheckEnabled === true) return perCheck?.events ? perCheck.events.includes(event) : globalAllows;
  if (perCheckEnabled === false) return false;

  // Folder enabled/events only apply when the check has no entry of its own.
  const perFolder = !perCheck ? folderEntry : undefined;
  const perFolderEnabled = perFolder && 'enabled' in perFolder ? perFolder.enabled : undefined;
  if (perFolderEnabled === true) return perFolder?.events ? perFolder.events.includes(event) : globalAllows;
  if (perFolderEnabled === false) return false;

  if (settings.checkFilter?.mode === 'all') {
    const defaults = settings.checkFilter.defaultEvents;
    return defaults ? defaults.includes(event) : globalAllows;
  }
  return false;
}

/**
 * Would a check created right now be covered? Used by onboarding to decide whether
 * to show the alert step. A synthetic id never matches a per-check entry, so this
 * is exactly "does the document cover checks by default", which is the question.
 */
export function coversNewChecks(settings: GateSettings | null | undefined, event: WebhookEvent): boolean {
  return willDeliver(settings, { id: '__new_check__', folder: null }, event);
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
