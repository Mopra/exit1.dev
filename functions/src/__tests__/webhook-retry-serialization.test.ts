import test from "node:test";
import assert from "node:assert/strict";

import { serializeWebsiteForRetry, hydrateWebsiteFromRetry } from "../alert-helpers";
import type { Website } from "../types";

// A webhook that fails its first send is serialized into the retry queue and
// hydrated back when drained. The round-trip MUST preserve `severity` —
// otherwise a retried Pushover alert silently drops from its P1→Emergency
// mapping back to the legacy High floor (the exact bug a user hit). The body
// fields (type/targetIp/lastError/timezone) must survive too so the retried
// message reads identically to the original.
test("retry serialization round-trip preserves severity and body fields", () => {
  const website = {
    id: "abc123",
    userId: "user_1",
    name: "Randles Family",
    url: "ping://family.example.co.uk",
    status: "offline",
    responseTime: 9046,
    detailedStatus: "DOWN",
    lastStatusCode: 0,
    severity: 1,
    type: "ping",
    targetIp: "92.234.104.113",
    lastError: "Ping failed: host unreachable",
    timezone: "Europe/London",
  } as unknown as Website;

  const hydrated = hydrateWebsiteFromRetry(serializeWebsiteForRetry(website));

  assert.equal(hydrated.severity, 1, "severity (drives Pushover priority) must survive the round-trip");
  assert.equal(hydrated.type, "ping");
  assert.equal(hydrated.targetIp, "92.234.104.113");
  assert.equal(hydrated.lastError, "Ping failed: host unreachable");
  assert.equal(hydrated.timezone, "Europe/London");
});
