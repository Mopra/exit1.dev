import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEmail,
  decideConfirmSend,
  normalizeEmailSendWindow,
  isConfirmTokenExpired,
  MAX_CONFIRM_SENDS_PER_EMAIL,
  CONFIRM_SEND_WINDOW_MS,
  CONFIRM_TOKEN_TTL_MS,
} from "../public-email-follow-policy";

const NOW = 1_800_000_000_000;

test("emails are trimmed and lowercased", () => {
  assert.equal(normalizeEmail("  Dev@Example.COM "), "dev@example.com");
});

test("garbage is rejected", () => {
  for (const bad of ["", "nope", "a@b", "a b@c.dev", "<x>@y.dev", "a@b.c", 42, null, undefined, `${"a".repeat(250)}@b.dev`]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});

test("plus addressing and subdomains pass", () => {
  assert.equal(normalizeEmail("me+pecl@mail.example.co.uk"), "me+pecl@mail.example.co.uk");
});

test("first confirmation send opens a window", () => {
  assert.deepEqual(decideConfirmSend(null, NOW), { allowed: true, next: { windowStart: NOW, count: 1 } });
});

test("sends inside the window count up to the cap, then stop", () => {
  let window = { windowStart: NOW, count: 1 };
  for (let i = 2; i <= MAX_CONFIRM_SENDS_PER_EMAIL; i++) {
    const d = decideConfirmSend(window, NOW + i);
    assert.equal(d.allowed, true);
    if (d.allowed) window = d.next;
  }
  assert.equal(window.count, MAX_CONFIRM_SENDS_PER_EMAIL);
  assert.deepEqual(decideConfirmSend(window, NOW + 1000), { allowed: false });
});

test("an expired window resets the count", () => {
  const window = { windowStart: NOW, count: MAX_CONFIRM_SENDS_PER_EMAIL };
  const later = NOW + CONFIRM_SEND_WINDOW_MS;
  assert.deepEqual(decideConfirmSend(window, later), { allowed: true, next: { windowStart: later, count: 1 } });
});

test("a malformed stored window is treated as none", () => {
  assert.equal(normalizeEmailSendWindow({ windowStart: "x", count: 1 }), null);
  assert.equal(normalizeEmailSendWindow(undefined), null);
  assert.deepEqual(normalizeEmailSendWindow({ windowStart: NOW, count: 2 }), { windowStart: NOW, count: 2 });
});

test("confirm tokens expire after the TTL", () => {
  assert.equal(isConfirmTokenExpired(NOW, NOW + CONFIRM_TOKEN_TTL_MS), false);
  assert.equal(isConfirmTokenExpired(NOW, NOW + CONFIRM_TOKEN_TTL_MS + 1), true);
});
