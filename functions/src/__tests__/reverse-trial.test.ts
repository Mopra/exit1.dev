import test from "node:test";
import assert from "node:assert/strict";

import {
  applyReverseTrial,
  cachedPaidTier,
  decideReverseTrialExpiry,
  decideReverseTrialReminder,
  decideReverseTrialStart,
  isReverseTrialActive,
  readReverseTrial,
  reverseTrialDaysLeft,
  shouldSendEndedEmail,
  shouldStampConversion,
  trialCacheExpired,
  REVERSE_TRIAL_DURATION_MS,
  REVERSE_TRIAL_FEATURE_START_MS,
  REVERSE_TRIAL_START_MAX_DELAY_MS,
  REVERSE_TRIAL_TIER,
  type ReverseTrialState,
  type Tier,
} from "../reverse-trial-policy";
import { decideTrialInvite, TRIAL_INVITE_1_AFTER_MS } from "../lifecycle-policy";
import {
  buildReverseTrialEnded,
  buildReverseTrialReminder,
  REVERSE_TRIAL_KEEP_URL,
} from "../reverse-trial-email";
import { TIER_LIMITS } from "../config";

const DAY = 24 * 60 * 60 * 1000;
const SIGNUP = REVERSE_TRIAL_FEATURE_START_MS + 3 * DAY;
const NONE = readReverseTrial(null);

function running(startedAt = SIGNUP): ReverseTrialState {
  return { ...NONE, startedAt, endsAt: startedAt + REVERSE_TRIAL_DURATION_MS };
}

// ── start ───────────────────────────────────────────────────────────────────

test("start: a new signup gets 7 days of Nano", () => {
  const d = decideReverseTrialStart({ createdAt: SIGNUP, now: SIGNUP + 1000, existing: NONE, agentUnclaimed: false });
  assert.ok("start" in d);
  assert.equal(d.start.endsAt - d.start.startedAt, 7 * DAY);
  assert.equal(REVERSE_TRIAL_TIER, "nano");
});

test("start: never twice, so a webhook retry cannot extend a trial", () => {
  const d = decideReverseTrialStart({ createdAt: SIGNUP, now: SIGNUP + 1000, existing: running(), agentUnclaimed: false });
  assert.deepEqual(d, { skip: "already_started" });
});

test("start: accounts created before the feature never get one", () => {
  const before = REVERSE_TRIAL_FEATURE_START_MS - 1;
  assert.deepEqual(
    decideReverseTrialStart({ createdAt: before, now: before + 1000, existing: NONE, agentUnclaimed: false }),
    { skip: "before_feature" },
  );
});

test("start: a late webhook replay does not start one", () => {
  assert.deepEqual(
    decideReverseTrialStart({
      createdAt: SIGNUP,
      now: SIGNUP + REVERSE_TRIAL_START_MAX_DELAY_MS + 1,
      existing: NONE,
      agentUnclaimed: false,
    }),
    { skip: "stale_signup" },
  );
});

test("start: unclaimed agent signups and unknown dates are skipped", () => {
  assert.deepEqual(
    decideReverseTrialStart({ createdAt: SIGNUP, now: SIGNUP, existing: NONE, agentUnclaimed: true }),
    { skip: "agent_unclaimed" },
  );
  assert.deepEqual(
    decideReverseTrialStart({ createdAt: null, now: SIGNUP, existing: NONE, agentUnclaimed: false }),
    { skip: "unknown_signup" },
  );
});

// ── tier overlay ────────────────────────────────────────────────────────────

test("overlay: free becomes nano while the trial runs", () => {
  assert.deepEqual(applyReverseTrial("free", running(), SIGNUP + DAY), { tier: "nano", source: "reverse_trial" });
});

test("overlay: a paid tier is never touched, up or down", () => {
  for (const paid of ["indie", "nano", "pro"] as Tier[]) {
    assert.deepEqual(applyReverseTrial(paid, running(), SIGNUP + DAY), { tier: paid, source: "clerk" });
  }
});

test("overlay: free stays free with no trial, after it ends, or after converting", () => {
  assert.equal(applyReverseTrial("free", NONE, SIGNUP).tier, "free");
  assert.equal(applyReverseTrial("free", running(), SIGNUP + 7 * DAY).tier, "free");
  assert.equal(applyReverseTrial("free", { ...running(), convertedAt: SIGNUP + DAY }, SIGNUP + 2 * DAY).tier, "free");
  assert.equal(applyReverseTrial("free", { ...running(), expiredAt: SIGNUP + DAY }, SIGNUP + 2 * DAY).tier, "free");
});

test("overlay: the last millisecond is inside, the end is outside", () => {
  const s = running();
  assert.equal(isReverseTrialActive(s, s.endsAt - 1), true);
  assert.equal(isReverseTrialActive(s, s.endsAt), false);
});

