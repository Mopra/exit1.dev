import test from "node:test";
import assert from "node:assert/strict";

import { decideSlaSends, duePeriodOf, nextSendAfterPeriod, sendPointAfterZoneChange, slaEntitlementOf } from "../sla-email-policy";
import { signSlaUnsubscribe, slaUnsubscribeUrl, verifySlaUnsubscribe } from "../sla-unsubscribe-token";
import { finalizeAt } from "../sla-time";

const at = (s: string) => Date.parse(s);
const D = 24 * 3600_000;

const report = (over: Record<string, unknown> = {}) => ({
  schedule: { enabled: true, recipients: ["a@x.io", "B@x.io"] },
  unsubscribed: [] as string[],
  timezone: "Europe/Copenhagen",
  nextSendAfter: finalizeAt("2026-11", "Europe/Copenhagen"),
  lastSentPeriod: "2026-10" as string | null,
  ...over,
});
const finalDoc = { status: "final", timezone: "Europe/Copenhagen" };
const now = at("2026-12-01T02:40:00Z");

test("due and final: send to active recipients, next send is end of December + 2 h", () => {
  const d = decideSlaSends(report(), finalDoc, true, now);
  assert.equal(d.kind, "send");
  if (d.kind !== "send") return;
  assert.equal(d.period, "2026-11");
  assert.deepEqual(d.recipients, ["a@x.io", "b@x.io"]);
  assert.equal(d.nextSendAfter, finalizeAt("2026-12", "Europe/Copenhagen"));
});

test("not due yet waits", () => {
  assert.equal(decideSlaSends(report(), finalDoc, true, at("2026-11-30T23:30:00Z")).kind, "wait");
});

test("already sent, owner not Pro, nobody left: skip and advance", () => {
  for (const [r, pro, reason] of [
    [report({ lastSentPeriod: "2026-11" }), true, "already_sent"],
    [report(), false, "not_pro"],
    [report({ unsubscribed: ["a@x.io", "b@x.io"] }), true, "no_recipients"],
  ] as const) {
    const d = decideSlaSends(r, finalDoc, pro, now);
    assert.equal(d.kind, "skip");
    if (d.kind === "skip") {
      assert.equal(d.reason, reason);
      assert.equal(d.nextSendAfter, finalizeAt("2026-12", "Europe/Copenhagen"));
    }
  }
});

test("a failed tier lookup waits and keeps the send point; only a confirmed tier skips", () => {
  const d = decideSlaSends(report(), finalDoc, null, now);
  assert.equal(d.kind, "wait");
  if (d.kind === "wait") {
    assert.equal(d.reason, "tier_unknown");
    assert.equal(d.period, "2026-11");
  }
  assert.equal(slaEntitlementOf({ tier: "free", failedOpen: true }), null);
  assert.equal(slaEntitlementOf({ tier: "pro", failedOpen: true }), null);
  assert.equal(slaEntitlementOf({ tier: "free", failedOpen: false }), false);
  assert.equal(slaEntitlementOf({ tier: "pro", failedOpen: false }), true);
});

test("a zone change after month end keeps the just-ended month owed", () => {
  // November ended in Copenhagen; the user moves to New York before the send.
  const existing = { timezone: "Europe/Copenhagen", nextSendAfter: finalizeAt("2026-11", "Europe/Copenhagen"), lastSentPeriod: "2026-10" };
  const t = at("2026-12-01T10:00:00Z");
  const next = sendPointAfterZoneChange(existing, "America/New_York", t);
  assert.equal(next, finalizeAt("2026-11", "America/New_York"));
  assert.equal(duePeriodOf(next, "America/New_York"), "2026-11");
  const d = decideSlaSends({ ...report(), ...existing, timezone: "America/New_York", nextSendAfter: next }, { status: "final", timezone: "America/New_York" }, true, t);
  assert.equal(d.kind, "send");
  if (d.kind === "send") assert.equal(d.period, "2026-11");

  // Already sent, or past the 7-day window, or the old point was for a later month: current month.
  assert.equal(sendPointAfterZoneChange({ ...existing, lastSentPeriod: "2026-11" }, "America/New_York", t), finalizeAt("2026-12", "America/New_York"));
  assert.equal(sendPointAfterZoneChange(existing, "America/New_York", at("2026-12-20T00:00:00Z")), finalizeAt("2026-12", "America/New_York"));
  assert.equal(
    sendPointAfterZoneChange({ ...existing, nextSendAfter: finalizeAt("2026-12", "Europe/Copenhagen"), lastSentPeriod: "2026-11" }, "UTC", at("2026-12-10T00:00:00Z")),
    finalizeAt("2026-12", "UTC"),
  );
  // Mid-month change: plain end of the current month.
  assert.equal(
    sendPointAfterZoneChange({ ...existing, nextSendAfter: finalizeAt("2026-12", "Europe/Copenhagen"), lastSentPeriod: "2026-11" }, "UTC", at("2026-12-15T00:00:00Z")),
    finalizeAt("2026-12", "UTC"),
  );
});

