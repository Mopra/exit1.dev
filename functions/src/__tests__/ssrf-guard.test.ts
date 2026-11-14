// Must be set before anything asks the guard about an address: the set of
// refused extra addresses is read once and then cached for five minutes.
process.env.PROBE_BLOCKED_IPS = "93.184.216.34, 2606:2800:220:1::1";

import test from "node:test";
import assert from "node:assert/strict";
import dgram from "dgram";
import http from "http";
import net from "net";
import os from "os";

import {
  checkPingEndpoint,
  checkRestEndpoint,
  checkTcpEndpoint,
  checkTcpQuick,
  checkUdpEndpoint,
  checkWebSocketEndpoint,
} from "../check-utils";
import { CONFIG } from "../config";
import { checkSSLCertificate } from "../security-utils";
import {
  BLOCKED_ADDRESS_CODE,
  assertPublicHost,
  blockedAddressReason,
  blockedPeerError,
  reservedAddressReason,
  resolvePublicAddress,
  setSsrfGuardExemptionForTests,
  withSsrfGuard,
} from "../ssrf-guard";
import type { LookupFn } from "../probe-blockers";
import type { Website } from "../types";

// No test in this file touches the network. Fake lookups stand in for DNS, and
// probe-level tests aim at IP literals or localhost only.

type Answer = { address: string; family: number };

const fixedLookup = (answer: Answer[]): LookupFn =>
  (_hostname, options, callback) => {
    const opts = typeof options === "number" ? { family: options } : options;
    if (opts.all) callback(null, answer);
    else callback(null, answer[0].address, answer[0].family);
  };

const lookupOnce = (fn: LookupFn, all: boolean, hostname = "internal.test") =>
  new Promise<{ address: unknown; family?: number }>((resolve, reject) => {
    fn(hostname, { all }, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });

const blockedError = (err: unknown): boolean => {
  assert.equal((err as { code?: unknown }).code, BLOCKED_ADDRESS_CODE);
  return true;
};

const baseWebsite = (url: string, extra: Partial<Website> = {}): Website => ({
  id: "ssrf-guard-check",
  userId: "test-user",
  name: "SSRF Guard Site",
  url,
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  // Stored metadata with a fresh timestamp keeps the probes from doing any
  // geo or certificate lookups of their own.
  targetIp: "203.0.113.42",
  targetIpFamily: 4,
  targetMetadataLastChecked: Date.now(),
  sslCertificate: { valid: true, lastChecked: Date.now() },
  ...extra,
});

/** A TCP listener on loopback that counts every connection it accepts. */
async function countingTcpListener(host = "127.0.0.1") {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BLOCKED = /Blocked target/;

// 1. Range table

test("reservedAddressReason refuses every reserved, private and local address", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    // Every IPv4-mapped address is refused, public inner address or not.
    "::ffff:8.8.8.8",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    // Teredo
    "2001::1",
    // 6to4 wrapping a private IPv4 address
    "2002:7f00:1::1",
    "2002:c0a8:101::1",
    "[::1]",
    "not-an-ip",
  ];
  for (const ip of blocked) {
    assert.equal(typeof reservedAddressReason(ip), "string", `${ip} should be refused`);
  }
});

test("reservedAddressReason allows public addresses, including range neighbours", () => {
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.167.255.255",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
    "187.77.85.132",
    "2620:cb:2000::1",
    "2a02:4780:79:2ec9::1",
    "2606:4700:4700::1111",
    "2002:808:808::1",
    "2001:4860:4860::8888",
  ];
  for (const ip of allowed) {
    assert.equal(reservedAddressReason(ip), undefined, `${ip} should be allowed`);
  }
});

// 2. The box's own addresses and PROBE_BLOCKED_IPS

test("blockedAddressReason refuses addresses listed in PROBE_BLOCKED_IPS", () => {
  // Public by range, so only the env list can be what refuses them.
  assert.equal(reservedAddressReason("93.184.216.34"), undefined);
  assert.equal(reservedAddressReason("2606:2800:220:1::1"), undefined);

  assert.equal(typeof blockedAddressReason("93.184.216.34"), "string");
  assert.equal(typeof blockedAddressReason("2606:2800:220:1::1"), "string");
  // The same IPv6 address written out differently.
  assert.equal(typeof blockedAddressReason("2606:2800:0220:0001:0:0:0:1"), "string");
  assert.equal(typeof blockedAddressReason("[2606:2800:220:1:0:0:0:1]"), "string");

  // Neighbours stay reachable.
  assert.equal(blockedAddressReason("93.184.216.35"), undefined);
  assert.equal(blockedAddressReason("2606:2800:220:1::2"), undefined);
});

