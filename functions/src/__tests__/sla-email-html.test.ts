import test from "node:test";
import assert from "node:assert/strict";

import { buildSlaEmail, formatDuration, formatPercent, SLA_EMAIL_BUDGET_BYTES, type SlaEmailPeriod } from "../sla-email-html";
import type { SlaCheckResult, SlaIncident } from "../sla-math";

const M = 60_000;
const start = Date.parse("2026-11-01T00:00:00Z");

function check(i: number, over: Partial<SlaCheckResult> = {}): SlaCheckResult {
  return {
    checkId: `c${i}`, name: `Check ${i}`, url: `https://c${i}.example`,
    upMs: 30 * 24 * 60 * M, downMs: 0, maintenanceMs: 0, blockedMs: 0, noDataMs: 0,
    availability: 1, coverage: 1, incidents: 0, longestIncidentMs: 0, status: "met", insufficientData: false,
    ...over,
  };
}

function period(checks: SlaCheckResult[], incidents: SlaIncident[] = []): SlaEmailPeriod {
  return {
    period: "2026-11",
    timezone: "Europe/Copenhagen",
    status: "final",
    targetPercent: 99.9,
    dataThrough: Date.parse("2026-12-01T00:00:00Z"),
    overall: {
      upMs: 1000, downMs: 10 * M, maintenanceMs: 0, blockedMs: 0, noDataMs: 0,
      availability: 0.99953, coverage: 1, budgetMs: 43 * M, budgetUsed: 0.23, projectedBudgetMs: 43 * M,
      status: "met", insufficientData: false,
    },
    checks,
    incidents,
    incidentsTotal: incidents.length,
    exclusions: [{ checkId: "c1", state: "maintenance", startMs: start, endMs: start + 30 * M }],
  };
}

const opts = { appUrl: "https://app.exit1.dev/sla/r1?period=2026-11", unsubscribeUrl: "https://u.example/?t=x", senderLabel: "Acme" };
const report = { id: "r1", name: "Acme hosting", timezone: "Europe/Copenhagen" };

test("subject format", () => {
  assert.equal(buildSlaEmail(report, period([check(1)]), opts).subject, "Acme hosting: November 2026 SLA report, 99.953% (Met)");
  assert.match(buildSlaEmail(report, period([check(1)]), { ...opts, test: true }).subject, /^\[Test\] /);
});

test("user text is escaped", () => {
  const evil = '<script>alert("x")</script>';
  const email = buildSlaEmail(
    { ...report, name: evil, branding: { companyName: evil, logoUrl: 'https://a.com/x.png"onerror="x', brandColor: "red;background:url(x)" } },
    period([check(1, { name: evil })]),
    { ...opts, senderLabel: evil },
  );
  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes('"onerror="'));
  assert.ok(!email.html.includes("url(x)"));
  assert.ok(email.html.includes("&lt;script&gt;"));
});

test("email-safe markup: no flex, grid or CSS variables; tables are presentational with widths", () => {
  const { html } = buildSlaEmail(report, period([check(1)]), opts);
  assert.ok(!/display:\s*flex/.test(html));
  assert.ok(!/display:\s*grid/.test(html));
  assert.ok(!html.includes("var("));
  const tables = html.match(/<table\b[^>]*>/g) ?? [];
  assert.ok(tables.length > 3);
  for (const t of tables) {
    assert.match(t, /role="presentation"/);
    assert.match(t, /width="/);
  }
});

test("times are in the report's zone with the zone name", () => {
  const inc: SlaIncident = { checkId: "c1", startMs: Date.parse("2026-11-14T02:12:00Z"), endMs: Date.parse("2026-11-14T02:22:00Z"), durationMs: 10 * M };
  const { html, text } = buildSlaEmail(report, period([check(1, { incidents: 1, downMs: 10 * M })], [inc]), opts);
  assert.match(html, /Nov 14, 2026, 03:12 (GMT\+1|CET)/);
  assert.match(text, /03:12/);
});

test("300 checks and 500 incidents truncate to 50 and 25 and stay under budget", () => {
  const checks = Array.from({ length: 300 }, (_, i) => check(i, i < 5 ? { status: "breached", availability: 0.98, incidents: 3 } : {}));
  const incidents = Array.from({ length: 500 }, (_, i) => ({ checkId: `c${i % 5}`, startMs: start + i * 60 * M, endMs: start + i * 60 * M + (i + 1) * 1000, durationMs: (i + 1) * 1000 }));
  const email = buildSlaEmail(report, period(checks, incidents), opts);
  assert.equal(email.shown.checks, 50);
  assert.equal(email.shown.incidents, 25);
  assert.match(email.html, /And 250 more checks that met the target/);
  assert.match(email.html, /475 more incidents/);
  // Problem checks come first.
  assert.ok(email.html.indexOf("Check 0") < email.html.indexOf("Check 100"));
  assert.ok(Buffer.byteLength(email.html) < SLA_EMAIL_BUDGET_BYTES);
  assert.ok(email.html.includes("Unsubscribe from this report"));
});

test("very long names trigger the halving fallback", () => {
  const long = "x".repeat(1500);
  const checks = Array.from({ length: 100 }, (_, i) => check(i, { name: `${long}${i}`, incidents: 1 }));
  const incidents = Array.from({ length: 100 }, (_, i) => ({ checkId: `c${i}`, startMs: start + i * M, endMs: start + i * M + 1000, durationMs: 1000 }));
  const email = buildSlaEmail(report, period(checks, incidents), opts);
  assert.ok(email.shown.checks < 50);
  assert.ok(email.shown.checks >= 10);
  assert.ok(email.html.includes("Unsubscribe from this report"));
});

test("number formatting", () => {
  assert.equal(formatPercent(null), "No data");
  assert.equal(formatPercent(1), "100%");
  assert.equal(formatPercent(0.999996), "99.999%");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(83 * M), "1h 23m");
  assert.equal(formatDuration(51 * 60 * M), "2d 3h");
});
