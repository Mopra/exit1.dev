import test from "node:test";
import assert from "node:assert/strict";

import { describeWafBlock } from "../waf-block";
import { buildPublicDay, isWafBlockError, publicCurrentStatus } from "../public-monitor-blocked";

const UA = "Exit1-Website-Monitor/1.0";
const DAY = Date.UTC(2026, 9, 11);

test("prefixes match what describeWafBlock actually writes", () => {
  assert.equal(isWafBlockError(describeWafBlock({ vendor: "Cloudflare", kind: "challenge" }, 403, UA)), true);
  assert.equal(isWafBlockError(describeWafBlock({ vendor: "Cloudflare", kind: "block" }, 403, UA)), true);
  assert.equal(isWafBlockError("HTTP 503"), false);
  assert.equal(isWafBlockError(undefined), false);
});

test("a day of only blocked probes is unknown, not down", () => {
  const d = buildPublicDay(DAY, { totalChecks: 286, onlineChecks: 0, offlineChecks: 286, hasIssues: true }, 155, 286);
  assert.equal(d.status, "unknown");
  assert.equal(d.totalChecks, 0);
  assert.equal(d.uptimePercentage, null);
  assert.equal(d.responseMs, null);
});

test("blocked probes leave the uptime math but real ones stay", () => {
  const d = buildPublicDay(DAY, { totalChecks: 197, onlineChecks: 10, offlineChecks: 187, hasIssues: true }, 155, 187);
  assert.equal(d.status, "online");
  assert.equal(d.totalChecks, 10);
  assert.equal(d.uptimePercentage, 100);
});

test("blocked rows outside the summary's offline bucket still leave the total", () => {
  // Real 2026-10-10 openai.com summary: 197 total, 10 online, 185 offline, 187 blocked.
  const d = buildPublicDay(DAY, { totalChecks: 197, onlineChecks: 10, offlineChecks: 185, hasIssues: true }, 34, 187);
  assert.equal(d.status, "online");
  assert.equal(d.totalChecks, 10);
  assert.equal(d.uptimePercentage, 100);
});

test("real downtime on a partly blocked day still shows red", () => {
  const d = buildPublicDay(DAY, { totalChecks: 30, onlineChecks: 20, offlineChecks: 10, hasIssues: true }, 200, 6);
  assert.equal(d.status, "offline");
  assert.equal(d.totalChecks, 24);
  assert.equal(d.uptimePercentage, 83.33);
});

test("days without blocks are unchanged", () => {
  const d = buildPublicDay(DAY, { totalChecks: 26, onlineChecks: 25, offlineChecks: 1, hasIssues: true }, 120, 0);
  assert.equal(d.status, "offline");
  assert.equal(d.uptimePercentage, 96.15);
  assert.equal(d.responseMs, 120);
});

test("current status is unknown only when offline because of a block", () => {
  const blocked = describeWafBlock({ vendor: "Cloudflare", kind: "challenge" }, 403, UA);
  assert.equal(publicCurrentStatus("offline", blocked), "unknown");
  assert.equal(publicCurrentStatus("offline", "CONNECT timeout after 30000ms"), "offline");
  assert.equal(publicCurrentStatus("online", blocked), "online");
});
