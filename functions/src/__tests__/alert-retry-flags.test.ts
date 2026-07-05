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

// ── System health gate: suppression must DEFER, not drop ──────────────────
//
// The gate can't tell an exit1-side false-alarm storm from a mass REAL outage
// (a big CDN failure downs 50+ customers' sites at once — genuine downtime).
// So triggerAlert attaches explicit per-channel needs-retry flags to every
// gate-suppressed result; the reason alone stays non-retryable because the
// reason axis is skip-blind (an SMS-only retry hitting the gate must not
// re-arm the already-delivered email channel).

test("system_health_gate reason ALONE is not retryable (skip-blind axis)", () => {
  assert.equal(shouldRetryAlert("system_health_gate"), false);
});

test("gate-suppressed fresh transition arms all three channel retry flags", () => {
  // What triggerAlert returns when the gate trips on a fresh down transition
  // (no skip options): every channel was about to fire, so every channel is owed.
  const result: AlertResult = {
    delivered: false, reason: "system_health_gate",
    emailNeedsRetry: true, smsNeedsRetry: true, webhooksNeedRetry: true,
  };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "offline", NOW, {});
  assert.equal(updateData.pendingDownEmail, true, "gate-suppressed down email must be retried");
  assert.equal(updateData.pendingDownSince, NOW);
  assert.equal(updateData.pendingDownSms, true, "gate-suppressed down SMS must be retried");
  assert.equal(updateData.pendingDownWebhooks, true, "gate-suppressed webhooks were never dispatched and must be re-driven");
});

test("gate hit on an SMS-only retry re-arms only the SMS channel", () => {
  // triggerAlert was called with skipEmail+skipWebhooks (already satisfied);
  // its gate return reflects that — only SMS is still owed.
  const result: AlertResult = {
    delivered: false, reason: "system_health_gate",
    emailNeedsRetry: false, smsNeedsRetry: true, webhooksNeedRetry: false,
  };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "online", NOW, {});
  assert.equal(updateData.pendingUpEmail, false, "delivered email must not be re-armed by the gate");
  assert.equal(updateData.pendingUpSms, true);
  assert.equal(updateData.pendingUpWebhooks, false, "dispatched webhooks must not be re-driven");
});

test("webhook re-drive flag is set only from the explicit result field", () => {
  // A retryable email reason must NOT drag webhooks along — once dispatched,
  // webhook failures belong to the webhook retry queue.
  const result: AlertResult = { delivered: false, reason: "throttle" };
  const updateData: Record<string, unknown> = {};
  applyPendingRetryFlags(updateData, result, "offline", NOW, {});
  assert.equal(updateData.pendingDownEmail, true);
  assert.equal(updateData.pendingDownWebhooks, false);
});
