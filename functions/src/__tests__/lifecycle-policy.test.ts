import test from "node:test";
import assert from "node:assert/strict";

import {
  decideFirstIncident,
  FIRST_INCIDENT_FRESHNESS_MS,
  isWithinGrace,
  NO_CHANNEL_GRACE_MS,
  mailerShouldSkip,
  NIGHTLY_NO_CHANNEL_CAP,
  pastSoftDeadline,
  RUN_SOFT_DEADLINE_MS,
} from "../lifecycle-policy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// ── first_incident_caught ───────────────────────────────────────────────────
//
// The first deploy fired this retroactively for 681 accounts whose outage could
// have been months old. The event has to mean "recently", or it means nothing.

test("no incident ever: nothing", () => {
  assert.equal(decideFirstIncident({ firstIncidentAt: null, alreadyStampedAt: 0, now: NOW }), "nothing");
});

test("already stamped: nothing, regardless of age", () => {
  assert.equal(decideFirstIncident({ firstIncidentAt: NOW - DAY, alreadyStampedAt: NOW - 1, now: NOW }), "nothing");
  assert.equal(decideFirstIncident({ firstIncidentAt: NOW - 90 * DAY, alreadyStampedAt: 1, now: NOW }), "nothing");
});

test("a fresh incident fires", () => {
  assert.equal(decideFirstIncident({ firstIncidentAt: NOW - DAY, alreadyStampedAt: 0, now: NOW }), "fire");
  assert.equal(
    decideFirstIncident({ firstIncidentAt: NOW - FIRST_INCIDENT_FRESHNESS_MS, alreadyStampedAt: 0, now: NOW }),
    "fire",
    "exactly at the window edge still counts as fresh",
  );
});

test("a historical incident is stamped without firing", () => {
  assert.equal(
    decideFirstIncident({ firstIncidentAt: NOW - FIRST_INCIDENT_FRESHNESS_MS - 1, alreadyStampedAt: 0, now: NOW }),
    "stamp_silently",
  );
  assert.equal(
    decideFirstIncident({ firstIncidentAt: NOW - 200 * DAY, alreadyStampedAt: 0, now: NOW }),
    "stamp_silently",
  );
});

// ── grace window ────────────────────────────────────────────────────────────

test("brand-new accounts are within grace; unknown createdAt is not", () => {
  assert.equal(isWithinGrace(NOW - 1000, NOW), true);
  assert.equal(isWithinGrace(NOW - NO_CHANNEL_GRACE_MS + 1, NOW), true);
  assert.equal(isWithinGrace(NOW - NO_CHANNEL_GRACE_MS, NOW), false);
  assert.equal(isWithinGrace(null, NOW), false);
});

// ── one notice per user ─────────────────────────────────────────────────────
//
// The stamp is the only thing standing between an uncovered user and a second
// copy of the same email, so it gets a test of its own even though the function
// is now one line.

test("already notified: skip", () => {
  assert.equal(mailerShouldSkip({ notifiedAt: 1 }), "already_notified");
});

test("never notified: send", () => {
  assert.equal(mailerShouldSkip({ notifiedAt: 0 }), null);
});

// The nightly cap has to leave room for the run's other work inside the soft
// deadline: 50 sends paced at the 600 ms provider limit is about 30 s.
test("nightly cap fits well inside the soft deadline", () => {
  assert.ok(NIGHTLY_NO_CHANNEL_CAP * 600 < RUN_SOFT_DEADLINE_MS / 2);
});

// ── soft deadline ───────────────────────────────────────────────────────────

test("soft deadline trips before the hard 540s ceiling", () => {
  assert.ok(RUN_SOFT_DEADLINE_MS < 540_000);
  assert.equal(pastSoftDeadline(NOW, NOW + RUN_SOFT_DEADLINE_MS - 1), false);
  assert.equal(pastSoftDeadline(NOW, NOW + RUN_SOFT_DEADLINE_MS), true);
});
