// ============================================================================
// CUSTOM STATUS PAGE DOMAINS: callables
//
// Pro users connect status.acme.com to a status page. Every write goes through
// here (rules deny clients custom_domains and the status_pages.customDomain
// mirror):
//
//   claimStatusPageDomain   reserve the hostname (custom_domains/{host}, txn)
//   checkStatusPageDomain   TXT, CNAME and Cloudflare checks; also Retry/Reconnect
//   releaseStatusPageDomain Cloudflare delete, both docs cleared
//
// Lifecycle and the reasons for each step: docs/plans/custom-status-domain.md
// sections 5 to 7. Pure decisions live in custom-domain-policy.ts.
// ============================================================================

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { promises as dnsPromises } from "node:dns";
import { FieldValue } from "firebase-admin/firestore";
import { firestore, getUserTierLive } from "./init";
import { CUSTOM_DOMAINS_ENABLED, TIER_LIMITS } from "./config";
import { CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD, CLOUDFLARE_SAAS_API_TOKEN } from "./env";
import { resolveAccount, type AccountContext } from "./team-access";
import { FixedWindowRateLimiter } from "./rate-limit";
import { getCloudflareSaasClient, mapProviderState, type CloudflareSaasClient } from "./cloudflare-saas";
import {
  CUSTOM_DOMAIN,
  CUSTOM_DOMAINS_COLLECTION,
  applyProviderState,
  buildMirror,
  cnameMatchesTarget,
  decideClaim,
  describeTxtMiss,
  hasMeaningfulChange,
  needsReverify,
  newDomainDoc,
  normalizeHostname,
  setupExpired,
  tierHasCustomDomain,
  transition,
  txtMatches,
  verifyTokenFor,
  type CustomDomainDoc,
  type StatusPageCustomDomain,
} from "./custom-domain-policy";

const STATUS_PAGES = "status_pages";
const DAY_MS = 24 * 60 * 60 * 1000;

const domains = () => firestore.collection(CUSTOM_DOMAINS_COLLECTION);
const pages = () => firestore.collection(STATUS_PAGES);

const claimLimiter = new FixedWindowRateLimiter({ windowMs: DAY_MS, maxKeys: 5000 });
/** hostname to last check time, per instance. Polls that land inside the window do no work. */
const checkThrottle = new Map<string, number>();

const CALLABLE_OPTS = {
  cors: true,
  maxInstances: 5,
  secrets: [CLOUDFLARE_SAAS_API_TOKEN, CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
};

function log(event: string, fields: Record<string, unknown>): void {
  logger.info(`[custom-domains] ${event}`, fields);
}

// ── Guards ──

/**
 * The kill switch. While CUSTOM_DOMAINS_ENABLED is false only admins (the
 * cached `users/{uid}.admin` flag) and CUSTOM_DOMAIN.allowUids get through.
 */
async function assertFeatureOpen(ctx: AccountContext): Promise<void> {
  if (CUSTOM_DOMAINS_ENABLED) return;
  if (CUSTOM_DOMAIN.allowUids.includes(ctx.accountId) || CUSTOM_DOMAIN.allowUids.includes(ctx.actorUid)) return;
  const snap = await firestore.collection("users").doc(ctx.actorUid).get();
  if (snap.exists && (snap.data() || {}).admin === true) return;
  throw new HttpsError("failed-precondition", "Custom domains are not available yet.");
}

async function assertEntitled(accountId: string): Promise<void> {
  const tier = await getUserTierLive(accountId);
  if (!tierHasCustomDomain(TIER_LIMITS, tier)) {
    throw new HttpsError("permission-denied", "Custom domains are a Pro feature.");
  }
}

function asStatusPageId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || value.includes("/")) {
    throw new HttpsError("invalid-argument", "statusPageId is required");
  }
  return value;
}

type PageData = { userId?: string; customDomain?: StatusPageCustomDomain | null; visibility?: string };

async function loadOwnedPage(statusPageId: string, accountId: string): Promise<PageData> {
  const snap = await pages().doc(statusPageId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Status page not found");
  const data = snap.data() as PageData;
  if (data.userId !== accountId) throw new HttpsError("permission-denied", "You do not have access to this status page");
  return data;
}

// ── DNS ──

function resolver(): dnsPromises.Resolver {
  const r = new dnsPromises.Resolver({ timeout: CUSTOM_DOMAIN.dnsTimeoutMs, tries: 1 });
  r.setServers([...CUSTOM_DOMAIN.dnsServers]);
  return r;
}

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "ENONAME", "NXDOMAIN"]);

