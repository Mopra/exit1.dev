import test from "node:test";
import assert from "node:assert/strict";

import {
  RESOLVED_IDS_TTL_MS,
  SHARED_SNAPSHOT_MIN_CHECKS,
  SNAPSHOT_TTL_MS,
  buildPageSourceKey,
  matchFolderCheckIds,
  pickFreshEntry,
  pickHeartbeatBySource,
  readPageSources,
  shouldShareSnapshot,
  type HeartbeatEntry,
} from "../status-pages";

const NOW = 1_800_000_000_000;

test("the snapshot TTL covers the 60 s poll but stays within 90 s", () => {
  assert.ok(SNAPSHOT_TTL_MS > 60_000);
  assert.ok(SNAPSHOT_TTL_MS <= 90_000);
});

test("readPageSources keeps only non-empty strings", () => {
  assert.deepEqual(
    readPageSources({ checkIds: ["a", "", "  ", 5, null, "b"], folderPaths: "nope" }),
    { explicitCheckIds: ["a", "b"], folderPaths: [] },
  );
  assert.deepEqual(readPageSources({}), { explicitCheckIds: [], folderPaths: [] });
});

test("the page source key changes with owner, checks, folders and order", () => {
  const base = buildPageSourceKey("u1", ["a", "b"], ["Prod"]);
  assert.equal(base, buildPageSourceKey("u1", ["a", "b"], ["Prod"]));
  assert.notEqual(base, buildPageSourceKey("u2", ["a", "b"], ["Prod"]));
  assert.notEqual(base, buildPageSourceKey("u1", ["a", "b", "c"], ["Prod"]));
  assert.notEqual(base, buildPageSourceKey("u1", ["a", "b"], ["Prod", "Staging"]));
  // The snapshot lists checks in page order, so a reorder is a new setup.
  assert.notEqual(base, buildPageSourceKey("u1", ["b", "a"], ["Prod"]));
  // An id cannot be confused with a folder of the same name.
  assert.notEqual(buildPageSourceKey("u1", ["x"], []), buildPageSourceKey("u1", [], ["x"]));
});

test("pickFreshEntry returns an entry for the same setup within its TTL", () => {
  const entry = { expiresAt: NOW + 10_000, sourceKey: "k", checkIds: ["a"] };
  assert.equal(pickFreshEntry(entry, "k", NOW, RESOLVED_IDS_TTL_MS), entry);
});

test("pickFreshEntry rejects missing, expired and other-setup entries", () => {
  assert.equal(pickFreshEntry(undefined, "k", NOW, SNAPSHOT_TTL_MS), null);
  assert.equal(pickFreshEntry(null, "k", NOW, SNAPSHOT_TTL_MS), null);
  assert.equal(pickFreshEntry({ expiresAt: NOW, sourceKey: "k" }, "k", NOW, SNAPSHOT_TTL_MS), null);
  assert.equal(pickFreshEntry({ expiresAt: NOW - 1, sourceKey: "k" }, "k", NOW, SNAPSHOT_TTL_MS), null);
  assert.equal(pickFreshEntry({ expiresAt: NOW + 1000, sourceKey: "old" }, "k", NOW, SNAPSHOT_TTL_MS), null);
});

test("pickFreshEntry rejects an expiry further ahead than the TTL allows", () => {
  const entry = { expiresAt: NOW + SNAPSHOT_TTL_MS + 1, sourceKey: "k" };
  assert.equal(pickFreshEntry(entry, "k", NOW, SNAPSHOT_TTL_MS), null);
  const edge = { expiresAt: NOW + SNAPSHOT_TTL_MS, sourceKey: "k" };
  assert.equal(pickFreshEntry(edge, "k", NOW, SNAPSHOT_TTL_MS), edge);
});

test("a lone viewer polling every 60 s hits the snapshot cache every second poll", () => {
  let entry: { expiresAt: number; sourceKey: string } | null = null;
  let misses = 0;
  for (let poll = 0; poll < 10; poll++) {
    const now = NOW + poll * 60_000;
    if (!pickFreshEntry(entry, "k", now, SNAPSHOT_TTL_MS)) {
      misses++;
      entry = { expiresAt: now + SNAPSHOT_TTL_MS, sourceKey: "k" };
    }
  }
  assert.equal(misses, 5);
});