test("unsubscribed recipients are left out", () => {
  const d = decideSlaSends(report({ unsubscribed: ["b@x.io"] }), finalDoc, true, now);
  assert.equal(d.kind, "send");
  if (d.kind === "send") assert.deepEqual(d.recipients, ["a@x.io"]);
});

test("period not final yet, or in an old zone: wait", () => {
  assert.equal(decideSlaSends(report(), { status: "open", timezone: "Europe/Copenhagen" }, true, now).kind, "wait");
  assert.equal(decideSlaSends(report(), null, true, now).kind, "wait");
  assert.equal(decideSlaSends(report(), { status: "final", timezone: "UTC" }, true, now).kind, "wait");
});

test("a month that ended over 7 days ago is skipped without a backlog", () => {
  const late = at("2027-03-10T00:00:00Z");
  const d = decideSlaSends(report(), finalDoc, true, late);
  assert.equal(d.kind, "skip");
  if (d.kind === "skip") {
    assert.equal(d.reason, "too_late");
    // Jump straight to the current month, not December, January, February.
    assert.equal(d.nextSendAfter, finalizeAt("2027-03", "Europe/Copenhagen"));
  }
});

test("a zone change does not resend a month already sent", () => {
  // Report moved to New York after November went out from Copenhagen.
  const r = report({ timezone: "America/New_York", nextSendAfter: finalizeAt("2026-11", "America/New_York"), lastSentPeriod: "2026-11" });
  const d = decideSlaSends(r, { status: "final", timezone: "America/New_York" }, true, at("2026-12-01T08:40:00Z"));
  assert.equal(d.kind, "skip");
});

test("nextSendAfter and the due month for each test zone", () => {
  for (const tz of ["UTC", "Europe/Copenhagen", "America/New_York", "Asia/Kolkata", "Asia/Kathmandu", "Pacific/Kiritimati", "Etc/GMT+12"]) {
    const next = nextSendAfterPeriod("2026-10", tz, at("2026-11-15T00:00:00Z"));
    assert.equal(next, finalizeAt("2026-11", tz), tz);
    assert.equal(duePeriodOf(next, tz), "2026-11", tz);
  }
  assert.ok(nextSendAfterPeriod("2026-10", "UTC", at("2026-11-15T00:00:00Z")) - at("2026-12-01T00:00:00Z") === 2 * 3600_000);
  assert.ok(D > 0);
});

test("unsubscribe tokens bind the report and the address", () => {
  const t = signSlaUnsubscribe("s3cret", "rep1", "Ops <OPS@x.io>");
  assert.ok(verifySlaUnsubscribe("s3cret", "rep1", "ops@x.io", t));
  assert.ok(!verifySlaUnsubscribe("s3cret", "rep2", "ops@x.io", t));
  assert.ok(!verifySlaUnsubscribe("s3cret", "rep1", "other@x.io", t));
  assert.ok(!verifySlaUnsubscribe("other", "rep1", "ops@x.io", t));
  assert.ok(!verifySlaUnsubscribe("s3cret", "rep1", "ops@x.io", undefined));
  const url = new URL(slaUnsubscribeUrl("s3cret", "rep1", "OPS@x.io"));
  assert.equal(url.searchParams.get("e"), "ops@x.io");
  assert.ok(verifySlaUnsubscribe("s3cret", "rep1", url.searchParams.get("e")!, url.searchParams.get("t")));
});