/** TXT records at the verify name. Empty when none exist; null when DNS failed. */
async function lookupVerifyTxt(hostname: string): Promise<string[][] | null> {
  try {
    return await resolver().resolveTxt(`${CUSTOM_DOMAIN.txtPrefix}.${hostname}`);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (NO_RECORD.has(code)) return [];
    logger.warn("[custom-domains] TXT lookup failed", { hostname, code });
    return null;
  }
}

/** The CNAME target, null when the name has no CNAME, undefined when DNS failed. */
async function lookupCname(hostname: string): Promise<string | null | undefined> {
  try {
    const answers = await resolver().resolveCname(hostname);
    return answers[0] ? answers[0].toLowerCase().replace(/\.$/, "") : null;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (NO_RECORD.has(code)) return null;
    return undefined;
  }
}

// ── The step shared by checkStatusPageDomain and the reconciler ──

/**
 * Move a pending, verifying or active domain one step forward with fresh
 * observations. Pure apart from DNS and Cloudflare calls; the caller persists.
 */
export async function advanceDomain(
  start: CustomDomainDoc,
  now: number,
  client: CloudflareSaasClient | null,
): Promise<CustomDomainDoc> {
  let doc: CustomDomainDoc = { ...start, lastCheckedAt: now };

  if (setupExpired(doc, now)) {
    return transition(doc, {
      status: "failed", failedReason: "timeout",
      lastError: doc.status === "pending"
        ? "The TXT record was not found within 72 hours"
        : "The domain did not become active within 72 hours",
    }, now);
  }

  if (doc.status === "pending") {
    const records = await lookupVerifyTxt(doc.hostname);
    if (records === null) return transition(doc, { lastError: "DNS lookup failed, will try again" }, now);
    if (!txtMatches(records, doc.verifyToken)) {
      return transition(doc, { lastError: describeTxtMiss(doc.hostname, records) }, now);
    }
    doc = transition(doc, { status: "verifying", ownershipVerifiedAt: now, lastError: null }, now);
    log("ownership verified", { hostname: doc.hostname, accountId: doc.userId });
  }

  if (doc.status !== "verifying" && doc.status !== "active") return doc;

  let cnameTarget: string | null | undefined;
  if (doc.status === "verifying") {
    cnameTarget = await lookupCname(doc.hostname);
    if (cnameTarget !== undefined) {
      // No CNAME at all can mean the record is proxied by the customer's own
      // Cloudflare (it then answers with A/AAAA), so only a wrong target is a definite no.
      doc = { ...doc, cnameOk: cnameTarget === null ? null : cnameMatchesTarget(cnameTarget) };
    }
  }

  if (!client) {
    return transition(doc, { lastError: "Custom domains are not configured on this server yet" }, now);
  }

  try {
    let h = doc.providerId ? await client.getCustomHostname(doc.providerId) : null;
    if (!h) {
      if (doc.providerId) log("provider hostname missing, recreating", { hostname: doc.hostname });
      h = await client.createCustomHostname(doc.hostname);
      doc = { ...doc, providerId: h.id };
      if (start.providerId !== h.id) log("registered with Cloudflare", { hostname: doc.hostname, providerId: h.id });
    }
    const ps = mapProviderState(h);
    if (ps.kind === "pending" && doc.status === "verifying" && doc.cnameOk === false && cnameTarget) {
      ps.error = `CNAME points to ${cnameTarget}. It should point to ${CUSTOM_DOMAIN.cnameTarget}`;
    }
    doc = applyProviderState(doc, ps, now);
  } catch (e) {
    logger.warn("[custom-domains] Cloudflare call failed", { hostname: doc.hostname, error: (e as Error).message });
    doc = transition(doc, { lastError: "Could not reach the certificate provider, will try again" }, now);
  }
  return doc;
}

