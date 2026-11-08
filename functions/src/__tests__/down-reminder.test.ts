import test from "node:test";
import assert from "node:assert/strict";

import {
  DOWN_REMINDER_OFF_RECHECK_MS,
  noteRemindersOff,
  remindersKnownOff,
  clearDownReminder,
  formatDowntime,
  getLastDownEmail,
  isDownReminderDue,
  normalizeDownReminderInterval,
  noteDownEmail,
  resolveDownSince,
} from "../down-reminder";
import { isPostDeployBaseline } from "../deploy-baseline";

const MIN = 60 * 1000;

test("normalizeDownReminderInterval only accepts the offered intervals", () => {
  assert.equal(normalizeDownReminderInterval(10), 10);
  assert.equal(normalizeDownReminderInterval(30), 30);
  assert.equal(normalizeDownReminderInterval(60), 60);
  assert.equal(normalizeDownReminderInterval("30"), 30);
  assert.equal(normalizeDownReminderInterval(0), 0);
  assert.equal(normalizeDownReminderInterval(5), 0);
  assert.equal(normalizeDownReminderInterval(undefined), 0);
  assert.equal(normalizeDownReminderInterval(null), 0);
  assert.equal(normalizeDownReminderInterval("abc"), 0);
});

test("isDownReminderDue: off when the interval is 0", () => {
  assert.equal(isDownReminderDue({ now: 100 * MIN, intervalMinutes: 0, lastStatusChange: 1 }), false);
});

test("isDownReminderDue: waits a full interval after the down transition", () => {
  const down = 1_000 * MIN;
  assert.equal(isDownReminderDue({ now: down + 9 * MIN, intervalMinutes: 10, lastStatusChange: down }), false);
  assert.equal(isDownReminderDue({ now: down + 10 * MIN, intervalMinutes: 10, lastStatusChange: down }), true);
});

test("isDownReminderDue: spaces reminders from the last one sent", () => {
  const down = 1_000 * MIN;
  const lastReminder = down + 10 * MIN;
  assert.equal(isDownReminderDue({ now: lastReminder + 5 * MIN, intervalMinutes: 10, lastStatusChange: down, lastReminderAt: lastReminder }), false);
  assert.equal(isDownReminderDue({ now: lastReminder + 10 * MIN, intervalMinutes: 10, lastStatusChange: down, lastReminderAt: lastReminder }), true);
});

test("isDownReminderDue: a stale clock from an earlier outage never beats a fresh DOWN", () => {
  const oldReminder = 1_000 * MIN;
  const freshDown = oldReminder + 120 * MIN;
  assert.equal(isDownReminderDue({ now: freshDown + 1 * MIN, intervalMinutes: 10, lastStatusChange: freshDown, lastReminderAt: oldReminder }), false);
});

test("isDownReminderDue: no anchor means no reminder", () => {
  assert.equal(isDownReminderDue({ now: 1_000 * MIN, intervalMinutes: 10 }), false);
});

test("resolveDownSince takes the earliest of first failure and transition", () => {
  const now = 1_000 * MIN;
  // A passing blip mid-outage restarts lastFailureTime; the transition still wins.
  assert.equal(resolveDownSince({ lastFailureTime: now - 2 * MIN, lastStatusChange: now - 180 * MIN }, now), now - 180 * MIN);
  assert.equal(resolveDownSince({ lastFailureTime: now - 30 * MIN, lastStatusChange: now - 28 * MIN }, now), now - 30 * MIN);
  assert.equal(resolveDownSince({ lastFailureTime: null, lastStatusChange: now - 28 * MIN }, now), now - 28 * MIN);
  assert.equal(resolveDownSince({}, now), undefined);
  // Future timestamps are not usable.
  assert.equal(resolveDownSince({ lastFailureTime: now + MIN }, now), undefined);
});

test("formatDowntime", () => {
  assert.equal(formatDowntime(45 * 1000), "45s");
  assert.equal(formatDowntime(12 * MIN), "12m");
  assert.equal(formatDowntime(65 * MIN), "1h 5m");
  assert.equal(formatDowntime(120 * MIN), "2h");
  assert.equal(formatDowntime((2 * 24 + 3) * 60 * MIN), "2d 3h");
  assert.equal(formatDowntime(-5), "0s");
});

test("down email clock is per check and clears on recovery", () => {
  noteDownEmail("a", 123);
  assert.equal(getLastDownEmail("a"), 123);
  assert.equal(getLastDownEmail("b"), undefined);
  clearDownReminder("a");
  assert.equal(getLastDownEmail("a"), undefined);
});

test("reminders-off back-off expires", () => {
  const now = 1_000 * MIN;
  assert.equal(remindersKnownOff("u1", now), false);
  noteRemindersOff("u1", now);
  assert.equal(remindersKnownOff("u1", now + 1), true);
  assert.equal(remindersKnownOff("u1", now + DOWN_REMINDER_OFF_RECHECK_MS), false);
  assert.equal(remindersKnownOff("u2", now + 1), false);
});

// Regression: 2026-11-06, an edited check (lastChecked reset to 0) had its
// recovery swallowed as a "post-deploy baseline" eight days after the deploy.
test("isPostDeployBaseline ignores lastChecked 0 from an edit", () => {
  const deployClosed = 1_000 * MIN;
  assert.equal(isPostDeployBaseline(0, deployClosed), false);
  assert.equal(isPostDeployBaseline(undefined, deployClosed), false);
  assert.equal(isPostDeployBaseline(null, deployClosed), false);
});

test("isPostDeployBaseline still baselines a check last probed before the deploy", () => {
  const deployClosed = 1_000 * MIN;
  assert.equal(isPostDeployBaseline(deployClosed - MIN, deployClosed), true);
  assert.equal(isPostDeployBaseline(deployClosed + MIN, deployClosed), false);
  assert.equal(isPostDeployBaseline(deployClosed - MIN, 0), false);
});
