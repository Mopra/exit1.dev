import test from "node:test";
import assert from "node:assert/strict";

import { FixedWindowRateLimiter, applyRateLimitHeaders } from "../rate-limit";

test("FixedWindowRateLimiter enforces limit and provides Retry-After/RateLimit headers", () => {
  const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 100 });

  const resHeaders: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      resHeaders[k] = v;
    },
  };

  const now = 1_700_000_000_000; // fixed timestamp
  const key = "key:test";

  const first = limiter.consume(key, 2, now);
  assert.equal(first.allowed, true);
  applyRateLimitHeaders(res, first);
  assert.equal(resHeaders["RateLimit-Limit"], "2");
  assert.equal(resHeaders["RateLimit-Remaining"], "1");
  assert.ok(Number(resHeaders["RateLimit-Reset"]) > 0);

  const second = limiter.consume(key, 2, now + 1);
  assert.equal(second.allowed, true);

  const third = limiter.consume(key, 2, now + 2);
  assert.equal(third.allowed, false);
  applyRateLimitHeaders(res, third);
  assert.equal(resHeaders["RateLimit-Remaining"], "0");
  assert.ok(Number(resHeaders["Retry-After"]) >= 1);
});