/**
 * Write a changed doc and its page mirror in one transaction. Skips the write
 * when the domain was released or moved to another page meanwhile, and when
 * nothing worth a write changed. A doc that just failed loses its Cloudflare
 * hostname first.
 */
export async function persistDomain(
  before: CustomDomainDoc,
  after: CustomDomainDoc,
  client: CloudflareSaasClient | null,
): Promise<CustomDomainDoc> {
  let next = after;
  if (next.status === "failed" && next.providerId && client) {
    try {
      await client.deleteCustomHostname(next.providerId);
      next = { ...next, providerId: null };
    } catch (e) {
      // Kept on the doc; the daily drift sweep deletes it.
      logger.warn("[custom-domains] Cloudflare delete on failure did not go through", {
        hostname: next.hostname, error: (e as Error).message,
      });
    }
  }
  if (!hasMeaningfulChange(before, next)) return before;

  next = { ...next, updatedAt: Date.now() };
  const written = await firestore.runTransaction(async (tx) => {
    const domRef = domains().doc(next.hostname);
    const pageRef = pages().doc(next.statusPageId);
    const [domSnap, pageSnap] = await Promise.all([tx.get(domRef), tx.get(pageRef)]);
    const current = domSnap.exists ? (domSnap.data() as CustomDomainDoc) : null;
    if (!current || current.userId !== before.userId || current.statusPageId !== before.statusPageId) return false;
    tx.set(domRef, next);
    const page = pageSnap.exists ? (pageSnap.data() as PageData) : null;
    if (page && page.customDomain?.hostname === next.hostname) {
      tx.update(pageRef, { customDomain: buildMirror(next) });
    }
    return true;
  });
  if (!written) return before;
  if (before.status !== next.status) {
    log("status changed", {
      hostname: next.hostname, accountId: next.userId, from: before.status, to: next.status,
      reason: next.failedReason ?? next.disabledReason ?? null, lastError: next.lastError,
    });
  }
  return next;
}

// ── Release ──

/**
 * Remove a hostname everywhere: the custom_domains doc, the page mirror (only
 * on pages that still point at this hostname) and the Cloudflare hostname.
 * `expect` guards against releasing a doc that now belongs to someone else.
 */
export async function releaseDomain(
  hostname: string,
  opts: { expect?: { userId: string; statusPageId: string }; pageId?: string; reason: string },
): Promise<boolean> {
  const domRef = domains().doc(hostname);
  const providerId = await firestore.runTransaction(async (tx) => {
    const domSnap = await tx.get(domRef);
    const doc = domSnap.exists ? (domSnap.data() as CustomDomainDoc) : null;
    if (doc && opts.expect && (doc.userId !== opts.expect.userId || doc.statusPageId !== opts.expect.statusPageId)) {
      return undefined;
    }
    const pageIds = new Set<string>();
    if (doc) pageIds.add(doc.statusPageId);
    if (opts.pageId) pageIds.add(opts.pageId);
    const refs = [...pageIds].map((id) => pages().doc(id));
    const snaps = refs.length ? await tx.getAll(...refs) : [];
    for (const snap of snaps) {
      if (snap.exists && (snap.data() as PageData).customDomain?.hostname === hostname) {
        tx.update(snap.ref, { customDomain: FieldValue.delete() });
      }
    }
    if (doc) tx.delete(domRef);
    return doc?.providerId ?? null;
  });
  if (providerId === undefined) return false;

  if (providerId) {
    const client = getCloudflareSaasClient();
    try {
      if (client) await client.deleteCustomHostname(providerId);
    } catch (e) {
      logger.warn("[custom-domains] Cloudflare delete on release did not go through; drift sweep will retry", {
        hostname, error: (e as Error).message,
      });
    }
  }
  checkThrottle.delete(hostname);
  log("released", { hostname, reason: opts.reason });
  return true;
}

// ── Callables ──

/**
 * claimStatusPageDomain({ statusPageId, hostname, accountId? })
 *   -> { customDomain: StatusPageCustomDomain }
 */
