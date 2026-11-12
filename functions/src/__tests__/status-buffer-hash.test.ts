import test from "node:test";
import assert from "node:assert/strict";

import { __statusBufferTestHooks, type StatusUpdateData } from "../status-buffer";

// The hourly heartbeat-defer flush wrote about 1,400 check docs an hour
// (about 34k writes a day) although real status changes happen a few hundred
// times a day. Measured 2026-11-12 by diffing two snapshots of `checks`
// across one flush: most flush writes changed no stored state at all. These
// tests pin the classification that decides write vs skip.

const { MATERIAL_KEYS, TIMING_KEYS, SSL_MATERIAL_KEYS, planFlushWrite } = __statusBufferTestHooks;

type Payload = StatusUpdateData & Record<string, unknown>;
type Prev = Parameters<typeof planFlushWrite>[0];

const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
const opts = (now: number) => ({ steadySkipEnabled: true, maxAgeMs: 24 * HOUR, now });

/** Plan a flush and, when it writes, return the record as committed at `now`. */
const flush = (prev: Prev, data: Payload, now: number) => {
  const plan = planFlushWrite(prev, data, opts(now));
  const next: Prev = plan.action === "write" ? { ...plan.record, writtenAt: now } : prev;
  return { action: plan.action, next };
};

// The slim update processOneCheck sends when nothing changed.
const slim = (now: number, over: Partial<Payload> = {}): Payload => ({
  status: "online",
  lastChecked: now,
  updatedAt: now,
  nextCheckAt: now + 5 * 60_000,
  responseTime: 180,
  lastStatusCode: 200,
  consecutiveFailures: 0,
  consecutiveSuccesses: 100,
  dnsMs: 4,
  connectMs: 11,
  tlsMs: 23,
  ttfbMs: 140,
  peerRegion: null,
  peerStatus: null,
  peerResponseTime: null,
  peerCheckedAt: null,
  peerReachable: null,
  ...over,
});

// The full update it sends when response time moved more than 100ms (or
// anything else changed): the slim fields plus region, target metadata,
// detailedStatus, lastError and the cert.
const full = (now: number, over: Partial<Payload> = {}): Payload => ({
  ...slim(now),
  checkRegion: "vps-eu-1",
  userTier: "free",
  detailedStatus: "UP",
  targetCountry: "US",
  targetRegion: "California",
  targetCity: "San Francisco",
  targetLatitude: 37.77,
  targetLongitude: -122.41,
  targetHostname: "example.com",
  targetIp: "104.18.24.105",
  targetIpsJson: '["104.18.24.105","104.18.25.105"]',
  targetIpFamily: 4,
  targetAsn: "AS13335",
  targetOrg: "Cloudflare",
  targetIsp: "Cloudflare",
  lastError: null,
  redirectLocation: null,
  sslCertificate: {
    valid: true,
    lastChecked: now,
    issuer: "Let's Encrypt",
    subject: "example.com",
    validFrom: T0 - 30 * 24 * HOUR,
    validTo: T0 + 60 * 24 * HOUR,
    daysUntilExpiry: 60,
  },
  ...over,
});

const written = (data: Payload, now = T0): Prev => {
  const { action, next } = flush(undefined, data, now);
  assert.equal(action, "write");
  return next;
};

test("the first flush for a check always writes", () => {
  assert.equal(flush(undefined, slim(T0), T0).action, "write");
});

test("an identical payload is a no-op", () => {
  const prev = written(full(T0));
  assert.equal(flush(prev, full(T0), T0 + 1000).action, "noop");
});

test("probe recency and measurements alone do not write", () => {
  const prev = written(full(T0));
  const later = full(T0 + HOUR, {
    responseTime: 950,
    dnsMs: 40,
    connectMs: 90,
    tlsMs: 120,
    ttfbMs: 700,
    lastHistoryAt: T0 + HOUR,
    peerCheckedAt: T0 + HOUR,
    peerResponseTime: 333,
  });
  assert.equal(flush(prev, later, T0 + HOUR).action, "steady-skip");
});

