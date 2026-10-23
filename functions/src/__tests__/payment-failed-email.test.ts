import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPaymentFailedEmail,
  declineReason,
  shouldSendPaymentFailedEmail,
  UPDATE_CARD_URL,
  type PaymentAttemptPayload,
} from "../payment-failed-email";

const failedRenewal: PaymentAttemptPayload = {
  id: "pa_1",
  status: "failed",
  charge_type: "recurring",
  failed_reason: { code: "card_declined", decline_code: "insufficient_funds" },
  payer: { user_id: "user_1", email: "a@example.com", first_name: "Sam" },
  totals: { grand_total: { amount_formatted: "9.00", currency_symbol: "$" } },
  payment_source: { card_type: "visa", last4: "4242" },
  subscription_items: [{ plan: { name: "Nano" } }],
};

test("sends only for a failed renewal", () => {
  assert.equal(shouldSendPaymentFailedEmail("paymentAttempt.updated", failedRenewal), true);
  assert.equal(shouldSendPaymentFailedEmail("paymentAttempt.created", failedRenewal), true);
  assert.equal(shouldSendPaymentFailedEmail("paymentAttempt.updated", { ...failedRenewal, charge_type: "checkout" }), false);
  assert.equal(shouldSendPaymentFailedEmail("paymentAttempt.updated", { ...failedRenewal, status: "paid" }), false);
  assert.equal(shouldSendPaymentFailedEmail("paymentAttempt.updated", { ...failedRenewal, id: undefined }), false);
  assert.equal(shouldSendPaymentFailedEmail("subscription.pastDue", failedRenewal), false);
});

test("decline reason prefers decline_code and knows nothing it was not told", () => {
  assert.equal(declineReason(failedRenewal.failed_reason), "the bank declined it for insufficient funds");
  assert.equal(declineReason({ code: "something_new" }), null);
  assert.equal(declineReason(null), null);
});

test("email names amount, plan, card and reason, and links to the card tab", () => {
  const { subject, text } = buildPaymentFailedEmail({ firstName: "Sam", attempt: failedRenewal });
  assert.equal(subject, "Your exit1 payment did not go through");
  assert.match(text, /^Hi Sam,/);
  assert.match(text, /The \$9\.00 renewal for your exit1 Nano plan did not go through on the Visa ending 4242: the bank declined it for insufficient funds\./);
  assert.ok(text.includes(UPDATE_CARD_URL));
  assert.ok(UPDATE_CARD_URL.endsWith("?tab=payment-methods"));
});

test("email reads well with nothing but the failure", () => {
  const { text } = buildPaymentFailedEmail({ firstName: null, attempt: { id: "pa_2", status: "failed", charge_type: "recurring" } });
  assert.match(text, /^Hi,/);
  assert.match(text, /The renewal for your exit1 plan did not go through\./);
});

test("an organization payer is named", () => {
  const { text } = buildPaymentFailedEmail({
    firstName: "Sam",
    attempt: { ...failedRenewal, payer: { ...failedRenewal.payer, organization_name: "Acme" } },
  });
  assert.match(text, /for Acme's exit1 Nano plan/);
});
