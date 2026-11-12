import test from "node:test";
import assert from "node:assert/strict";

import {
  PAGE_MAX_AGE_MS,
  applyIndexFreshness,
  planPageWrite,
  stableEqual,
  stalePageSlugs,
} from "../public-monitor-persist";

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 12, 9, 5);

/** Minimal stand-in for a Firestore Timestamp. */
const ts = (ms: number, nanoseconds = (ms % 1000) * 1e6) => ({
  seconds: Math.floor(ms / 1000),
  nanoseconds,
  toMillis: () => Math.floor(ms / 1000) * 1000 + Math.floor(nanoseconds / 1e6),
});

const page = (over: Record<string, unknown> = {}) => ({
  slug: "github.com",
  name: "GitHub",
  url: "https://github.com",
  host: "github.com",
  type: "website",
  status: "online",
  lastChecked: T0 - 2 * 60 * 1000,
  uptime30d: 99.98,
  daysWithData: 90,
  checkId: "abc",
  source: "direct",
  stats: { uptime7d: 100, uptime30d: 99.98, uptime90d: 99.99, avgResponseMs: 120, totalChecks30d: 720 },
  heartbeat: [
    { day: T0 - 24 * HOUR, status: "online", uptimePercentage: 100, totalChecks: 24, responseMs: 118 },
    { day: T0, status: "unknown", uptimePercentage: null, totalChecks: 0, responseMs: null },
  ],
  incidents: [],
  updatedAt: T0,
  ...over,
});

/** The page as stored by the run one hour earlier. */
const storedAnHourAgo = (over: Record<string, unknown> = {}) =>
  page({ updatedAt: T0 - HOUR, lastChecked: T0 - HOUR - 2 * 60 * 1000, ...over });

test("stableEqual ignores object key order at every depth", () => {
  assert.equal(stableEqual({ a: 1, b: { c: [1, { x: 1, y: 2 }], d: null } }, { b: { d: null, c: [1, { y: 2, x: 1 }] }, a: 1 }), true);
});

test("stableEqual keeps array order and length significant", () => {
  assert.equal(stableEqual([1, 2], [2, 1]), false);
  assert.equal(stableEqual([1, 2], [1, 2, 3]), false);
});

test("stableEqual tells null, missing, zero and empty apart", () => {
  assert.equal(stableEqual({ a: null }, {}), false);
  assert.equal(stableEqual({ a: 0 }, { a: null }), false);
  assert.equal(stableEqual({ a: [] }, { a: {} }), false);
  assert.equal(stableEqual("1", 1), false);
});

