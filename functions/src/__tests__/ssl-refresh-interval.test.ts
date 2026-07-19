import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../config";

// ── getSslRefreshIntervalMs cadence selection ───────────────────────────────
//
// The interval gates BOTH writers that observe certificates (the per-probe
// sslFresh check in checkRestEndpoint and the scheduled refreshSecurityMetadata
// job). The invalid/error → urgent rule is what lets a false "SSL broken"
// state (e.g. a probe that hit a host mid-reboot) self-heal within hours
// instead of sitting on the 7-day default with no user recourse.

test("no stored cert falls back to the default interval", () => {
  assert.equal(CONFIG.getSslRefreshIntervalMs(undefined), CONFIG.SSL_REFRESH_INTERVAL_DEFAULT_MS);
});

test("healthy cert far from expiry uses the default interval", () => {
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: true, daysUntilExpiry: 90 }),
    CONFIG.SSL_REFRESH_INTERVAL_DEFAULT_MS
  );
});

test("healthy cert with unknown expiry uses the default interval", () => {
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: true }),
    CONFIG.SSL_REFRESH_INTERVAL_DEFAULT_MS
  );
});

test("cert spanning the 30-day warning edge uses the daily interval", () => {
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: true, daysUntilExpiry: 35 }),
    CONFIG.SSL_REFRESH_INTERVAL_MEDIUM_MS
  );
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: true, daysUntilExpiry: 8 }),
    CONFIG.SSL_REFRESH_INTERVAL_MEDIUM_MS
  );
});

test("cert at/inside 7 days uses the urgent interval", () => {
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: true, daysUntilExpiry: 7 }),
    CONFIG.SSL_REFRESH_INTERVAL_URGENT_MS
  );
});

test("invalid cert uses the urgent interval regardless of expiry", () => {
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: false, daysUntilExpiry: 200 }),
    CONFIG.SSL_REFRESH_INTERVAL_URGENT_MS
  );
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: false }),
    CONFIG.SSL_REFRESH_INTERVAL_URGENT_MS
  );
});

test("errored observation uses the urgent interval even without daysUntilExpiry", () => {
  // The exact shape stored by a mid-reboot probe failure: valid:false + error,
  // no daysUntilExpiry. Under the old daysUntilExpiry-only signature this
  // mapped to the 7-day default — the stuck-for-a-week bug.
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: false, error: "SSL connection failed: connect ECONNREFUSED" }),
    CONFIG.SSL_REFRESH_INTERVAL_URGENT_MS
  );
  assert.equal(
    CONFIG.getSslRefreshIntervalMs({ valid: true, error: "SSL connection timeout" }),
    CONFIG.SSL_REFRESH_INTERVAL_URGENT_MS
  );
});
