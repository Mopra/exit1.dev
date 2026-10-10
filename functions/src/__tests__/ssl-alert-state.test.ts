import test from "node:test";
import assert from "node:assert/strict";

import {
  getSSLAlertState,
  decideSSLAlertTransition,
  SSL_WARNING_THRESHOLD_DAYS,
  normalizeSSLAlertState,
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
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 15 }), "warning");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 14 }), "warning_14");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 7 }), "warning_7");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 4 }), "warning_7");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 3 }), "warning_3");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 1 }), "warning_1");
  assert.equal(getSSLAlertState({ valid: true, daysUntilExpiry: 0 }), "warning_1");
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

const ALL: SSLAlertState[] = ["ok", "warning", "warning_14", "warning_7", "warning_3", "warning_1", "error"];

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

// ── Reminder bands: an unrenewed cert keeps warning on its way to expiry ─────

test("reminders: each tighter band fires ssl_warning again (kairandles 2026-09-19)", () => {
  // One warning at 30 days and then silence until expiry was the bug. Walk a
  // cert from 31 days to expired and collect every alert the durable state
  // machine produces.
  let lastAlerted: SSLAlertState = "ok";
  const fired: Array<[number, string]> = [];
  for (let days = 31; days >= 0; days--) {
    const decision = decideSSLAlertTransition(getSSLAlertState({ valid: true, daysUntilExpiry: days }), lastAlerted);
    if (decision.kind === "alert") {
      fired.push([days, decision.eventType]);
      lastAlerted = getSSLAlertState({ valid: true, daysUntilExpiry: days });
    }
  }
  const expired = decideSSLAlertTransition(getSSLAlertState({ valid: false, daysUntilExpiry: -1 }), lastAlerted);
  assert.deepEqual(fired, [[30, "ssl_warning"], [14, "ssl_warning"], [7, "ssl_warning"], [3, "ssl_warning"], [1, "ssl_warning"]]);
  assert.deepEqual(expired, { kind: "alert", eventType: "ssl_error" });
});

test("reminders: a legacy 'warning' state reminds once the cert reaches a tighter band", () => {
  assert.deepEqual(
    decideSSLAlertTransition(getSSLAlertState({ valid: true, daysUntilExpiry: 10 }), "warning"),
    { kind: "alert", eventType: "ssl_warning" },
  );
});

test("reminders: moving to a less urgent band rebases without alerting", () => {
  assert.deepEqual(decideSSLAlertTransition("warning_14", "warning_3"), { kind: "rebase", state: "warning_14" });
  assert.deepEqual(decideSSLAlertTransition("warning", "warning_7"), { kind: "rebase", state: "warning" });
});

test("reminders: error to any warning band still alerts", () => {
  assert.deepEqual(decideSSLAlertTransition("warning_7", "error"), { kind: "alert", eventType: "ssl_warning" });
});

test("normalizeSSLAlertState: unknown or missing values read as 'ok'", () => {
  assert.equal(normalizeSSLAlertState(undefined), "ok");
  assert.equal(normalizeSSLAlertState("bogus"), "ok");
  assert.equal(normalizeSSLAlertState("warning_7"), "warning_7");
});
