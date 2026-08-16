import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";

import {
  bounceKindForSuppressionReason,
  classifyDay3Event,
  isPermanentBounceType,
  parseDay3Signature,
  verifyDay3Signature,
  type Day3WebhookEvent,
} from "../day3-webhook-policy";

const SECRET = "whsec_test_secret_value";
const NOW = 1_755_264_000_000; // fixed clock; t below is the matching second

const sign = (rawBody: string, secret = SECRET, t = Math.floor(NOW / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;

const BODY = JSON.stringify({
  id: "evt_2k4h9x",
  type: "email.bounced",
  created_at: "2026-08-15T09:14:03.221Z",
  data: { object: "email", email: "user@example.com", bounce_type: "Permanent" },
});

const verify = (over: Partial<Parameters<typeof verifyDay3Signature>[0]> = {}) =>
  verifyDay3Signature({ header: sign(BODY), rawBody: BODY, secret: SECRET, nowMs: NOW, ...over });

// ── Signature: the happy path ───────────────────────────────────────────────

test("a valid signature is accepted", () => {
  assert.deepEqual(verify(), { ok: true });
});

test("verification is over the raw bytes, not a re-serialized object", () => {
  // The canary for the single most likely integration bug: parsing the body
  // and re-stringifying it reorders keys and drops whitespace, and every
  // signature then fails. Same JSON, different bytes → must not verify.
  const reserialized = JSON.stringify(JSON.parse(BODY), ["type", "id", "created_at", "data"]);
  assert.notEqual(reserialized, BODY, "test is meaningless if the bytes match");
  assert.equal(verify({ rawBody: reserialized }).ok, false);
});

// ── Signature: rejections ───────────────────────────────────────────────────

test("a tampered body is rejected", () => {
  const tampered = BODY.replace("user@example.com", "attacker@evil.com");
  const result = verify({ rawBody: tampered });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_match");
});

test("a signature from the wrong secret is rejected", () => {
  const result = verify({ header: sign(BODY, "whsec_wrong_secret") });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_match");
});

test("re-dating t invalidates the signature rather than extending its life", () => {
  // t is inside the signed string, so moving it alone breaks the hash — this
  // is what stops a captured request being replayed with a fresh timestamp.
  const original = sign(BODY);
  const freshT = Math.floor(NOW / 1000);
  const redated = original.replace(/^t=\d+/, `t=${freshT + 10}`);
  const result = verify({ header: redated });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_match");
});

test("a correctly-signed but stale request is rejected on tolerance", () => {
  const staleT = Math.floor(NOW / 1000) - 6 * 60;
  const result = verify({ header: sign(BODY, SECRET, staleT) });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "timestamp_out_of_tolerance");
});

test("a future-dated request beyond tolerance is rejected too", () => {
  const futureT = Math.floor(NOW / 1000) + 6 * 60;
  const result = verify({ header: sign(BODY, SECRET, futureT) });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "timestamp_out_of_tolerance");
});

test("small clock skew inside the tolerance still verifies", () => {
  for (const offset of [-240, -60, 0, 60, 240]) {
    const t = Math.floor(NOW / 1000) + offset;
    assert.equal(verify({ header: sign(BODY, SECRET, t) }).ok, true, `offset ${offset}s`);
  }
});

test("a missing header is rejected", () => {
  const result = verify({ header: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "missing_header");
});

test("garbled headers are rejected, not thrown on", () => {
  for (const header of [
    "",
    "garbage",
    "v1=abc",                      // no t
    "t=1755264000",                // no v1
    "t=notanumber,v1=abc",
    "t=1755264000,v1=",
    ",,,",
  ]) {
    const result = verify({ header });
    assert.equal(result.ok, false, `accepted ${JSON.stringify(header)}`);
  }
});

test("a non-hex or wrong-length v1 is rejected without throwing", () => {
  const t = Math.floor(NOW / 1000);
  for (const v1 of ["zzzz", "abc", "a".repeat(63), "a".repeat(65)]) {
    assert.equal(verify({ header: `t=${t},v1=${v1}` }).ok, false, `accepted ${v1}`);
  }
});

// ── Signature: secret rotation ──────────────────────────────────────────────

test("any matching v1 element is enough during a rotation", () => {
  const t = Math.floor(NOW / 1000);
  const good = createHmac("sha256", SECRET).update(`${t}.${BODY}`).digest("hex");
  const other = createHmac("sha256", "whsec_old").update(`${t}.${BODY}`).digest("hex");

  assert.equal(verify({ header: `t=${t},v1=${other},v1=${good}` }).ok, true, "match in second position");
  assert.equal(verify({ header: `t=${t},v1=${good},v1=${other}` }).ok, true, "match in first position");
  assert.equal(verify({ header: `t=${t},v1=${other},v1=${other}` }).ok, false, "no element matches");
});

test("the parser keeps every v1 and tolerates spacing", () => {
  const parsed = parseDay3Signature("t=1755264000, v1=aa, v1=bb");
  assert.equal(parsed?.timestamp, 1_755_264_000);
  assert.deepEqual(parsed?.signatures, ["aa", "bb"]);
});

// ── Bounce classification ───────────────────────────────────────────────────

test("only Permanent and Undetermined mean the address is dead", () => {
  assert.equal(isPermanentBounceType("Permanent"), true);
  assert.equal(isPermanentBounceType("Undetermined"), true);
  assert.equal(isPermanentBounceType("permanent"), true, "casing must not matter");
  assert.equal(isPermanentBounceType("Transient"), false);
  assert.equal(isPermanentBounceType(undefined), false);
});

test("a transient bounce never suppresses", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "email.bounced", created_at: "",
    data: { object: "email", email: "user@example.com", bounce_type: "Transient" },
  });
  assert.equal(action.kind, "informational");
});

