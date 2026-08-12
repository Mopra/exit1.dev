import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG, TIER_LIMITS, type Tier } from "../config";

// ── Tier ladder invariants ──────────────────────────────────────────────────
//
// Replaces the retired legacy-free-checks suite. Those tests guarded one
// grandfathering flag; these guard the shape of the ladder itself, which is the
// thing that actually rotted last time — Indie shipped 15s intervals while the
// more expensive Nano shipped 2min, and the app carried a `ceilingTightens`
// special case plus a "do not correct this" note in PRICING.md for a year.
//
// If a repricing wants to break one of these, the assertion is the place to
// have the argument.

const LADDER: readonly Tier[] = ["free", "indie", "nano", "pro"];

/** Every consecutive (cheaper, dearer) pair on the ladder. */
const STEPS = LADDER.slice(0, -1).map((from, i) => [from, LADDER[i + 1]] as const);

test("every tier in the union has a TIER_LIMITS row", () => {
  for (const tier of LADDER) {
    assert.ok(TIER_LIMITS[tier], `${tier} is missing from TIER_LIMITS`);
  }
  assert.equal(Object.keys(TIER_LIMITS).length, LADDER.length);
});

test("numeric caps never shrink as price rises", () => {
  const dimensions = [
    "maxChecks",
    "maxWebhooks",
    "maxApiKeys",
    "maxStatusPages",
    "emailHourly",
    "emailMonthly",
    "smsHourly",
    "smsMonthly",
    "retentionDays",
    "teamSeats",
  ] as const;

  for (const [from, to] of STEPS) {
    for (const dim of dimensions) {
      assert.ok(
        TIER_LIMITS[to][dim] >= TIER_LIMITS[from][dim],
        `${to}.${dim} (${TIER_LIMITS[to][dim]}) must not be below ${from}.${dim} (${TIER_LIMITS[from][dim]})`
      );
    }
  }
});

test("check intervals get faster, never slower, as price rises", () => {
  // The interval is a floor, so "better" means a SMALLER number. This is the
  // invariant the old lineup violated.
  for (const [from, to] of STEPS) {
    assert.ok(
      TIER_LIMITS[to].minCheckIntervalMinutes <= TIER_LIMITS[from].minCheckIntervalMinutes,
      `${to} (${TIER_LIMITS[to].minCheckIntervalMinutes}min) must probe at least as fast as ${from} (${TIER_LIMITS[from].minCheckIntervalMinutes}min)`
    );
  }
});

test("feature flags are never revoked as price rises", () => {
  const flags = [
    "statusPageBuilder",
    "domainIntel",
    "maintenanceMode",
    "smsAlerts",
    "apiAccess",
    "csvExport",
    "slaReporting",
    "customStatusDomain",
    "allAlertChannels",
    "regionChoice",
  ] as const;

  for (const [from, to] of STEPS) {
    for (const flag of flags) {
      if (TIER_LIMITS[from][flag]) {
        assert.ok(
          TIER_LIMITS[to][flag],
          `${to} must not lose '${flag}', which ${from} has`
        );
      }
    }
  }
});

test("the hourly email cap covers a total outage on every tier", () => {
  // The blast radius of one provider going down is every monitor at once. If
  // the hourly cap is below the check cap, the alerts that get dropped are
  // dropped during the exact incident the product exists for.
  for (const tier of LADDER) {
    assert.ok(
      TIER_LIMITS[tier].emailHourly >= TIER_LIMITS[tier].maxChecks,
      `${tier} can hold ${TIER_LIMITS[tier].maxChecks} checks but only sends ${TIER_LIMITS[tier].emailHourly} emails/hour — a full outage would be silently truncated`
    );
  }
});

test("the monthly email cap leaves room for repeat incidents", () => {
  // One incident costs 2 emails (down + up). Six per monitor per month is the
  // floor we designed to; below that the cap becomes the de-facto product limit
  // instead of the monitor count.
  for (const tier of LADDER) {
    const perMonitor = TIER_LIMITS[tier].emailMonthly / TIER_LIMITS[tier].maxChecks;
    assert.ok(
      perMonitor >= 6,
      `${tier} allows only ${perMonitor} emails per monitor per month (need >= 6)`
    );
  }
});

test("the monthly cap is never below the hourly cap", () => {
  for (const tier of LADDER) {
    assert.ok(TIER_LIMITS[tier].emailMonthly >= TIER_LIMITS[tier].emailHourly);
    assert.ok(TIER_LIMITS[tier].smsMonthly >= TIER_LIMITS[tier].smsHourly);
  }
});

test("SMS budget is non-zero exactly when smsAlerts is on", () => {
  for (const tier of LADDER) {
    const { smsAlerts, smsHourly, smsMonthly } = TIER_LIMITS[tier];
    assert.equal(
      smsAlerts,
      smsMonthly > 0,
      `${tier}: smsAlerts=${smsAlerts} contradicts smsMonthly=${smsMonthly}`
    );
    if (!smsAlerts) assert.equal(smsHourly, 0);
  }
});

