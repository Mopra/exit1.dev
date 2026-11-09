import test from "node:test";
import assert from "node:assert/strict";

import { periodsToRefresh, planRollupDays } from "../sla-rollup-plan";
import {
  buildReportRowsSql,
  buildRollupMergeSql,
  buildRollupSelectSql,
  carryMsForFrequency,
  reportRowsParams,
  rollupParams,
  SLA_DEFAULT_CARRY_MS,
} from "../sla-rollup-sql";
import { WAF_BLOCK_ERROR_PREFIXES } from "../public-monitor-blocked";
import { BigQuery } from "@google-cloud/bigquery";

const H = 3600_000;
const D = 24 * H;
const at = (s: string) => Date.parse(s);
const days = (plan: ReturnType<typeof planRollupDays>) =>
  plan.map((d) => `${new Date(d.dayStartMs).toISOString().slice(0, 10)}${d.complete ? "" : "~"}`);

test("02:10 run completes yesterday and starts today", () => {
  const plan = planRollupDays(at("2026-11-08T02:10:00Z"), "2026-11-06");
  assert.deepEqual(days(plan), ["2026-11-07", "2026-11-08~"]);
  assert.equal(plan[1].cutMs, at("2026-11-08T02:10:00Z"));
});

test("later slots only refresh today", () => {
  assert.deepEqual(days(planRollupDays(at("2026-11-08T14:10:00Z"), "2026-11-07")), ["2026-11-08~"]);
});

test("a missed run heals up to 3 days back", () => {
  assert.deepEqual(days(planRollupDays(at("2026-11-08T08:10:00Z"), "2026-11-01")), ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08~"]);
  assert.deepEqual(days(planRollupDays(at("2026-11-08T08:10:00Z"), null)), ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08~"]);
});

test("a day inside the 2 h margin is written but not complete", () => {
  const plan = planRollupDays(at("2026-11-08T01:00:00Z"), "2026-11-06");
  assert.deepEqual(days(plan), ["2026-11-07~", "2026-11-08~"]);
  assert.equal(plan[0].cutMs, at("2026-11-08T00:00:00Z"));
});

test("cron refreshes the open month and the previous one until it is final", () => {
  const report = { timezone: "Europe/Copenhagen", createdAt: at("2026-09-01T00:00:00Z"), lastFinalPeriod: "2026-10" };
  assert.deepEqual(periodsToRefresh(report, at("2026-11-20T08:10:00Z")), ["2026-11"]);
  assert.deepEqual(periodsToRefresh(report, at("2026-12-01T02:10:00Z")), ["2026-11", "2026-12"]);
  assert.deepEqual(periodsToRefresh({ ...report, lastFinalPeriod: "2026-11" }, at("2026-12-01T08:10:00Z")), ["2026-12"]);
  // A report created this month has no previous month.
  assert.deepEqual(periodsToRefresh({ ...report, createdAt: at("2026-12-01T00:30:00Z"), lastFinalPeriod: null }, at("2026-12-01T02:10:00Z")), ["2026-12"]);
});

test("carry is 3 h, or twice the interval for slow checks", () => {
  assert.equal(carryMsForFrequency(undefined), SLA_DEFAULT_CARRY_MS);
  assert.equal(carryMsForFrequency(5), SLA_DEFAULT_CARRY_MS);
  assert.equal(carryMsForFrequency(1440), 2 * D);
});

test("rollup params carry the WAF prefixes and reject a cut outside the day", () => {
  const { params, types } = rollupParams(at("2026-11-06T00:00:00Z"), at("2026-11-07T00:00:00Z"), []);
  assert.deepEqual(params.wafPrefixes, [...WAF_BLOCK_ERROR_PREFIXES]);
  assert.deepEqual(types.carry, [{ website_id: "STRING", carry_ms: "INT64" }]);
  assert.throws(() => rollupParams(at("2026-11-06T01:00:00Z"), at("2026-11-07T00:00:00Z"), []));
  assert.throws(() => rollupParams(at("2026-11-06T00:00:00Z"), at("2026-11-07T00:00:01Z"), []));
});

test("every query has a lower time bound", () => {
  const merge = buildRollupMergeSql();
  assert.match(merge, /timestamp >= @dayStart AND timestamp < @cut/);
  assert.match(merge, /timestamp >= TIMESTAMP_SUB\(@dayStart, INTERVAL 2 DAY\)/);
  assert.match(merge, /ON target\.day = DATE\(@dayStart\)/);
  assert.match(buildReportRowsSql(), /day >= @firstDay/);
});

test("rows with a NULL key never reach the MERGE (check_sla_daily keys are REQUIRED)", () => {
  const select = buildRollupSelectSql();
  const filters = select.match(/AND website_id IS NOT NULL AND user_id IS NOT NULL/g) ?? [];
  // Both history reads: the day's rows and the seed row.
  assert.equal(filters.length, 2);
});

test("report read sends real DATE values for its day bounds (regression: NULL bounds read 0 rows)", () => {
  const { params, types } = reportRowsParams(["a"], "2026-10-31", "2026-11-09");
  for (const key of ["firstDay", "lastDay"] as const) {
    // What the client puts on the wire. A plain string with type DATE came
    // out with no parameterValue, i.e. NULL.
    const wire = (BigQuery as unknown as { valueToQueryParameter_: (v: unknown, t: unknown) => { parameterType: { type: string }; parameterValue?: { value?: string } } })
      .valueToQueryParameter_(params[key], types[key]);
    assert.equal(wire.parameterType.type, "DATE");
    assert.equal(wire.parameterValue?.value, key === "firstDay" ? "2026-10-31" : "2026-11-09");
  }
});