export const claimStatusPageDomain = onCall(CALLABLE_OPTS, async (request) => {
  const ctx = await resolveAccount(request, "write");
  await assertFeatureOpen(ctx);
  const { accountId } = ctx;
  const data = (request.data ?? {}) as Record<string, unknown>;
  const statusPageId = asStatusPageId(data.statusPageId);
  const parsed = normalizeHostname(data.hostname);
  if (!parsed.ok) throw new HttpsError("invalid-argument", parsed.error);
  const hostname = parsed.hostname;

  await assertEntitled(accountId);
  await loadOwnedPage(statusPageId, accountId);

  const limit = claimLimiter.consume(accountId, CUSTOM_DOMAIN.claimsPerDay);
  if (!limit.allowed) {
    throw new HttpsError("resource-exhausted", "Too many domain changes today. Try again tomorrow.");
  }

  // A contested claim (another account holds an unverified pending claim)
  // goes to whoever can publish their own TXT. Look it up before the txn.
  const now = Date.now();
  const preSnap = await domains().doc(hostname).get();
  const pre = preSnap.exists ? (preSnap.data() as CustomDomainDoc) : null;
  let claimantTxtVerified = false;
  if (pre && pre.userId !== accountId) {
    const records = await lookupVerifyTxt(hostname);
    claimantTxtVerified = !!records && txtMatches(records, verifyTokenFor(accountId, hostname));
  }

  const outcome = await firestore.runTransaction(async (tx) => {
    const pageRef = pages().doc(statusPageId);
    const domRef = domains().doc(hostname);
    const [pageSnap, domSnap, accountSnap] = await Promise.all([
      tx.get(pageRef),
      tx.get(domRef),
      tx.get(domains().where("userId", "==", accountId)),
    ]);
    if (!pageSnap.exists) throw new HttpsError("not-found", "Status page not found");
    const page = pageSnap.data() as PageData;
    if (page.userId !== accountId) throw new HttpsError("permission-denied", "You do not have access to this status page");
    const existing = domSnap.exists ? (domSnap.data() as CustomDomainDoc) : null;
    const pageCurrentHost = page.customDomain?.hostname ?? null;

    const decision = decideClaim({
      accountId, statusPageId, hostname, now, existing,
      accountDomains: accountSnap.docs.map((d) => ({ hostname: d.id })),
      pageCurrentHost, claimantTxtVerified,
    });
    if (decision.kind === "error") throw new HttpsError(decision.code, decision.message);
    if (decision.kind === "existing") {
      return { doc: existing as CustomDomainDoc, deleteProviderIds: [] as string[], created: false };
    }

    // All reads before writes: the replaced domain and, on a takeover, the old holder's page.
    const deleteProviderIds: string[] = [];
    const oldRef = decision.releaseHost ? domains().doc(decision.releaseHost) : null;
    const oldSnap = oldRef ? await tx.get(oldRef) : null;
    const loserPageRef = decision.takeover && existing ? pages().doc(existing.statusPageId) : null;
    const loserPageSnap = loserPageRef ? await tx.get(loserPageRef) : null;

    if (oldRef && oldSnap?.exists) {
      const old = oldSnap.data() as CustomDomainDoc;
      if (old.userId === accountId && old.statusPageId === statusPageId) {
        tx.delete(oldRef);
        if (old.providerId) deleteProviderIds.push(old.providerId);
      }
    }
    if (decision.takeover && existing) {
      if (existing.providerId) deleteProviderIds.push(existing.providerId);
      if (loserPageRef && loserPageSnap?.exists &&
        (loserPageSnap.data() as PageData).customDomain?.hostname === hostname) {
        tx.update(loserPageRef, { customDomain: FieldValue.delete() });
      }
    }

    const doc = newDomainDoc({ hostname, accountId, statusPageId, now });
    tx.set(domRef, doc);
    tx.update(pageRef, { customDomain: buildMirror(doc) });
    return { doc, deleteProviderIds, created: true, takeoverFrom: decision.takeover ? existing?.userId : undefined };
  });

  if (outcome.deleteProviderIds.length) {
    const client = getCloudflareSaasClient();
    for (const id of outcome.deleteProviderIds) {
      try {
        if (client) await client.deleteCustomHostname(id);
      } catch (e) {
        logger.warn("[custom-domains] Cloudflare delete after claim did not go through", { id, error: (e as Error).message });
      }
    }
  }

  let doc = outcome.doc;
  if (outcome.created) {
    log("claimed", {
      hostname, accountId, actorUid: ctx.actorUid, statusPageId,
      takeoverFrom: (outcome as { takeoverFrom?: string }).takeoverFrom ?? null,
    });
    // One immediate step: a customer who published the TXT first goes straight to verifying.
    try {
      const client = getCloudflareSaasClient();
      doc = await persistDomain(doc, await advanceDomain(doc, Date.now(), client), client);
      checkThrottle.set(hostname, Date.now());
    } catch (e) {
      logger.warn("[custom-domains] first check after claim failed", { hostname, error: (e as Error).message });
    }
  }
  return { customDomain: buildMirror(doc) };
});

