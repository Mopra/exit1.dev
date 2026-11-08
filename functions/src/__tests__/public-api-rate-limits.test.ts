import test from "node:test";
import assert from "node:assert/strict";

import {
  IP_GUARD_PER_MINUTE,
  TIER_READ_RATE_LIMITS,
  TierCache,
  resolveReadRateLimits,
} from "../public-api-rate-limits";

test("Free keeps the original read limits", () => {
  assert.deepEqual(resolveReadRateLimits("free", false), {
    perKeyTotalPerMinute: 5,
    perEndpointPerMinute: 1,
    perKeyDaily: 500,
    perUserDaily: 2000,
  });
});

test("read limits rise with the plan and fit under the IP guard", () => {
  const order = ["free", "indie", "nano", "pro"] as const;
  for (let i = 1; i < order.length; i++) {
    const lo = TIER_READ_RATE_LIMITS[order[i - 1]];
    const hi = TIER_READ_RATE_LIMITS[order[i]];
    assert.ok(hi.perKeyTotalPerMinute > lo.perKeyTotalPerMinute, order[i]);
    assert.ok(hi.perEndpointPerMinute > lo.perEndpointPerMinute, order[i]);
    assert.ok(hi.perKeyDaily > lo.perKeyDaily, order[i]);
    assert.ok(hi.perUserDaily > lo.perUserDaily, order[i]);
    assert.ok(hi.perKeyTotalPerMinute <= IP_GUARD_PER_MINUTE, order[i]);
  }
});

test("agent sessions never get less than the plan's key", () => {
  assert.equal(resolveReadRateLimits("free", true).perEndpointPerMinute, 10);
  assert.equal(resolveReadRateLimits("pro", true).perKeyTotalPerMinute, 60);
  assert.equal(resolveReadRateLimits("pro", true).perEndpointPerMinute, 20);
});

test("tier cache loads once per TTL and does not cache failures", async () => {
  let calls = 0;
  let fail = false;
  const cache = new TierCache(async () => {
    calls++;
    if (fail) throw new Error("down");
    return "pro";
  }, 1000);
  assert.equal(await cache.get("u", 0), "pro");
  assert.equal(await cache.get("u", 500), "pro");
  assert.equal(calls, 1);
  fail = true;
  // Expired: the load fails, the stale answer is kept.
  assert.equal(await cache.get("u", 2000), "pro");
  // Unknown user with a failing load falls to Free.
  assert.equal(await cache.get("other", 2000), "free");
  fail = false;
  assert.equal(await cache.get("other", 2001), "pro");
});
