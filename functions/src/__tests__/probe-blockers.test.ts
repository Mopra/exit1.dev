import test from "node:test";
import assert from "node:assert/strict";
import type os from "os";

import {
  describeProbeBlock,
  hasGlobalIpv6,
  isConnectStageFailure,
  probeBlockerFor,
  withBlockerReroute,
  PROBE_BLOCKED_ERROR_PREFIX,
  type LookupFn,
} from "../probe-blockers";

const WEBFLOW_V4 = "198.202.211.1";
const WEBFLOW_V6 = "2620:cb:2000::1";

const fixedLookup = (answer: Array<{ address: string; family: number }>): LookupFn =>
  (_hostname, options, callback) => {
    const opts = typeof options === "number" ? { family: options } : options;
    if (opts.all) callback(null, answer);
    else callback(null, answer[0].address, answer[0].family);
  };

const lookupOnce = (fn: LookupFn, all: boolean) =>
  new Promise<{ address: unknown; family?: number }>((resolve, reject) => {
    fn("example.com", { all }, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });

test("probeBlockerFor matches the blocked address and its fallback, nothing else", () => {
  assert.equal(probeBlockerFor(WEBFLOW_V4)?.name, "Webflow");
  assert.equal(probeBlockerFor(WEBFLOW_V6)?.name, "Webflow");
  assert.equal(probeBlockerFor("198.202.211.2"), undefined);
  assert.equal(probeBlockerFor(undefined), undefined);
});

test("only a failure before the TCP connection counts as a block", () => {
  assert.equal(isConnectStageFailure("CONNECT", undefined), true);
  assert.equal(isConnectStageFailure(undefined, "ENETUNREACH"), true);
  assert.equal(isConnectStageFailure(undefined, "EHOSTUNREACH"), true);
  // The host answered: these are real observations.
  assert.equal(isConnectStageFailure("TLS", undefined), false);
  assert.equal(isConnectStageFailure("TTFB", undefined), false);
  assert.equal(isConnectStageFailure("DNS", undefined), false);
  assert.equal(isConnectStageFailure(undefined, "ECONNREFUSED"), false);
  assert.equal(isConnectStageFailure(undefined, "ECONNRESET"), false);
});

test("describeProbeBlock carries the stable prefix and the cause", () => {
  const msg = describeProbeBlock({ name: "Webflow" }, "CONNECT timeout after 30000ms");
  assert.ok(msg.startsWith(PROBE_BLOCKED_ERROR_PREFIX));
  assert.match(msg, /Webflow/);
  assert.match(msg, /CONNECT timeout after 30000ms/);
});

test("hasGlobalIpv6 ignores loopback, link-local and ULA addresses", () => {
  const iface = (address: string, family: "IPv4" | "IPv6", internal = false) =>
    ({ address, family, internal }) as os.NetworkInterfaceInfo;
  assert.equal(hasGlobalIpv6({ lo: [iface("::1", "IPv6", true)], eth0: [iface("187.77.85.132", "IPv4")] }), false);
  assert.equal(hasGlobalIpv6({ eth0: [iface("fe80::1", "IPv6")], br0: [iface("fda6:b6a8:82cc::1", "IPv6")] }), false);
  assert.equal(hasGlobalIpv6({ eth0: [iface("2a02:4780:79:2ec9::1", "IPv6")] }), true);
});

test("a blocked address is swapped for its fallback in both lookup shapes", async () => {
  const lookup = withBlockerReroute(fixedLookup([{ address: WEBFLOW_V4, family: 4 }]), () => true);
  assert.deepEqual(await lookupOnce(lookup, false), { address: WEBFLOW_V6, family: 6 });
  assert.deepEqual((await lookupOnce(lookup, true)).address, [{ address: WEBFLOW_V6, family: 6 }]);
});

test("reroute dedupes when the host already lists the fallback", async () => {
  const lookup = withBlockerReroute(
    fixedLookup([{ address: WEBFLOW_V4, family: 4 }, { address: WEBFLOW_V6, family: 6 }]),
    () => true,
  );
  assert.deepEqual((await lookupOnce(lookup, true)).address, [{ address: WEBFLOW_V6, family: 6 }]);
});

test("no reroute without a route for the fallback family, or for other hosts", async () => {
  const noV6 = withBlockerReroute(fixedLookup([{ address: WEBFLOW_V4, family: 4 }]), (family) => family === 4);
  assert.deepEqual(await lookupOnce(noV6, false), { address: WEBFLOW_V4, family: 4 });

  const other = withBlockerReroute(fixedLookup([{ address: "198.202.211.2", family: 4 }]), () => true);
  assert.deepEqual(await lookupOnce(other, false), { address: "198.202.211.2", family: 4 });
});

test("lookup errors pass through untouched", async () => {
  const failing: LookupFn = (_h, _o, cb) => cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), "", 0);
  await assert.rejects(lookupOnce(withBlockerReroute(failing, () => true), false), /ENOTFOUND/);
});