test("cache: a tier cached from an ended trial is stale and reads as free", () => {
  const s = { ...running(), tierSource: "reverse_trial" as const };
  assert.equal(trialCacheExpired(s, SIGNUP + DAY), false);
  assert.equal(trialCacheExpired(s, SIGNUP + 8 * DAY), true);
  assert.equal(cachedPaidTier("nano", s), "free");
  // A cache written from Clerk is Clerk's answer, whatever the trial says.
  assert.equal(cachedPaidTier("nano", { ...s, tierSource: "clerk" }), "nano");
  assert.equal(trialCacheExpired({ ...s, tierSource: "clerk" }, SIGNUP + 8 * DAY), false);
});

test("conversion: stamped the first time a paid tier shows on a trial account", () => {
  assert.equal(shouldStampConversion("indie", running()), true);
  assert.equal(shouldStampConversion("free", running()), false);
  assert.equal(shouldStampConversion("nano", NONE), false);
  assert.equal(shouldStampConversion("nano", { ...running(), convertedAt: 1 }), false);
});

test("readReverseTrial: junk fields read as no trial", () => {
  const s = readReverseTrial({ reverseTrialStartedAt: "x", reverseTrialEndsAt: -5, tierSource: "nope" });
  assert.deepEqual(s, NONE);
});

// ── expiry and downgrade ────────────────────────────────────────────────────

const AFTER = SIGNUP + REVERSE_TRIAL_DURATION_MS + 1000;

test("expiry: not before the week is over", () => {
  assert.deepEqual(
    decideReverseTrialExpiry({ s: running(), now: AFTER - 2 * DAY, paid: { tier: "free", planKey: null } }),
    { action: "not_due" },
  );
});

test("expiry: still free on Clerk means downgrade", () => {
  assert.deepEqual(
    decideReverseTrialExpiry({ s: running(), now: AFTER, paid: { tier: "free", planKey: null } }),
    { action: "downgrade" },
  );
  assert.deepEqual(
    decideReverseTrialExpiry({ s: running(), now: AFTER, paid: { tier: "free", planKey: "free_user" } }),
    { action: "downgrade" },
  );
});

test("expiry: a failed Clerk lookup is retried, never read as free", () => {
  assert.deepEqual(
    decideReverseTrialExpiry({ s: running(), now: AFTER, paid: null }),
    { action: "retry", reason: "lookup_failed" },
  );
});

test("expiry: a paying customer is never downgraded", () => {
  for (const tier of ["indie", "nano", "pro"] as Tier[]) {
    assert.deepEqual(
      decideReverseTrialExpiry({ s: running(), now: AFTER, paid: { tier, planKey: tier === "nano" ? "nanov2" : tier } }),
      { action: "keep_paid", tier },
    );
  }
});

test("expiry: someone who subscribed during the trial is closed out untouched", () => {
  assert.deepEqual(
    decideReverseTrialExpiry({ s: { ...running(), convertedAt: SIGNUP + DAY }, now: AFTER, paid: null }),
    { action: "close_converted" },
  );
});

test("expiry: an unknown plan slug is left alone", () => {
  assert.deepEqual(
    decideReverseTrialExpiry({ s: running(), now: AFTER, paid: { tier: "free", planKey: "enterprise_2027" } }),
    { action: "retry", reason: "unknown_plan" },
  );
});

test("expiry: runs once", () => {
  assert.deepEqual(
    decideReverseTrialExpiry({ s: { ...running(), expiredAt: AFTER }, now: AFTER + DAY, paid: { tier: "free", planKey: null } }),
    { action: "not_due" },
  );
});

test("downgrade: the trial grants Nano, and Free is strictly below it", () => {
  // Expiry hands the account to handlePlanDowngrade, the lapsed-plan path,
  // which clamps to these Free limits. Everything it clamps must actually move.
  const nano = TIER_LIMITS[REVERSE_TRIAL_TIER];
  const free = TIER_LIMITS.free;
  assert.ok(free.minCheckIntervalMinutes > nano.minCheckIntervalMinutes);
  assert.ok(free.maxChecks < nano.maxChecks);
  assert.equal(free.domainIntel, false);
  assert.equal(free.regionChoice, false);
  // Nano, not Pro: the trial never grants SMS.
  assert.equal(nano.smsAlerts, false);
});

// ── emails ──────────────────────────────────────────────────────────────────

test("reminder: due at day 5, once, while the trial runs", () => {
  const s = running();
  assert.deepEqual(decideReverseTrialReminder({ s, now: SIGNUP + 3 * DAY, reminderAt: 0 }), { skip: "too_early" });
  assert.deepEqual(decideReverseTrialReminder({ s, now: SIGNUP + 5 * DAY, reminderAt: 0 }), { send: true, daysLeft: 2 });
  assert.deepEqual(decideReverseTrialReminder({ s, now: SIGNUP + 5 * DAY, reminderAt: 1 }), { skip: "done" });
  assert.deepEqual(decideReverseTrialReminder({ s, now: s.endsAt - 60_000, reminderAt: 0 }), { skip: "too_late" });
  assert.deepEqual(decideReverseTrialReminder({ s: NONE, now: SIGNUP, reminderAt: 0 }), { skip: "no_trial" });
  assert.deepEqual(
    decideReverseTrialReminder({ s: { ...s, convertedAt: SIGNUP + DAY }, now: SIGNUP + 5 * DAY, reminderAt: 0 }),
    { skip: "not_active" },
  );
});

