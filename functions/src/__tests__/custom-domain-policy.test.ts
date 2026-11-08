import test from "node:test";
import assert from "node:assert/strict";

import {
  CUSTOM_DOMAIN,
  applyProviderState,
  buildMirror,
  decideClaim,
  describeTxtMiss,
  graceExpired,
  hasMeaningfulChange,
  needsReverify,
  newDomainDoc,
  normalizeHostname,
  setupExpired,
  transition,
  txtMatches,
  verifyRecordFor,
  verifyTokenFor,
  type CustomDomainDoc,
} from "../custom-domain-policy";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ok = (input: string) => {
  const r = normalizeHostname(input);
  assert.equal(r.ok, true, `expected ${input} to be accepted, got ${r.ok ? "" : r.error}`);
  return r.ok ? r.hostname : "";
};
const bad = (input: unknown) => {
  const r = normalizeHostname(input);
  assert.equal(r.ok, false, `expected ${String(input)} to be rejected`);
};

const doc = (overrides: Partial<CustomDomainDoc> = {}): CustomDomainDoc => ({
  ...newDomainDoc({ hostname: "status.acme.com", accountId: "owner", statusPageId: "page1", now: NOW - DAY }),
  ...overrides,
});

// ── normalization ──

test("normalizes case and a trailing dot", () => {
  assert.equal(ok("Status.ACME.com."), "status.acme.com");
});

test("accepts a pasted URL with scheme and trailing slash", () => {
  assert.equal(ok("https://status.acme.com/"), "status.acme.com");
  assert.equal(ok("  http://status.acme.com  "), "status.acme.com");
});

test("converts IDN to punycode", () => {
  assert.equal(ok("status.bücher.de"), "status.xn--bcher-kva.de");
});

test("accepts subdomains under multi-part suffixes", () => {
  assert.equal(ok("status.acme.co.uk"), "status.acme.co.uk");
});

test("rejects apex domains", () => {
  bad("acme.com");
  bad("acme.co.uk");
});

test("rejects paths, ports, queries and credentials", () => {
  bad("status.acme.com/status");
  bad("status.acme.com:8443");
  bad("status.acme.com?x=1");
  bad("user@status.acme.com");
});

test("rejects IP literals, wildcards and localhost", () => {
  bad("1.2.3.4");
  bad("[::1]");
  bad("*.acme.com");
  bad("localhost");
  bad("status.localhost");
});

test("rejects our own and our hosts' domains", () => {
  bad("status.exit1.dev");
  bad("exit1.dev");
  bad("foo.web.app");
  bad("foo.firebaseapp.com");
  bad("foo.cloudfunctions.net");
  bad("foo.vercel.app");
});

test("rejects names without a public suffix", () => {
  bad("status.acme.notarealtld");
  bad("intranet");
});

test("rejects too long names and labels", () => {
  bad(`${"a".repeat(64)}.acme.com`);
  bad(`${"a.".repeat(130)}acme.com`);
  bad("");
  bad(42);
});

// ── verification record ──

test("token is stable per account and hostname, 32 hex chars", () => {
  const a = verifyTokenFor("owner", "status.acme.com");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, verifyTokenFor("owner", "status.acme.com"));
  assert.notEqual(a, verifyTokenFor("other", "status.acme.com"));
});

test("verify record and TXT matching", () => {
  const token = verifyTokenFor("owner", "status.acme.com");
  const rec = verifyRecordFor("status.acme.com", token);
  assert.equal(rec.name, "_exit1-verify.status.acme.com");
  assert.equal(rec.value, `exit1-verify=${token}`);
  assert.equal(txtMatches([["v=spf1"], [`exit1-verify=${token.slice(0, 10)}`, token.slice(10)]], token), true);
  assert.equal(txtMatches([["exit1-verify=nope"]], token), false);
  assert.match(describeTxtMiss("status.acme.com", []), /not found yet/);
  assert.match(describeTxtMiss("status.acme.com", [["exit1-verify=nope"]]), /does not match/);
});

