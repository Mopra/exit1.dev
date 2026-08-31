/**
 * Pure delivery-gate resolution. No firestore, no firebase-admin, so it can be
 * unit-tested directly (see __tests__/email-gate.test.ts).
 *
 * This is the same precedence the alert path runs inline in alert.ts,
 * alert-dns.ts and alert-domain.ts. It was extracted so read-only consumers, the
 * alert-coverage sweep and the "nobody will be told" audit, can answer "would this
 * actually be delivered?" without re-deriving the rules.
 *
 * IMPORTANT: the hot alert paths still inline their own copies. They were left
 * alone deliberately: five call sites with different surrounding state are not
 * worth refactoring in the same change that adds new consumers, and a mistake
 * there means alerts stop arriving. Any change to the precedence below must be
 * mirrored in those call sites, and vice versa. The frontend has a third copy in
 * src/lib/notification-shared.ts (`willDeliver`) for the same reason.
 */
import type { WebhookEvent } from "./types";

/** Just enough of a settings document to answer the gate question. */
export interface GateSettings {
  enabled?: boolean;
  /** @deprecated legacy single-recipient field, still present on old documents. */
  recipient?: string;
  recipients?: string[];
  events?: WebhookEvent[];
  perCheck?: Record<string, { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] }>;
  perFolder?: Record<string, { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] }>;
  checkFilter?: { mode?: "all" | "include"; defaultEvents?: WebhookEvent[] };
}

export interface GateCheck {
  id: string;
  folder?: string | null;
}

/**
 * Folder inheritance: exact path first, then each parent. "Production/APIs"
 * matches a "Production" entry when it has no entry of its own.
 */
export function resolveFolderEntry(settings: GateSettings, folder?: string | null) {
  if (!folder || !settings.perFolder) return undefined;
  const exact = settings.perFolder[folder];
  if (exact) return exact;
  const parts = folder.split("/");
  while (parts.length > 1) {
    parts.pop();
    const entry = settings.perFolder[parts.join("/")];
    if (entry) return entry;
  }
  return undefined;
}

/** Global + per-folder + per-check recipients, deduplicated case-insensitively. */
export function collectRecipients(settings: GateSettings, check: GateCheck): string[] {
  const global = settings.recipients?.length
    ? settings.recipients
    : settings.recipient ? [settings.recipient] : [];
  const perCheck = settings.perCheck?.[check.id];
  const perFolder = resolveFolderEntry(settings, check.folder);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...global, ...(perFolder?.recipients ?? []), ...(perCheck?.recipients ?? [])]) {
    const lower = raw.toLowerCase().trim();
    if (lower && !seen.has(lower)) {
      seen.add(lower);
      out.push(raw.trim());
    }
  }
  return out;
}

/**
 * Would `event` actually be delivered for this check?
 *
 * Precedence, highest first:
 *   1. perCheck.enabled === true  -> perCheck.events, else the global event list
 *   2. perCheck.enabled === false -> never, even in 'all' mode
 *   3. perFolder.enabled === true/false, same rules
 *   4. checkFilter.mode === 'all' -> checkFilter.defaultEvents, else global events
 *   5. otherwise (mode 'include', or absent) -> never
 *
 * Rule 5 is the trap worth knowing about: 'include' is the DEFAULT the app writes,
 * so a settings document with a valid recipient and every event ticked still
 * delivers nothing until checks are individually enabled. 386 of 404 production
 * documents are in that state.
 */
export function eventAllowedForCheck(
  settings: GateSettings | null | undefined,
  check: GateCheck,
  event: WebhookEvent,
): boolean {
  if (!settings) return false;
  if (settings.enabled === false) return false;
  if (collectRecipients(settings, check).length === 0) return false;

  const globalAllows = (settings.events ?? []).includes(event);

  const perCheck = settings.perCheck?.[check.id];
  const perCheckEnabled = perCheck && "enabled" in perCheck ? perCheck.enabled : undefined;
  if (perCheckEnabled === true) return perCheck?.events ? perCheck.events.includes(event) : globalAllows;
  if (perCheckEnabled === false) return false;

  // perCheck wins outright: a folder rule is only consulted when the check has no
  // entry of its own at all.
  const perFolder = !perCheck ? resolveFolderEntry(settings, check.folder) : undefined;
  const perFolderEnabled = perFolder && "enabled" in perFolder ? perFolder.enabled : undefined;
  if (perFolderEnabled === true) return perFolder?.events ? perFolder.events.includes(event) : globalAllows;
  if (perFolderEnabled === false) return false;

  if (settings.checkFilter?.mode === "all") {
    const defaults = settings.checkFilter.defaultEvents;
    return defaults ? defaults.includes(event) : globalAllows;
  }
  return false;
}