test("a folder page polled every 60 s scans the owner's checks once per 5 min", () => {
  let entry: { expiresAt: number; sourceKey: string } | null = null;
  let scans = 0;
  for (let poll = 0; poll < 60; poll++) {
    const now = NOW + poll * 60_000;
    if (!pickFreshEntry(entry, "k", now, RESOLVED_IDS_TTL_MS)) {
      scans++;
      entry = { expiresAt: now + RESOLVED_IDS_TTL_MS, sourceKey: "k" };
    }
  }
  assert.equal(scans, 12);
});

test("only pages at or above the threshold share their snapshot through Firestore", () => {
  assert.equal(shouldShareSnapshot(0), false);
  assert.equal(shouldShareSnapshot(SHARED_SNAPSHOT_MIN_CHECKS - 1), false);
  assert.equal(shouldShareSnapshot(SHARED_SNAPSHOT_MIN_CHECKS), true);
  assert.equal(shouldShareSnapshot(50), true);
});

test("matchFolderCheckIds without folders returns the explicit ids, deduplicated", () => {
  assert.deepEqual(matchFolderCheckIds(["a", "b", "a"], [], [{ id: "z", folder: "Prod" }]), ["a", "b"]);
});

test("matchFolderCheckIds adds checks whose folder matches exactly", () => {
  const owner = [
    { id: "c1", folder: "Prod" },
    { id: "c2", folder: "Prod/APIs" },
    { id: "c3", folder: "Staging" },
    { id: "c4", folder: null },
    { id: "c5" },
  ];
  assert.deepEqual(matchFolderCheckIds(["a"], ["Prod"], owner), ["a", "c1"]);
  assert.deepEqual(matchFolderCheckIds([], ["Prod/APIs", "Staging"], owner), ["c2", "c3"]);
});

test("matchFolderCheckIds normalizes stored folders and skips domain checks", () => {
  const owner = [
    { id: "c1", folder: " /Prod/ " },
    { id: "c2", folder: "Prod\\APIs" },
    { id: "c3", folder: "Prod//APIs" },
    { id: "d1", folder: "Prod", type: "domain" },
  ];
  assert.deepEqual(matchFolderCheckIds([], ["Prod"], owner), ["c1"]);
  assert.deepEqual(matchFolderCheckIds([], ["Prod/APIs"], owner), ["c2", "c3"]);
});

test("matchFolderCheckIds does not list a check twice when it is explicit and in a folder", () => {
  assert.deepEqual(matchFolderCheckIds(["c1"], ["Prod"], [{ id: "c1", folder: "Prod" }]), ["c1"]);
});

const day = (extra: Record<string, unknown> = {}) => ({
  day: NOW,
  status: "online" as const,
  totalChecks: 10,
  issueCount: 0,
  onlineChecks: 10,
  offlineChecks: 0,
  ...extra,
});

test("pickHeartbeatBySource returns data computed for the same page checks", () => {
  const data: HeartbeatEntry[] = [{ checkId: "a", days: [day()] }];
  const entry = { data, expiresAt: NOW + 1000, checkIdsKey: "a", sourceIdsKey: "a|gone" };
  assert.equal(pickHeartbeatBySource(entry, "a|gone", NOW), data);
});

test("pickHeartbeatBySource misses on expiry, another check list or no source key", () => {
  const data: HeartbeatEntry[] = [{ checkId: "a", days: [day()] }];
  assert.equal(pickHeartbeatBySource(undefined, "a", NOW), null);
  assert.equal(pickHeartbeatBySource({ data, expiresAt: NOW, sourceIdsKey: "a" }, "a", NOW), null);
  assert.equal(pickHeartbeatBySource({ data, expiresAt: NOW + 1000, sourceIdsKey: "a" }, "a|b", NOW), null);
  // Written by older code: only the filtered key is present.
  assert.equal(pickHeartbeatBySource({ data, expiresAt: NOW + 1000, checkIdsKey: "a" }, "a", NOW), null);
  assert.equal(pickHeartbeatBySource({ data, expiresAt: NOW + 1000, sourceIdsKey: "" }, "", NOW), null);
});

test("pickHeartbeatBySource rejects entries from before the per-day counts existed", () => {
  const legacyDay = day();
  delete (legacyDay as { onlineChecks?: number }).onlineChecks;
  const data = [{ checkId: "a", days: [legacyDay] }] as HeartbeatEntry[];
  assert.equal(pickHeartbeatBySource({ data, expiresAt: NOW + 1000, sourceIdsKey: "a" }, "a", NOW), null);
});
