import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG, LEGACY_FREE_CHECKS_CUTOFF_MS, LEGACY_FREE_MAX_CHECKS, TIER_LIMITS } from "../config";

// ── Grandfathered Free check cap ────────────────────────────────────────────
//
// Free went 10 → 5 in the Indie restructure with no migration, stranding ~91
// existing users above the new cap. The override lifts them back to 10 and must
// do so at every gate that can refuse an action — most importantly re-enabling a
// check they already own.
//
// The pairing that matters: the override applies to Free ONLY, and only when the
// flag is set. Everything else must read straight off TIER_LIMITS, or the cut
// silently never happened for new signups either.

test("free without the override gets the current, reduced cap", () => {
  assert.equal(CONFIG.getMaxChecksForTier("free"), 5);
  assert.equal(CONFIG.getMaxChecksForTier("free", {}), 5);
  assert.equal(CONFIG.getMaxChecksForTier("free", { legacyFreeChecks: false }), 5);
});

test("free with the override gets the legacy cap", () => {
  assert.equal(CONFIG.getMaxChecksForTier("free", { legacyFreeChecks: true }), LEGACY_FREE_MAX_CHECKS);
  assert.equal(CONFIG.getMaxChecksForTier("free", { legacyFreeChecks: true }), 10);
});

test("the override never lowers a cap, whatever TIER_LIMITS says", () => {
  // Guards the direction of the Math.max: if Free is ever raised above 10, a
  // grandfathered user must keep the higher number, not be pinned to the legacy
  // one.
  assert.ok(
    CONFIG.getMaxChecksForTier("free", { legacyFreeChecks: true }) >= TIER_LIMITS.free.maxChecks
  );
});

test("paid tiers ignore the override entirely", () => {
  for (const tier of ["indie", "nano", "pro"] as const) {
    assert.equal(
      CONFIG.getMaxChecksForTier(tier, { legacyFreeChecks: true }),
      TIER_LIMITS[tier].maxChecks,
      `${tier} must not be affected by the legacy Free override`
    );
  }
});

test("the legacy cap does not exceed the cheapest paid tier", () => {
  // Indie sells "10 checks, watched closely". If grandfathered Free ever beat
  // Indie's check count, the upgrade path would be selling a downgrade.
  assert.ok(LEGACY_FREE_MAX_CHECKS <= TIER_LIMITS.indie.maxChecks);
});

test("the cutoff is a real timestamp on the far side of the restructure", () => {
  // c80880a (the commit that cut the cap) landed 2026-07-29; the cutoff rounds
  // forward so anyone who signed up that day is grandfathered rather than caught
  // by a deploy-time race.
  assert.ok(Number.isFinite(LEGACY_FREE_CHECKS_CUTOFF_MS));
  assert.ok(LEGACY_FREE_CHECKS_CUTOFF_MS > Date.parse("2026-07-29T00:00:00Z"));
  // And it must be in the past — a future cutoff would grandfather new signups.
  assert.ok(LEGACY_FREE_CHECKS_CUTOFF_MS < Date.now());
});
