import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateCheck,
  computePeriod,
  computeStatus,
  stitchSegments,
  windowFromRow,
  SLA_MAX_INCIDENTS,
  type SlaDailyRow,
  type SlaSegment,
} from "../sla-math";
import { periodBounds } from "../sla-time";

const H = 3600_000;
const M = 60_000;
const D = 24 * H;
const at = (s: string) => Date.parse(s);

const row = (checkId: string, day: string, segments: SlaSegment[], coveredToMs?: number): SlaDailyRow => ({
  checkId,
  day,
  coveredToMs: coveredToMs ?? at(`${day}T00:00:00Z`) + D,
  segments,
});

const seg = (state: SlaSegment["state"], start: string, end: string): SlaSegment => ({ state, startMs: at(start), endMs: at(end) });

const byDay = (...rows: SlaDailyRow[]) => new Map(rows.map((r) => [r.day, r]));

test("only up: availability 1; only down: 0; nothing measured: null", () => {
  const up = aggregateCheck(byDay(row("c", "2026-11-02", [])), at("2026-11-02T00:00:00Z"), at("2026-11-03T00:00:00Z"), { countBlockedAsDown: false, dataThroughMs: Infinity });
  assert.equal(up.upMs, D);
  assert.equal(computeStatus({ final: true, targetPercent: 99.9, upMs: up.upMs, downMs: up.downMs, spanMs: up.spanMs, fullSpanMs: up.spanMs }).availability, 1);

  const down = aggregateCheck(byDay(row("c", "2026-11-02", [seg("down", "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z")])), at("2026-11-02T00:00:00Z"), at("2026-11-03T00:00:00Z"), { countBlockedAsDown: false, dataThroughMs: Infinity });
  assert.equal(down.downMs, D);
  assert.equal(computeStatus({ final: true, targetPercent: 99, upMs: 0, downMs: D, spanMs: D, fullSpanMs: D }).availability, 0);

  const none = computeStatus({ final: true, targetPercent: 99, upMs: 0, downMs: 0, spanMs: D, fullSpanMs: D });
  assert.equal(none.availability, null);
  assert.equal(none.status, "no_data");
});

test("maintenance, blocked and no_data are excluded; countBlockedAsDown moves blocked to down", () => {
  const r = row("c", "2026-11-02", [
    seg("down", "2026-11-02T01:00:00Z", "2026-11-02T02:00:00Z"),
    seg("maintenance", "2026-11-02T03:00:00Z", "2026-11-02T05:00:00Z"),
    seg("blocked", "2026-11-02T06:00:00Z", "2026-11-02T07:00:00Z"),
    seg("no_data", "2026-11-02T20:00:00Z", "2026-11-03T00:00:00Z"),
  ]);
  const s = at("2026-11-02T00:00:00Z");
  const e = s + D;
  const a = aggregateCheck(byDay(r), s, e, { countBlockedAsDown: false, dataThroughMs: Infinity });
  assert.equal(a.downMs, H);
  assert.equal(a.maintenanceMs, 2 * H);
  assert.equal(a.blockedMs, H);
  assert.equal(a.noDataMs, 4 * H);
  assert.equal(a.upMs, 16 * H);

  const b = aggregateCheck(byDay(r), s, e, { countBlockedAsDown: true, dataThroughMs: Infinity });
  assert.equal(b.downMs, 2 * H);
  assert.equal(b.blockedMs, 0);
  assert.equal(b.upMs, 16 * H);
});

test("sub-windows split at 05:30 sum exactly to the whole day", () => {
  const rows = [
    // Created 10:00 UTC: leading no_data segment.
    row("c", "2026-11-02", [
      seg("no_data", "2026-11-02T00:00:00Z", "2026-11-02T10:00:00Z"),
      seg("down", "2026-11-02T12:00:00Z", "2026-11-02T12:30:00Z"),
    ]),
    // Deleted: carry then trailing no_data.
    row("c", "2026-11-03", [
      seg("down", "2026-11-03T04:00:00Z", "2026-11-03T06:00:00Z"),
      seg("no_data", "2026-11-03T09:00:00Z", "2026-11-04T00:00:00Z"),
    ]),
    // Partial today row covered to 14:10.
    row("c", "2026-11-04", [seg("maintenance", "2026-11-04T05:00:00Z", "2026-11-04T06:00:00Z")], at("2026-11-04T14:10:00Z")),
  ];
  for (const r of rows) {
    const s = at(`${r.day}T00:00:00Z`);
    const cut = s + 5.5 * H;
    const whole = windowFromRow(r, s, s + D);
    const left = windowFromRow(r, s, cut);
    const right = windowFromRow(r, cut, s + D);
    for (const k of ["upMs", "downMs", "maintenanceMs", "blockedMs", "noDataMs", "coveredMs"] as const) {
      assert.equal(left[k] + right[k], whole[k], `${r.day} ${k}`);
    }
  }
  // The partial row describes only up to its cut.
  const partial = windowFromRow(rows[2], at("2026-11-04T00:00:00Z"), at("2026-11-05T00:00:00Z"));
  assert.equal(partial.coveredMs, 14 * H + 10 * M);
});

