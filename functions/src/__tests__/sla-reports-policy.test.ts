import test from "node:test";
import assert from "node:assert/strict";

import {
  nextSendAfterFor,
  selectReportChecks,
  validateSlaReportInput,
  SLA_MAX_CHECKS_PER_REPORT,
  type OwnerCheck,
} from "../sla-reports-policy";

const base = {
  name: "Acme hosting",
  targetPercent: 99.9,
  checkIds: ["abc"],
  folderPaths: [],
  timezone: "Europe/Copenhagen",
  schedule: { enabled: false, recipients: [] },
};

test("valid input normalizes", () => {
  const v = validateSlaReportInput({
    ...base,
    name: "  Acme   hosting ",
    folderPaths: ["/Clients//Acme/"],
    schedule: { enabled: true, recipients: ["Ops <OPS@Acme.com>", "ops@acme.com", "b@x.io"] },
    branding: { companyName: " Acme ", brandColor: "#2563EB", logoUrl: "https://acme.com/logo.png?v=2" },
  });
  assert.equal(v.name, "Acme hosting");
  assert.deepEqual(v.folderPaths, ["Clients/Acme"]);
  assert.deepEqual(v.schedule.recipients, ["ops@acme.com", "b@x.io"]);
  assert.equal(v.countBlockedAsDown, false);
  assert.deepEqual(v.branding, { companyName: "Acme", brandColor: "#2563eb", logoUrl: "https://acme.com/logo.png?v=2" });
});

test("name length, target range and precision", () => {
  assert.throws(() => validateSlaReportInput({ ...base, name: "A" }));
  assert.throws(() => validateSlaReportInput({ ...base, name: "x".repeat(81) }));
  assert.throws(() => validateSlaReportInput({ ...base, targetPercent: 89.9 }));
  assert.throws(() => validateSlaReportInput({ ...base, targetPercent: 100 }));
  assert.throws(() => validateSlaReportInput({ ...base, targetPercent: 99.9999 }));
  assert.equal(validateSlaReportInput({ ...base, targetPercent: 99.995 }).targetPercent, 99.995);
  assert.equal(validateSlaReportInput({ ...base, targetPercent: "99.95" }).targetPercent, 99.95);
});

test("timezone, scope and recipients are validated", () => {
  assert.throws(() => validateSlaReportInput({ ...base, timezone: "Mars/Base" }), /IANA/);
  assert.throws(() => validateSlaReportInput({ ...base, checkIds: [], folderPaths: [] }), /at least one/);
  assert.throws(() => validateSlaReportInput({ ...base, checkIds: ["bad id"] }));
  assert.throws(() => validateSlaReportInput({ ...base, folderPaths: ["a/b/c/d/e/f/g/h/i/j/k"] }), /nested/);
  assert.throws(() => validateSlaReportInput({ ...base, schedule: { enabled: true, recipients: [] } }), /recipient/);
  assert.throws(() => validateSlaReportInput({ ...base, schedule: { enabled: false, recipients: ["nope"] } }), /valid email/);
  const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@x.io`);
  assert.throws(() => validateSlaReportInput({ ...base, schedule: { enabled: true, recipients: eleven } }), /at most 10/);
});

test("branding rejects http, SVG and bad colors", () => {
  assert.throws(() => validateSlaReportInput({ ...base, branding: { logoUrl: "http://a.com/l.png" } }), /https/);
  assert.throws(() => validateSlaReportInput({ ...base, branding: { logoUrl: "https://a.com/l.svg" } }), /PNG or JPEG/);
  assert.throws(() => validateSlaReportInput({ ...base, branding: { brandColor: "red" } }), /hex/);
  assert.equal(validateSlaReportInput({ ...base, branding: { companyName: "  " } }).branding, null);
});

const check = (id: string, over: Partial<OwnerCheck> = {}): OwnerCheck => ({
  id, userId: "owner", name: id.toUpperCase(), url: `https://${id}`, folder: null, type: "website", createdAt: 1, ...over,
});

test("scope: explicit ids, folders with subfolders, no dns or domain, deleted kept", () => {
  const pool = [
    check("a"),
    check("b", { folder: "Clients/Acme" }),
    check("c", { folder: "Clients/Acme/API" }),
    check("d", { folder: "Clients/Acme-old" }),
    check("e", { folder: "Clients/Acme", type: "dns" }),
    check("f", { userId: "stranger", folder: "Clients/Acme" }),
  ];
  const { checks, truncated } = selectReportChecks({ userId: "owner", checkIds: ["a", "gone"], folderPaths: ["Clients/Acme"] }, pool);
  assert.equal(truncated, false);
  assert.deepEqual(checks.map((c) => c.checkId), ["a", "gone", "b", "c"]);
  assert.equal(checks[1].deleted, true);
});

test("scope is capped after folder resolution", () => {
  const pool = Array.from({ length: 300 }, (_, i) => check(`c${i}`, { folder: "Big" }));
  const { checks, truncated } = selectReportChecks({ userId: "owner", folderPaths: ["Big"] }, pool);
  assert.equal(checks.length, SLA_MAX_CHECKS_PER_REPORT);
  assert.equal(truncated, true);
});

test("nextSendAfter is the local month end plus 2 h, or null", () => {
  assert.equal(nextSendAfterFor(false, "UTC", 0), null);
  assert.equal(nextSendAfterFor(true, "Europe/Copenhagen", Date.parse("2026-11-20T00:00:00Z")), Date.parse("2026-12-01T01:00:00Z"));
  assert.equal(nextSendAfterFor(true, "Pacific/Kiritimati", Date.parse("2026-11-20T00:00:00Z")), Date.parse("2026-11-30T12:00:00Z"));
});