test("a CDN answering with another primary address does not write", () => {
  const prev = written(full(T0));
  const rotated = full(T0 + HOUR, { targetIp: "104.18.25.105" });
  assert.equal(flush(prev, rotated, T0 + HOUR).action, "steady-skip");
});

test("a failure streak past the cap does not write, below it does", () => {
  const down = (now: number, failures: number) =>
    slim(now, { status: "offline", consecutiveFailures: failures, consecutiveSuccesses: 0 });
  const long = written(down(T0, 480));
  assert.equal(flush(long, down(T0 + HOUR, 492), T0 + HOUR).action, "steady-skip");
  const young = written(down(T0, 4));
  assert.equal(flush(young, down(T0 + HOUR, 16), T0 + HOUR).action, "write");
  // Recovery from a long outage is a zero crossing and must write.
  assert.equal(flush(long, slim(T0 + HOUR), T0 + HOUR).action, "write");
});

test("a success streak counting up does not write", () => {
  const prev = written(slim(T0, { consecutiveSuccesses: 12 }));
  const later = slim(T0 + HOUR, { consecutiveSuccesses: 24 });
  assert.equal(flush(prev, later, T0 + HOUR).action, "steady-skip");
});

test("a re-read of the same certificate does not write", () => {
  const prev = written(full(T0));
  const later = full(T0 + HOUR);
  later.sslCertificate = { ...later.sslCertificate!, lastChecked: T0 + HOUR };
  assert.equal(flush(prev, later, T0 + HOUR).action, "steady-skip");
});

// The regression this file exists for. A check alternates between the slim
// and the full payload from hour to hour. The fields the slim one leaves out
// are untouched in Firestore, so the stored state is identical either way.
test("alternating between the slim and the full payload does not write", () => {
  let prev = written(full(T0));
  for (let hour = 1; hour <= 6; hour++) {
    const now = T0 + hour * HOUR;
    const data = hour % 2 === 1 ? slim(now) : full(now);
    const result = flush(prev, data, now);
    assert.equal(result.action, "steady-skip", `hour ${hour}`);
    prev = result.next;
  }
});

test("a field the payload leaves out is compared against what was last written", () => {
  // Written with the full payload, then a slim hour, then a full payload
  // whose detailedStatus really differs: that must write.
  const prev = written(full(T0));
  assert.equal(flush(prev, slim(T0 + HOUR), T0 + HOUR).action, "steady-skip");
  const changed = full(T0 + 2 * HOUR, { detailedStatus: "REDIRECT" });
  assert.equal(flush(prev, changed, T0 + 2 * HOUR).action, "write");
});

test("fields first seen after a slim write are written once, then settle", () => {
  let prev = written(slim(T0));
  const first = flush(prev, full(T0 + HOUR), T0 + HOUR);
  assert.equal(first.action, "write");
  prev = first.next;
  assert.equal(flush(prev, slim(T0 + 2 * HOUR), T0 + 2 * HOUR).action, "steady-skip");
  assert.equal(flush(prev, full(T0 + 3 * HOUR), T0 + 3 * HOUR).action, "steady-skip");
});

