import test from "node:test";
import assert from "node:assert/strict";

import { isSmsDestinationAllowed } from "../sms-countries";

test("allows US, Canada and Europe", () => {
  for (const n of ["+16505550122", "+16475550112", "+4520123456", "+48691234520", "+447700900123", "+33612345678", "+41791234567"]) {
    assert.equal(isSmsDestinationAllowed(n), true, n);
  }
});

test("blocks costly destinations", () => {
  for (const n of ["+27821234525", "+61412345678", "+919812345678", "+5511912345678", "+81701234509", "+32470123456"]) {
    assert.equal(isSmsDestinationAllowed(n), false, n);
  }
});

test("blocks Caribbean numbers that share +1", () => {
  assert.equal(isSmsDestinationAllowed("+18765551234"), false);
  assert.equal(isSmsDestinationAllowed("+18095551234"), false);
});
