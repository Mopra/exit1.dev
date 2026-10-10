import test from "node:test";
import assert from "node:assert/strict";

import { parseIncludeParam, UptimeCache, UPTIME_24H_TTL_MS, UPTIME_30D_TTL_MS, type Window24h } from "../public-api-uptime";

test("parseIncludeParam accepts uptime and rejects unknown options", () => {
  assert.deepEqual([...parseIncludeParam("uptime")], ["uptime"]);
  assert.deepEqual([...parseIncludeParam(" uptime, ")], ["uptime"]);
  assert.equal(parseIncludeParam(undefined).size, 0);
  assert.equal(parseIncludeParam("").size, 0);
  assert.throws(() => parseIncludeParam("uptime,stats"), /Invalid include: stats/);
});

function fakeFetchers() {
  const calls = { h24: [] as string[][], d30: [] as string[][] };
  return {
    calls,
    fetchers: {
      fetch24h: async (ids: string[]) => {
        calls.h24.push(ids);
        const m = new Map<string, Window24h>();
        if (ids.includes("a")) m.set("a", { uptime: 99.98765, avgResponseTime: 123.6 });
        return m;
      },
      fetch30d: async (ids: string[]) => {
        calls.d30.push(ids);
        const m = new Map<string, number>();
        if (ids.includes("a")) m.set("a", 100);
        return m;
      },
    },
  };
}

test("UptimeCache rounds, reports missing data as null, and fetches only misses", async () => {
  let now = 1_000_000;
  const cache = new UptimeCache(() => now);
  const { calls, fetchers } = fakeFetchers();

  const first = await cache.lookup("u1", ["a", "b"], fetchers);
  assert.deepEqual(first.get("a"), { uptime24h: 99.988, uptime30d: 100, avgResponseTime24h: 124 });
  assert.deepEqual(first.get("b"), { uptime24h: null, uptime30d: null, avgResponseTime24h: null });

  // Within both TTLs: no fetch at all, same answers (nulls are cached too).
  const again = await cache.lookup("u1", ["a", "b"], fetchers);
  assert.equal(calls.h24.length, 1);
  assert.equal(calls.d30.length, 1);
  assert.deepEqual(again.get("a"), first.get("a"));

  // Past the 24h TTL only: the 30d figure comes from cache.
  now += UPTIME_24H_TTL_MS + 1;
  await cache.lookup("u1", ["a", "b", "c"], fetchers);
  assert.deepEqual(calls.h24[1], ["a", "b", "c"]);
  assert.deepEqual(calls.d30[1], ["c"]);

  now += UPTIME_30D_TTL_MS;
  await cache.lookup("u1", ["a"], fetchers);
  assert.deepEqual(calls.d30[2], ["a"]);
});

test("UptimeCache keys by user, so one user's figures never answer another's", async () => {
  const cache = new UptimeCache(() => 0);
  const { calls, fetchers } = fakeFetchers();
  await cache.lookup("u1", ["a"], fetchers);
  await cache.lookup("u2", ["a"], fetchers);
  assert.equal(calls.h24.length, 2);
});

test("UptimeCache does not cache a failed fetch", async () => {
  const cache = new UptimeCache(() => 0);
  const { calls, fetchers } = fakeFetchers();
  await assert.rejects(cache.lookup("u1", ["a"], { ...fetchers, fetch24h: async () => { throw new Error("bq"); } }));
  await cache.lookup("u1", ["a"], fetchers);
  assert.equal(calls.h24.length, 1);
});