test("apiAccess is non-zero exactly when the tier can mint keys", () => {
  // MCP access follows API access — there is no separate entitlement — so a
  // tier claiming apiAccess with a cap of 0 would advertise a dead feature.
  for (const tier of LADDER) {
    const { apiAccess, maxApiKeys } = TIER_LIMITS[tier];
    assert.equal(
      apiAccess,
      maxApiKeys > 0,
      `${tier}: apiAccess=${apiAccess} contradicts maxApiKeys=${maxApiKeys}`
    );
  }
});

test("no tier can probe faster than the scheduler floor", () => {
  // getNextCheckAtMs clamps to 0.25min; a tier promising faster would be
  // selling an interval the runner silently refuses to honour.
  for (const tier of LADDER) {
    assert.ok(
      TIER_LIMITS[tier].minCheckIntervalMinutes >= 0.25,
      `${tier} promises ${TIER_LIMITS[tier].minCheckIntervalMinutes}min, below the 15s hard floor`
    );
  }
});

test("the default check frequency is legal on the free tier", () => {
  // New checks are created at DEFAULT_CHECK_FREQUENCY_MINUTES without a tier
  // check in some paths; if it ever drops below the Free floor, free signups
  // would create checks that immediately fail validation on their next edit.
  assert.ok(
    CONFIG.DEFAULT_CHECK_FREQUENCY_MINUTES >= TIER_LIMITS.free.minCheckIntervalMinutes
  );
});

test("unknown-tier email fallbacks are not stingier than Free", () => {
  // These fire when a tier can't be resolved. Degrading below the weakest real
  // tier turns a lookup blip into dropped alerts.
  assert.ok(CONFIG.EMAIL_USER_BUDGET_MAX_PER_WINDOW >= TIER_LIMITS.free.emailHourly);
  assert.ok(
    CONFIG.EMAIL_USER_MONTHLY_BUDGET_MAX_PER_WINDOW >= TIER_LIMITS.free.emailMonthly
  );
});

test("the *ForTier helpers agree with the table they read from", () => {
  for (const tier of LADDER) {
    const row = CONFIG.getTierLimits(tier);
    assert.equal(CONFIG.getMaxChecksForTier(tier), row.maxChecks);
    assert.equal(CONFIG.getMaxWebhooksForTier(tier), row.maxWebhooks);
    assert.equal(CONFIG.getMaxApiKeysForTier(tier), row.maxApiKeys);
    assert.equal(CONFIG.getHistoryRetentionDaysForTier(tier), row.retentionDays);
    assert.equal(CONFIG.getMinCheckIntervalMinutesForTier(tier), row.minCheckIntervalMinutes);
    assert.equal(CONFIG.getEmailBudgetMaxPerWindowForTier(tier), row.emailHourly);
    assert.equal(CONFIG.getEmailMonthlyBudgetMaxPerWindowForTier(tier), row.emailMonthly);
    assert.equal(CONFIG.getSmsBudgetMaxPerWindowForTier(tier), row.smsHourly);
    assert.equal(CONFIG.getSmsMonthlyBudgetMaxPerWindowForTier(tier), row.smsMonthly);
    assert.equal(CONFIG.getMinCheckIntervalSecondsForTier(tier), row.minCheckIntervalMinutes * 60);
  }
});

test("validateCheckFrequencyForTier enforces exactly the tier floor", () => {
  for (const tier of LADDER) {
    const floor = TIER_LIMITS[tier].minCheckIntervalMinutes;
    assert.equal(CONFIG.validateCheckFrequencyForTier(floor, tier).valid, true);
    const below = CONFIG.validateCheckFrequencyForTier(floor / 2, tier);
    assert.equal(below.valid, false, `${tier} accepted an interval below its floor`);
    assert.equal(below.minAllowed, floor);
  }
});

test("DNS intervals stay slower than the general check interval", () => {
  // DNS queries cost far more than an HTTP probe, so the DNS floor is set
  // independently. Nano probing HTTP at 30s must not drag DNS down with it.
  for (const tier of LADDER) {
    const dns = CONFIG.getMinDnsCheckIntervalMinutesForTier(tier);
    if (dns === 0) continue; // 0 = DNS not available on this tier
    assert.ok(
      dns >= TIER_LIMITS[tier].minCheckIntervalMinutes,
      `${tier} DNS floor (${dns}min) must not be faster than its check floor`
    );
  }
});

test("free is the only tier without DNS monitoring", () => {
  assert.equal(CONFIG.getMinDnsCheckIntervalMinutesForTier("free"), 0);
  for (const tier of ["indie", "nano", "pro"] as const) {
    assert.ok(CONFIG.getMinDnsCheckIntervalMinutesForTier(tier) > 0);
  }
});
