import test from "node:test";
import assert from "node:assert/strict";

import {
  decideDaily,
  decideProviderDrift,
  graceExpired,
  newDomainDoc,
  tierHasCustomDomain,
  type CustomDomainDoc,
} from "../custom-domain-policy";
import { TIER_LIMITS } from "../config";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const doc = (overrides: Partial<CustomDomainDoc> = {}): CustomDomainDoc => ({
  ...newDomainDoc({ hostname: "status.acme.com", accountId: "owner", statusPageId: "page1", now: NOW - DAY }),
  ...overrides,
});
const page = { userId: "owner", customHost: "status.acme.com" };

test("only Pro is entitled", () => {
  assert.equal(tierHasCustomDomain(TIER_LIMITS, "pro"), true);
  for (const t of ["free", "indie", "nano", "bogus"]) assert.equal(tierHasCustomDomain(TIER_LIMITS, t), false);
});

test("lost tier disables a domain that is not disabled yet", () => {
  assert.equal(decideDaily({ doc: doc({ status: "active" }), page, entitled: false, now: NOW }), "disable");
  assert.equal(decideDaily({ doc: doc({ status: "pending" }), page, entitled: false, now: NOW }), "disable");
  assert.equal(decideDaily({ doc: doc({ status: "disabled" }), page, entitled: false, now: NOW }), null);
});

test("an unknown tier (failed open) does nothing", () => {
  assert.equal(decideDaily({ doc: doc({ status: "active" }), page, entitled: null, now: NOW }), null);
});

test("entitled and healthy does nothing", () => {
  assert.equal(decideDaily({ doc: doc({ status: "active" }), page, entitled: true, now: NOW }), null);
});

test("orphans are released: page gone, page moved account, page points elsewhere", () => {
  assert.equal(decideDaily({ doc: doc(), page: null, entitled: true, now: NOW }), "release");
  assert.equal(decideDaily({ doc: doc(), page: { ...page, userId: "x" }, entitled: true, now: NOW }), "release");
  assert.equal(decideDaily({ doc: doc(), page: { ...page, customHost: "other.acme.com" }, entitled: true, now: NOW }), "release");
  assert.equal(decideDaily({ doc: doc(), page: { ...page, customHost: null }, entitled: true, now: NOW }), "release");
});

test("never-verified failed claims are released after 7 days", () => {
  const old = doc({ status: "failed", ownershipVerifiedAt: null, statusChangedAt: NOW - 8 * DAY });
  assert.equal(decideDaily({ doc: old, page, entitled: true, now: NOW }), "release");
  const recent = doc({ status: "failed", ownershipVerifiedAt: null, statusChangedAt: NOW - 6 * DAY });
  assert.equal(decideDaily({ doc: recent, page, entitled: true, now: NOW }), null);
  const verified = doc({ status: "failed", ownershipVerifiedAt: NOW - 30 * DAY, statusChangedAt: NOW - 8 * DAY });
  assert.equal(decideDaily({ doc: verified, page, entitled: true, now: NOW }), null);
});

test("drift: hostnames without a doc are deleted, lost ids adopted, strays deleted", () => {
  const docs = new Map<string, Pick<CustomDomainDoc, "status" | "providerId">>([
    ["a.acme.com", { status: "active", providerId: "id-a" }],
    ["b.acme.com", { status: "verifying", providerId: null }],
    ["c.acme.com", { status: "pending", providerId: null }],
    ["d.acme.com", { status: "active", providerId: "id-d-new" }],
  ]);
  const result = decideProviderDrift([
    { id: "id-a", hostname: "a.acme.com" },
    { id: "id-b", hostname: "B.acme.com" },
    { id: "id-c", hostname: "c.acme.com" },
    { id: "id-d-old", hostname: "d.acme.com" },
    { id: "id-x", hostname: "nobody.example.com" },
  ], docs);
  assert.deepEqual(result.adopt, [{ hostname: "b.acme.com", id: "id-b" }]);
  assert.deepEqual(result.deleteIds.sort(), ["id-c", "id-d-old", "id-x"]);
});

test("grace cleanup only for disabled docs past 14 days", () => {
  assert.equal(graceExpired(doc({ status: "disabled", providerId: "p", statusChangedAt: NOW - 15 * DAY }), NOW), true);
  assert.equal(graceExpired(doc({ status: "active", providerId: "p", statusChangedAt: NOW - 15 * DAY }), NOW), false);
});
