import test from "node:test";
import assert from "node:assert/strict";

import { classifyRetry, IDEMPOTENCY_CONFLICT } from "../day3-client";

const decide = (over: Partial<Parameters<typeof classifyRetry>[0]> = {}) =>
  classifyRetry({
    status: 500,
    code: "internal_error",
    isWrite: true,
    hasIdempotencyKey: true,
    attempt: 0,
    retryAfterS: null,
    ...over,
  });

// ── Idempotency conflicts ───────────────────────────────────────────────────
// The failure that killed the first live backfill: a 1,000-row batch 500s at
// the gateway while Day3 keeps applying it, the 500 ms replay lands inside the
// still-open idempotency lock, and the run died on a 409 it should have waited
// out. A conflict means "come back later", never "give up".

test("an idempotency conflict is retried, not fatal", () => {
  const decision = decide({ status: 409, code: IDEMPOTENCY_CONFLICT, attempt: 1 });
  assert.equal(decision.retry, true);
});

test("conflict backoff is seconds, never milliseconds", () => {
  // Anything sub-second re-enters the lock that caused the conflict.
  for (let attempt = 0; attempt < 6; attempt++) {
    const decision = decide({ status: 409, code: IDEMPOTENCY_CONFLICT, attempt });
    assert.ok(
      decision.waitMs >= 3_000,
      `attempt ${attempt} waited ${decision.waitMs}ms — too soon to replay`,
    );
  }
});

test("conflict backoff grows, then holds at its ceiling", () => {
  const waits = [0, 1, 2, 3, 4, 5].map(
    (attempt) => decide({ status: 409, code: IDEMPOTENCY_CONFLICT, attempt }).waitMs,
  );
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] >= waits[i - 1], `wait shrank at attempt ${i}`);
  }
  assert.equal(waits[4], waits[5], "past the schedule the tail value repeats");
});

// ── Writes vs reads ─────────────────────────────────────────────────────────

test("a keyless write is never retried — a replay would write twice", () => {
  assert.equal(decide({ hasIdempotencyKey: false }).retry, false);
  assert.equal(
    decide({ hasIdempotencyKey: false, status: 409, code: IDEMPOTENCY_CONFLICT }).retry,
    false,
  );
});

test("a keyless read still retries — nothing is in flight to duplicate", () => {
  const decision = decide({ isWrite: false, hasIdempotencyKey: false });
  assert.equal(decision.retry, true);
});

test("a 5xx write waits longer than a 5xx read", () => {
  const write = decide({ status: 500 }).waitMs;
  const read = decide({ status: 500, isWrite: false }).waitMs;
  assert.ok(write > read, `write ${write}ms should outwait read ${read}ms`);
  assert.ok(write >= 2_000, "an ambiguous write needs room to settle server-side");
});

// ── Transient vs terminal ───────────────────────────────────────────────────

test("network failures (status 0) are treated as transient", () => {
  assert.equal(decide({ status: 0, code: "network_error" }).retry, true);
});

test("4xx other than a conflict is terminal", () => {
  for (const status of [400, 403, 404, 422]) {
    assert.equal(decide({ status, code: "invalid_request" }).retry, false, `${status} retried`);
  }
});

test("transient backoff is exponential", () => {
  const first = decide({ attempt: 0 }).waitMs;
  const second = decide({ attempt: 1 }).waitMs;
  assert.equal(second, first * 2);
});

// ── Rate limiting ───────────────────────────────────────────────────────────

test("429 honours Retry-After rather than backing off blindly", () => {
  assert.equal(decide({ status: 429, code: "rate_limited", retryAfterS: 7 }).waitMs, 7_000);
});

test("429 caps a hostile Retry-After so the invocation budget survives", () => {
  const decision = decide({ status: 429, code: "rate_limited", retryAfterS: 6_000 });
  assert.equal(decision.retry, true);
  assert.equal(decision.waitMs, 30_000);
});

test("429 without a Retry-After header falls back to a short wait", () => {
  assert.equal(decide({ status: 429, code: "rate_limited", retryAfterS: null }).waitMs, 1_000);
});
