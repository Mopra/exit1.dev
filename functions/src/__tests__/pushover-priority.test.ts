import test from "node:test";
import assert from "node:assert/strict";

import { mapEventToPushoverPriority } from "../alert-pushover";

// Check severity (P1–P5) maps one-to-one onto Pushover's five priorities for
// critical events; non-critical events (recoveries, warnings) are capped at
// High so a recovery never pages at Emergency until acknowledged. Severity
// unset or P3 must reproduce the legacy default-based mapping exactly, so
// existing checks see no behavior change.

test("P1 sends critical events at Emergency, recoveries at High", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 0, 1), 2);
  assert.equal(mapEventToPushoverPriority("website_up", 0, 1), 1);
  assert.equal(mapEventToPushoverPriority("ssl_warning", 0, 1), 1);
});

test("P2 sends critical events at High even when the integration default is Emergency", () => {
  assert.equal(mapEventToPushoverPriority("website_down", 2, 2), 1);
  assert.equal(mapEventToPushoverPriority("website_up", 2, 2), 1);
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
});

test("P3 behaves exactly like unset", () => {
  const events = ["website_down", "website_up", "ssl_error", "ssl_warning", "domain_expired", "domain_renewed"] as const;
  for (const event of events) {
    for (const defaultPriority of [-2, -1, 0, 1, 2] as const) {
      assert.equal(
        mapEventToPushoverPriority(event, defaultPriority, 3),
        mapEventToPushoverPriority(event, defaultPriority),
        `${event} @ default=${defaultPriority}`
      );
    }
  }
});

test("all critical event types respect severity", () => {
  const critical = ["website_down", "website_error", "ssl_error", "domain_expired", "dns_record_missing", "dns_resolution_failed"] as const;
  for (const event of critical) {
    assert.equal(mapEventToPushoverPriority(event, 0, 1), 2, `${event} at P1`);
    assert.equal(mapEventToPushoverPriority(event, 0, 5), -2, `${event} at P5`);
  }
});
