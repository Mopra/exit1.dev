// ============================================================================
// RESEND WEBHOOK — bounce/complaint ingestion
//
// Resend signs webhooks with Svix (same as Clerk). We subscribe to
// email.bounced and email.complained, fold each event into the address's
// durable suppression state (emailSuppressions), and — the first time an
// address flips to suppressed — notify the owning user(s) on their account
// email plus an in-app notification, so they can fix or remove the recipient.
//
// Setup: Resend dashboard → Webhooks → add endpoint pointing at this
// function's URL, events: email.bounced, email.complained. Store the signing
// secret via `firebase functions:secrets:set RESEND_WEBHOOK_SECRET`.
// ============================================================================

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { Webhook } from "svix";
import { Resend } from "resend";
import { createClerkClient } from "@clerk/backend";
import { firestore } from "./init";
import {
  RESEND_API_KEY,
  RESEND_FROM,
  RESEND_WEBHOOK_SECRET,
  CLERK_SECRET_KEY_PROD,
  getResendCredentials,
} from "./env";
import { recordEmailBounce, isEmailSuppressedCached } from "./email-suppression";
import { normalizeEmail, type BounceKind, type EmailSuppressionState } from "./email-suppression-policy";

interface ResendWebhookPayload {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: {
      message?: string;
      subType?: string;
      type?: string; // 'Permanent' | 'Transient' | 'Undetermined'
    };
  };
}

const bounceKindFromPayload = (payload: ResendWebhookPayload): BounceKind => {
  if (payload.type === "email.complained") return "complaint";
  const bounceType = payload.data?.bounce?.type?.toLowerCase();
  if (bounceType === "permanent") return "permanent";
  // Transient and Undetermined both get the soft (self-expiring) treatment.
  return "transient";
};

const getRecipients = (payload: ResendWebhookPayload): string[] => {
  const to = payload.data?.to;
  if (Array.isArray(to)) return to.filter((t): t is string => typeof t === "string");
  if (typeof to === "string") return [to];
  return [];
};

// ----------------------------------------------------------------------------
// Owner notification
// ----------------------------------------------------------------------------

/**
 * Find users whose global email-alert recipient list contains this address.
 * Recipients may be stored either bare or as "Display Name <addr>", so match
 * both the raw webhook string and the normalized bare address.
 * Per-check/per-folder-only recipients live inside map fields and cannot be
 * queried; those owners are not notified (the suppression itself still
 * applies) — we log so admins can follow up if it ever matters.
 */
const findOwnersOfRecipient = async (email: string): Promise<string[]> => {
  const candidates = new Set<string>([email.trim(), normalizeEmail(email)]);
  const owners = new Set<string>();

  for (const candidate of candidates) {
    const snap = await firestore
      .collection("emailSettings")
      .where("recipients", "array-contains", candidate)
      .limit(20)
      .get();
    snap.docs.forEach((d) => owners.add(d.id));
  }

  return [...owners];
};

const formatPauseDescription = (state: EmailSuppressionState): string => {
  if (state.permanent) {
    return state.lastBounceKind === "complaint"
      ? "The recipient marked our email as spam, so alerts to this address are paused until you resume them."
      : "The address hard-bounced (it likely doesn't exist), so alerts to it are paused until you resume them.";
  }
  const hours = state.suppressedUntil
    ? Math.max(1, Math.round((state.suppressedUntil - Date.now()) / (60 * 60 * 1000)))
    : 0;
  return `The address bounced — it may be mistyped, so please fix or remove it. Alerts to it are paused for about ${hours} hour${hours === 1 ? "" : "s"}; if it keeps bouncing, each pause gets longer.`;
};

