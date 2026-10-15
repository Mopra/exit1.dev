import test from "node:test";
import assert from "node:assert/strict";

import {
  decideTrialInvite,
  isTrialInviteEligible,
  minutesSoonerOnIndie,
  NIGHTLY_TRIAL_INVITE_CAP,
  RUN_SOFT_DEADLINE_MS,
  TRIAL_INVITE_1_AFTER_MS,
  TRIAL_INVITE_2_AFTER_MS,
  TRIAL_INVITE_FEATURE_START_MS,
  TRIAL_INVITE_LATE_MS,
} from "../lifecycle-policy";
import {
  buildTrialInvite1,
  buildTrialInvite2,
  describeMonitors,
  hostnameOf,
  TRIAL_INVITE_URL,
} from "../trial-invite-email";

const DAY = 24 * 60 * 60 * 1000;
const SIGNUP = TRIAL_INVITE_FEATURE_START_MS + 2 * DAY;

const base = {
  tier: "free",
  subscribedPlanKey: null as string | null,
  checkCount: 2,
  createdAt: SIGNUP as number | null,
  invite1At: 0,
  invite2At: 0,
  now: SIGNUP + TRIAL_INVITE_1_AFTER_MS,
};

// ── who is due ──────────────────────────────────────────────────────────────

test("day 3, free, never invited: invite 1", () => {
  assert.deepEqual(decideTrialInvite(base), { send: "invite1" });
});

test("before day 3: too new", () => {
  assert.deepEqual(decideTrialInvite({ ...base, now: SIGNUP + TRIAL_INVITE_1_AFTER_MS - 1 }), { skip: "too_new" });
});

test("the existing base is never invited", () => {
  const old = TRIAL_INVITE_FEATURE_START_MS - 1;
  assert.deepEqual(
    decideTrialInvite({ ...base, createdAt: old, now: old + TRIAL_INVITE_1_AFTER_MS }),
    { skip: "before_feature" },
  );
  assert.deepEqual(decideTrialInvite({ ...base, createdAt: null }), { skip: "unknown_signup" });
});

test("paid, Founders or any past plan: no invite", () => {
  assert.deepEqual(decideTrialInvite({ ...base, tier: "indie" }), { skip: "not_free" });
  assert.deepEqual(decideTrialInvite({ ...base, tier: "pro", subscribedPlanKey: "nano" }), { skip: "not_free" });
  assert.deepEqual(decideTrialInvite({ ...base, subscribedPlanKey: "nanov2" }), { skip: "plan_history" });
  assert.deepEqual(decideTrialInvite({ ...base, subscribedPlanKey: "free_user" }), { send: "invite1" });
});

test("no checks: no invite", () => {
  assert.deepEqual(decideTrialInvite({ ...base, checkCount: 0 }), { skip: "no_checks" });
});

test("invite 1 is not sent late", () => {
  assert.deepEqual(
    decideTrialInvite({ ...base, now: SIGNUP + TRIAL_INVITE_1_AFTER_MS + TRIAL_INVITE_LATE_MS }),
    { send: "invite1" },
  );
  assert.deepEqual(
    decideTrialInvite({ ...base, now: SIGNUP + TRIAL_INVITE_1_AFTER_MS + TRIAL_INVITE_LATE_MS + 1 }),
    { skip: "too_late" },
  );
});

test("invite 2 on day 10 only after invite 1", () => {
  const day10 = SIGNUP + TRIAL_INVITE_2_AFTER_MS;
  assert.deepEqual(decideTrialInvite({ ...base, invite1At: SIGNUP + 3 * DAY, now: day10 }), { send: "invite2" });
  assert.deepEqual(decideTrialInvite({ ...base, invite1At: SIGNUP + 3 * DAY, now: day10 - 1 }), { skip: "too_new" });
  assert.deepEqual(decideTrialInvite({ ...base, now: day10 }), { skip: "invite1_missing" });
  assert.deepEqual(
    decideTrialInvite({ ...base, invite1At: SIGNUP + 3 * DAY, now: day10 + TRIAL_INVITE_LATE_MS + 1 }),
    { skip: "too_late" },
  );
});

test("one stamp per email: never a third email, never a repeat", () => {
  const day10 = SIGNUP + TRIAL_INVITE_2_AFTER_MS;
  assert.deepEqual(
    decideTrialInvite({ ...base, invite1At: SIGNUP + 3 * DAY, invite2At: day10, now: day10 + DAY }),
    { skip: "done" },
  );
  // Stamped invite 1 three days ago: not again on day 4.
  assert.deepEqual(decideTrialInvite({ ...base, invite1At: SIGNUP + 3 * DAY, now: SIGNUP + 4 * DAY }), { skip: "too_new" });
});

