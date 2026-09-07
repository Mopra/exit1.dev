/**
 * Email delivery gate: recipients, folder inheritance and event precedence.
 *
 * Pure. No firestore, no firebase-admin, so it is unit-tested directly
 * (__tests__/email-gate.test.ts) and is the single owner of the folder and
 * recipient rules: alert-helpers.ts re-exports `resolvePerFolder` and
 * `getEmailRecipientsForCheck` from here, so the hot alert paths that call those
 * helpers run this code.
 *
 * `eventAllowedForCheck` matches the precedence that alert.ts (uptime, SSL) and
 * alert-dns.ts inline. It is used by the read-only consumers, the alert-coverage
 * sweep and the "nobody will be told" audit, so "covered" here means the uptime
 * alert path would deliver. Those hot paths were deliberately left with their
 * inline copies: a mistake there stops alerts, and that is not a change to bundle
 * with new consumers.
 *
 * alert-domain.ts is NOT the same gate and must not be folded into this one: it
 * treats a missing `checkFilter` as send-by-default and an override entry with no
 * `enabled` flag as opt-in. Domain-expiry coverage would need its own predicate.
 *
 * The frontend mirrors this in src/lib/notification-shared.ts (`willDeliver`),
 * kept in step by hand. Change one, change the other.
 */
import type { WebhookEvent } from "./types";

type OverrideEntry = { enabled?: boolean; events?: WebhookEvent[]; recipients?: string[] };

/** Just enough of a settings document to answer the gate question. */
export interface GateSettings {
  enabled?: boolean;
  /** @deprecated legacy single-recipient field, still present on old documents. */
  recipient?: string;
  recipients?: string[];
  events?: WebhookEvent[];
  perCheck?: Record<string, OverrideEntry>;
  perFolder?: Record<string, OverrideEntry>;
  checkFilter?: { mode?: "all" | "include"; defaultEvents?: WebhookEvent[] };
}

export interface GateCheck {
  id: string;
  folder?: string | null;
}

/** Global recipients only: the `recipients` array, else the legacy `recipient`. */
export function getGlobalRecipients(settings: Pick<GateSettings, "recipient" | "recipients">): string[] {
  if (settings.recipients && settings.recipients.length > 0) return settings.recipients;
  if (settings.recipient) return [settings.recipient];
  return [];
}

/**
 * Folder inheritance: exact path first, then each parent. "Production/APIs"
 * matches a "Production" entry when it has no entry of its own.
 */
export function resolveFolderEntry(
  settings: Pick<GateSettings, "perFolder">,
  folder?: string | null,
): OverrideEntry | undefined {
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

/**
 * Global + per-folder + per-check recipients, deduplicated case-insensitively.
 * Folder recipients are always included, whether or not the check has its own
 * entry: the per-check entry decides whether to send, not who else to copy.
 */
export function collectRecipients(settings: GateSettings, check: GateCheck): string[] {
  const perCheck = settings.perCheck?.[check.id];
  const perFolder = resolveFolderEntry(settings, check.folder);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [
    ...getGlobalRecipients(settings),
    ...(perFolder?.recipients ?? []),
    ...(perCheck?.recipients ?? []),
  ]) {
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
 *   3. perFolder.enabled === true/false, same rules (only when no perCheck entry)
 *   4. checkFilter.mode === 'all' -> checkFilter.defaultEvents, else global events
 *   5. otherwise (mode 'include', or absent) -> never
 *
 * Rule 5 is the trap worth knowing about: 'include' was the DEFAULT the app wrote
 * until the alert-coverage fix, so a settings document with a valid recipient and
 * every event ticked still delivered nothing until checks were individually
 * enabled. 386 of 404 production documents were in that state.
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

/**
 * A settings document with every suppressed address removed from every scope.
 *
 * The delivery path drops suppressed (bounced) recipients at send time, so a
 * user whose only address has bounced is configured but unreachable. Coverage
 * has to see what delivery sees. Returns the same object when nothing changes.
 */
export function stripSuppressedRecipients(
  settings: GateSettings,
  isSuppressed: (email: string) => boolean,
): GateSettings {
  const keep = (list?: string[]) => list?.filter((e) => !isSuppressed(e));
  const stripEntries = (entries?: Record<string, OverrideEntry>) => {
    if (!entries) return entries;
    const out: Record<string, OverrideEntry> = {};
    for (const [k, v] of Object.entries(entries)) {
      out[k] = v.recipients ? { ...v, recipients: keep(v.recipients) } : v;
    }
    return out;
  };

  const legacyKept = settings.recipient && !isSuppressed(settings.recipient)
    ? settings.recipient
    : undefined;

  return {
    ...settings,
    recipient: legacyKept,
    recipients: keep(settings.recipients),
    perCheck: stripEntries(settings.perCheck),
    perFolder: stripEntries(settings.perFolder),
  };
}

/** Every address a settings document could ever send to, for a batch suppression lookup. */
export function allRecipientAddresses(settings: GateSettings): string[] {
  const out = new Set<string>();
  for (const e of getGlobalRecipients(settings)) out.add(e);
  for (const entry of Object.values(settings.perCheck ?? {})) for (const e of entry.recipients ?? []) out.add(e);
  for (const entry of Object.values(settings.perFolder ?? {})) for (const e of entry.recipients ?? []) out.add(e);
  return [...out];
}