test("blockedAddressReason refuses the machine's own interface addresses", (t) => {
  const own = Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((info) => !info.internal);

  // Reserved or not, an address on a local interface is never a valid target.
  for (const info of own) {
    assert.equal(typeof blockedAddressReason(info.address), "string", `${info.address} should be refused`);
  }

  // Only a public-looking one proves the own-address check, since the range
  // table already refuses the rest.
  const publicLooking = own.find((info) => reservedAddressReason(info.address) === undefined);
  if (!publicLooking) {
    t.skip("no public-looking interface address on this machine");
    return;
  }
  assert.equal(blockedAddressReason(publicLooking.address), "monitoring server");
});

// 3. withSsrfGuard

test("withSsrfGuard passes a single public answer through unchanged", async () => {
  const lookup = withSsrfGuard(fixedLookup([{ address: "8.8.8.8", family: 4 }]));
  assert.deepEqual(await lookupOnce(lookup, false), { address: "8.8.8.8", family: 4 });

  const v6 = withSsrfGuard(fixedLookup([{ address: "2606:4700:4700::1111", family: 6 }]));
  assert.deepEqual(await lookupOnce(v6, false), { address: "2606:4700:4700::1111", family: 6 });
});

test("withSsrfGuard fails a single private answer, naming the host and the IP", async () => {
  const lookup = withSsrfGuard(fixedLookup([{ address: "10.0.0.1", family: 4 }]));
  await assert.rejects(lookupOnce(lookup, false, "internal.test"), (err: Error) => {
    assert.equal((err as { code?: unknown }).code, "EBLOCKEDADDR");
    assert.match(err.message, /internal\.test/);
    assert.match(err.message, /10\.0\.0\.1/);
    assert.match(err.message, BLOCKED);
    return true;
  });
});

test("withSsrfGuard keeps only the public answers of a mixed list, in order", async () => {
  const lookup = withSsrfGuard(
    fixedLookup([
      { address: "10.0.0.1", family: 4 },
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 },
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "169.254.169.254", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]),
  );
  assert.deepEqual((await lookupOnce(lookup, true)).address, [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "1.1.1.1", family: 4 },
  ]);
});

test("withSsrfGuard fails a list with nothing public in it", async () => {
  const lookup = withSsrfGuard(
    fixedLookup([
      { address: "192.168.1.1", family: 4 },
      { address: "fd12:3456::1", family: 6 },
    ]),
  );
  await assert.rejects(lookupOnce(lookup, true, "internal.test"), (err: Error) => {
    assert.equal((err as { code?: unknown }).code, "EBLOCKEDADDR");
    assert.match(err.message, /internal\.test/);
    assert.match(err.message, /192\.168\.1\.1/);
    return true;
  });
});

test("withSsrfGuard passes an upstream lookup error through untouched", async () => {
  const upstream = Object.assign(new Error("getaddrinfo ENOTFOUND internal.test"), { code: "ENOTFOUND" });
  const failing: LookupFn = (_h, _o, cb) => cb(upstream, "", 0);
  const guarded = withSsrfGuard(failing);
  await assert.rejects(lookupOnce(guarded, false), (err: unknown) => err === upstream);
  await assert.rejects(lookupOnce(guarded, true), (err: unknown) => err === upstream);
});

test("withSsrfGuard passes an empty answer list through", async () => {
  const empty: LookupFn = (_h, _o, cb) => cb(null, []);
  assert.deepEqual((await lookupOnce(withSsrfGuard(empty), true)).address, []);
});

// 4. assertPublicHost

test("assertPublicHost throws for reserved IP literals", () => {
  for (const host of ["127.0.0.1", "[::1]", "169.254.169.254"]) {
    assert.throws(() => assertPublicHost(host), blockedError, `${host} should throw`);
  }
});

test("assertPublicHost lets hostnames and public literals through", () => {
  // Hostnames are judged at lookup time, so even localhost passes here.
  for (const host of ["example.com", "8.8.8.8", "localhost"]) {
    assert.doesNotThrow(() => assertPublicHost(host), `${host} should pass`);
  }
});

// 5. resolvePublicAddress

