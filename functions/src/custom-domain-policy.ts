// ============================================================================
// CUSTOM STATUS PAGE DOMAINS: pure policy
//
// Hostname validation, the verification record, claim decisions, state
// transitions and the reconciler's decisions. No Firestore, no network: the
// callables and the reconciler in custom-domains.ts do the IO and ask this
// module what to do. See docs/plans/custom-status-domain.md.
// ============================================================================

import { createHash } from "node:crypto";
import { parse as parseDomain } from "tldts";
import { CUSTOM_DOMAIN } from "./config";
import type {
  CustomDomainDoc,
  CustomDomainStatus,
  StatusPageCustomDomain,
} from "./types";

export { CUSTOM_DOMAIN };
export type { CustomDomainDoc, CustomDomainStatus, StatusPageCustomDomain };

export const CUSTOM_DOMAINS_COLLECTION = "custom_domains";

// ── Hostname validation ──

/** Suffixes we never serve customer pages on (our own and our hosts'). */
export const RESERVED_SUFFIXES: readonly string[] = [
  "exit1.dev",
  "web.app",
  "firebaseapp.com",
  "cloudfunctions.net",
  "vercel.app",
  "run.app",
  "workers.dev",
  "pages.dev",
];

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostnameResult =
  | { ok: true; hostname: string }
  | { ok: false; error: string };

/**
 * Normalize what a user typed into a hostname: lowercase, punycode, no
 * trailing dot. Accepts a pasted `https://status.acme.com/` (scheme and a bare
 * trailing slash are dropped) but rejects anything with a path, query, port or
 * credentials, since that is not what the user meant to connect.
 */
export function normalizeHostname(input: unknown): HostnameResult {
  if (typeof input !== "string") return { ok: false, error: "Enter a hostname, for example status.yourcompany.com" };
  let raw = input.trim();
  if (!raw) return { ok: false, error: "Enter a hostname, for example status.yourcompany.com" };
  if (raw.length > 300) return { ok: false, error: "That hostname is too long" };

  raw = raw.replace(/^https?:\/\//i, "");
  if (raw.endsWith("/")) raw = raw.slice(0, -1);
  if (/[/?#@\s\\]/.test(raw)) {
    return { ok: false, error: "Enter just the hostname, without a path, for example status.yourcompany.com" };
  }
  if (raw.includes("*")) return { ok: false, error: "Wildcard hostnames are not supported" };
  if (raw.startsWith("[") || /:\d*$/.test(raw) || raw.includes(":")) {
    return { ok: false, error: "Enter the hostname without a port" };
  }

  let hostname: string;
  try {
    hostname = new URL(`https://${raw}`).hostname.toLowerCase();
  } catch {
    return { ok: false, error: "That is not a valid hostname" };
  }
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);

  const check = validateHostname(hostname);
  return check ? { ok: false, error: check } : { ok: true, hostname };
}

/** Returns an error message, or null when `hostname` (already normalized) may be connected. */
export function validateHostname(hostname: string): string | null {
  if (!hostname) return "That is not a valid hostname";
  if (hostname.length > 253) return "That hostname is too long";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    return "Use a hostname, not an IP address";
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "That hostname is not reachable from the internet";

  const labels = hostname.split(".");
  if (labels.length < 2) return "Enter a full hostname, for example status.yourcompany.com";
  for (const label of labels) {
    if (label.length > 63) return "One part of that hostname is longer than 63 characters";
    if (!LABEL_RE.test(label)) return "That hostname contains characters DNS does not allow";
  }

  for (const suffix of RESERVED_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return "That hostname cannot be used as a custom domain";
    }
  }

  const parsed = parseDomain(hostname);
  if (parsed.isIp) return "Use a hostname, not an IP address";
  if (!parsed.isIcann || !parsed.domain || !parsed.publicSuffix) {
    return "That hostname does not end in a public domain suffix";
  }
  if (parsed.domain === hostname) {
    return `Use a subdomain such as status.${hostname}. Root domains cannot point a CNAME at us.`;
  }
  return null;
}

