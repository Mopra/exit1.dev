// Unsubscribe links for SLA report emails: an HMAC over the report id and the
// normalized recipient, so a link only ever unsubscribes the address it was
// sent to. Pure (the secret is passed in) so it can be unit-tested.

import { createHmac, timingSafeEqual } from "crypto";
import { normalizeEmail } from "./email-suppression-policy";

export const SLA_UNSUBSCRIBE_BASE_URL = "https://us-central1-exit1-dev.cloudfunctions.net/slaReportUnsubscribe";

export function signSlaUnsubscribe(secret: string, reportId: string, email: string): string {
  return createHmac("sha256", secret)
    .update(`sla-unsubscribe\n${reportId}\n${normalizeEmail(email)}`)
    .digest("base64url")
    .slice(0, 32);
}

export function verifySlaUnsubscribe(secret: string, reportId: string, email: string, token: unknown): boolean {
  if (typeof token !== "string" || token.length !== 32) return false;
  const expected = Buffer.from(signSlaUnsubscribe(secret, reportId, email));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function slaUnsubscribeUrl(secret: string, reportId: string, email: string, base = SLA_UNSUBSCRIBE_BASE_URL): string {
  const url = new URL(base);
  url.searchParams.set("r", reportId);
  url.searchParams.set("e", normalizeEmail(email));
  url.searchParams.set("t", signSlaUnsubscribe(secret, reportId, email));
  return url.toString();
}
