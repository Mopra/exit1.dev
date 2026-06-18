import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import net from "net";

import { checkRestEndpoint, performHttpRequest } from "../check-utils";
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

test("net.isIP distinguishes IP literals from hostnames", () => {
  // Drives the initial-stage decision in performHttpRequest.
  assert.ok(net.isIP("69.75.238.234") > 0);
  assert.equal(net.isIP("example.com"), 0);
});

test("IP-literal connect timeouts are labeled CONNECT, not DNS", async () => {
  // 192.0.2.1 is TEST-NET-1 (RFC 5737): reserved and unrouted, so the TCP
  // handshake hangs and our total-timeout fires. Because the host is an IP
  // literal, Node performs no DNS lookup — the failure must be attributed to
  // CONNECT, never the bogus "DNS timeout" that the old initial value produced.
  let err: (Error & { stage?: string }) | undefined;
  try {
    await performHttpRequest({
      url: "http://192.0.2.1:1026",
      method: "GET",
      headers: {},
      useRange: false,
      readBody: false,
      totalTimeoutMs: 300,
    });
    assert.fail("expected the request to time out");
  } catch (e) {
    err = e as Error & { stage?: string };
  }

  if (/timeout after/.test(err!.message)) {
    assert.equal(err!.stage, "CONNECT");
    assert.match(err!.message, /^CONNECT timeout after/);
    assert.doesNotMatch(err!.message, /DNS timeout/);
  } else {
    // Some sandboxes reject the route immediately (ENETUNREACH/EHOSTUNREACH)
    // instead of hanging; that path doesn't exercise stage attribution.
    assert.ok(err);
  }
});


