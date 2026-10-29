import test from "node:test";
import assert from "node:assert/strict";

import { findFreeTierRisks, findSpikes, topSeries, type CostSeries } from "../cost-watch-rules";

const q = (days: number[], key = "q1"): CostSeries => ({ key, group: "query", label: "SELECT ...", unit: "GB", days });

test("a doubled query family is a spike", () => {
  const f = findSpikes([q([3, 3, 3, 3, 3, 3, 3, 22])]);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "spike");
});

test("small absolute jumps are noise, even at a high ratio", () => {
  assert.deepEqual(findSpikes([q([0.1, 0.1, 0.1, 2])]), []);
  assert.deepEqual(findSpikes([{ ...q([0.05, 0.05, 0.4]), unit: "DKK" }]), []);
});

test("steady expensive lines don't alert every day", () => {
  assert.deepEqual(findSpikes([q([27, 25, 30, 28, 26, 29, 31, 30])]), []);
});

test("a line with no history that is already big is new", () => {
  const f = findSpikes([q([0, 0, 0, 19])]);
  assert.equal(f[0].kind, "new");
});

test("the Oct 23 blocked-count query would have been caught the next day", () => {
  // 2.7 GB/day before, 19 GB/day after the hourly 90-day scan shipped.
  const f = findSpikes([q([2.5, 2.7, 2.8, 2.5, 2.7, 2.8, 2.6, 19])]);
  assert.equal(f.length, 1);
});

test("free tier: warns when the month is on course to use it", () => {
  // October: 1.1 TiB by day 28 of 31.
  const f = findFreeTierRisks([{ name: "BigQuery analysis", unit: "GB", used: 1210, limit: 1100, daysElapsed: 28, daysInMonth: 31 }]);
  assert.equal(f.length, 1);
  assert.match(f[0].message, /already used up/);
});

test("free tier: says when it will run out", () => {
  const f = findFreeTierRisks([{ name: "Cloud Run CPU", unit: "vCPU-s", used: 100_000, limit: 180_000, daysElapsed: 15, daysInMonth: 31 }]);
  assert.match(f[0].message, /around day 27/);
});

test("free tier: warns once, on the day the projection crosses", () => {
  const base = { name: "x", unit: "GB", limit: 1100, daysInMonth: 30 };
  assert.equal(findFreeTierRisks([{ ...base, used: 500, usedDayBefore: 470, daysElapsed: 15 }]).length, 0);
  assert.equal(findFreeTierRisks([{ ...base, used: 500, usedDayBefore: 300, daysElapsed: 15 }]).length, 1);
});

test("free tier: quiet with headroom", () => {
  assert.deepEqual(findFreeTierRisks([{ name: "x", unit: "GB", used: 300, limit: 1100, daysElapsed: 15, daysInMonth: 30 }]), []);
});

test("topSeries ranks by window total within a group", () => {
  const top = topSeries([q([1, 1], "a"), q([5, 5], "b"), { ...q([99, 99], "c"), group: "function" }], "query", 5);
  assert.deepEqual(top.map(t => t.total), [10, 2]);
});