test("mirror carries the record and reasons only in their state", () => {
  const m = buildMirror(doc({ status: "failed", failedReason: "timeout", disabledReason: "owner" }));
  assert.equal(m.cnameTarget, CUSTOM_DOMAIN.cnameTarget);
  assert.equal(m.failedReason, "timeout");
  assert.equal(m.disabledReason, null);
  assert.equal("verifyToken" in m, false);
});

// ── claims ──

const domains = (n: number) => Array.from({ length: n }, (_, i) => ({ hostname: `s${i}.acme.com` }));

test("first claim creates", () => {
  const d = decideClaim({
    accountId: "owner", statusPageId: "p", hostname: "status.acme.com", now: NOW,
    existing: null, accountDomains: [], pageCurrentHost: null, claimantTxtVerified: false,
  });
  assert.deepEqual(d, { kind: "create", releaseHost: null, takeover: false });
});

test("the 11th domain is refused, disabled ones count", () => {
  const d = decideClaim({
    accountId: "owner", statusPageId: "p", hostname: "status.acme.com", now: NOW,
    existing: null, accountDomains: domains(10), pageCurrentHost: null, claimantTxtVerified: false,
  });
  assert.equal(d.kind, "error");
  if (d.kind === "error") assert.equal(d.code, "resource-exhausted");
});

test("replacing a page's own domain at the cap succeeds and releases the old one", () => {
  const d = decideClaim({
    accountId: "owner", statusPageId: "p", hostname: "new.acme.com", now: NOW,
    existing: null, accountDomains: domains(10), pageCurrentHost: "s3.acme.com", claimantTxtVerified: false,
  });
  assert.deepEqual(d, { kind: "create", releaseHost: "s3.acme.com", takeover: false });
});

test("re-claiming the same hostname on the same page is idempotent", () => {
  const d = decideClaim({
    accountId: "owner", statusPageId: "page1", hostname: "status.acme.com", now: NOW,
    existing: doc(), accountDomains: domains(10), pageCurrentHost: "status.acme.com", claimantTxtVerified: false,
  });
  assert.deepEqual(d, { kind: "existing" });
});

test("a hostname on another page of the same account is refused", () => {
  const d = decideClaim({
    accountId: "owner", statusPageId: "page2", hostname: "status.acme.com", now: NOW,
    existing: doc(), accountDomains: [], pageCurrentHost: null, claimantTxtVerified: true,
  });
  assert.equal(d.kind === "error" && d.code, "already-exists");
});

test("another account's verified claim holds even with TXT", () => {
  const d = decideClaim({
    accountId: "b", statusPageId: "pb", hostname: "status.acme.com", now: NOW,
    existing: doc({ status: "active", ownershipVerifiedAt: NOW - DAY }),
    accountDomains: [], pageCurrentHost: null, claimantTxtVerified: true,
  });
  assert.equal(d.kind === "error" && d.code, "already-exists");
});

test("an old unverified pending claim is taken over by an account that passes TXT", () => {
  const input = {
    accountId: "b", statusPageId: "pb", hostname: "status.acme.com", now: NOW,
    existing: doc({ createdAt: NOW - 2 * HOUR }), accountDomains: [], pageCurrentHost: null,
  };
  assert.deepEqual(decideClaim({ ...input, claimantTxtVerified: true }), { kind: "create", releaseHost: null, takeover: true });
  assert.equal(decideClaim({ ...input, claimantTxtVerified: false }).kind, "error");
  const young = decideClaim({ ...input, existing: doc({ createdAt: NOW - 10 * 60 * 1000 }), claimantTxtVerified: true });
  assert.equal(young.kind, "error");
});

test("a team editor's claim counts against the owner's account", () => {
  // Callables pass the resolved owner id as accountId; the owner's 10 docs are what count.
  const d = decideClaim({
    accountId: "owner", statusPageId: "p", hostname: "x.acme.com", now: NOW,
    existing: null, accountDomains: domains(10), pageCurrentHost: null, claimantTxtVerified: false,
  });
  assert.equal(d.kind, "error");
});