// Every material field must still force a write when its value changes.
const CHANGED: Record<(typeof MATERIAL_KEYS)[number], unknown> = {
  status: "offline",
  lastStatusChange: T0 + 5,
  lastStatusCode: 503,
  statusCode: 503,
  consecutiveFailures: 1,
  detailedStatus: "DOWN",
  lastError: "connect ETIMEDOUT",
  checkRegion: "vps-us-1",
  targetCountry: "DE",
  targetRegion: "Hesse",
  targetCity: "Frankfurt",
  targetLatitude: 50.11,
  targetLongitude: 8.68,
  targetHostname: "other.example.com",
  targetIpsJson: '["3.3.3.3"]',
  targetIpFamily: 6,
  targetAsn: "AS16509",
  targetOrg: "Amazon",
  targetIsp: "Amazon",
  targetMetadataLastChecked: T0 + 5,
  downtimeCount: 3,
  lastDowntime: T0 + 5,
  lastFailureTime: T0 + 5,
  disabled: true,
  disabledAt: T0 + 5,
  disabledReason: "quota",
  pendingDownEmail: true,
  pendingDownSince: T0 + 5,
  pendingUpEmail: true,
  pendingUpSince: T0 + 5,
  pendingDownSms: true,
  pendingUpSms: true,
  pendingDownWebhooks: true,
  pendingUpWebhooks: true,
  sslAlertedState: "warning",
  maintenanceMode: true,
  maintenanceStartedAt: T0 + 5,
  maintenanceExpiresAt: T0 + 6,
  maintenanceDuration: 30,
  maintenanceReason: "deploy",
  maintenanceScheduledStart: T0 + 7,
  maintenanceScheduledDuration: 60,
  maintenanceScheduledReason: "window",
  maintenanceRecurringActiveUntil: T0 + 8,
  redirectLocation: "https://example.com/new",
  peerRegion: "vps-us-1",
  peerStatus: "offline",
  peerReachable: false,
  peerDisagreementStreakStartedAt: T0 + 5,
  peerDisagreementNotifiedAt: T0 + 6,
};

for (const key of MATERIAL_KEYS) {
  test(`material: a change to ${key} writes`, () => {
    const prev = written(full(T0));
    const changed = { ...slim(T0 + HOUR), [key]: CHANGED[key] } as Payload;
    assert.equal(flush(prev, changed, T0 + HOUR).action, "write");
  });
}

const CHANGED_SSL: Record<(typeof SSL_MATERIAL_KEYS)[number], unknown> = {
  valid: false,
  issuer: "ZeroSSL",
  subject: "other.example.com",
  validFrom: T0,
  validTo: T0 + 90 * 24 * HOUR,
  daysUntilExpiry: 59,
  error: "certificate has expired",
};

for (const key of SSL_MATERIAL_KEYS) {
  test(`material: a change to sslCertificate.${key} writes`, () => {
    const prev = written(full(T0));
    const base = full(T0 + HOUR);
    const changed = { ...slim(T0 + HOUR), sslCertificate: { ...base.sslCertificate!, [key]: CHANGED_SSL[key] } } as Payload;
    assert.equal(flush(prev, changed, T0 + HOUR).action, "write");
  });
}

test("a cert error that clears writes, because the cert map is replaced whole", () => {
  const broken = full(T0);
  broken.sslCertificate = { ...broken.sslCertificate!, valid: false, error: "self-signed" };
  const prev = written(broken);
  const fixed = full(T0 + HOUR);
  fixed.sslCertificate = { ...fixed.sslCertificate!, valid: false };
  assert.equal(flush(prev, fixed, T0 + HOUR).action, "write");
});

test("an explicit null is a value, not an omission", () => {
  const down = written(full(T0, { status: "offline", lastError: "timeout", lastFailureTime: T0 }));
  const cleared = slim(T0 + HOUR, { status: "offline", lastFailureTime: null });
  assert.equal(flush(down, cleared, T0 + HOUR).action, "write");
});

test("no field is classified as both material and timing", () => {
  const timing = new Set<string>(TIMING_KEYS);
  assert.deepEqual(MATERIAL_KEYS.filter((key) => timing.has(key)), []);
});

test("alert-relevant fields are material", () => {
  // Every field isTransition consults (status-transition.ts) must be
  // material, or an update routed to the immediate path could be skipped.
  const material = new Set<string>(MATERIAL_KEYS);
  for (const key of ["status", "detailedStatus", "disabled", "maintenanceMode", "lastError", "consecutiveFailures", "sslAlertedState"]) {
    assert.equal(material.has(key), true, key);
  }
});

