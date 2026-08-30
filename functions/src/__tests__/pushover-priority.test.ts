import test from "node:test";
import assert from "node:assert/strict";

import { mapEventToPushoverPriority } from "../alert-pushover";

// Check severity (P1-P5) maps one-to-one onto Pushover's five priorities for
// critical events. Non-critical events (warnings AND recoveries) are capped
// at Normal: with an explicit severity, only a critical event may bypass
// quiet hours. An explicit severity, P3 included, is a hard cap on every
// alert the check emits. Only UNSET severity ("use default priority") keeps
// the legacy default-based mapping with criticals floored at High and
// warnings following the integration default capped at High.

test("P1 pages at Emergency, warns at Normal, recovers at Normal", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 0, 1), 2);
  assert.equal(mapEventToPushoverPriority("ssl_warning", 0, 1), 0);
  assert.equal(mapEventToPushoverPriority("website_up", 0, 1), 0);
});

test("P2 sends critical events at High even when the integration default is Emergency", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 2, 2), 1);
  assert.equal(mapEventToPushoverPriority("website_up", 2, 2), 0);
});

// The 4umediagroup report: a P1 check's recovery arrived at High and bypassed
// quiet hours, louder than the same integration would send with no severity
// set at all. Recoveries must never outrank the severity-unset behaviour.
test("recoveries never bypass quiet hours at any severity", () => {
  for (const severity of [1, 2, 3, 4, 5] as const) {
    for (const event of ["website_up", "domain_renewed"] as const) {
      for (const defaultPriority of [-2, -1, 0, 1, 2] as const) {
        const p = mapEventToPushoverPriority(event, defaultPriority, severity);
        assert.ok(p <= 0, `${event} P${severity} @ default=${defaultPriority}: got ${p}`);
      }
    }
  }
  // …but a quiet check still recovers quietly rather than snapping up to Normal.
  assert.equal(mapEventToPushoverPriority("website_up", 0, 4), -1);
  assert.equal(mapEventToPushoverPriority("domain_renewed", 0, 5), -2);
});

// The kairandles report, round two: a P1 check's ssl_warning arrived at High
// and bypassed quiet hours, and NO severity value could express "downs page
// me, warnings can wait until morning". With severity set, a warning is never
// worth waking anyone: the escalation to loud is the critical event
// (ssl_error / domain_expired) at full severity.
test("warnings never bypass quiet hours when severity is set", () => {
  for (const event of ["ssl_warning", "domain_expiring", "dns_record_changed"] as const) {
    assert.equal(mapEventToPushoverPriority(event, 0, 1), 0, `${event} at P1`);
    assert.equal(mapEventToPushoverPriority(event, 0, 2), 0, `${event} at P2`);
    assert.equal(mapEventToPushoverPriority(event, 0, 3), 0, `${event} at P3`);
    // Quiet checks stay below Normal rather than snapping up to it.
    assert.equal(mapEventToPushoverPriority(event, 0, 4), -1, `${event} at P4`);
  }
  // Severity unset keeps the legacy High cap: an explicit priority=1 default
  // on the integration is an expressed "everything High" preference.
  assert.equal(mapEventToPushoverPriority("ssl_warning", 1), 1);
  assert.equal(mapEventToPushoverPriority("ssl_warning", 2), 1);
});

test("explicit P3 caps everything at Normal — no quiet-hours bypass", () => {
  const events = ["website_down", "website_error", "ssl_error", "ssl_warning", "domain_expired", "domain_expiring", "dns_record_missing", "website_up"] as const;
  for (const event of events) {
    for (const defaultPriority of [-2, -1, 0, 1, 2] as const) {
      assert.equal(
        mapEventToPushoverPriority(event, defaultPriority, 3),
        0,
        `${event} @ default=${defaultPriority}`
      );
    }
  }
});

