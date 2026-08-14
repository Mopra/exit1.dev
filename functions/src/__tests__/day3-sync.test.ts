import test from "node:test";
import assert from "node:assert/strict";

import {
  assertStringAttributes,
  buildDay3Payload,
  chunkForDay3,
  dedupeByEmail,
  normalizeDay3Email,
  type Day3ContactInput,
} from "../day3-sync";
import { buildPropertiesForUser } from "../contact-model";

const contact = (email: string, extra: Partial<Day3ContactInput> = {}): Day3ContactInput => ({
  email,
  attributes: { plan_tier: "free" },
  ...extra,
});

// ── Email canonicalization ──────────────────────────────────────────────────
// Day3 trims and lowercases before anything else, so our view of identity has
// to match its view or we send it duplicates.

test("normalizeDay3Email lowercases and trims", () => {
  assert.equal(normalizeDay3Email("  Ada@Acme.com "), "ada@acme.com");
  assert.equal(normalizeDay3Email("ada@acme.com"), "ada@acme.com");
});

// ── Dedupe ──────────────────────────────────────────────────────────────────
// A duplicate inside one payload rejects the ENTIRE batch, so this is the guard
// that keeps one bad pair of Clerk users from failing 1,000 imports.

test("dedupeByEmail collapses case-only duplicates", () => {
  const result = dedupeByEmail([contact("Ada@Acme.com"), contact("ada@acme.com")]);
  assert.equal(result.length, 1);
});

test("dedupeByEmail collapses whitespace-only duplicates", () => {
  const result = dedupeByEmail([contact("ada@acme.com"), contact(" ada@acme.com ")]);
  assert.equal(result.length, 1);
});

test("dedupeByEmail keeps the last occurrence so fresher data wins", () => {
  const result = dedupeByEmail([
    contact("ada@acme.com", { attributes: { plan_tier: "free" } }),
    contact("ADA@acme.com", { attributes: { plan_tier: "pro" } }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].attributes.plan_tier, "pro");
});

test("dedupeByEmail leaves distinct addresses alone", () => {
  const result = dedupeByEmail([
    contact("ada@acme.com"),
    contact("grace@acme.com"),
    contact("alan@acme.com"),
  ]);
  assert.equal(result.length, 3);
});

test("dedupeByEmail handles an empty list", () => {
  assert.deepEqual(dedupeByEmail([]), []);
});

// ── Attribute value coercion ────────────────────────────────────────────────
// A non-string attribute value fails schema validation and rejects the whole
// batch — not just the offending row. Coercing at the boundary means one stray
// Firestore number can't take down an entire import.

test("assertStringAttributes passes strings through untouched", () => {
  const out = assertStringAttributes({ plan_tier: "pro", team_size: "2_5" }, "test");
  assert.deepEqual(out, { plan_tier: "pro", team_size: "2_5" });
});

test("assertStringAttributes stringifies numbers and booleans", () => {
  const out = assertStringAttributes({ orders: 5, active: true }, "test");
  assert.deepEqual(out, { orders: "5", active: "true" });
});

test("assertStringAttributes drops null and undefined rather than sending 'null'", () => {
  const out = assertStringAttributes(
    { a: "keep", b: null, c: undefined },
    "test",
  );
  assert.deepEqual(out, { a: "keep" });
});

// ── Opt-out carry-over ──────────────────────────────────────────────────────
// Resend holds the only copy of unsubscribe state; Day3 was seeded
// contacts-only. These lock in the two halves of the rule: WRITE the opt-out,
// and never write the opt-in. Getting the second half wrong silently
// re-subscribes every opted-out contact on every backfill re-run, and the only
// symptom is mail landing in the inbox of someone who asked you to stop.

test("an unsubscribed contact carries status: unsubscribed", () => {
  const payload = buildDay3Payload(contact("ada@acme.com", { unsubscribed: true }), "test");
  assert.equal(payload.status, "unsubscribed");
});

test("a subscribed contact writes NO status at all", () => {
  // Omission is what preserves a Day3-native opt-out across a re-run —
  // verified against the live API. An explicit "subscribed" would undo it.
  const payload = buildDay3Payload(contact("ada@acme.com", { unsubscribed: false }), "test");
  assert.equal("status" in payload, false);
});

test("an unspecified opt-out state writes no status either", () => {
  const payload = buildDay3Payload(contact("ada@acme.com"), "test");
  assert.equal("status" in payload, false);
});

test("the opt-out never travels as unsubscribed_at, which batch silently drops", () => {
  const payload = buildDay3Payload(contact("ada@acme.com", { unsubscribed: true }), "test");
  assert.equal("unsubscribed_at" in payload, false);
});

test("dedupe keeps the opt-out when the last write carries it", () => {
  const result = dedupeByEmail([
    contact("ada@acme.com"),
    contact("ADA@acme.com", { unsubscribed: true }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].unsubscribed, true);
});

// ── Chunking ────────────────────────────────────────────────────────────────

test("chunkForDay3 splits on the requested size", () => {
  const items = Array.from({ length: 2500 }, (_, i) => i);
  const chunks = chunkForDay3(items, 1000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 1000);
  assert.equal(chunks[2].length, 500);
});

test("chunkForDay3 returns nothing for an empty list", () => {
  assert.deepEqual(chunkForDay3([], 1000), []);
});

// ── Model compatibility ─────────────────────────────────────────────────────
// The whole dual-write design rests on buildPropertiesForUser being safe to
// hand to Day3 unchanged. Lock that in.

test("buildPropertiesForUser emits only string values", () => {
  const props = buildPropertiesForUser({
    signupDate: "2026-01-15",
    tier: "nano",
    onboarding: { sources: ["reddit"], useCases: ["saas"], teamSize: "2_5" },
  });

  for (const [key, value] of Object.entries(props)) {
    assert.equal(typeof value, "string", `${key} should be a string`);
  }
  assert.equal(props.plan_tier, "nano");
  assert.equal(props.source_reddit, "true");
  assert.equal(props.source_google, "false");
  assert.equal(props.use_case_saas, "true");
});

test("buildPropertiesForUser omits onboarding keys when there are no answers", () => {
  const props = buildPropertiesForUser({ signupDate: null, tier: "free", onboarding: null });
  assert.deepEqual(Object.keys(props), ["plan_tier"]);
  // Omission matters: Day3 shallow-merges attributes, so an absent key preserves
  // whatever is already stored instead of blanking a real value.
  assert.equal("team_size" in props, false);
});

test("buildPropertiesForUser never emits reserved Day3 column names", () => {
  const props = buildPropertiesForUser({
    signupDate: "2026-01-15",
    tier: "pro",
    onboarding: { sources: [], useCases: [], teamSize: null },
  });
  for (const reserved of ["email", "first_name", "last_name"]) {
    assert.equal(reserved in props, false, `${reserved} must stay a top-level field`);
  }
});
