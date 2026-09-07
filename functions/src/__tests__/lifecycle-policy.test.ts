import test from "node:test";
import assert from "node:assert/strict";

import {
  decideFirstIncident,
  FIRST_INCIDENT_FRESHNESS_MS,
  isWithinGrace,
  NO_CHANNEL_GRACE_MS,
  mailerShouldSkip,
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

// ── mailer vs automation event ──────────────────────────────────────────────
//
// Two senders, one gap. Without this a user could be told twice.

test("already notified by the mailer: skip, always", () => {
  assert.equal(
    mailerShouldSkip({ notifiedAt: 1, automationEventAt: 0, includeAutomationRecipients: true }),
    "already_notified",
  );
});

test("automation event already fired: skip unless the operator opts in", () => {
  assert.equal(
    mailerShouldSkip({ notifiedAt: 0, automationEventAt: 1, includeAutomationRecipients: false }),
    "automation_event",
  );
  assert.equal(
    mailerShouldSkip({ notifiedAt: 0, automationEventAt: 1, includeAutomationRecipients: true }),
    null,
  );
});

test("nothing fired yet: send", () => {
  assert.equal(mailerShouldSkip({ notifiedAt: 0, automationEventAt: 0, includeAutomationRecipients: false }), null);
});

// ── soft deadline ───────────────────────────────────────────────────────────

test("soft deadline trips before the hard 540s ceiling", () => {
  assert.ok(RUN_SOFT_DEADLINE_MS < 540_000);
  assert.equal(pastSoftDeadline(NOW, NOW + RUN_SOFT_DEADLINE_MS - 1), false);
  assert.equal(pastSoftDeadline(NOW, NOW + RUN_SOFT_DEADLINE_MS), true);
});