// ── Verification record ──

/**
 * The TXT token. Derived from (account, hostname) instead of random so that
 * removing and re-adding a domain, or retrying a failed one, keeps the same
 * record in the customer's DNS, and so a second account's token is known
 * before it holds the claim (contested pending claims). Secrecy is not needed:
 * the token only proves control of DNS once it is published there.
 */
export function verifyTokenFor(accountId: string, hostname: string): string {
  return createHash("sha256").update(`exit1-custom-domain:${accountId}:${hostname}`).digest("hex").slice(0, 32);
}

export function verifyRecordFor(hostname: string, token: string): { name: string; value: string } {
  return { name: `${CUSTOM_DOMAIN.txtPrefix}.${hostname}`, value: `${CUSTOM_DOMAIN.txtValuePrefix}${token}` };
}

/** True when any TXT record (chunks joined, as resolvers split long strings) carries the token. */
export function txtMatches(records: string[][], token: string): boolean {
  const want = `${CUSTOM_DOMAIN.txtValuePrefix}${token}`;
  return records.some((chunks) => chunks.join("").trim().replace(/^"|"$/g, "") === want);
}

/** What a failed TXT lookup should tell the user. */
export function describeTxtMiss(hostname: string, records: string[][]): string {
  const name = `${CUSTOM_DOMAIN.txtPrefix}.${hostname}`;
  if (records.length === 0) return `TXT record not found yet at ${name}`;
  const found = records.map((r) => r.join("")).slice(0, 2).join(", ");
  return `TXT record at ${name} does not match. Found: ${found.slice(0, 200)}`;
}

/** Normalize a CNAME answer for comparison. */
export function cnameMatchesTarget(target: string | null): boolean {
  if (!target) return false;
  return target.toLowerCase().replace(/\.$/, "") === CUSTOM_DOMAIN.cnameTarget;
}

// ── Mirror ──

export function buildMirror(doc: CustomDomainDoc): StatusPageCustomDomain {
  return {
    hostname: doc.hostname,
    status: doc.status,
    verifyRecord: verifyRecordFor(doc.hostname, doc.verifyToken),
    cnameTarget: CUSTOM_DOMAIN.cnameTarget,
    lastError: doc.lastError,
    failedReason: doc.status === "failed" ? doc.failedReason : null,
    disabledReason: doc.status === "disabled" ? doc.disabledReason : null,
    statusChangedAt: doc.statusChangedAt,
    lastCheckedAt: doc.lastCheckedAt,
  };
}