test("a missing day is no_data; time before createdAt is outside the span", () => {
  const s = at("2026-11-01T00:00:00Z");
  const res = aggregateCheck(byDay(row("c", "2026-11-02", [])), s, s + 3 * D, {
    countBlockedAsDown: false,
    createdAtMs: at("2026-11-01T12:00:00Z"),
    dataThroughMs: Infinity,
  });
  assert.equal(res.spanMs, 2.5 * D);
  assert.equal(res.upMs, D);
  assert.equal(res.noDataMs, 1.5 * D);
});

test("time past a partial row's cut counts as no_data", () => {
  const s = at("2026-11-04T00:00:00Z");
  const res = aggregateCheck(byDay(row("c", "2026-11-04", [], s + 10 * H)), s, s + D, { countBlockedAsDown: false, dataThroughMs: s + 12 * H });
  assert.equal(res.spanMs, 12 * H);
  assert.equal(res.upMs, 10 * H);
  assert.equal(res.noDataMs, 2 * H);
});

test("error budget, budget over 100% and statuses", () => {
  const month = 30 * D;
  const met = computeStatus({ final: true, targetPercent: 99.9, upMs: month - 10 * M, downMs: 10 * M, spanMs: month, fullSpanMs: month });
  assert.equal(met.status, "met");
  assert.ok(Math.abs(met.budgetMs - 0.001 * month) < 1);

  const breached = computeStatus({ final: true, targetPercent: 99.9, upMs: month - 2 * H, downMs: 2 * H, spanMs: month, fullSpanMs: month });
  assert.equal(breached.status, "breached");
  assert.ok(breached.budgetUsed > 1);

  // MTD, 10 days in, full month budget at 99.9% is 43.2 min.
  const elapsed = 10 * D;
  const onTrack = computeStatus({ final: false, targetPercent: 99.9, upMs: elapsed - M, downMs: M, spanMs: elapsed, fullSpanMs: month });
  assert.equal(onTrack.status, "on_track");
  const atRisk = computeStatus({ final: false, targetPercent: 99.9, upMs: elapsed - 12 * M, downMs: 12 * M, spanMs: elapsed, fullSpanMs: month });
  assert.equal(atRisk.status, "at_risk");
  const mtdBreached = computeStatus({ final: false, targetPercent: 99.9, upMs: elapsed - 50 * M, downMs: 50 * M, spanMs: elapsed, fullSpanMs: month });
  assert.equal(mtdBreached.status, "breached");

  const thin = computeStatus({ final: true, targetPercent: 99, upMs: 10 * D, downMs: 0, spanMs: month, fullSpanMs: month });
  assert.equal(thin.status, "met");
  assert.equal(thin.insufficientData, true);
});

test("MTD projection uses the DST-correct month length", () => {
  const { startMs, endMs } = periodBounds("2026-03", "Europe/Copenhagen");
  const len = endMs - startMs;
  assert.equal(len, 31 * D - H);
  const res = computeStatus({ final: false, targetPercent: 99.9, upMs: 10 * D, downMs: 0, spanMs: 10 * D, fullSpanMs: len });
  assert.ok(Math.abs(res.projectedBudgetMs - 0.001 * len) < 1);
});

test("stitchSegments merges across UTC midnight", () => {
  const out = stitchSegments([
    seg("down", "2026-11-30T23:50:00Z", "2026-12-01T00:00:00Z"),
    seg("down", "2026-12-01T00:00:00Z", "2026-12-01T00:20:00Z"),
    seg("maintenance", "2026-12-01T01:00:00Z", "2026-12-01T02:00:00Z"),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].endMs - out[0].startMs, 30 * M);
});

