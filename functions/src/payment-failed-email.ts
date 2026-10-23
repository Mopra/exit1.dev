/**
 * Our own email for a failed renewal charge. Clerk's billing_failed_payment
 * template is read-only and has no way to update the card, so the customer
 * learns the charge failed but not where to fix it. This one links straight to
 * the card tab of the billing page.
 *
 * Pure and firestore-free so the copy and the send rule are unit-tested
 * (__tests__/payment-failed-email.test.ts).
 */

export const UPDATE_CARD_URL = "https://app.exit1.dev/billing?tab=payment-methods";

/** The parts of Clerk's paymentAttempt.* webhook payload this email reads. */
export interface PaymentAttemptPayload {
  id?: string;
  status?: string;
  charge_type?: string;
  failed_reason?: { code?: string; decline_code?: string } | null;
  payer?: {
    user_id?: string;
    email?: string;
    first_name?: string;
    organization_id?: string;
    organization_name?: string;
  } | null;
  totals?: { grand_total?: { amount_formatted?: string; currency_symbol?: string } } | null;
  payment_source?: { card_type?: string; last4?: string } | null;
  subscription_items?: Array<{ plan?: { name?: string } | null }> | null;
}

/**
 * Only a failed renewal gets the email. A failed checkout happens while the
 * customer is on the page and sees the error there.
 */
export function shouldSendPaymentFailedEmail(type: string, a: PaymentAttemptPayload): boolean {
  if (type !== "paymentAttempt.created" && type !== "paymentAttempt.updated") return false;
  return a.status === "failed" && a.charge_type === "recurring" && typeof a.id === "string";
}

const DECLINE_REASONS: Record<string, string> = {
  insufficient_funds: "the bank declined it for insufficient funds",
  expired_card: "the card has expired",
  card_expired: "the card has expired",
  lost_card: "the card was reported lost",
  stolen_card: "the card was reported stolen",
  do_not_honor: "the bank declined it",
  generic_decline: "the bank declined it",
  card_declined: "the bank declined it",
  authentication_required: "the bank asked for authentication",
};

export function declineReason(r: PaymentAttemptPayload["failed_reason"]): string | null {
  if (!r) return null;
  return DECLINE_REASONS[r.decline_code ?? ""] ?? DECLINE_REASONS[r.code ?? ""] ?? null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function buildPaymentFailedEmail(opts: {
  firstName: string | null;
  attempt: PaymentAttemptPayload;
}): { subject: string; text: string } {
  const a = opts.attempt;
  const name = opts.firstName?.trim();
  const plan = a.subscription_items?.find((i) => i.plan?.name)?.plan?.name ?? null;
  const g = a.totals?.grand_total;
  const amount = g?.amount_formatted
    ? `${g.currency_symbol ?? ""}${g.amount_formatted}`
    : null;
  const card = a.payment_source?.last4
    ? `${a.payment_source.card_type ? capitalize(a.payment_source.card_type) : "card"} ending ${a.payment_source.last4}`
    : null;
  const reason = declineReason(a.failed_reason);
  const org = a.payer?.organization_name?.trim();

  const what = [
    "The",
    amount ? `${amount} renewal` : "renewal",
    "for",
    org ? `${org}'s exit1` : "your exit1",
    plan ? `${plan} plan` : "plan",
    "did not go through",
  ].join(" ");
  const why = card && reason ? ` on the ${card}: ${reason}.`
    : card ? ` on the ${card}.`
    : reason ? `: ${reason}.`
    : ".";

  const text = [
    name ? `Hi ${name},` : "Hi,",
    "",
    `${what}${why}`,
    "",
    "We will try the card again automatically. To use a different card, update it here:",
    UPDATE_CARD_URL,
    "",
    "If you meant to stop, or something looks wrong, just reply. This comes straight to me.",
    "",
    "Morten",
    "exit1.dev",
  ].join("\n");

  return { subject: "Your exit1 payment did not go through", text };
}
