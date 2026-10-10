import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRegions,
  buildSnapshot,
  mergeDelta,
  planRefresh,
  deltaSince,
  ifNoneMatchHits,
  toStatusEntry,
  STATUS_MIN_REFRESH_MS,
  STATUS_FULL_RELOAD_MS,
  STATUS_DELTA_OVERLAP_MS,
} from "../public-api-status";

// GET /v1/public/checks/status is polled every 10 to 30 seconds. These tests
// pin the two things that keep that cheap and correct: the snapshot only
// re-reads what changed, and its ETag only moves when reported state moves.

const T0 = 1_760_000_000_000;

test("an online check reports one region and no error", () => {
  const entry = toStatusEntry("a", { name: "API", status: "online", lastError: "old", checkRegion: "vps-eu-1", lastStatusChange: T0 });
  assert.deepEqual(entry, {
    id: "a",
    name: "API",
    status: "online",
    lastStatusChange: T0,
    lastError: null,
    disabled: false,
    maintenanceMode: false,
    regions: { primary: "vps-eu-1", peer: null, regionsTotal: 1, regionsDown: 0, confirmedDown: false },
  });
});

test("down in both regions is confirmedDown", () => {
  const r = buildRegions({ status: "offline", checkRegion: "vps-eu-1", peerRegion: "vps-us-1", peerStatus: "offline", peerCheckedAt: T0, peerReachable: true });
  assert.deepEqual(r, { primary: "vps-eu-1", peer: "vps-us-1", regionsTotal: 2, regionsDown: 2, confirmedDown: true });
});

test("peer disagreeing is two regions, one down, not confirmed", () => {
  const r = buildRegions({ status: "offline", checkRegion: "vps-eu-1", peerRegion: "vps-us-1", peerStatus: "online", peerCheckedAt: T0, peerReachable: true });
  assert.equal(r.regionsTotal, 2);
  assert.equal(r.regionsDown, 1);
  assert.equal(r.confirmedDown, false);
});

test("an unreachable peer gave no verdict and is not counted", () => {
  const r = buildRegions({ status: "offline", checkRegion: "vps-eu-1", peerRegion: "vps-us-1", peerStatus: "offline", peerCheckedAt: T0, peerReachable: false });
  assert.deepEqual(r, { primary: "vps-eu-1", peer: null, regionsTotal: 1, regionsDown: 1, confirmedDown: false });
});

test("missing name falls back to url, missing status to unknown, missing lastStatusChange to null", () => {
  const e = toStatusEntry("x", { url: "https://x.test" });
  assert.equal(e.name, "https://x.test");
  assert.equal(e.status, "unknown");
  assert.equal(e.lastStatusChange, null);
});

test("snapshot is ordered by orderIndex then id", () => {
  const snap = buildSnapshot([
    { id: "b", data: { status: "online", orderIndex: 1 } },
    { id: "c", data: { status: "online", orderIndex: 0 } },
    { id: "a", data: { status: "online", orderIndex: 1 } },
  ], T0);
  assert.deepEqual(JSON.parse(snap.body).data.map((d: { id: string }) => d.id), ["c", "a", "b"]);
  assert.equal(JSON.parse(snap.body).meta.total, 3);
});

test("ETag is stable across refreshes that change nothing, and moves on a status change", () => {
  const rows = [{ id: "a", data: { status: "online", updatedAt: T0 } }];
  const s1 = buildSnapshot(rows, T0);
  const s2 = mergeDelta(s1, rows, 1, T0 + 30_000);
  assert.ok(s2);
  assert.equal(s2.etag, s1.etag);
  const s3 = mergeDelta(s2, [{ id: "a", data: { status: "offline", lastStatusChange: T0 + 60_000 } }], 1, T0 + 60_000);
  assert.ok(s3);
  assert.notEqual(s3.etag, s1.etag);
});

test("a delta that leaves the count off forces a full reload (deleted check)", () => {
  const s1 = buildSnapshot([{ id: "a", data: {} }, { id: "b", data: {} }], T0);
  assert.equal(mergeDelta(s1, [], 1, T0 + 10_000), null);
});

test("a new check arriving in the delta is merged", () => {
  const s1 = buildSnapshot([{ id: "a", data: {} }], T0);
  const s2 = mergeDelta(s1, [{ id: "b", data: { status: "online" } }], 2, T0 + 10_000);
  assert.ok(s2);
  assert.equal(s2.rows.size, 2);
  assert.equal(s2.fullAt, T0);
});

test("refresh plan: cached inside the min window, delta after, full when old or absent", () => {
  const s = buildSnapshot([], T0);
  assert.equal(planRefresh(undefined, T0), "full");
  assert.equal(planRefresh(s, T0 + STATUS_MIN_REFRESH_MS - 1), "cached");
  assert.equal(planRefresh(s, T0 + STATUS_MIN_REFRESH_MS), "delta");
  assert.equal(planRefresh(s, T0 + STATUS_FULL_RELOAD_MS), "full");
});

test("delta looks back past the last sync to catch late buffered writes", () => {
  assert.equal(deltaSince(buildSnapshot([], T0)), T0 - STATUS_DELTA_OVERLAP_MS);
});

test("If-None-Match matches strong, weak, listed and wildcard tags", () => {
  const etag = '"abc"';
  assert.equal(ifNoneMatchHits(undefined, etag), false);
  assert.equal(ifNoneMatchHits('"abc"', etag), true);
  assert.equal(ifNoneMatchHits('W/"abc"', etag), true);
  assert.equal(ifNoneMatchHits('"zzz", "abc"', etag), true);
  assert.equal(ifNoneMatchHits("*", etag), true);
  assert.equal(ifNoneMatchHits('"abd"', etag), false);
});
