import test from "node:test";
import assert from "node:assert/strict";

import {
  getSSLAlertState,
  decideSSLAlertTransition,
  SSL_WARNING_THRESHOLD_DAYS,
  type SSLAlertState,
} from "../ssl-alert-state";

// ── getSSLAlertState classification ─────────────────────────────────────────

test("getSSLAlertState: no certificate is 'ok'", () => {
  assert.equal(getSSLAlertState(null), "ok");
  assert.equal(getSSLAlertState(undefined), "ok");
});

test("getSSLAlertState: invalid/expired certificate is 'error'", () => {
  assert.equal(getSSLAlertState({ valid: false }), "error");
  assert.equal(getSSLAlertState({ valid: false, daysUntilExpiry: -3 }), "error");
});

test("getSSLAlertState: valid cert far from expiry is 'ok'", () => {
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 90 }), "ok");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 31 }), "ok");
});

test("getSSLAlertState: valid cert within the warning band is 'warning'", () => {
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 30 }), "warning");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 7 }), "warning");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 0 }), "warning");
});

test("getSSLAlertState: 30-day boundary is inclusive, 31 is not", () => {
  assert.equal(SSL_WARNING_THRESHOLD_DAYS, 30);
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: SSL_WARNING_THRESHOLD_DAYS }), "warning");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: SSL_WARNING_THRESHOLD_DAYS + 1 }), "ok");
});

test("getSSLAlertState: valid cert with unknown days is 'ok' (no false warning)", () => {
  assert.equal(getSSLAlertState({ valid: true }), "ok");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: undefined }), "ok");
});

// ── decideSSLAlertTransition: the full state machine ────────────────────────

const ALL: SSLAlertState[] = ["ok", "warning", "error"];

test("decideSSLAlertTransition: identical states are a noop (no re-fire)", () => {
  for (const s of ALL) {
    assert.deepEqual(decideSSLAlertTransition(s, s), { kind: "noop" });
  }
});

test("decideSSLAlertTransition: ok->warning fires ssl_warning (the original bug)", () => {
  assert.deepEqual(
    decideSSLAlertTransition("warning", "ok"),
    { kind: "alert", eventType: "ssl_warning" },
  );
});

test("decideSSLAlertTransition: ok->error fires ssl_error", () => {
  assert.deepEqual(
    decideSSLAlertTransition("error", "ok"),
    { kind: "alert", eventType: "ssl_error" },
  );
});

test("decideSSLAlertTransition: warning->error escalates to ssl_error", () => {
  assert.deepEqual(
    decideSSLAlertTransition("error", "warning"),
    { kind: "alert", eventType: "ssl_error" },
  );
});

test("decideSSLAlertTransition: error->warning still alerts (state changed)", () => {
  assert.deepEqual(
    decideSSLAlertTransition("warning", "error"),
    { kind: "alert", eventType: "ssl_warning" },
  );
});

test("decideSSLAlertTransition: recovery to ok is a reset (persist, no alert)", () => {
  assert.deepEqual(decideSSLAlertTransition("ok", "warning"), { kind: "reset" });
  assert.deepEqual(decideSSLAlertTransition("ok", "error"), { kind: "reset" });
});

// ── Regression: the durable-state design defeats the silent-swallow bug ──────

test("regression: ok->warning fires even when a silent writer already advanced the cert", () => {
  // Simulate refreshSecurityMetadata having recomputed a 24-day cert (warning)
  // and persisted it WITHOUT alerting. The durable last-alerted state is still
  // 'ok'. Deciding off that durable state — not the (now-warning) cert snapshot
  // — must still fire the warning. This is exactly the scenario that previously
  // produced no alert.
  const advancedCert = { valid: true, daysUntilExpiry: 24 };
  const lastAlerted: SSLAlertState = "ok";
  const decision = decideSSLAlertTransition(getSSLAlertState(advancedCert), lastAlerted);
  assert.deepEqual(decision, { kind: "alert", eventType: "ssl_warning" });
});

test("regression: a warning already notified does not re-fire every probe", () => {
  // Once sslAlertedState === 'warning', subsequent probes that recompute the
  // same warning cert must be noops (the throttle is a backstop, not the
  // primary guard).
  const stillWarning = { valid: true, daysUntilExpiry: 18 };
  assert.deepEqual(
    decideSSLAlertTransition(getSSLAlertState(stillWarning), "warning"),
    { kind: "noop" },
  );
});

test("regression: renew then re-approach expiry warns again", () => {
  // warning -> ok (renewed, reset) -> warning (new cert nearing expiry) must
  // alert again, proving the reset re-arms the state machine.
  assert.deepEqual(decideSSLAlertTransition("ok", "warning"), { kind: "reset" });
  assert.deepEqual(
    decideSSLAlertTransition("warning", "ok"),
    { kind: "alert", eventType: "ssl_warning" },
  );
});