// ── transitions ──

test("transition stamps statusChangedAt and clears stale reasons", () => {
  const before = doc({ status: "failed", failedReason: "timeout" });
  const after = transition(before, { status: "pending" }, NOW);
  assert.equal(after.statusChangedAt, NOW);
  assert.equal(after.failedReason, null);
  assert.equal(hasMeaningfulChange(before, after), true);
  assert.equal(hasMeaningfulChange(before, transition(before, { lastCheckedAt: NOW }, NOW)), false);
});

test("setup expires after 72h in pending or verifying", () => {
  assert.equal(setupExpired(doc({ statusChangedAt: NOW - 73 * HOUR }), NOW), true);
  assert.equal(setupExpired(doc({ status: "verifying", statusChangedAt: NOW - 71 * HOUR }), NOW), false);
  assert.equal(setupExpired(doc({ status: "active", statusChangedAt: NOW - 100 * DAY }), NOW), false);
});

test("grace cleanup after 14 days disabled with a provider id", () => {
  assert.equal(graceExpired(doc({ status: "disabled", providerId: "cf1", statusChangedAt: NOW - 15 * DAY }), NOW), true);
  assert.equal(graceExpired(doc({ status: "disabled", providerId: "cf1", statusChangedAt: NOW - 13 * DAY }), NOW), false);
  assert.equal(graceExpired(doc({ status: "disabled", providerId: null, statusChangedAt: NOW - 15 * DAY }), NOW), false);
});

test("reconnect re-verifies after 30 days", () => {
  assert.equal(needsReverify(doc({ ownershipVerifiedAt: null }), NOW), true);
  assert.equal(needsReverify(doc({ ownershipVerifiedAt: NOW - 31 * DAY }), NOW), true);
  assert.equal(needsReverify(doc({ ownershipVerifiedAt: NOW - 29 * DAY }), NOW), false);
});

test("provider active turns verifying into active", () => {
  const d = applyProviderState(doc({ status: "verifying" }),
    { kind: "active", providerStatus: "active", sslStatus: "active", error: null }, NOW);
  assert.equal(d.status, "active");
  assert.equal(d.statusChangedAt, NOW);
});

test("provider blocked fails the domain", () => {
  const d = applyProviderState(doc({ status: "active" }),
    { kind: "blocked", providerStatus: "blocked", sslStatus: null, error: null }, NOW);
  assert.equal(d.status, "failed");
  assert.equal(d.failedReason, "blocked");
});

test("moved keeps an active domain for 7 days, then fails it", () => {
  const moved = { kind: "moved" as const, providerStatus: "moved", sslStatus: "active", error: "CNAME moved" };
  const first = applyProviderState(doc({ status: "active" }), moved, NOW);
  assert.equal(first.status, "active");
  assert.equal(first.movedSince, NOW);
  const later = applyProviderState(first, moved, NOW + 8 * DAY);
  assert.equal(later.status, "failed");
  assert.equal(later.failedReason, "moved");
  const back = applyProviderState(first, { kind: "active", providerStatus: "active", sslStatus: "active", error: null }, NOW + DAY);
  assert.equal(back.movedSince, null);
});

test("a renewing certificate does not demote an active domain", () => {
  const d = applyProviderState(doc({ status: "active" }),
    { kind: "pending", providerStatus: "active", sslStatus: "pending_validation", error: "x" }, NOW);
  assert.equal(d.status, "active");
  assert.equal(d.sslStatus, "pending_validation");
});

test("disabled docs only record raw provider fields", () => {
  const d = applyProviderState(doc({ status: "disabled" }),
    { kind: "active", providerStatus: "active", sslStatus: "active", error: null }, NOW);
  assert.equal(d.status, "disabled");
  assert.equal(d.providerStatus, "active");
});
