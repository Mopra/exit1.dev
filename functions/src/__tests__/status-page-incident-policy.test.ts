import test from "node:test";
import assert from "node:assert/strict";

import {
  IncidentValidationError,
  PUBLIC_HISTORY_MS,
  buildPublicIncidents,
  mergeDowntimeIntervals,
  deriveIncidentState,
  parseLinkedDowntime,
  parseTimestamp,
  parseTitle,
  type IncidentDoc,
  type IncidentUpdate,
} from "../status-page-incident-policy";


const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const update = (id: string, status: IncidentUpdate["status"], createdAt: number): IncidentUpdate => ({
  id,
  status,
  message: `${status} message`,
  createdAt,
});

const incident = (overrides: Partial<IncidentDoc>): IncidentDoc => ({
  userId: "owner",
  statusPageId: "page",
  title: "API errors",
  status: "investigating",
  affectedCheckIds: [],
  linkedDowntime: null,
  startedAt: NOW - HOUR,
  resolvedAt: null,
  updates: [update("u1", "investigating", NOW - HOUR)],
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  createdBy: "owner",
  updatedBy: "owner",
  ...overrides,
});

test("status follows the latest update, not the order it was posted", () => {
  const state = deriveIncidentState([
    update("b", "resolved", NOW),
    update("a", "investigating", NOW - HOUR),
  ]);
  assert.deepEqual(state, { status: "resolved", resolvedAt: NOW });
});

test("a later non-resolved update reopens the incident", () => {
  const state = deriveIncidentState([
    update("a", "resolved", NOW - HOUR),
    update("b", "monitoring", NOW),
  ]);
  assert.deepEqual(state, { status: "monitoring", resolvedAt: null });
});

test("timestamps default to now and reject the future and the distant past", () => {
  assert.equal(parseTimestamp(undefined, NOW, "t"), NOW);
  assert.throws(() => parseTimestamp(NOW + DAY, NOW, "t"), IncidentValidationError);
  assert.throws(() => parseTimestamp(NOW - 500 * DAY, NOW, "t"), IncidentValidationError);
});

test("titles are trimmed and length-checked", () => {
  assert.equal(parseTitle("  Database   slow "), "Database slow");
  assert.throws(() => parseTitle("ab"), IncidentValidationError);
});

test("linked downtime needs a start and cannot end before it starts", () => {
  assert.throws(() => parseLinkedDowntime({ checkId: "c" }, NOW), IncidentValidationError);
  assert.throws(
    () => parseLinkedDowntime({ checkId: "c", startedAt: NOW - HOUR, endedAt: NOW - 2 * HOUR }, NOW),
    IncidentValidationError,
  );
  assert.deepEqual(parseLinkedDowntime({ checkId: "c", startedAt: NOW - HOUR }, NOW), {
    checkId: "c",
    startedAt: NOW - HOUR,
    endedAt: null,
  });
});

test("public projection keeps open incidents and 90 days of resolved ones, open first", () => {
  const result = buildPublicIncidents(
    [
      { id: "old", doc: incident({ status: "resolved", startedAt: NOW - 200 * DAY, resolvedAt: NOW - PUBLIC_HISTORY_MS - DAY }) },
      { id: "recent", doc: incident({ status: "resolved", startedAt: NOW - 2 * DAY, resolvedAt: NOW - DAY }) },
      { id: "open-ancient", doc: incident({ startedAt: NOW - 300 * DAY }) },
      { id: "open", doc: incident({ startedAt: NOW - HOUR }) },
    ],
    NOW,
  );
  assert.deepEqual(result.map((i) => i.id), ["open", "open-ancient", "recent"]);
});

test("public projection drops uids and lists updates newest first", () => {
  const [pub] = buildPublicIncidents(
    [{ id: "x", doc: incident({ updates: [update("a", "investigating", NOW - HOUR), update("b", "identified", NOW)] }) }],
    NOW,
  );
  assert.equal("userId" in pub, false);
  assert.equal("createdBy" in pub, false);
  assert.deepEqual(pub.updates.map((u) => u.id), ["b", "a"]);
});

test("public projection stays under the byte budget", () => {
  const big = "x".repeat(2000);
  const updates = Array.from({ length: 50 }, (_, i) => ({ ...update(`u${i}`, "monitoring" as const, NOW - i * 1000), message: big }));
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, doc: incident({ startedAt: NOW - i * HOUR, updates }) }));
  const result = buildPublicIncidents(many, NOW);
  assert.ok(result.length >= 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 200 * 1024);
});

test("downtime intervals a few minutes apart merge into one outage, newest first", () => {
  const end = NOW;
  const windows = mergeDowntimeIntervals(
    [
      { started_at_ms: NOW - 10 * HOUR, ended_at_ms: NOW - 9 * HOUR },
      { started_at_ms: NOW - 9 * HOUR + 5 * 60 * 1000, ended_at_ms: NOW - 8 * HOUR },
      { started_at_ms: NOW - HOUR, ended_at_ms: end },
    ],
    end,
  );
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], { startedAt: NOW - HOUR, endedAt: null, durationMs: HOUR });
  assert.deepEqual(windows[1], { startedAt: NOW - 10 * HOUR, endedAt: NOW - 8 * HOUR, durationMs: 2 * HOUR });
});
