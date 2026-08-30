import test from "node:test";
import assert from "node:assert/strict";

import { isTransition, mergeLastWritten, type LastWrittenState } from "../status-transition";

// Regression coverage for the duplicate-ssl_warning bug (kairandles,
// 2026-08-25): the VPS probe path alerted on ok->warning and put
// sslAlertedState:'warning' into the status buffer, but the classifier
// didn't consult sslAlertedState, so the update was heartbeat-classified
// and parked in the deferred buffer (60-min flush). The 6-hourly
// refreshSecurityMetadata job then read the stale 'ok' from Firestore and
// sent the same ssl_warning again. Alert-state advances must classify as
// transitions and take the immediate write path.

// Steady-state snapshot of a healthy online check.
const steady: LastWrittenState = {
  status: "online",
  detailedStatus: "UP",
  disabled: false,
  maintenanceMode: false,
  lastError: null,
  consecutiveFailures: 0,
  sslAlertedState: "ok",
};

test("sslAlertedState advance is a transition (the duplicate-ssl_warning bug)", () => {
  assert.equal(isTransition(steady, { sslAlertedState: "warning" }), true);
  assert.equal(isTransition(steady, { sslAlertedState: "error" }), true);
  // Recovery back to ok must also write immediately, or the refresh job
  // keeps suppressing off a stale 'warning' after the cert renews.
  assert.equal(isTransition({ ...steady, sslAlertedState: "warning" }, { sslAlertedState: "ok" }), true);
});

test("unchanged or absent sslAlertedState stays heartbeat-classified", () => {
  assert.equal(isTransition(steady, { sslAlertedState: "ok" }), false);
  // The common probe payload carries no ssl fields at all.
  assert.equal(isTransition(steady, { status: "online", consecutiveFailures: 0 }), false);
});

test("first observation always classifies as a transition (seeds the baseline)", () => {
  assert.equal(isTransition(undefined, { status: "online" }), true);
});

test("status and error flips remain transitions", () => {
  assert.equal(isTransition(steady, { status: "offline" }), true);
  assert.equal(isTransition(steady, { lastError: "ECONNREFUSED" }), true);
  // consecutiveFailures only matters when it crosses zero.
  assert.equal(isTransition(steady, { consecutiveFailures: 1 }), true);
  assert.equal(isTransition({ ...steady, consecutiveFailures: 3 }, { consecutiveFailures: 4 }), false);
});

test("mergeLastWritten folds an advance in and keeps it across later heartbeats", () => {
  const afterAlert = mergeLastWritten(steady, { sslAlertedState: "warning" });
  assert.equal(afterAlert.sslAlertedState, "warning");
  assert.equal(afterAlert.status, "online");

  // A later heartbeat without ssl fields must not lose the snapshot value,
  // or the next identical advance would re-classify as a transition forever.
  const afterHeartbeat = mergeLastWritten(afterAlert, { status: "online", consecutiveFailures: 0 });
  assert.equal(afterHeartbeat.sslAlertedState, "warning");
  assert.equal(isTransition(afterHeartbeat, { sslAlertedState: "warning" }), false);
});
