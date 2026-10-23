import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveIncidents,
  mergeIncidentHistory,
  normalizeStoredIncidents,
  MERGE_GAP_MS,
  INCIDENT_RETENTION_MS,
  type IncidentIsland,
  type PublicIncident,
} from "../public-incidents";

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 21, 6, 10);

const island = (over: Partial<IncidentIsland> = {}): IncidentIsland => ({
  startedAt: T0,
  lastFailedAt: T0 + 60 * MIN,
  nextProbeAt: T0 + 65 * MIN,
  probes: 12,
  statusCode: 503,
  error: "HTTP 503",
  peerOfflineProbes: 0,
  ...over,
});

test("a closed island becomes one ended incident", () => {
  const [i] = deriveIncidents([island()], false);
  assert.equal(i.startedAt, T0);
  assert.equal(i.endedAt, T0 + 65 * MIN);
  assert.equal(i.durationMs, 65 * MIN);
  assert.equal(i.ongoing, false);
  assert.equal(i.statusCode, 503);
  assert.equal(i.id, String(T0));
});

test("one confirmed offline row is enough: confirmation already filtered blips", () => {
  assert.equal(deriveIncidents([island({ probes: 1 })], false).length, 1);
});

test("an island with no rows is dropped", () => {
  assert.deepEqual(deriveIncidents([island({ probes: 0 })], false), []);
});

test("islands split by a short recovery merge into one outage", () => {
  const a = island({ lastFailedAt: T0 + 20 * MIN, nextProbeAt: T0 + 25 * MIN, probes: 4 });
  const b = island({ startedAt: T0 + 25 * MIN + MERGE_GAP_MS - MIN, lastFailedAt: T0 + 90 * MIN, nextProbeAt: T0 + 95 * MIN, probes: 6, peerOfflineProbes: 2 });
  const out = deriveIncidents([b, a], false);
  assert.equal(out.length, 1);
  assert.equal(out[0].startedAt, T0);
  assert.equal(out[0].endedAt, T0 + 95 * MIN);
  assert.equal(out[0].probes, 10);
  assert.equal(out[0].confirmedFromTwoRegions, true);
});

test("islands far apart stay separate, newest first", () => {
  const a = island();
  const b = island({ startedAt: T0 + 12 * 60 * MIN, lastFailedAt: T0 + 13 * 60 * MIN, nextProbeAt: T0 + 13 * 60 * MIN + 5 * MIN });
  const out = deriveIncidents([a, b], false);
  assert.deepEqual(out.map((i) => i.startedAt), [b.startedAt, a.startedAt]);
});

test("no probe after the last island: ongoing only while the check says down", () => {
  const open = island({ nextProbeAt: null });
  const down = deriveIncidents([open], true)[0];
  assert.equal(down.ongoing, true);
  assert.equal(down.endedAt, null);
  assert.equal(down.durationMs, 60 * MIN);
  const up = deriveIncidents([open], false)[0];
  assert.equal(up.ongoing, false);
  assert.equal(up.endedAt, open.lastFailedAt);
});

test("status code 0 means no response; long errors are trimmed", () => {
  const [i] = deriveIncidents([island({ statusCode: 0, error: `  ${"x".repeat(300)}\n` })], false);
  assert.equal(i.statusCode, null);
  assert.equal(i.error!.length, 200);
});

const incident = (over: Partial<PublicIncident> = {}): PublicIncident => ({
  id: String(T0),
  startedAt: T0,
  endedAt: T0 + 65 * MIN,
  durationMs: 65 * MIN,
  ongoing: false,
  probes: 12,
  statusCode: 503,
  error: "HTTP 503",
  confirmedFromTwoRegions: false,
  ...over,
});

test("fresh incidents replace stored ones inside the window, older ones stay", () => {
  const windowStart = T0 + 24 * 60 * MIN;
  const old = incident();
  const staleInWindow = incident({ id: "x", startedAt: windowStart + 60 * MIN, durationMs: MIN });
  const fresh = incident({ id: "y", startedAt: windowStart + 60 * MIN, durationMs: 30 * MIN, endedAt: windowStart + 90 * MIN });
  const out = mergeIncidentHistory([old, staleInWindow], [fresh], windowStart, windowStart + 2 * 60 * MIN);
  assert.deepEqual(out.map((i) => i.id), ["y", String(T0)]);
});

test("an outage clipped by the window keeps its true start and id", () => {
  const windowStart = T0 + 60 * MIN;
  const stored = incident({ endedAt: null, ongoing: true, durationMs: 50 * MIN });
  const clipped = incident({ id: String(windowStart), startedAt: windowStart, endedAt: windowStart + 30 * MIN, durationMs: 30 * MIN, probes: 6 });
  const [out] = mergeIncidentHistory([stored], [clipped], windowStart, windowStart + 60 * MIN);
  assert.equal(out.id, String(T0));
  assert.equal(out.startedAt, T0);
  assert.equal(out.endedAt, windowStart + 30 * MIN);
  assert.equal(out.durationMs, 90 * MIN);
  assert.equal(out.probes, 12);
});

test("a stored outage that ended well before a fresh one is not continued", () => {
  const windowStart = T0 + 60 * MIN;
  const stored = incident({ endedAt: windowStart - 9 * MIN, durationMs: 51 * MIN });
  const fresh = incident({ id: "f", startedAt: windowStart + 9 * MIN, endedAt: windowStart + 20 * MIN, durationMs: 11 * MIN });
  const out = mergeIncidentHistory([stored], [fresh], windowStart, windowStart + 60 * MIN);
  assert.deepEqual(out.map((i) => i.id), ["f", String(T0)]);
});

test("a stored ongoing outage the fresh read no longer sees gets closed", () => {
  const windowStart = T0 + 24 * 60 * MIN;
  const stored = incident({ endedAt: null, ongoing: true, durationMs: 30 * MIN });
  const [out] = mergeIncidentHistory([stored], [], windowStart, windowStart + MIN);
  assert.equal(out.ongoing, false);
  assert.equal(out.endedAt, T0 + 30 * MIN);
});

test("incidents older than the retention drop off", () => {
  const now = T0 + INCIDENT_RETENTION_MS + MIN;
  assert.deepEqual(mergeIncidentHistory([incident()], [], now - 3 * 24 * 60 * MIN, now), []);
});

test("stored incidents are read tolerantly", () => {
  assert.deepEqual(normalizeStoredIncidents(undefined), []);
  assert.deepEqual(normalizeStoredIncidents([null, { startedAt: "x" }]), []);
  const [i] = normalizeStoredIncidents([{ startedAt: T0, durationMs: 5 }]);
  assert.equal(i.id, String(T0));
  assert.equal(i.endedAt, T0 + 5);
  const [open] = normalizeStoredIncidents([{ startedAt: T0, durationMs: 5, ongoing: true }]);
  assert.equal(open.endedAt, null);
});