test("even a permanent bounce is informational — suppression.created is the writer", () => {
  // One writer keeps the handler order-independent: it cannot matter whether
  // `bounced` or `suppression.created` arrives first.
  const action = classifyDay3Event({
    id: "evt_1", type: "email.bounced", created_at: "",
    data: { object: "email", email: "user@example.com", bounce_type: "Permanent" },
  });
  assert.equal(action.kind, "informational");
});

test("a complaint is informational for the same reason", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "email.complained", created_at: "",
    data: { object: "email", email: "user@example.com" },
  });
  assert.equal(action.kind, "informational");
});

// ── Suppression events ──────────────────────────────────────────────────────

test("suppression.created is the one event that writes", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "suppression.created", created_at: "",
    data: { object: "suppression", email: "user@example.com", reason: "hard_bounce" },
  });
  assert.equal(action.kind, "suppress");
  assert.equal(action.kind === "suppress" && action.email, "user@example.com");
  assert.equal(action.kind === "suppress" && action.bounceKind, "permanent");
  assert.match(action.kind === "suppress" ? action.reason : "", /hard_bounce/);
});

test("every documented suppression reason maps to a permanent-ish kind", () => {
  assert.equal(bounceKindForSuppressionReason("hard_bounce"), "permanent");
  assert.equal(bounceKindForSuppressionReason("provider_suppressed"), "permanent");
  assert.equal(bounceKindForSuppressionReason("complaint"), "complaint");
  // A standing decision to stop mailing this address. Transient would resume
  // sending on its own once the backoff expired, which is not what was asked.
  assert.equal(bounceKindForSuppressionReason("unsubscribe"), "permanent");
  assert.equal(bounceKindForSuppressionReason("manual"), "permanent");
});

test("an unknown suppression reason suppresses rather than guessing it was harmless", () => {
  assert.equal(bounceKindForSuppressionReason("some_new_reason_v2"), "permanent");
  assert.equal(bounceKindForSuppressionReason(undefined), "permanent");
});

test("a suppression without an email is ignored, not crashed on", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "suppression.created", created_at: "",
    data: { object: "suppression", reason: "hard_bounce" },
  });
  assert.equal(action.kind, "ignore");
});

// ── Shapes we don't handle ──────────────────────────────────────────────────

test("campaign_recipient events parse and no-op instead of throwing", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "email.delivered", created_at: "",
    data: {
      object: "campaign_recipient",
      campaign_id: "cmp_1", recipient_id: "rcp_1", contact_id: "con_1",
    },
  });
  assert.equal(action.kind, "ignore");
});

test("an unknown event type is ignored rather than misread", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "email.opened", created_at: "",
    data: { object: "email", email: "user@example.com" },
  });
  assert.equal(action.kind, "ignore");
});

test("delivery events fall through to logging with no state invented", () => {
  for (const type of ["email.sent", "email.delivered", "email.failed"]) {
    const action = classifyDay3Event({
      id: "evt_1", type, created_at: "",
      data: { object: "email", email: "user@example.com" },
    });
    assert.equal(action.kind, "informational", type);
  }
});

test("a single-recipient `to` stands in when `email` is absent", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "email.delivered", created_at: "",
    data: { object: "email", to: ["user@example.com"] },
  } as Day3WebhookEvent);
  assert.equal(action.kind === "informational" && action.email, "user@example.com");
});

test("a multi-recipient `to` does not guess which address the event is about", () => {
  const action = classifyDay3Event({
    id: "evt_1", type: "email.delivered", created_at: "",
    data: { object: "email", to: ["a@example.com", "b@example.com"] },
  } as Day3WebhookEvent);
  assert.equal(action.kind === "informational" && action.email, null);
});

test("a malformed body does not throw", () => {
  for (const data of [{}, { object: "email" }, null, undefined]) {
    assert.doesNotThrow(() =>
      classifyDay3Event({ id: "evt_1", type: "email.bounced", created_at: "", data } as Day3WebhookEvent),
    );
  }
});
