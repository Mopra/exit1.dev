import test from "node:test";
import assert from "node:assert/strict";

import { SLA_FEATURE_ERROR, formatSlaPeriod, periodWithinAccess } from "../public-api-sla-format";
import type { SlaPeriodDoc } from "../sla-types";

const doc = {
  userId: "u", reportId: "r1", period: "2026-11", timezone: "Europe/Copenhagen", status: "open",
  periodStart: Date.parse("2026-10-31T23:00:00Z"), periodEnd: Date.parse("2026-11-30T23:00:00Z"),
  dataThrough: Date.parse("2026-11-08T14:10:00Z"), computedAt: Date.parse("2026-11-08T14:11:00Z"), rollupVersion: 1,
  targetPercent: 99.9, countBlockedAsDown: false,
  overall: { upMs: 1, downMs: 0, maintenanceMs: 0, blockedMs: 0, noDataMs: 0, availability: 1, coverage: 1, budgetMs: 0, budgetUsed: 0, projectedBudgetMs: 0, status: "on_track", insufficientData: false },
  daily: [],
  checks: [
    { checkId: "a", name: "A", url: "u", upMs: 1, downMs: 0, maintenanceMs: 0, blockedMs: 0, noDataMs: 0, availability: 1, coverage: 1, incidents: 0, longestIncidentMs: 0, status: "on_track", insufficientData: false },
    { checkId: "b", name: "B", url: "u", upMs: 1, downMs: 0, maintenanceMs: 0, blockedMs: 0, noDataMs: 0, availability: 1, coverage: 1, incidents: 0, longestIncidentMs: 0, status: "on_track", insufficientData: false },
  ],
  incidents: [{ checkId: "a", startMs: Date.parse("2026-11-03T10:00:00Z"), endMs: null, durationMs: 60_000 }],
  incidentsTotal: 1,
  exclusions: [],
  exclusionsTotal: 0,
} as SlaPeriodDoc;

test("403 body names the feature", () => {
  assert.deepEqual({ ...SLA_FEATURE_ERROR }, { error: "feature_not_in_plan", feature: "slaReporting", message: "SLA reporting is a Pro feature" });
});

test("period timestamps are UTC ISO strings with the zone alongside", () => {
  const out = formatSlaPeriod("r1", { name: "Acme" }, doc);
  assert.equal(out.periodStart, "2026-10-31T23:00:00.000Z");
  assert.equal(out.timezone, "Europe/Copenhagen");
  assert.equal(out.incidents[0].end, null);
  assert.equal(out.incidents[0].ongoing, true);
  assert.equal(out.sent, null);
});

test("a restricted key sees a report only when it covers every check", () => {
  const folders = new Map<string, string | null>([["a", "Clients/Acme"], ["b", "Other"]]);
  assert.ok(periodWithinAccess(null, doc, folders));
  assert.ok(periodWithinAccess({ checkIds: ["a", "b"], folders: [] }, doc, folders));
  assert.ok(!periodWithinAccess({ checkIds: [], folders: ["Clients"] }, doc, folders));
  assert.ok(periodWithinAccess({ checkIds: ["b"], folders: ["Clients"] }, doc, folders));
  assert.ok(!periodWithinAccess({ checkIds: ["a"], folders: [] }, null, folders));
});