test("an incident across a local month end is clipped into the right month per zone", () => {
  // 22:50 to 23:20 UTC on Nov 30: November in New York, split for Copenhagen
  // (whose December starts at 23:00 UTC).
  const rows = [
    row("c", "2026-11-30", [seg("down", "2026-11-30T22:50:00Z", "2026-11-30T23:20:00Z")]),
    row("c", "2026-12-01", []),
  ];
  const checks = [{ checkId: "c", name: "C", url: "https://c" }];
  const allRows = [...rows];
  for (let d = 1; d <= 29; d++) allRows.push(row("c", `2026-11-${String(d).padStart(2, "0")}`, []));
  const dt = at("2026-12-03T00:00:00Z");

  const ny = computePeriod({ period: "2026-11", timezone: "America/New_York", targetPercent: 99.9, countBlockedAsDown: false, checks, rows: allRows, dataThroughMs: dt });
  assert.equal(ny.incidents.length, 1);
  assert.equal(ny.incidents[0].durationMs, 30 * M);
  assert.equal(ny.status, "final");

  const cphNov = computePeriod({ period: "2026-11", timezone: "Europe/Copenhagen", targetPercent: 99.9, countBlockedAsDown: false, checks, rows: allRows, dataThroughMs: dt });
  assert.equal(cphNov.incidents[0].durationMs, 10 * M);
  const cphDec = computePeriod({ period: "2026-12", timezone: "Europe/Copenhagen", targetPercent: 99.9, countBlockedAsDown: false, checks, rows: allRows, dataThroughMs: dt });
  assert.equal(cphDec.incidents[0].durationMs, 20 * M);
  assert.equal(cphDec.status, "open");
});

test("an incident still running at dataThrough is ongoing", () => {
  const cut = at("2026-11-10T14:10:00Z");
  const rows = [row("c", "2026-11-10", [seg("down", "2026-11-10T13:00:00Z", "2026-11-10T14:10:00Z")], cut)];
  const p = computePeriod({ period: "2026-11", timezone: "UTC", targetPercent: 99, countBlockedAsDown: false, checks: [{ checkId: "c", name: "C", url: "u", createdAtMs: at("2026-11-10T00:00:00Z") }], rows, dataThroughMs: cut });
  assert.equal(p.incidents[0].endMs, null);
  assert.equal(p.status, "open");
  assert.equal(p.dataThrough, cut);
});

test("overall is time-weighted across checks, including one added mid-month", () => {
  const s = at("2026-11-01T00:00:00Z");
  const rows: SlaDailyRow[] = [];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    rows.push(row("a", day, d === 5 ? [seg("down", `${day}T00:00:00Z`, `${day}T01:00:00Z`)] : []));
    if (d >= 16) rows.push(row("b", day, []));
  }
  const p = computePeriod({
    period: "2026-11", timezone: "UTC", targetPercent: 99.9, countBlockedAsDown: false,
    checks: [
      { checkId: "a", name: "A", url: "a", createdAtMs: s - D },
      { checkId: "b", name: "B", url: "b", createdAtMs: at("2026-11-16T00:00:00Z") },
    ],
    rows,
    dataThroughMs: at("2026-12-05T00:00:00Z"),
  });
  const b = p.checks.find((c) => c.checkId === "b")!;
  assert.equal(b.coverage, 1);
  assert.equal(p.overall.downMs, H);
  assert.equal(p.overall.upMs, 30 * D - H + 15 * D);
  assert.ok(Math.abs(p.overall.availability! - (45 * D - H) / (45 * D)) < 1e-12);
  assert.equal(p.daily.length, 30);
  assert.equal(p.daily[4].downMs, H);
});

test("incident cap keeps the longest and reports the true total", () => {
  const rows: SlaDailyRow[] = [];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    const segs: SlaSegment[] = [];
    for (let i = 0; i < 20; i++) {
      const start = at(`${day}T00:00:00Z`) + i * H;
      segs.push({ state: "down", startMs: start, endMs: start + (i + 1) * M });
    }
    rows.push(row("c", day, segs));
  }
  const p = computePeriod({ period: "2026-11", timezone: "UTC", targetPercent: 99, countBlockedAsDown: false, checks: [{ checkId: "c", name: "C", url: "u" }], rows, dataThroughMs: at("2026-12-02T00:00:00Z") });
  assert.equal(p.incidentsTotal, 600);
  assert.equal(p.incidents.length, SLA_MAX_INCIDENTS);
  assert.ok(p.incidents.every((i) => i.durationMs >= 2 * M));
  for (let i = 1; i < p.incidents.length; i++) assert.ok(p.incidents[i].startMs >= p.incidents[i - 1].startMs);
});

test("finalization needs dataThrough at or past period end plus 2 hours", () => {
  const { endMs } = periodBounds("2026-11", "Europe/Copenhagen");
  const base = { period: "2026-11", timezone: "Europe/Copenhagen", targetPercent: 99, countBlockedAsDown: false, checks: [], rows: [] };
  assert.equal(computePeriod({ ...base, dataThroughMs: endMs + 2 * H - 1 }).status, "open");
  assert.equal(computePeriod({ ...base, dataThroughMs: endMs + 2 * H }).status, "final");
});