const notifyOwnersOfSuppression = async (
  rawRecipient: string,
  state: EmailSuppressionState
): Promise<void> => {
  const suppressedEmail = normalizeEmail(rawRecipient);
  const owners = await findOwnersOfRecipient(rawRecipient);
  if (owners.length === 0) {
    logger.info("Suppressed address has no queryable owner (per-check/per-folder recipient?)", {
      email: suppressedEmail,
    });
    return;
  }

  const clerkSecretKey = CLERK_SECRET_KEY_PROD.value();
  const clerkClient = clerkSecretKey ? createClerkClient({ secretKey: clerkSecretKey }) : null;
  const { apiKey, fromAddress } = getResendCredentials();
  const resend = apiKey ? new Resend(apiKey) : null;

  const baseUrl = process.env.FRONTEND_URL || "https://app.exit1.dev";
  const emailsUrl = `${baseUrl}/emails`;
  const description = formatPauseDescription(state);
  const title = `Alert emails to ${suppressedEmail} are bouncing`;

  for (const userId of owners) {
    // In-app notification (users read user_notifications live).
    try {
      await firestore.collection("user_notifications").add({
        userId,
        title,
        message: `${description} Manage recipients on the Emails page.`,
        type: "warning",
        createdAt: Date.now(),
        read: false,
        link: "/emails",
      });
    } catch (error) {
      logger.error("Failed to create suppression in-app notification", { userId, error });
    }

    // Email notice to the account's primary (Clerk) address — a known-good
    // mailbox, unless it is itself the suppressed address.
    if (!clerkClient || !resend) continue;
    try {
      const user = await clerkClient.users.getUser(userId);
      const accountEmail =
        user.primaryEmailAddress?.emailAddress || user.emailAddresses[0]?.emailAddress;
      if (!accountEmail) continue;
      if (normalizeEmail(accountEmail) === normalizeEmail(suppressedEmail)) continue;
      if (await isEmailSuppressedCached(accountEmail)) continue;

      const html = `
        <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
          <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
            <h2 style="margin:0 0 8px 0">Alert delivery problem</h2>
            <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2)">
              <p style="margin:0;color:#e2e8f0">Alert emails to <strong>${suppressedEmail}</strong> are bouncing.</p>
            </div>
            <p style="margin:0 0 12px 0;color:#94a3b8">${description}</p>
            <p style="margin:0 0 12px 0;color:#94a3b8">Your checks keep running as normal, and alerts to your other recipients and channels are unaffected.</p>
            <div style="margin:16px 0 0 0;text-align:center">
              <a href="${emailsUrl}" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:12px;font-weight:500">Manage email recipients</a>
            </div>
          </div>
        </div>`;

      await resend.emails.send({
        from: fromAddress,
        to: accountEmail,
        subject: title,
        html,
      });
    } catch (error) {
      logger.error("Failed to send suppression notice email", { userId, error });
    }
  }
};

// ----------------------------------------------------------------------------
// Endpoint
// ----------------------------------------------------------------------------

export const resendWebhook = onRequest({
  secrets: [RESEND_WEBHOOK_SECRET, RESEND_API_KEY, RESEND_FROM, CLERK_SECRET_KEY_PROD],
  cors: false,
}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let webhookSecret: string | undefined;
  try {
    webhookSecret = RESEND_WEBHOOK_SECRET.value()?.trim();
  } catch {
    webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  }
  if (!webhookSecret) {
    logger.error("Resend webhook secret not configured");
    res.status(500).json({ error: "Webhook secret not configured" });
    return;
  }

  const svixId = req.headers["svix-id"] as string;
  const svixTimestamp = req.headers["svix-timestamp"] as string;
  const svixSignature = req.headers["svix-signature"] as string;
  if (!svixId || !svixTimestamp || !svixSignature) {
    logger.warn("Missing Svix headers in Resend webhook");
    res.status(400).json({ error: "Missing webhook signature headers" });
    return;
  }

  let payload: ResendWebhookPayload;
  try {
    const wh = new Webhook(webhookSecret);
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody?.toString() || JSON.stringify(req.body);
    payload = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ResendWebhookPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    logger.error("Resend webhook signature verification failed", { error: message });
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  if (payload.type !== "email.bounced" && payload.type !== "email.complained") {
    res.status(200).json({ received: true, processed: false, reason: "unhandled_type" });
    return;
  }

  const kind = bounceKindFromPayload(payload);
  const reason = payload.data?.bounce?.message || (kind === "complaint" ? "Marked as spam" : null);
  const recipients = getRecipients(payload);

  if (recipients.length === 0) {
    logger.warn("Resend bounce webhook without recipients", { type: payload.type });
    res.status(200).json({ received: true, processed: false, reason: "no_recipients" });
    return;
  }

  for (const recipient of recipients) {
    try {
      const { state, becameSuppressed } = await recordEmailBounce(recipient, kind, reason);
      logger.info("Recorded email bounce", {
        email: normalizeEmail(recipient),
        kind,
        totalBounces: state.totalBounces,
        transientCount: state.transientCount,
        permanent: state.permanent,
        suppressedUntil: state.suppressedUntil,
        becameSuppressed,
      });

      if (becameSuppressed) {
        await notifyOwnersOfSuppression(recipient, state);
      }
    } catch (error) {
      // Log and continue — never 500 back to Resend for a single bad recipient,
      // or the whole event gets retried and double-counts the others.
      logger.error("Failed to process bounce for recipient", { recipient, error });
    }
  }

  res.status(200).json({ received: true, processed: true });
});
