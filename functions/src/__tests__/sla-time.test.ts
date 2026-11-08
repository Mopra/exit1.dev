import test from "node:test";
import assert from "node:assert/strict";

import {
  currentPeriod,
  finalizeAt,
  formatInZone,
  isValidPeriod,
  isValidTimeZone,
  localDayBounds,
  nextPeriod,
  periodBounds,
  periodLabel,
  previousPeriod,
  zonedMidnightToUtc,
} from "../sla-time";

const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

test("periodBounds in UTC is plain calendar months", () => {
  const { startMs, endMs } = periodBounds("2026-11", "UTC");
  assert.equal(iso(startMs), "2026-11-01T00:00:00.000Z");
  assert.equal(iso(endMs), "2026-12-01T00:00:00.000Z");
});

test("periodBounds across zones from UTC-12 to UTC+14, half and quarter hours", () => {
  const cases: Array<[string, string, string]> = [
    ["Europe/Copenhagen", "2026-10-31T23:00:00.000Z", "2026-11-30T23:00:00.000Z"],
    ["America/New_York", "2026-11-01T04:00:00.000Z", "2026-12-01T05:00:00.000Z"],
    ["Asia/Kolkata", "2026-10-31T18:30:00.000Z", "2026-11-30T18:30:00.000Z"],
    ["Asia/Kathmandu", "2026-10-31T18:15:00.000Z", "2026-11-30T18:15:00.000Z"],
    ["Pacific/Kiritimati", "2026-10-31T10:00:00.000Z", "2026-11-30T10:00:00.000Z"],
    ["Etc/GMT+12", "2026-11-01T12:00:00.000Z", "2026-12-01T12:00:00.000Z"],
  ];
  for (const [tz, start, end] of cases) {
    const b = periodBounds("2026-11", tz);
    assert.equal(iso(b.startMs), start, tz);
    assert.equal(iso(b.endMs), end, tz);
  }
});

test("Lord Howe's 30-minute DST shift shortens October by 30 minutes", () => {
  const { startMs, endMs } = periodBounds("2026-10", "Australia/Lord_Howe");
  assert.equal(endMs - startMs, 31 * 24 * H - 0.5 * H);
});

test("months with a DST change are an hour shorter or longer", () => {
  const len = (p: string, tz: string) => {
    const b = periodBounds(p, tz);
    return b.endMs - b.startMs;
  };
  assert.equal(len("2026-03", "Europe/Copenhagen"), 31 * 24 * H - H);
  assert.equal(len("2026-10", "Europe/Copenhagen"), 31 * 24 * H + H);
  assert.equal(len("2026-03", "America/New_York"), 31 * 24 * H - H);
  assert.equal(len("2026-11", "America/New_York"), 30 * 24 * H + H);
  assert.equal(len("2026-11", "Europe/Copenhagen"), 30 * 24 * H);
});

test("a skipped local midnight starts at the first instant after it", () => {
  // Chile moved clocks forward at local 00:00 on 2019-09-08 (00:00 -> 01:00).
  const t = zonedMidnightToUtc(2019, 9, 8, "America/Santiago");
  assert.equal(iso(t), "2019-09-08T04:00:00.000Z");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(new Date(t));
  assert.equal(parts, "01:00");
  // One ms earlier is still the previous local day.
  assert.equal(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date(t - 1)),
    "2019-09-07",
  );
});

test("currentPeriod flips exactly at the local month boundary", () => {
  const { endMs } = periodBounds("2026-11", "Europe/Copenhagen");
  assert.equal(currentPeriod(endMs - 1, "Europe/Copenhagen"), "2026-11");
  assert.equal(currentPeriod(endMs, "Europe/Copenhagen"), "2026-12");
  // Same instant is still November in New York.
  assert.equal(currentPeriod(endMs, "America/New_York"), "2026-11");
});

test("period arithmetic wraps years", () => {
  assert.equal(nextPeriod("2026-12"), "2027-01");
  assert.equal(previousPeriod("2027-01"), "2026-12");
  assert.equal(periodLabel("2026-11"), "November 2026");
  assert.ok(isValidPeriod("2026-01"));
  assert.ok(!isValidPeriod("2026-13"));
  assert.ok(!isValidPeriod("2026-1"));
});

test("invalid zone names are rejected", () => {
  assert.ok(isValidTimeZone("Europe/Copenhagen"));
  assert.ok(isValidTimeZone("UTC"));
  assert.ok(!isValidTimeZone("Mars/Olympus"));
  assert.ok(!isValidTimeZone(""));
  assert.ok(!isValidTimeZone(42));
});

test("finalizeAt is the local month end plus 2 hours (worked examples)", () => {
  assert.equal(iso(finalizeAt("2026-11", "Pacific/Kiritimati")), "2026-11-30T12:00:00.000Z");
  assert.equal(iso(finalizeAt("2026-11", "Etc/GMT+12")), "2026-12-01T14:00:00.000Z");
  assert.equal(iso(finalizeAt("2026-11", "Europe/Copenhagen")), "2026-12-01T01:00:00.000Z");
});

test("localDayBounds tiles the month without gaps", () => {
  const days = localDayBounds("2026-10", "Europe/Copenhagen");
  assert.equal(days.length, 31);
  const { startMs, endMs } = periodBounds("2026-10", "Europe/Copenhagen");
  assert.equal(days[0].startMs, startMs);
  assert.equal(days[30].endMs, endMs);
  for (let i = 1; i < days.length; i++) assert.equal(days[i].startMs, days[i - 1].endMs);
  // The DST day (Oct 25) is 25 hours long.
  const dst = days.find((d) => d.day === "2026-10-25")!;
  assert.equal(dst.endMs - dst.startMs, 25 * H);
});

test("formatInZone shows local time with the zone name", () => {
  const s = formatInZone(Date.parse("2026-11-14T02:12:00Z"), "Europe/Copenhagen");
  assert.match(s, /Nov 14, 2026/);
  assert.match(s, /03:12/);
  assert.match(s, /GMT\+1|CET/);
});
