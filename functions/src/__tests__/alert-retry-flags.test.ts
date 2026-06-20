import test from "node:test";
import assert from "node:assert/strict";

import { applyPendingRetryFlags, shouldRetryAlert } from "../alert-retry-flags";
import type { AlertResult } from "../alert";

// Regression coverage for the per-channel "deferred alert dropped" bug.
//
// On a single transition one channel can be deferred while the other delivers —
// e.g. SMS is blocked by its per-user budget/throttle (or a transient Twilio
// send error) while email sends immediately. The old code drove a single
// pending flag off the EMAIL outcome only, so the satisfied email cleared the
// flag and the deferred SMS retry was lost forever. applyPendingRetryFlags must
// track the two channels independently and keep pendingUpSms/pendingDownSms
// pending in that exact shape.
//
// (The per-channel minConsecutiveEvents debounce that originally produced this
// "flap" deferral was removed — the per-check Down-confirmation gate now handles
// flap suppression — but the identical deferral shape still arises from
// budget/throttle/send-error, so this coverage stands.)

const NOW = 1_700_000_000_000;

test("recovery: email sent but SMS deferred keeps the SMS retry pending (the bug)", () => {
  // triggerAlert outcome for probe #1 of a recovery: webhook+email delivered,
  // SMS deferred (budget/throttle/send error).
  const result: AlertResult = { delivered: true, emailNeedsRetry: false, smsNeedsRetry: true };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "online", NOW, {});

  // Email is satisfied — its flag must clear.
  assert.equal(updateData.pendingUpEmail, false);
  assert.equal(updateData.pendingUpSince, null);
  // SMS is still owed — its flag MUST stay set so the next probe retries it.
  assert.equal(updateData.pendingUpSms, true, "deferred recovery SMS must remain pending");
});

test("down: email sent but SMS deferred keeps the down SMS retry pending", () => {
  const result: AlertResult = { delivered: true, emailNeedsRetry: false, smsNeedsRetry: true };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "offline", NOW, {});

  assert.equal(updateData.pendingDownEmail, false);
  assert.equal(updateData.pendingDownSince, null);
  assert.equal(updateData.pendingDownSms, true);
});

test("both channels satisfied clears both pending flags", () => {
  const result: AlertResult = { delivered: true, emailNeedsRetry: false, smsNeedsRetry: false };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "online", NOW, {});

  assert.equal(updateData.pendingUpEmail, false);
  assert.equal(updateData.pendingUpSince, null);
  assert.equal(updateData.pendingUpSms, false);
});

test("both channels deferred sets both pending flags and stamps pendingSince", () => {
  const result: AlertResult = { delivered: true, emailNeedsRetry: true, smsNeedsRetry: true };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "online", NOW, {});

  assert.equal(updateData.pendingUpEmail, true);
  assert.equal(updateData.pendingUpSince, NOW);
  assert.equal(updateData.pendingUpSms, true);
});

test("pendingSince is preserved across retries, not overwritten", () => {
  const result: AlertResult = { delivered: false, reason: "flap", emailNeedsRetry: true, smsNeedsRetry: true };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "online", NOW, { pendingUpSince: NOW - 60_000 });
  // Already pending since earlier — don't reset the clock.
  assert.equal(updateData.pendingUpSince, undefined, "existing pendingUpSince must not be overwritten");
  assert.equal(updateData.pendingUpEmail, true);
});

test("all channels failed for a retryable reason sets pending via reason, not just *NeedsRetry", () => {
  // anythingDelivered=false path: triggerAlert returns the email reason.
  const result: AlertResult = { delivered: false, reason: "throttle", emailNeedsRetry: true, smsNeedsRetry: true };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "offline", NOW, {});
  assert.equal(updateData.pendingDownEmail, true);
  assert.equal(updateData.pendingDownSms, true);
});

test("non-retryable suppression (settings) clears both channels", () => {
  const result: AlertResult = { delivered: false, reason: "settings" };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "online", NOW, {});
  assert.equal(updateData.pendingUpEmail, false);
  assert.equal(updateData.pendingUpSince, null);
  assert.equal(updateData.pendingUpSms, false);
});

test("system_health_gate suppression is NOT retried (documents current behavior)", () => {
  // The gate returns this reason with no *NeedsRetry signals; both flags clear.
  // (A gate-suppressed recovery being dropped is a separate, documented gap.)
  const result: AlertResult = { delivered: false, reason: "system_health_gate" };
  assert.equal(shouldRetryAlert(result.reason), false);
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "online", NOW, {});
  assert.equal(updateData.pendingUpEmail, false);
  assert.equal(updateData.pendingUpSms, false);
});