export function newDomainDoc(input: {
  hostname: string;
  accountId: string;
  statusPageId: string;
  now: number;
}): CustomDomainDoc {
  const { hostname, accountId, statusPageId, now } = input;
  return {
    hostname,
    userId: accountId,
    statusPageId,
    status: "pending",
    verifyToken: verifyTokenFor(accountId, hostname),
    ownershipVerifiedAt: null,
    cnameOk: null,
    provider: "cloudflare",
    providerId: null,
    providerStatus: null,
    sslStatus: null,
    lastError: null,
    failedReason: null,
    disabledReason: null,
    movedSince: null,
    statusChangedAt: now,
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Claims ──

export type ClaimDecision =
  | { kind: "existing" }
  | { kind: "create"; releaseHost: string | null; takeover: boolean }
  | { kind: "error"; code: "already-exists" | "resource-exhausted"; message: string };

/** A claim nobody proved ownership of, old enough that someone who can pass TXT may take it. */
export function isContestable(doc: CustomDomainDoc, now: number): boolean {
  if (doc.ownershipVerifiedAt !== null) return false;
  if (doc.status !== "pending" && doc.status !== "failed") return false;
  return now - doc.createdAt >= CUSTOM_DOMAIN.contestedPendingMinAgeMs;
}

/**
 * Decide a claim. `accountDomains` are every custom_domains doc of the
 * account (any status), `pageCurrentHost` is the hostname the page holds now.
 * `claimantTxtVerified` is whether the claimant's own TXT is published, only
 * looked at when another account holds a contestable claim.
 */
export function decideClaim(input: {
  accountId: string;
  statusPageId: string;
  hostname: string;
  now: number;
  existing: CustomDomainDoc | null;
  accountDomains: ReadonlyArray<Pick<CustomDomainDoc, "hostname">>;
  pageCurrentHost: string | null;
  claimantTxtVerified: boolean;
  maxPerAccount?: number;
}): ClaimDecision {
  const { accountId, statusPageId, hostname, now, existing, pageCurrentHost } = input;
  const max = input.maxPerAccount ?? CUSTOM_DOMAIN.maxPerAccount;

  let takeover = false;
  if (existing) {
    if (existing.userId === accountId && existing.statusPageId === statusPageId) return { kind: "existing" };
    if (existing.userId === accountId) {
      return {
        kind: "error",
        code: "already-exists",
        message: "This hostname is connected to another of your status pages. Remove it there first.",
      };
    }
    if (!(isContestable(existing, now) && input.claimantTxtVerified)) {
      return { kind: "error", code: "already-exists", message: "This hostname is connected to another status page" };
    }
    takeover = true;
  }

  const counted = input.accountDomains.filter(
    (d) => d.hostname !== hostname && d.hostname !== pageCurrentHost,
  ).length;
  if (counted >= max) {
    return {
      kind: "error",
      code: "resource-exhausted",
      message: `Pro includes ${max} custom domains. Remove one to add another.`,
    };
  }

  const releaseHost = pageCurrentHost && pageCurrentHost !== hostname ? pageCurrentHost : null;
  return { kind: "create", releaseHost, takeover };
}

// ── Transitions ──

/** Merge a patch, stamping statusChangedAt and clearing reasons that no longer apply. */
export function transition(
  doc: CustomDomainDoc,
  patch: Partial<CustomDomainDoc>,
  now: number,
): CustomDomainDoc {
  const next: CustomDomainDoc = { ...doc, ...patch };
  if (next.status !== doc.status) next.statusChangedAt = now;
  if (next.status !== "failed") next.failedReason = null;
  if (next.status !== "disabled") next.disabledReason = null;
  return next;
}

/** Fields whose change is worth a write. lastCheckedAt alone is not. */
const WATCHED_FIELDS: readonly (keyof CustomDomainDoc)[] = [
  "status", "lastError", "providerId", "providerStatus", "sslStatus", "cnameOk",
  "ownershipVerifiedAt", "failedReason", "disabledReason", "movedSince", "statusPageId", "userId",
];

export function hasMeaningfulChange(before: CustomDomainDoc, after: CustomDomainDoc): boolean {
  return WATCHED_FIELDS.some((k) => before[k] !== after[k]);
}

/** pending or verifying for longer than the setup window. */
export function setupExpired(doc: CustomDomainDoc, now: number): boolean {
  return (doc.status === "pending" || doc.status === "verifying") &&
    now - doc.statusChangedAt > CUSTOM_DOMAIN.setupTimeoutMs;
}

/** Reconnect or retry must see the TXT again. */
export function needsReverify(doc: CustomDomainDoc, now: number): boolean {
  return doc.ownershipVerifiedAt === null || now - doc.ownershipVerifiedAt > CUSTOM_DOMAIN.reverifyAfterMs;
}

/** Disabled long enough that the Cloudflare hostname should go. */
export function graceExpired(doc: CustomDomainDoc, now: number): boolean {
  return doc.status === "disabled" && doc.providerId !== null &&
    now - doc.statusChangedAt > CUSTOM_DOMAIN.disabledGraceMs;
}

/** The provider's view, already mapped (cloudflare-saas.ts mapProviderState). */
export interface ProviderState {
  kind: "active" | "pending" | "moved" | "blocked";
  providerStatus: string | null;
  sslStatus: string | null;
  error: string | null;
}

/**
 * Apply a provider observation to a verifying or active doc. Disabled,
 * pending and failed docs only record the raw fields.
 */
export function applyProviderState(doc: CustomDomainDoc, ps: ProviderState, now: number): CustomDomainDoc {
  const base: Partial<CustomDomainDoc> = { providerStatus: ps.providerStatus, sslStatus: ps.sslStatus };
  if (doc.status !== "verifying" && doc.status !== "active") return transition(doc, base, now);

  switch (ps.kind) {
  case "blocked":
    return transition(doc, {
      ...base, status: "failed", failedReason: "blocked", movedSince: null,
      lastError: ps.error ?? "Cloudflare blocked this hostname",
    }, now);
  case "moved": {
    if (doc.status === "verifying") return transition(doc, { ...base, lastError: ps.error }, now);
    const movedSince = doc.movedSince ?? now;
    if (now - movedSince > CUSTOM_DOMAIN.movedFailAfterMs) {
      return transition(doc, {
        ...base, status: "failed", failedReason: "moved", movedSince: null,
        lastError: ps.error ?? `The CNAME no longer points at ${CUSTOM_DOMAIN.cnameTarget}`,
      }, now);
    }
    return transition(doc, { ...base, movedSince, lastError: ps.error }, now);
  }
  case "active":
    return transition(doc, { ...base, status: "active", lastError: null, movedSince: null }, now);
  case "pending":
  default:
    // An active domain whose certificate is renewing keeps serving; the
    // health email reports a non-active ssl status.
    if (doc.status === "active") return transition(doc, { ...base, lastError: null, movedSince: null }, now);
    return transition(doc, { ...base, lastError: ps.error, movedSince: null }, now);
  }
}

// ── Reconciler decisions ──

export type DailyAction = "release" | "disable" | null;

/**
 * The daily sweep's verdict for one doc.
 * `page` is null when the status page is gone. `entitled` is null when the
 * owner's tier could not be read (fail open: do nothing).
 */
export function decideDaily(input: {
  doc: CustomDomainDoc;
  page: { userId: string | null; customHost: string | null } | null;
  entitled: boolean | null;
  now: number;
}): DailyAction {
  const { doc, page, entitled, now } = input;
  if (!page || page.userId !== doc.userId || page.customHost !== doc.hostname) return "release";
  if (doc.status === "failed" && doc.ownershipVerifiedAt === null &&
    now - doc.statusChangedAt > CUSTOM_DOMAIN.failedReleaseAfterMs) {
    return "release";
  }
  if (entitled === false && doc.status !== "disabled") return "disable";
  return null;
}

/**
 * Compare Cloudflare's hostnames with our docs. Hostnames with no doc, or a
 * doc that should not have one, are deleted; a doc that should have one but
 * lost the id (a write failed after the create) adopts it.
 */
export function decideProviderDrift(
  provider: ReadonlyArray<{ id: string; hostname: string }>,
  docs: ReadonlyMap<string, Pick<CustomDomainDoc, "status" | "providerId">>,
): { deleteIds: string[]; adopt: Array<{ hostname: string; id: string }> } {
  const deleteIds: string[] = [];
  const adopt: Array<{ hostname: string; id: string }> = [];
  for (const h of provider) {
    const doc = docs.get(h.hostname.toLowerCase());
    if (!doc) { deleteIds.push(h.id); continue; }
    if (doc.providerId === h.id) continue;
    const shouldHaveOne = doc.status === "verifying" || doc.status === "active" || doc.status === "disabled";
    if (doc.providerId === null && shouldHaveOne) adopt.push({ hostname: h.hostname.toLowerCase(), id: h.id });
    else deleteIds.push(h.id);
  }
  return { deleteIds, adopt };
}

/** Entitlement from a tier, with the feature flag as the only source. */
export function tierHasCustomDomain(
  tierLimits: Record<string, { customStatusDomain: boolean }>,
  tier: string,
): boolean {
  return tierLimits[tier]?.customStatusDomain === true;
}