test("days left rounds up and never goes negative", () => {
  assert.equal(reverseTrialDaysLeft(2 * DAY, 1), 2);
  assert.equal(reverseTrialDaysLeft(DAY, 0), 1);
  assert.equal(reverseTrialDaysLeft(0, DAY), 0);
});

test("ended email: only after a drop to free, once, while fresh", () => {
  const s = { ...running(), expiredAt: AFTER, outcome: "free" as const };
  assert.equal(shouldSendEndedEmail({ s, now: AFTER + 1000, endedEmailAt: 0 }), true);
  assert.equal(shouldSendEndedEmail({ s, now: AFTER + 1000, endedEmailAt: 1 }), false);
  assert.equal(shouldSendEndedEmail({ s: { ...s, outcome: "paid" }, now: AFTER + 1000, endedEmailAt: 0 }), false);
  assert.equal(shouldSendEndedEmail({ s, now: AFTER + 4 * DAY, endedEmailAt: 0 }), false);
});

test("reminder copy: days left, what they used, keep-it link", () => {
  const e = buildReverseTrialReminder({
    firstName: "Ada",
    daysLeft: 2,
    usage: { checkCount: 3, hostnames: ["a.com", "b.com"], fastChecks: 2, domainIntel: 1, pinnedRegions: 0 },
  });
  assert.equal(e.subject, "2 days left of your Nano trial");
  assert.match(e.text, /^Hi Ada,/);
  assert.match(e.text, /3 monitors, including a\.com and b\.com/);
  assert.match(e.text, /2 monitors checking faster than every 5 minutes/);
  assert.match(e.text, /domain expiry tracking on 1 monitor\b/);
  assert.doesNotMatch(e.text, /pinned/);
  assert.ok(e.text.includes(REVERSE_TRIAL_KEEP_URL));
  assert.equal(REVERSE_TRIAL_KEEP_URL, "https://app.exit1.dev/billing");
});

test("ended copy: says what changed and that nothing was deleted", () => {
  const e = buildReverseTrialEnded({
    firstName: null,
    changes: { slowedChecks: 4, pausedChecks: 1, domainIntelOff: 0, regionsReset: 2, freeMaxChecks: 50 },
  });
  assert.equal(e.subject, "Your Nano trial has ended");
  assert.match(e.text, /^Hi,/);
  assert.match(e.text, /4 monitors now check every 5 minutes/);
  assert.match(e.text, /1 monitor was paused, because Free covers 50 monitors/);
  assert.match(e.text, /2 monitors went back to the default region/);
  assert.match(e.text, /Nothing was deleted/);
  assert.ok(e.text.includes(REVERSE_TRIAL_KEEP_URL));
  const none = buildReverseTrialEnded({
    firstName: "B",
    changes: { slowedChecks: 0, pausedChecks: 0, domainIntelOff: 0, regionsReset: 0, freeMaxChecks: 50 },
  });
  assert.match(none.text, /nothing about them changed/);
});

test("no em dashes, en dashes or double hyphens in the copy", () => {
  const all = [
    buildReverseTrialReminder({ firstName: "A", daysLeft: 2, usage: { checkCount: 0, hostnames: [], fastChecks: 0, domainIntel: 0, pinnedRegions: 0 } }),
    buildReverseTrialEnded({ firstName: "A", changes: { slowedChecks: 1, pausedChecks: 1, domainIntelOff: 1, regionsReset: 1, freeMaxChecks: 50 } }),
  ];
  for (const e of all) {
    // Em dash, en dash, double hyphen.
    const dashes = new RegExp([0x2014, 0x2013].map((c) => String.fromCharCode(c)).join("|") + "|-{2}");
    assert.doesNotMatch(e.subject + e.text, dashes);
  }
});

// ── no double-dip with the trial invites ────────────────────────────────────

test("trial invites skip accounts that had a reverse trial", () => {
  const base = {
    tier: "free",
    subscribedPlanKey: null,
    checkCount: 2,
    createdAt: SIGNUP,
    invite1At: 0,
    invite2At: 0,
    now: SIGNUP + TRIAL_INVITE_1_AFTER_MS,
  };
  assert.deepEqual(decideTrialInvite({ ...base, hadReverseTrial: true }), { skip: "reverse_trial" });
  assert.deepEqual(decideTrialInvite({ ...base, hadReverseTrial: false }), { send: "invite1" });
});