test("a DNS re-baseline writes even though no typed field moved", () => {
  const prev = written(full(T0));
  const rebaselined: Payload = {
    ...full(T0 + HOUR),
    "dnsMonitoring.lastResult": { A: { values: ["1.2.3.4"], queriedAt: T0 + HOUR, responseTimeMs: 12 } },
    "dnsMonitoring.baseline": { A: { values: ["1.2.3.4"], capturedAt: T0 + HOUR } },
    "dnsMonitoring.changes": [{ recordType: "A", detectedAt: T0 + HOUR }],
  };
  assert.equal(flush(prev, rebaselined, T0 + HOUR).action, "write");
});

test("the per-probe DNS result alone does not write", () => {
  const result = (now: number) => ({ A: { values: ["1.2.3.4"], queriedAt: now, responseTimeMs: now % 50 } });
  const prev = written({ ...full(T0), "dnsMonitoring.lastResult": result(T0) });
  const later: Payload = { ...full(T0 + HOUR), "dnsMonitoring.lastResult": result(T0 + HOUR) };
  assert.equal(flush(prev, later, T0 + HOUR).action, "steady-skip");
});

test("a tier change writes", () => {
  const prev = written(full(T0));
  assert.equal(flush(prev, full(T0 + HOUR, { userTier: "pro" }), T0 + HOUR).action, "write");
});

test("heartbeat ping fields alone do not write", () => {
  const prev = written({ ...full(T0), lastPingAt: T0, lastPingMetadata: { ip: "1.1.1.1" } });
  const later: Payload = { ...full(T0 + HOUR), lastPingAt: T0 + HOUR, lastPingMetadata: { ip: "2.2.2.2" } };
  assert.equal(flush(prev, later, T0 + HOUR).action, "steady-skip");
});

test("the refresh floor still writes a steady check once it lapses", () => {
  const prev = written(full(T0));
  assert.equal(flush(prev, slim(T0 + 23 * HOUR), T0 + 23 * HOUR).action, "steady-skip");
  assert.equal(flush(prev, slim(T0 + 24 * HOUR), T0 + 24 * HOUR).action, "write");
});

test("the skip is off when the defer flag is off, on shutdown, or with a zero floor", () => {
  const prev = written(full(T0));
  const later = slim(T0 + HOUR);
  const now = T0 + HOUR;
  assert.equal(planFlushWrite(prev, later, { steadySkipEnabled: false, maxAgeMs: 24 * HOUR, now }).action, "write");
  assert.equal(planFlushWrite(prev, later, { steadySkipEnabled: true, maxAgeMs: 0, now }).action, "write");
});

// Resync reconciliation: the doc read back from Firestore is compared with
// the material state this process last wrote.
const { docMatchesWritten } = __statusBufferTestHooks;

test("a doc that still holds what was written matches", () => {
  const prev = written(full(T0));
  const doc: Record<string, unknown> = { ...full(T0), extraField: "ignored" };
  assert.equal(docMatchesWritten(prev!.material, doc), true);
});

test("a material field changed by another writer does not match", () => {
  const prev = written({ ...full(T0), maintenanceMode: false });
  assert.equal(docMatchesWritten(prev!.material, { ...full(T0), maintenanceMode: true }), false);
  assert.equal(docMatchesWritten(prev!.material, { ...full(T0), maintenanceMode: false, status: "offline" }), false);
});

test("timing fields and failures past the cap do not count as a mismatch", () => {
  const prev = written({ ...full(T0), status: "offline", consecutiveFailures: 150 });
  const doc = { ...full(T0), status: "offline", consecutiveFailures: 400, lastChecked: 1, responseTime: 9999, consecutiveSuccesses: 3 };
  assert.equal(docMatchesWritten(prev!.material, doc), true);
});

test("null and a missing field are the same stored value", () => {
  const prev = written({ ...full(T0), lastError: null } as Payload);
  const doc: Record<string, unknown> = { ...full(T0) };
  delete doc.lastError;
  assert.equal(docMatchesWritten(prev!.material, doc), true);
});