test("stableEqual treats a key holding undefined as absent", () => {
  assert.equal(stableEqual({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(stableEqual({ a: 1 }, { a: 1, b: undefined }), true);
});

test("stableEqual compares Timestamps and Dates by value", () => {
  assert.equal(stableEqual(ts(T0), ts(T0)), true);
  assert.equal(stableEqual(ts(T0), ts(T0 + 1)), false);
  assert.equal(stableEqual(ts(T0, 1_000), ts(T0, 2_000)), false);
  assert.equal(stableEqual(new Date(T0), new Date(T0)), true);
  assert.equal(stableEqual(new Date(T0), new Date(T0 + 1)), false);
  assert.equal(stableEqual(ts(T0), { seconds: Math.floor(T0 / 1000) }), false);
});

test("planPageWrite writes the whole page when no doc exists", () => {
  const p = page();
  assert.deepEqual(planPageWrite(undefined, p, T0 - 1000, T0), p);
});

test("planPageWrite skips a page where only the clock fields moved", () => {
  assert.equal(planPageWrite(storedAnHourAgo(), page(), T0 - 1000, T0), null);
});

test("planPageWrite skips when the stored doc differs only in key order and push fields", () => {
  const stored = storedAnHourAgo();
  const shuffled: Record<string, unknown> = { statusChangedAt: T0 - 50 * HOUR, statusChangedTo: "online" };
  for (const key of Object.keys(stored).reverse()) shuffled[key] = (stored as Record<string, unknown>)[key];
  assert.equal(planPageWrite(shuffled, page(), T0 - 1000, T0), null);
});

test("planPageWrite sends only the changed fields plus the clock", () => {
  const next = page({ stats: { ...page().stats, uptime7d: 99.5 }, uptime30d: 99.9 });
  assert.deepEqual(planPageWrite(storedAnHourAgo(), next, T0 - 1000, T0), {
    stats: next.stats,
    uptime30d: 99.9,
    updatedAt: T0,
    lastChecked: next.lastChecked,
  });
});

test("planPageWrite sees a change deep inside the heartbeat", () => {
  const heartbeat = page().heartbeat.map((d) => ({ ...d }));
  heartbeat[1] = { ...heartbeat[1], status: "online", uptimePercentage: 100, totalChecks: 9, responseMs: 130 };
  const patch = planPageWrite(storedAnHourAgo(), page({ heartbeat }), T0 - 1000, T0);
  assert.deepEqual(Object.keys(patch ?? {}).sort(), ["heartbeat", "lastChecked", "updatedAt"]);
});

test("planPageWrite writes a status change, including to the grey unknown of a blocked probe", () => {
  const patch = planPageWrite(storedAnHourAgo(), page({ status: "unknown" }), T0 - 1000, T0);
  assert.equal(patch?.status, "unknown");
});

test("planPageWrite leaves an unchanged status out, so a later transition push survives", () => {
  const patch = planPageWrite(storedAnHourAgo(), page({ daysWithData: 91 }), T0 - 1000, T0);
  assert.ok(patch);
  assert.equal("status" in patch, false);
});

test("planPageWrite lets a push that landed during the build keep status and lastChecked", () => {
  const buildStartedAt = T0 - 30 * 1000;
  const stored = storedAnHourAgo({
    status: "offline",
    lastChecked: T0 - 10 * 1000,
    statusChangedAt: T0 - 10 * 1000,
    statusChangedTo: "offline",
  });
  // Nothing else changed: no write at all.
  assert.equal(planPageWrite(stored, page(), buildStartedAt, T0), null);
  // Something else changed: written without status or lastChecked.
  assert.deepEqual(planPageWrite(stored, page({ daysWithData: 91 }), buildStartedAt, T0), {
    daysWithData: 91,
    updatedAt: T0,
  });
});

test("planPageWrite overwrites a status pushed before the build began", () => {
  const stored = storedAnHourAgo({ status: "offline", statusChangedAt: T0 - 2 * HOUR, statusChangedTo: "offline" });
  assert.equal(planPageWrite(stored, page(), T0 - 1000, T0)?.status, "online");
});

test("planPageWrite never moves lastChecked backwards", () => {
  const stored = storedAnHourAgo({ lastChecked: T0 + 5000 });
  const patch = planPageWrite(stored, page({ daysWithData: 91 }), T0 - 1000, T0);
  assert.ok(patch);
  assert.equal("lastChecked" in patch, false);
});

test("planPageWrite touches an unchanged page once it is older than the max age", () => {
  const fresh = storedAnHourAgo({ updatedAt: T0 - PAGE_MAX_AGE_MS + 1 });
  assert.equal(planPageWrite(fresh, page(), T0 - 1000, T0), null);
  const old = storedAnHourAgo({ updatedAt: T0 - PAGE_MAX_AGE_MS });
  assert.deepEqual(planPageWrite(old, page(), T0 - 1000, T0), { updatedAt: T0, lastChecked: page().lastChecked });
});

test("planPageWrite skips incidents when the build could not read them", () => {
  const withoutIncidents: Record<string, unknown> & { updatedAt: number; lastChecked: number } = page();
  delete withoutIncidents.incidents;
  const stored = storedAnHourAgo({ incidents: [{ id: "1", startedAt: 1, durationMs: 5 }] });
  assert.equal(planPageWrite(stored, withoutIncidents, T0 - 1000, T0), null);
});

test("stalePageSlugs returns what the previous index had and the new one lacks", () => {
  const previous = [{ slug: "a.com" }, { slug: "b.com" }, { slug: "c.com" }];
  assert.deepEqual(stalePageSlugs(previous, new Set(["a.com", "c.com", "new.com"])), ["b.com"]);
  assert.deepEqual(stalePageSlugs(previous, new Set(["a.com", "b.com", "c.com"])), []);
  assert.deepEqual(stalePageSlugs([], new Set(["a.com"])), []);
});

test("stalePageSlugs returns every previous slug when nothing is live", () => {
  assert.deepEqual(stalePageSlugs([{ slug: "a.com" }, { slug: "a.com" }, { slug: "b.com" }], new Set()), ["a.com", "b.com"]);
});

test("stalePageSlugs asks for the listing fallback when the previous index is unusable", () => {
  const live = new Set(["a.com"]);
  assert.equal(stalePageSlugs(undefined, live), null);
  assert.equal(stalePageSlugs(null, live), null);
  assert.equal(stalePageSlugs({ slug: "a.com" }, live), null);
  assert.equal(stalePageSlugs([{ slug: "a.com" }, { name: "no slug" }], live), null);
  assert.equal(stalePageSlugs([{ slug: "" }], live), null);
  assert.equal(stalePageSlugs(["a.com"], live), null);
});

test("applyIndexFreshness lifts an unwritten page's clock to the index", () => {
  const stored = { slug: "a.com", status: "online", updatedAt: T0 - 5 * HOUR, lastChecked: T0 - 5 * HOUR };
  assert.deepEqual(applyIndexFreshness(stored, { lastChecked: T0 - 60 * 1000 }, T0), {
    slug: "a.com",
    status: "online",
    updatedAt: T0,
    lastChecked: T0 - 60 * 1000,
  });
});

test("applyIndexFreshness never moves a value backwards", () => {
  // A transition push wrote the page after the index.
  const pushed = { status: "offline", updatedAt: T0, lastChecked: T0 + 20 * 60 * 1000 };
  assert.deepEqual(applyIndexFreshness(pushed, { lastChecked: T0 - 60 * 1000 }, T0 - HOUR), pushed);
});

test("applyIndexFreshness leaves the page alone without a usable index entry", () => {
  const stored = { updatedAt: T0 - 5 * HOUR, lastChecked: T0 - 5 * HOUR };
  assert.equal(applyIndexFreshness(stored, undefined, T0), stored);
  assert.deepEqual(applyIndexFreshness(stored, { lastChecked: "soon" }, undefined), stored);
});

test("applyIndexFreshness does not change status, so a blocked page stays unknown", () => {
  const stored = { status: "unknown", updatedAt: T0 - HOUR, lastChecked: T0 - HOUR };
  assert.equal(applyIndexFreshness(stored, { lastChecked: T0, status: "offline" } as { lastChecked: number }, T0).status, "unknown");
});
