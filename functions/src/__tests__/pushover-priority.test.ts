import test from "node:test";
import assert from "node:assert/strict";

import { mapEventToPushoverPriority } from "../alert-pushover";

// Check severity (P1–P5) maps one-to-one onto Pushover's five priorities for
// critical events; non-critical events (recoveries, warnings) are capped at
// High so a recovery never pages at Emergency until acknowledged. An explicit
// severity — including P3 — is a hard cap on every alert the check emits.
// Only UNSET severity ("use default priority") keeps the legacy default-based
// mapping with criticals floored at High.

test("P1 sends critical events at Emergency, recoveries at High", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 0, 1), 2);
  assert.equal(mapEventToPushoverPriority("website_up", 0, 1), 1);
  assert.equal(mapEventToPushoverPriority("ssl_warning", 0, 1), 1);
});

test("P2 sends critical events at High even when the integration default is Emergency", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 2, 2), 1);
  assert.equal(mapEventToPushoverPriority("website_up", 2, 2), 1);
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

test("P4/P5 stay below High for outages — no quiet-hours bypass", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 0, 4), -1);
  assert.equal(mapEventToPushoverPriority("website_up", 0, 4), -1);
  assert.equal(mapEventToPushoverPriority("website_down", 0, 5), -2);
  assert.equal(mapEventToPushoverPriority("ssl_warning", 0, 5), -2);
  // Severity overrides an Emergency integration default entirely.
  assert.equal(mapEventToPushoverPriority("website_down", 2, 5), -2);
});

test("severity unset keeps the legacy mapping: critical floored at High, rest capped at High", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 0), 1);
  assert.equal(mapEventToPushoverPriority("website_down", 2), 2);
  assert.equal(mapEventToPushoverPriority("website_up", 2), 1);
  assert.equal(mapEventToPushoverPriority("website_up", -1), -1);
  // null (cleared back to "use default priority") behaves like undefined.
  assert.equal(mapEventToPushoverPriority("website_down", 0, null), 1);
  assert.equal(mapEventToPushoverPriority("website_up", 2, null), 1);
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
