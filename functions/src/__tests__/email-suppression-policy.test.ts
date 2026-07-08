import test from "node:test";
import assert from "node:assert/strict";

import {
  applyBounceEvent,
  isSuppressed,
  suppressionDurationForEscalation,
  normalizeEmail,
  TRANSIENT_THRESHOLD,
  TRANSIENT_WINDOW_MS,
  BASE_SUPPRESSION_MS,
  MAX_SUPPRESSION_MS,
  type EmailSuppressionState,
} from "../email-suppression-policy";

const NOW = 1_750_000_000_000;
const EMAIL = "Ops@Example.com";

test("permanent bounce suppresses immediately and indefinitely", () => {
  const { state, becameSuppressed } = applyBounceEvent(null, EMAIL, "permanent", NOW, "550 no such user");
  assert.equal(becameSuppressed, true);
  assert.equal(state.permanent, true);
  assert.equal(state.email, "ops@example.com");
  assert.equal(isSuppressed(state, NOW), true);
  // Permanent never expires
  assert.equal(isSuppressed(state, NOW + 365 * 24 * 60 * 60 * 1000), true);
});

test("complaint suppresses like a permanent bounce", () => {
  const { state, becameSuppressed } = applyBounceEvent(null, EMAIL, "complaint", NOW);
  assert.equal(becameSuppressed, true);
  assert.equal(state.permanent, true);
});

test("first transient bounce suppresses immediately and notifies", () => {
  const { state, becameSuppressed } = applyBounceEvent(null, EMAIL, "transient", NOW, "greylisted");
  assert.equal(becameSuppressed, true);
  assert.equal(isSuppressed(state, NOW), true);
  assert.equal(state.permanent, false);
  assert.equal(state.suppressedUntil, NOW + BASE_SUPPRESSION_MS);
  // Timed pause expires on its own
  assert.equal(isSuppressed(state, NOW + BASE_SUPPRESSION_MS + 1), false);
});

test("threshold transient bounces inside the window trigger a timed pause", () => {
  let state: EmailSuppressionState | null = null;
  let became = false;
  for (let i = 0; i < TRANSIENT_THRESHOLD; i++) {
    const t = applyBounceEvent(state, EMAIL, "transient", NOW + i * 60_000);
    state = t.state;
    became = t.becameSuppressed;
  }
  const at = NOW + (TRANSIENT_THRESHOLD - 1) * 60_000;
  assert.equal(became, true);
  assert.equal(isSuppressed(state!, at), true);
  assert.equal(state!.permanent, false);
  assert.equal(state!.suppressedUntil, at + BASE_SUPPRESSION_MS);
  assert.equal(state!.escalations, 1);
  // Expires on its own
  assert.equal(isSuppressed(state!, at + BASE_SUPPRESSION_MS + 1), false);
});

test("bounces after each pause expires start new, longer episodes", () => {
  let state: EmailSuppressionState | null = null;
  let t = NOW;
  for (let episode = 0; episode < 3; episode++) {
    const transition = applyBounceEvent(state, EMAIL, "transient", t);
    state = transition.state;
    assert.equal(transition.becameSuppressed, true);
    assert.equal(state.suppressedUntil, t + suppressionDurationForEscalation(episode));
    assert.equal(state.escalations, episode + 1);
    t = state.suppressedUntil! + TRANSIENT_WINDOW_MS + 1;
  }
});

test("repeat episodes back off exponentially and cap", () => {
  assert.equal(suppressionDurationForEscalation(0), BASE_SUPPRESSION_MS);
  assert.equal(suppressionDurationForEscalation(1), BASE_SUPPRESSION_MS * 2);
  assert.equal(suppressionDurationForEscalation(10), MAX_SUPPRESSION_MS);
});

test("second episode uses doubled duration", () => {
  // First episode
  let state: EmailSuppressionState | null = null;
  let t = NOW;
  for (let i = 0; i < TRANSIENT_THRESHOLD; i++) {
    state = applyBounceEvent(state, EMAIL, "transient", t).state;
    t += 60_000;
  }
  // Jump past first pause, bounce again to a second episode
  t = state!.suppressedUntil! + 1;
  for (let i = 0; i < TRANSIENT_THRESHOLD; i++) {
    state = applyBounceEvent(state, EMAIL, "transient", t).state;
    t += 60_000;
  }
  const episodeStart = t - 60_000;
  assert.equal(state!.suppressedUntil, episodeStart + BASE_SUPPRESSION_MS * 2);
  assert.equal(state!.escalations, 2);
});

test("bounces while already paused do not extend the pause or re-notify", () => {
  let state: EmailSuppressionState | null = null;
  for (let i = 0; i < TRANSIENT_THRESHOLD; i++) {
    state = applyBounceEvent(state, EMAIL, "transient", NOW).state;
  }
  const pauseEnd = state!.suppressedUntil;
  const t2 = applyBounceEvent(state, EMAIL, "transient", NOW + 1000);
  assert.equal(t2.becameSuppressed, false);
  assert.equal(t2.state.suppressedUntil, pauseEnd);
});

test("permanent bounce on an already transient-paused address does not re-flag becameSuppressed", () => {
  let state: EmailSuppressionState | null = null;
  for (let i = 0; i < TRANSIENT_THRESHOLD; i++) {
    state = applyBounceEvent(state, EMAIL, "transient", NOW).state;
  }
  const t = applyBounceEvent(state, EMAIL, "permanent", NOW + 1000);
  assert.equal(t.becameSuppressed, false);
  assert.equal(t.state.permanent, true);
});

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  Ops@Example.COM "), "ops@example.com");
});

test("normalizeEmail extracts the bare address from a display-name form", () => {
  assert.equal(
    normalizeEmail("Jaron Heskamp <JH@Heskamp-Medien.de>"),
    "jh@heskamp-medien.de"
  );
  assert.equal(normalizeEmail("  Ops <ops@example.com>  "), "ops@example.com");
  assert.equal(normalizeEmail("<ops@example.com>"), "ops@example.com");
  // Bare addresses pass through untouched
  assert.equal(normalizeEmail("ops@example.com"), "ops@example.com");
});

test("display-name and bare forms normalize to the same suppression key", () => {
  const fromWebhook = applyBounceEvent(null, "Some Name <Ops@Example.com>", "permanent", NOW);
  assert.equal(fromWebhook.state.email, normalizeEmail("ops@example.com"));
});
