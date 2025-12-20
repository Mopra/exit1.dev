import test from "node:test";
import assert from "node:assert/strict";

import { checkRestEndpoint } from "../check-utils";
import type { Website } from "../types";

test("checkRestEndpoint attaches a stable error string for 502 responses", async () => {
  const originalFetch = globalThis.fetch;

  // Mock fetch to return a 502 Bad Gateway response.
  globalThis.fetch = (async () => new Response(null, { status: 502, statusText: "Bad Gateway" })) as typeof fetch;

  const now = Date.now();
  const website: Website = {
    id: "test-check",
    userId: "test-user",
    name: "Test Site",
    url: "https://example.com",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    // Ensure security checks are treated as fresh so the test stays offline-safe.
    sslCertificate: { valid: true, lastChecked: now },
    domainExpiry: { valid: true, lastChecked: now },
  };

  try {
    const result = await checkRestEndpoint(website);
    assert.equal(result.status, "offline");
    assert.equal(result.detailedStatus, "REACHABLE_WITH_ERROR");
    assert.equal(result.statusCode, 502);
    assert.equal(result.error, "HTTP 502: Bad Gateway");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


