import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import net from "net";

import { checkRestEndpoint } from "../check-utils";
import type { Website } from "../types";

// Reported by a user: an alert email named 193.1.98.10 as the "Target IP" while
// its own error line read "connect EHOSTUNREACH 193.1.98.9:443" — the DNS record
// had propagated days earlier. The stored targetIp is refreshed only by a
// background job (geo TTL / geo failure backoff), so it can lag reality by
// weeks. What the probe actually dialed must win.

const STALE_IP = "203.0.113.42"; // TEST-NET-3, never the real answer

const baseWebsite = (url: string): Website => ({
  id: "observed-ip-check",
  userId: "test-user",
  name: "Observed IP Site",
  url,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  // Stored (stale) metadata. targetMetadataLastChecked being set is what
  // disables the inline metadata refresh, i.e. the exact production state.
  targetIp: STALE_IP,
  targetIpFamily: 4,
  targetMetadataLastChecked: Date.now(),
  sslCertificate: { valid: true, lastChecked: Date.now() },
});

test("a successful probe reports the IP it actually connected to, not the stored one", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const result = await checkRestEndpoint(baseWebsite(`http://127.0.0.1:${port}`));
    assert.equal(result.status, "online");
    assert.equal(result.targetIp, "127.0.0.1");
    assert.notEqual(result.targetIp, STALE_IP);
  } finally {
    server.close();
  }
});

test("a failed probe still reports the IP it dialed", async () => {
  // Grab a port, then close it so the connect is refused — the failure path is
  // where naming the right IP matters most, since that IP goes in the alert.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const result = await checkRestEndpoint(baseWebsite(`http://127.0.0.1:${port}`));
  assert.equal(result.status, "offline");
  assert.equal(result.targetIp, "127.0.0.1");
  assert.notEqual(result.targetIp, STALE_IP);
});

test("geo fields survive an IP correction", async () => {
  // Round-robin and CDN hosts legitimately answer with a different IP per
  // probe. Blanking country/ISP every time one does would flap the UI, so
  // applyObservedIp replaces only the IP and leaves geo to the refresher.
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const website = {
      ...baseWebsite(`http://127.0.0.1:${port}`),
      targetCountry: "IE",
      targetIsp: "Old ISP",
    } as Website;
    const result = await checkRestEndpoint(website);
    assert.equal(result.targetIp, "127.0.0.1");
    assert.equal(result.targetCountry, "IE");
    assert.equal(result.targetIsp, "Old ISP");
  } finally {
    server.close();
  }
});