test("invite 2 skipped once they upgraded", () => {
  const day10 = SIGNUP + TRIAL_INVITE_2_AFTER_MS;
  assert.deepEqual(
    decideTrialInvite({ ...base, tier: "nano", subscribedPlanKey: "nanov2", invite1At: SIGNUP + 3 * DAY, now: day10 }),
    { skip: "not_free" },
  );
});

// ── billing history ─────────────────────────────────────────────────────────

test("only a never-paid, never-trialled account is eligible", () => {
  const free = { planSlug: "free_user", lifetimePaidCents: 0 };
  assert.equal(isTrialInviteEligible({ eligibleForFreeTrial: true, items: [free] }), true);
  assert.equal(isTrialInviteEligible({ eligibleForFreeTrial: false, items: [free] }), false);
  assert.equal(isTrialInviteEligible({ eligibleForFreeTrial: null, items: [free] }), false);
  assert.equal(isTrialInviteEligible(null), false, "unknown is a skip");
  assert.equal(
    isTrialInviteEligible({ eligibleForFreeTrial: true, items: [free, { planSlug: "indie", lifetimePaidCents: 0 }] }),
    false,
  );
  assert.equal(
    isTrialInviteEligible({ eligibleForFreeTrial: true, items: [{ planSlug: "free_user", lifetimePaidCents: 400 }] }),
    false,
  );
});

test("nightly cap fits well inside the soft deadline", () => {
  assert.ok(NIGHTLY_TRIAL_INVITE_CAP * 2_000 < RUN_SOFT_DEADLINE_MS / 2);
});

// ── copy ────────────────────────────────────────────────────────────────────

test("hostnames from URLs, bare hosts and host:port", () => {
  assert.equal(hostnameOf("https://www.example.com/health?x=1"), "example.com");
  assert.equal(hostnameOf("api.example.com"), "api.example.com");
  assert.equal(hostnameOf("db.example.com:5432"), "db.example.com");
  assert.equal(hostnameOf(""), null);
  assert.equal(hostnameOf(undefined), null);
});

test("monitor description names count and up to two hosts", () => {
  assert.equal(describeMonitors(1, ["a.com"]), "a monitor on a.com");
  assert.equal(describeMonitors(3, ["a.com", "a.com", "b.com", "c.com"]), "3 monitors, including a.com and b.com");
  assert.equal(describeMonitors(2, []), "2 monitors");
});

const NO_DASHES = /[–—]|--/;

test("invite 1 names their monitors, both plans, the trial and the link", () => {
  const e = buildTrialInvite1({ firstName: "Ada", checkCount: 3, hostnames: ["a.com", "b.com"] });
  assert.match(e.text, /^Hi Ada,/);
  assert.match(e.text, /3 monitors, including a\.com and b\.com/);
  assert.match(e.text, /Indie, \$4\/mo: 1-minute checks, up to 100 monitors and a branded status page/);
  assert.match(e.text, /Nano, \$9\/mo: 30-second checks, domain expiry tracking/);
  assert.match(e.text, /US, EU or Asia/);
  assert.match(e.text, /7-day free trial/);
  assert.ok(e.text.includes(TRIAL_INVITE_URL));
  assert.match(e.text, /reply/i);
  assert.match(e.text, /\nMorten\n/);
  assert.doesNotMatch(e.text + e.subject, NO_DASHES);
});

test("invite 2 with an incident says how much sooner", () => {
  const e = buildTrialInvite2({ firstName: null, hadIncident: true, incidentHost: "shop.com", minutesSooner: 4 });
  assert.match(e.text, /^Hi,/);
  assert.match(e.text, /shop\.com went down/);
  assert.match(e.text, /up to 4 minutes sooner/);
  assert.ok(e.text.includes(TRIAL_INVITE_URL));
  assert.match(e.text, /If something is in your way, reply/);
  assert.doesNotMatch(e.text + e.subject, NO_DASHES);
});

test("invite 2 without an incident still gives one reason", () => {
  const e = buildTrialInvite2({ firstName: "Bo", hadIncident: false, incidentHost: null, minutesSooner: 4 });
  assert.match(e.text, /None of your monitors have gone down/);
  assert.match(e.text, /up to 4 minutes sooner/);
  assert.doesNotMatch(e.text + e.subject, NO_DASHES);
});

test("free to Indie is 4 minutes", () => {
  assert.equal(minutesSoonerOnIndie(5, 1), 4);
  assert.equal(minutesSoonerOnIndie(1, 1), 0);
});
