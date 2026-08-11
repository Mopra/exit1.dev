import test from "node:test";
import assert from "node:assert/strict";

import {
  decideSmsTier,
  isConclusiveCachedTier,
  isTierDriftUnderstated,
  normalizeTierValue,
} from "../sms-tier";

// Regression coverage for the silent SMS blackout.
//
// SMS is the only Pro-exclusive feature gated off `check.userTier`, a
// denormalised copy of the user's tier on each check doc. `backfillCheckUserTier`
// re-stamps that copy on downgrades and on subscription-webhook upgrades — but a
// Pro grant made via Clerk publicMetadata (`lifetimeNano`, `admin`) fires no
// subscription webhook, so nothing backfilled and checks created during the
// user's Nano era stayed stamped 'nano' forever.
//
// The alert gate is `smsTier !== 'pro'`, and it returned early with
// smsOutcome='tier' — no send, no error, no retry. Email has no tier gate, so
// the user got the email and no text, with nothing to indicate why. The bug was
// reported by a Pro customer whose site returned HTTP 500 and who received the
// down email but no SMS on any of four configured numbers.
//
// The invariant: a non-Pro value on the CHECK doc must never be enough to deny
// SMS on its own.

test("the reported bug: check doc says nano, user doc says pro — SMS must be allowed", () => {
  assert.equal(
    decideSmsTier("nano", "pro", false),
    "pro",
    "a stale 'nano' on the check doc must not suppress a Pro user's SMS",
  );
});

test("a stale check tier is not conclusive on its own, so the user doc is consulted", () => {
  assert.equal(isConclusiveCachedTier("nano"), false);
  assert.equal(isConclusiveCachedTier("indie"), false);
  assert.equal(isConclusiveCachedTier("free"), false);
  assert.equal(isConclusiveCachedTier(undefined), false);
  // 'pro' can never under-state entitlements, so it short-circuits the reads.
  assert.equal(isConclusiveCachedTier("pro"), true);
  assert.equal(isConclusiveCachedTier("scale"), true, "legacy scale maps to pro");
  assert.equal(isConclusiveCachedTier("agency"), true, "legacy agency maps to pro");
});

test("a fresh check stamped pro still wins when the user doc lags behind", () => {
  // The reverse drift: a check created right after an upgrade is stamped 'pro'
  // at creation time while a stale user doc still reads 'nano'.
  assert.equal(decideSmsTier("pro", "nano", false), "pro");
});

test("admins are treated as Pro regardless of either stored tier", () => {
  assert.equal(decideSmsTier("free", "free", true), "pro");
  assert.equal(decideSmsTier(undefined, null, true), "pro");
});

test("genuinely non-Pro users are still denied — the gate is not defeated", () => {
  assert.equal(decideSmsTier("nano", "nano", false), "nano");
  assert.equal(decideSmsTier("free", "free", false), "free");
  assert.equal(decideSmsTier("indie", "indie", false), "indie");
  assert.equal(decideSmsTier("nano", "free", false), "free");
});

test("an unreadable user doc falls back to the check doc rather than escalating", () => {
  // null = read failed / field missing. It must not be treated as Pro (that
  // would hand SMS to free users on a transient Firestore error) nor as 'free'
  // when the check doc knows better.
  assert.equal(decideSmsTier("nano", null, false), "nano");
  assert.equal(decideSmsTier("free", null, false), "free");
  assert.equal(decideSmsTier(undefined, null, false), "free");
});

test("legacy tier values map onto the current lineup", () => {
  assert.equal(normalizeTierValue("scale"), "pro");
  assert.equal(normalizeTierValue("agency"), "pro");
  assert.equal(normalizeTierValue("premium"), "nano");
  assert.equal(normalizeTierValue("pro"), "pro");
  assert.equal(normalizeTierValue("nano"), "nano");
  assert.equal(normalizeTierValue("indie"), "indie");
  assert.equal(normalizeTierValue("free"), "free");
});

test("unrecognised values are 'unknown', never silently 'free'", () => {
  assert.equal(normalizeTierValue(undefined), null);
  assert.equal(normalizeTierValue(null), null);
  assert.equal(normalizeTierValue(""), null);
  assert.equal(normalizeTierValue("enterprise"), null);
  assert.equal(normalizeTierValue(42), null);
});

test("legacy 'premium' on a check does not suppress a Pro user's SMS", () => {
  assert.equal(decideSmsTier("premium", "pro", false), "pro");
});

test("drift detection flags exactly the under-stating cases", () => {
  // Understated — the failure mode that loses alerts.
  assert.equal(isTierDriftUnderstated("nano", "pro"), true);
  assert.equal(isTierDriftUnderstated("free", "nano"), true);
  assert.equal(isTierDriftUnderstated("indie", "pro"), true);
  assert.equal(isTierDriftUnderstated(undefined, "pro"), true);

  // In sync — nothing to report.
  assert.equal(isTierDriftUnderstated("pro", "pro"), false);
  assert.equal(isTierDriftUnderstated("nano", "nano"), false);
  assert.equal(isTierDriftUnderstated("scale", "pro"), false, "legacy alias, not drift");
  assert.equal(isTierDriftUnderstated("premium", "nano"), false, "legacy alias, not drift");

  // Overstated — the check doc is ahead of the user doc. Not this bug, and not
  // something to warn about (a post-upgrade check doc legitimately leads).
  assert.equal(isTierDriftUnderstated("pro", "nano"), false);

  // Unknown authoritative value — cannot conclude drift either way.
  assert.equal(isTierDriftUnderstated("nano", null), false);
  assert.equal(isTierDriftUnderstated("nano", undefined), false);
});
