import test from "node:test";
import assert from "node:assert/strict";

import { __alertTestHooks, getSystemHealthGateStatus } from "../alert";
import { CONFIG } from "../config";

// These tests exercise the system health gate in isolation. The gate
// state is module-scoped, so we reset it before each scenario via
// __alertTestHooks.resetSystemHealthGate().
//
// Background: the gate is meant to suppress alert storms caused by
// exit1-side faults. The "ownership-blind" bug was that it counted
// distinct check IDs — so one customer's own real outage across many
// of THEIR sites could trip the gate during the very incident where
// they need the alert. Fix: count distinct USERS, not distinct checks.

const { recordStatusTransition, isSystemHealthGateTripped, resetSystemHealthGate } = __alertTestHooks;

test("60 DOWN flips all belonging to ONE user do not trip the gate", () => {
  resetSystemHealthGate();
  const userId = "single-customer";
  for (let i = 0; i < 60; i++) {
    recordStatusTransition(`check_${i}`, userId, "UP", "DOWN");
  }
  assert.equal(isSystemHealthGateTripped(), false);
  const status = getSystemHealthGateStatus();
  assert.equal(status.tripped, false);
  assert.equal(status.distinctUserCount, 1);
  assert.equal(status.downFlipCount, 60);
});

test("DOWN flips spread across >= USER_THRESHOLD distinct users trip the gate", () => {
  resetSystemHealthGate();
  const threshold = CONFIG.SYSTEM_HEALTH_GATE_USER_THRESHOLD;
  for (let i = 0; i < threshold; i++) {
    recordStatusTransition(`check_${i}`, `user_${i}`, "UP", "DOWN");
  }
  assert.equal(isSystemHealthGateTripped(), true);
  const status = getSystemHealthGateStatus();
  assert.equal(status.tripped, true);
  assert.equal(status.reason, "threshold");
  assert.equal(status.distinctUserCount, threshold);
});

test("repeated DOWN flips of the same checkId count once, not many times", () => {
  resetSystemHealthGate();
  // Same single check, same single user, flipped UP→DOWN many times in a row
  // (e.g. an actually-flapping site). Should NOT inflate the distinct-user
  // count or the total downFlip count.
  for (let i = 0; i < 30; i++) {
    recordStatusTransition("check_one", "user_one", "UP", "DOWN");
  }
  assert.equal(isSystemHealthGateTripped(), false);
  const status = getSystemHealthGateStatus();
  assert.equal(status.downFlipCount, 1, "repeated flips of the same checkId must collapse to one entry");
  assert.equal(status.distinctUserCount, 1);
});

test("missing userId falls back to checkId so the entry still counts as one owner", () => {
  resetSystemHealthGate();
  // Two checks with no userId → each counts as its own owner (keyed by checkId).
  recordStatusTransition("orphan_check_a", undefined, "UP", "DOWN");
  recordStatusTransition("orphan_check_b", "", "UP", "DOWN");
  const status = getSystemHealthGateStatus();
  assert.equal(status.downFlipCount, 2);
  assert.equal(status.distinctUserCount, 2, "each missing-userId entry counts as its own owner — never crashes, never drops");
});

test("non-UP→DOWN transitions are not recorded", () => {
  resetSystemHealthGate();
  recordStatusTransition("c1", "u1", "DOWN", "UP");        // recovery — ignore
  recordStatusTransition("c2", "u2", "DOWN", "DOWN");      // no-op
  recordStatusTransition("c3", "u3", "UP", "UP");          // no-op
  recordStatusTransition("c4", "u4", "UP", "REDIRECT");    // still up
  const status = getSystemHealthGateStatus();
  assert.equal(status.downFlipCount, 0);
  assert.equal(status.distinctUserCount, 0);
});