test("P4/P5 stay below Normal for outages — no quiet-hours bypass", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 0, 4), -1);
  assert.equal(mapEventToPushoverPriority("website_up", 0, 4), -1);
  assert.equal(mapEventToPushoverPriority("website_down", 0, 5), -2);
  assert.equal(mapEventToPushoverPriority("ssl_warning", 0, 5), -2);
  // Severity overrides an Emergency integration default entirely.
  assert.equal(mapEventToPushoverPriority("website_down", 2, 5), -2);
});

test("severity unset: critical floored at High, warnings capped at High, recoveries at Normal", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 0), 1);
  assert.equal(mapEventToPushoverPriority("website_down", 2), 2);
  assert.equal(mapEventToPushoverPriority("ssl_warning", 2), 1);
  // An Emergency default means "page me for outages", not "wake me on the
  // all-clear" — the same complaint the severity path had.
  assert.equal(mapEventToPushoverPriority("website_up", 2), 0);
  assert.equal(mapEventToPushoverPriority("website_up", 1), 0);
  // A deliberately quiet integration still recovers quietly.
  assert.equal(mapEventToPushoverPriority("website_up", -1), -1);
  assert.equal(mapEventToPushoverPriority("website_up", 0), 0);
  // null (cleared back to "use default priority") behaves like undefined.
  assert.equal(mapEventToPushoverPriority("website_down", 0, null), 1);
  assert.equal(mapEventToPushoverPriority("website_up", 2, null), 0);
});

// The one rule the whole mapping has to satisfy, both paths, every input.
test("only criticals reach Emergency; recoveries never bypass quiet hours", () => {
  const all = ["website_down", "website_error", "website_up", "ssl_error", "ssl_warning", "domain_expired", "domain_expiring", "domain_renewed", "dns_record_missing", "dns_resolution_failed", "dns_record_changed"] as const;
  const critical = ["website_down", "website_error", "ssl_error", "domain_expired", "dns_record_missing", "dns_resolution_failed"];
  const recovery = ["website_up", "domain_renewed"];
  for (const event of all) {
    for (const defaultPriority of [-2, -1, 0, 1, 2] as const) {
      for (const severity of [undefined, null, 1, 2, 3, 4, 5] as const) {
        const p = mapEventToPushoverPriority(event, defaultPriority, severity);
        if (!critical.includes(event)) {
          assert.ok(p < 2, `${event} reached Emergency (sev=${severity}, default=${defaultPriority})`);
        }
        if (recovery.includes(event)) {
          assert.ok(p <= 0, `${event} bypassed quiet hours at ${p} (sev=${severity}, default=${defaultPriority})`);
        }
        // With an explicit severity, ONLY a critical event may bypass quiet hours.
        if (severity != null && !critical.includes(event)) {
          assert.ok(p <= 0, `${event} bypassed quiet hours at ${p} (sev=${severity}, default=${defaultPriority})`);
        }
      }
    }
  }
});

test("all critical event types respect severity", () => {
  const critical = ["website_down", "website_error", "ssl_error", "domain_expired", "dns_record_missing", "dns_resolution_failed"] as const;
  for (const event of critical) {
    assert.equal(mapEventToPushoverPriority(event, 0, 1), 2, `${event} at P1`);
    assert.equal(mapEventToPushoverPriority(event, 0, 3), 0, `${event} at P3`);
    assert.equal(mapEventToPushoverPriority(event, 0, 5), -2, `${event} at P5`);
  }
});

test("severity never sends an alert above the check's mapped level", () => {
  const all = ["website_down", "website_error", "website_up", "ssl_error", "ssl_warning", "domain_expired", "domain_expiring", "domain_renewed", "dns_record_missing", "dns_resolution_failed", "dns_record_changed"] as const;
  for (const severity of [1, 2, 3, 4, 5] as const) {
    const cap = 3 - severity;
    for (const event of all) {
      for (const defaultPriority of [-2, 0, 2] as const) {
        const p = mapEventToPushoverPriority(event, defaultPriority, severity);
        assert.ok(p <= cap, `${event} P${severity} @ default=${defaultPriority}: got ${p}, cap ${cap}`);
      }
    }
  }
});