/**
 * checkStatusPageDomain({ statusPageId, accountId? })
 *   -> { customDomain: StatusPageCustomDomain }
 *
 * pending/verifying/active: check DNS and Cloudflare now.
 * failed: Retry (back to pending, same TXT).
 * disabled: Reconnect (needs Pro; TXT again if last verified over 30 days ago).
 */
export const checkStatusPageDomain = onCall(CALLABLE_OPTS, async (request) => {
  const ctx = await resolveAccount(request, "write");
  await assertFeatureOpen(ctx);
  const { accountId } = ctx;
  const data = (request.data ?? {}) as Record<string, unknown>;
  const statusPageId = asStatusPageId(data.statusPageId);

  const page = await loadOwnedPage(statusPageId, accountId);
  const hostname = page.customDomain?.hostname;
  if (!hostname) throw new HttpsError("not-found", "This status page has no custom domain");

  const snap = await domains().doc(hostname).get();
  if (!snap.exists) {
    // Mirror without a reservation: repair it so the editor shows "no domain".
    await releaseDomain(hostname, { pageId: statusPageId, reason: "stale_mirror" });
    throw new HttpsError("not-found", "This status page has no custom domain");
  }
  const before = snap.data() as CustomDomainDoc;
  if (before.userId !== accountId || before.statusPageId !== statusPageId) {
    throw new HttpsError("permission-denied", "This hostname is connected to another status page");
  }

  const now = Date.now();
  const isAction = before.status === "failed" || before.status === "disabled";
  const last = checkThrottle.get(hostname) ?? 0;
  if (!isAction && now - last < CUSTOM_DOMAIN.checkThrottleMs) {
    return { customDomain: buildMirror(before) };
  }
  checkThrottle.set(hostname, now);
  if (checkThrottle.size > 5000) checkThrottle.clear();

  let start = before;
  if (before.status === "failed") {
    await assertEntitled(accountId);
    start = transition(before, { status: "pending", lastError: null, movedSince: null }, now);
    log("retry", { hostname, accountId, actorUid: ctx.actorUid });
  } else if (before.status === "disabled") {
    await assertEntitled(accountId);
    start = transition(before, {
      status: needsReverify(before, now) ? "pending" : "verifying", lastError: null, movedSince: null,
    }, now);
    log("reconnect", { hostname, accountId, actorUid: ctx.actorUid, reverify: start.status === "pending" });
  }

  const client = getCloudflareSaasClient();
  const after = await advanceDomain(start, now, client);
  // Persist against `before`, so a retry or reconnect that changed nothing
  // else still writes the new status.
  const saved = await persistDomain(before, after, client);
  return { customDomain: buildMirror(saved) };
});

/**
 * releaseStatusPageDomain({ statusPageId, accountId? }) -> { released: boolean }
 *
 * Not behind the kill switch: removing a domain or deleting a page must keep
 * working if the feature is switched off.
 */
export const releaseStatusPageDomain = onCall(CALLABLE_OPTS, async (request) => {
  const { accountId, actorUid } = await resolveAccount(request, "write");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const statusPageId = asStatusPageId(data.statusPageId);

  const page = await loadOwnedPage(statusPageId, accountId);
  const hostname = page.customDomain?.hostname;
  if (!hostname) return { released: false };

  const released = await releaseDomain(hostname, {
    expect: { userId: accountId, statusPageId }, pageId: statusPageId, reason: "owner",
  });
  if (!released) {
    // The reservation belongs elsewhere; just drop this page's stale mirror.
    await pages().doc(statusPageId).update({ customDomain: FieldValue.delete() });
  }
  log("release requested", { hostname, accountId, actorUid, statusPageId });
  return { released: true };
});
