import test from "node:test";
import assert from "node:assert/strict";
import http from "http";

import { checkRestEndpoint } from "../check-utils";
import type { Website } from "../types";

test("checkRestEndpoint treats 502 responses as down", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 502;
    res.statusMessage = "Bad Gateway";
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const now = Date.now();
  const website: Website = {
    id: "test-check",
    userId: "test-user",
    name: "Test Site",
    url: `http://127.0.0.1:${port}`,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    // Ensure security checks are treated as fresh so the test stays offline-safe.
    sslCertificate: { valid: true, lastChecked: now },
  };

  try {
    const result = await checkRestEndpoint(website);
    assert.equal(result.status, "offline");
    assert.equal(result.detailedStatus, "DOWN");
    assert.equal(result.statusCode, 502);
    assert.equal(result.error, "HTTP 502: Bad Gateway");
  } finally {
    server.close();
  }
});