test("resolvePublicAddress returns the first allowed address and its family", async () => {
  const mixed = withSsrfGuard(
    fixedLookup([
      { address: "10.0.0.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]),
  );
  assert.deepEqual(await resolvePublicAddress("internal.test", 0, mixed), {
    address: "2606:4700:4700::1111",
    family: 6,
  });

  const v4 = withSsrfGuard(fixedLookup([{ address: "8.8.8.8", family: 4 }]));
  assert.deepEqual(await resolvePublicAddress("internal.test", 4, v4), { address: "8.8.8.8", family: 4 });
});

test("resolvePublicAddress rejects when every answer is private", async () => {
  const allPrivate = withSsrfGuard(
    fixedLookup([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]),
  );
  await assert.rejects(resolvePublicAddress("internal.test", 0, allPrivate), blockedError);
});

test("resolvePublicAddress with the system resolver refuses loopback", async () => {
  await assert.rejects(resolvePublicAddress("127.0.0.1"), blockedError);
  await assert.rejects(resolvePublicAddress("localhost"), blockedError);
});

// 6. blockedPeerError

test("blockedPeerError unwraps the dual-stack form of an IPv4 peer", () => {
  const blocked = blockedPeerError("internal.test", "::ffff:127.0.0.1");
  assert.ok(blocked);
  assert.equal(blocked.code, "EBLOCKEDADDR");
  assert.match(blocked.message, /127\.0\.0\.1/);

  assert.equal(blockedPeerError("internal.test", "::ffff:8.8.8.8"), undefined);
  assert.equal(blockedPeerError("internal.test", undefined), undefined);
});

// 7. Probe level. Each probe has a live listener on 127.0.0.1, so a missing
// guard would let the probe connect and succeed.

test("checkRestEndpoint refuses 127.0.0.1", async () => {
  const listener = await countingTcpListener();
  try {
    const literal = await checkRestEndpoint(baseWebsite(`http://127.0.0.1:${listener.port}`));
    assert.equal(literal.status, "offline");
    assert.match(String(literal.error), BLOCKED);

    assert.equal(listener.connections(), 0);
  } finally {
    await listener.close();
  }
});

test("checkRestEndpoint refuses odd spellings of loopback", async () => {
  const listener = await countingTcpListener();
  try {
    const hosts = ["2130706433", "0x7f.1", "[::1]", "[::ffff:127.0.0.1]"];
    for (const host of hosts) {
      const result = await checkRestEndpoint(baseWebsite(`http://${host}:${listener.port}/`));
      assert.equal(result.status, "offline", host);
      assert.match(String(result.error), BLOCKED, host);
    }
    assert.equal(listener.connections(), 0);
  } finally {
    await listener.close();
  }
});

test("checkTcpEndpoint refuses 127.0.0.1 and localhost", async () => {
  const listener = await countingTcpListener();
  try {
    for (const host of ["127.0.0.1", "localhost"]) {
      const result = await checkTcpEndpoint(baseWebsite(`tcp://${host}:${listener.port}`, { type: "tcp" }));
      assert.equal(result.status, "offline", host);
      assert.match(String(result.error), BLOCKED, host);
    }
    assert.equal(listener.connections(), 0);
  } finally {
    await listener.close();
  }
});

test("checkTcpEndpoint refuses a hex spelling of loopback", async () => {
  const listener = await countingTcpListener();
  try {
    // The error text depends on how the OS resolver treats the name.
    const result = await checkTcpEndpoint(baseWebsite(`tcp://0x7f.1:${listener.port}`, { type: "tcp" }));
    assert.equal(result.status, "offline");
    assert.equal(listener.connections(), 0);
  } finally {
    await listener.close();
  }
});

test("checkTcpQuick refuses 127.0.0.1", async () => {
  const listener = await countingTcpListener();
  try {
    const result = await checkTcpQuick(`http://127.0.0.1:${listener.port}`);
    assert.equal(result.status, "offline");
    assert.equal(listener.connections(), 0);
  } finally {
    await listener.close();
  }
});

test("checkWebSocketEndpoint refuses 127.0.0.1", async () => {
  const listener = await countingTcpListener();
  try {
    const result = await checkWebSocketEndpoint(
      baseWebsite(`ws://127.0.0.1:${listener.port}`, { type: "websocket" }),
    );
    assert.equal(result.status, "offline");
    assert.match(String(result.error), BLOCKED);
    assert.equal(listener.connections(), 0);
  } finally {
    await listener.close();
  }
});

test("checkUdpEndpoint refuses 127.0.0.1", async () => {
  let datagrams = 0;
  const socket = dgram.createSocket("udp4");
  socket.on("message", () => {
    datagrams++;
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  try {
    // UDP reports online when nothing answers, so offline here is the guard.
    const result = await checkUdpEndpoint(baseWebsite(`udp://127.0.0.1:${port}`, { type: "udp" }));
    assert.equal(result.status, "offline");
    assert.match(String(result.error), BLOCKED);
    assert.equal(datagrams, 0);
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
});

test("checkPingEndpoint refuses 127.0.0.1 before it spawns ping", async () => {
  const result = await checkPingEndpoint(baseWebsite("ping://127.0.0.1", { type: "ping" }));
  assert.equal(result.status, "offline");
  assert.match(String(result.error), BLOCKED);
});

test("checkSSLCertificate refuses 127.0.0.1 as a failed observation", async () => {
  const listener = await countingTcpListener();
  try {
    const result = await checkSSLCertificate(`https://127.0.0.1:${listener.port}`);
    assert.equal(result.valid, false);
    assert.equal(result.observationFailed, true);
    assert.match(String(result.error), BLOCKED);
    assert.equal(listener.connections(), 0);
  } finally {
    await listener.close();
  }
});

// 8. Redirect hops. Only 127.0.0.1 is exempted, so the first request reaches
// server A while every other local address stays refused.

async function redirectingServer(location: string) {
  const server = http.createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("Location", location);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

const closeHttp = (server: http.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

test("a redirect into a local address is not followed", async () => {
  const SECRET_BODY = "TOP-SECRET-BODY-FROM-B";
  let requestsToB = 0;
  const serverB = http.createServer((_req, res) => {
    requestsToB++;
    res.statusCode = 200;
    res.end(SECRET_BODY);
  });
  // 127.0.0.2 where it can be bound, otherwise every interface (which also
  // answers on 127.0.0.2 on Windows and Linux).
  await new Promise<void>((resolve) => {
    serverB.once("error", () => serverB.listen(0, "0.0.0.0", resolve));
    serverB.listen(0, "127.0.0.2", resolve);
  });
  const portB = (serverB.address() as net.AddressInfo).port;
  const a = await redirectingServer(`http://127.0.0.2:${portB}/secret`);

  setSsrfGuardExemptionForTests((ip) => ip === "127.0.0.1");
  try {
    const result = await checkRestEndpoint(
      baseWebsite(`http://127.0.0.1:${a.port}`, { maxRedirects: 5 }),
    );
    assert.equal(requestsToB, 0);
    assert.ok(!JSON.stringify(result).includes(SECRET_BODY));
    // The check is judged on the redirect response itself.
    assert.equal(result.statusCode, 302);
    assert.equal(result.redirectChain, undefined);
  } finally {
    setSsrfGuardExemptionForTests(undefined);
    await closeHttp(a.server);
    await closeHttp(serverB);
  }
});

test("a redirect to the metadata address is dropped at once, without a timeout", async () => {
  const a = await redirectingServer("http://169.254.169.254/latest/meta-data/");

  setSsrfGuardExemptionForTests((ip) => ip === "127.0.0.1");
  try {
    const startedAt = Date.now();
    const result = await checkRestEndpoint(
      baseWebsite(`http://127.0.0.1:${a.port}`, { maxRedirects: 5 }),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 3000, `took ${elapsedMs}ms`);
    assert.equal(result.statusCode, 302);
    assert.equal(result.redirectChain, undefined);
  } finally {
    setSsrfGuardExemptionForTests(undefined);
    await closeHttp(a.server);
  }
});

test("the guard is back in force after the redirect tests", () => {
  assert.equal(typeof blockedAddressReason("127.0.0.1"), "string");
});

// 9. CONFIG.validateUrl

test("CONFIG.validateUrl rejects reserved IP literals", () => {
  const invalid = [
    "http://127.0.0.1/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://0.0.0.0/",
    "http://2130706433/",
  ];
  for (const url of invalid) {
    assert.equal(CONFIG.validateUrl(url).valid, false, url);
  }
  assert.equal(CONFIG.validateUrl("tcp://10.0.0.5:6379", "tcp").valid, false);
});

test("CONFIG.validateUrl accepts hostnames and public IP literals", () => {
  // Not example.com: that name is on CONFIG.BLOCKED_DOMAINS for its own reasons.
  for (const url of ["https://exit1.dev", "http://8.8.8.8/", "http://[2606:4700:4700::1111]/"]) {
    assert.equal(CONFIG.validateUrl(url).valid, true, url);
  }
});
