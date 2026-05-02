/**
 * Anderro affiliate-tracking integration. Two-week trial — wired up so we can
 * remove it cleanly if the trial doesn't renew. Touches:
 *   - frontend snippet (index.html)
 *   - this module (signup callable + payment helper)
 *   - clerk-webhook.ts (calls firePaymentEvent on tier transitions to paid)
 *
 * The `visitorId` cookie set by the frontend snippet is what links a signup
 * back to the affiliate click. We do not persist it — the frontend reads it
 * via window.anderro.getVisitorId() and forwards it to the callable.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createClerkClient } from "@clerk/backend";
import {
  ANDERRO_SECRET_KEY,
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
} from "./env";

const ANDERRO_EVENTS_URL = "https://track.anderro.com/events";

// Monthly cents per Clerk plan slug. Annual prepayments under-report against
// these values (we'd need to read planPeriod off the Clerk subscription to
// distinguish monthly vs annual). Acceptable for the trial — initial-signup
// attribution is the primary goal; refine before renewing if needed.
const PLAN_KEY_TO_AMOUNT_CENTS: Record<string, number> = {
  nano: 900,    // legacy founders → still pay nano monthly price
  nanov2: 900,
  starter: 900, // legacy
  pro: 2400,
  agency: 4900,
  scale: 4900,  // legacy
};

const getAnderroSecret = (): string | null => {
  try {
    const v = ANDERRO_SECRET_KEY.value()?.trim();
    if (v) return v;
  } catch {
    // Not bound — fall through to env.
  }
  return process.env.ANDERRO_SECRET_KEY?.trim() || null;
};

interface AnderroSignupEvent {
  type: "signup";
  customerEmail: string;
  visitorId: string;
}

interface AnderroPaymentEvent {
  type: "payment";
  customerEmail: string;
  amountCents: number;
}

async function postEvent(
  body: AnderroSignupEvent | AnderroPaymentEvent,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const secret = getAnderroSecret();
  if (!secret) {
    return { ok: false, error: "ANDERRO_SECRET_KEY not configured" };
  }

  try {
    const res = await fetch(ANDERRO_EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": secret,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text || `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Try prod Clerk first, fall back to dev — mirrors the pattern used in
// onboarding.ts for users who live in either Clerk instance.
async function fetchUserEmail(uid: string): Promise<{
  email: string | null;
  publicMetadata: Record<string, unknown> | null;
  instance: "prod" | "dev" | null;
  secretKey: string | null;
}> {
  const candidates: Array<{ instance: "prod" | "dev"; secret: string }> = [];
  try {
    const v = CLERK_SECRET_KEY_PROD.value()?.trim();
    if (v) candidates.push({ instance: "prod", secret: v });
  } catch { /* noop */ }
  try {
    const v = CLERK_SECRET_KEY_DEV.value()?.trim();
    if (v) candidates.push({ instance: "dev", secret: v });
  } catch { /* noop */ }

  for (const { instance, secret } of candidates) {
    try {
      const client = createClerkClient({ secretKey: secret });
      const user = await client.users.getUser(uid);
      const primary = user.emailAddresses?.find(
        (e) => e.id === user.primaryEmailAddressId,
      ) ?? user.emailAddresses?.[0];
      const email = primary?.emailAddress ?? null;
      return {
        email,
        publicMetadata: (user.publicMetadata as Record<string, unknown>) ?? {},
        instance,
        secretKey: secret,
      };
    } catch {
      // 404 → user lives in the other instance; try next.
    }
  }

  return { email: null, publicMetadata: null, instance: null, secretKey: null };
}

/**
 * Idempotent signup tracker. Frontend (Onboarding) calls this once after
 * sign-up with the visitorId pulled from window.anderro.getVisitorId().
 * We stamp `anderroSignupTracked` on Clerk publicMetadata so a refresh /
 * revisit / re-sign-in can't double-fire.
 */
export const trackAnderroSignup = onCall(
  {
    cors: true,
    secrets: [ANDERRO_SECRET_KEY, CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const data = (request.data ?? {}) as { visitorId?: unknown };
    const visitorIdRaw = typeof data.visitorId === "string" ? data.visitorId.trim() : "";
    if (!visitorIdRaw) {
      // No visitor cookie usually means the user came directly without an
      // affiliate link. Nothing to attribute — skip silently.
      return { tracked: false, reason: "no_visitor_id" };
    }

    const { email, publicMetadata, instance, secretKey } = await fetchUserEmail(uid);
    if (!email || !secretKey || !instance) {
      logger.warn("trackAnderroSignup: could not resolve email", { uid });
      return { tracked: false, reason: "no_email" };
    }

    if (publicMetadata?.anderroSignupTracked) {
      return { tracked: false, reason: "already_tracked" };
    }

    const result = await postEvent({
      type: "signup",
      customerEmail: email,
      visitorId: visitorIdRaw,
    });

    if (!result.ok) {
      logger.warn("trackAnderroSignup: Anderro POST failed", {
        uid,
        email,
        status: result.status,
        error: result.error,
      });
      return { tracked: false, reason: "anderro_error" };
    }

    // Stamp the marker so we don't re-fire. Best-effort — if this fails the
    // worst case is a duplicate signup event next time the user lands on
    // onboarding, which Anderro can dedupe by email.
    try {
      const client = createClerkClient({ secretKey });
      await client.users.updateUserMetadata(uid, {
        publicMetadata: { anderroSignupTracked: Date.now() },
      });
    } catch (e) {
      logger.warn("trackAnderroSignup: failed to stamp metadata", {
        uid,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    logger.info("trackAnderroSignup: signup event sent", { uid, email });
    return { tracked: true };
  },
);

/**
 * Best-effort payment-event sender called from the Clerk subscription webhook
 * after a tier transition into a paid plan. Never throws — we don't want
 * Anderro outages to fail tier sync.
 *
 * `planKey` should be the Clerk plan slug (e.g. "nanov2", "pro", "agency").
 * Amount is looked up from PLAN_KEY_TO_AMOUNT_CENTS; unknown slugs are skipped.
 */
export async function firePaymentEvent(args: {
  uid: string;
  planKey: string | null;
}): Promise<void> {
  const { uid, planKey } = args;
  if (!planKey) {
    logger.debug("firePaymentEvent: no planKey, skipping", { uid });
    return;
  }

  const amountCents = PLAN_KEY_TO_AMOUNT_CENTS[planKey];
  if (!amountCents || amountCents <= 0) {
    logger.debug("firePaymentEvent: unknown planKey, skipping", { uid, planKey });
    return;
  }

  const { email } = await fetchUserEmail(uid);
  if (!email) {
    logger.warn("firePaymentEvent: no email resolvable, skipping", { uid });
    return;
  }

  const result = await postEvent({
    type: "payment",
    customerEmail: email,
    amountCents,
  });

  if (!result.ok) {
    logger.warn("firePaymentEvent: Anderro POST failed", {
      uid,
      email,
      planKey,
      amountCents,
      status: result.status,
      error: result.error,
    });
    return;
  }

  logger.info("firePaymentEvent: payment event sent", {
    uid,
    email,
    planKey,
    amountCents,
  });
}
