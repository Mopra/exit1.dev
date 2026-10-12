import test from "node:test";
import assert from "node:assert/strict";

import {
  decideFollowerNotification,
  normalizeFollowerAlertState,
  FOLLOWER_DOWN_THROTTLE_MS,
  type FollowerAlertState,
} from "../public-follow-policy";

const NOW = 1_800_000_000_000;
const fresh: FollowerAlertState = { lastEvent: null, lastDownAt: null };

test("first down on a fresh check is announced", () => {
  const d = decideFollowerNotification(fresh, "website_down", NOW);
  assert.deepEqual(d, { send: true, next: { lastEvent: "website_down", lastDownAt: NOW } });
});

test("up with no announced down is skipped", () => {
  assert.deepEqual(decideFollowerNotification(fresh, "website_up", NOW), { send: false, reason: "no_prior_down" });
});

test("a retried down is not announced twice", () => {
  const state = { lastEvent: "website_down" as const, lastDownAt: NOW };
  assert.deepEqual(decideFollowerNotification(state, "website_down", NOW + 5000), { send: false, reason: "duplicate" });
});

test("recovery after an announced down is announced and keeps lastDownAt", () => {
  const state = { lastEvent: "website_down" as const, lastDownAt: NOW };
  const d = decideFollowerNotification(state, "website_up", NOW + 600_000);
  assert.deepEqual(d, { send: true, next: { lastEvent: "website_up", lastDownAt: NOW } });
});

test("a retried up is not announced twice", () => {
  const state = { lastEvent: "website_up" as const, lastDownAt: NOW };
  assert.deepEqual(decideFollowerNotification(state, "website_up", NOW), { send: false, reason: "duplicate" });
});

test("a flap inside the throttle window is suppressed, and so is its recovery", () => {
  const afterUp = { lastEvent: "website_up" as const, lastDownAt: NOW };
  const down = decideFollowerNotification(afterUp, "website_down", NOW + 10 * 60_000);
  assert.deepEqual(down, { send: false, reason: "flap_throttle" });
  // State is unchanged by a throttled down, so the next up is a duplicate.
  assert.deepEqual(decideFollowerNotification(afterUp, "website_up", NOW + 20 * 60_000), { send: false, reason: "duplicate" });
});

test("a down after the throttle window is announced again", () => {
  const afterUp = { lastEvent: "website_up" as const, lastDownAt: NOW };
  const later = NOW + FOLLOWER_DOWN_THROTTLE_MS;
  assert.deepEqual(decideFollowerNotification(afterUp, "website_down", later), {
    send: true,
    next: { lastEvent: "website_down", lastDownAt: later },
  });
});

test("normalizeFollowerAlertState tolerates missing and junk docs", () => {
  assert.deepEqual(normalizeFollowerAlertState(undefined), fresh);
  assert.deepEqual(normalizeFollowerAlertState({ lastEvent: "nope", lastDownAt: "x" }), fresh);
  assert.deepEqual(normalizeFollowerAlertState({ lastEvent: "website_up", lastDownAt: 5 }), { lastEvent: "website_up", lastDownAt: 5 });
});
