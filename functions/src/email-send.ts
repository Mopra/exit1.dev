// ============================================================================
// TRANSACTIONAL EMAIL SEAM
//
// Every transactional email in this codebase goes out through this module, so
// the provider behind it is one Firestore flag rather than fifteen edits. See
// email-provider-settings.ts for the flag and how categories ramp.
//
// Imported by alert-email.ts, which runs inside the VPS runner — no Cloud
// Function definitions here.
//
// Two behaviours that did not exist before this module and are worth knowing:
//
//  1. It throws when a send fails. The Resend SDK reports failures in
//     `response.error` rather than by throwing, and eight of the alert send
//     sites never looked at that field, so a Resend-side rejection read as a
//     success — invisible in logs and invisible to the delivery-failure
//     tracker. Sending through here means those finally register (as a
//     failure, backoff, and eventually a drop, which is what the tracker is
//     for). Expect a small number of previously-silent failures to appear in
//     logs the first time this deploys. That is the bug surfacing, not a
//     regression.
//
//  2. A failed Day3 send retries through Resend before giving up (while
//     `fallbackToResend` is on). One-directional on purpose: Resend never
//     fails over to Day3, because Day3 may not have the sending domain
//     verified and a "fallback" onto an unverified domain would turn a
//     deliverable failure into a hard rejection. Resend is the floor.
// ============================================================================

import * as logger from "firebase-functions/logger";
import { getResendCredentials, getDay3EmailCredentials } from "./env";
import { getResendClient, emitAlertMetric } from "./alert-helpers";
import { sendDay3Email, DAY3_EMAIL_SUPPRESSED } from "./day3-email";
import {
  getEmailProviderSettings,
  resolveProvider,
  type EmailCategory,
  type EmailProvider,
} from "./email-provider-settings";

export type { EmailCategory, EmailProvider };

export interface TransactionalEmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  /** Decides how far along the migration ramp this message rides. */
  category: EmailCategory;
  /** Extra fields for the log line — check id, user id, event type. */
  meta?: Record<string, unknown>;
}

export interface TransactionalSendResult {
  /** The provider that actually accepted the message. */
  provider: EmailProvider;
  /** Provider-side message id, when it returns one. */
  id: string | null;
  /** True when the primary provider failed and the fallback carried it. */
  fellBack: boolean;
}

export class TransactionalEmailError extends Error {
  readonly provider: EmailProvider;
  readonly code: string;

  constructor(provider: EmailProvider, code: string, message: string) {
    super(`[${provider}] ${code}: ${message}`);
    this.name = "TransactionalEmailError";
    this.provider = provider;
    this.code = code;
  }
}

// ----------------------------------------------------------------------------
// Provider adapters — each either resolves with a message id or throws.
// ----------------------------------------------------------------------------

async function sendViaResend(input: TransactionalEmailInput): Promise<string | null> {
  const { resend, fromAddress } = getResendClient();

  // The SDK's union types reject `html: string | undefined`, so the two body
  // shapes are built separately rather than with a spread.
  const response = input.html
    ? await resend.emails.send({
        from: fromAddress,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      })
    : await resend.emails.send({
        from: fromAddress,
        to: input.to,
        subject: input.subject,
        text: input.text ?? "",
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });

  if (response.error) {
    throw new TransactionalEmailError(
      "resend",
      response.error.name || "resend_error",
      response.error.message || "Resend rejected the message",
    );
  }
  return response.data?.id ?? null;
}

async function sendViaDay3(input: TransactionalEmailInput): Promise<string | null> {
  const { apiKey, fromAddress } = getDay3EmailCredentials();
  if (!apiKey) {
    throw new TransactionalEmailError("day3", "not_configured", "DAY3_API_KEY is not configured");
  }

  const result = await sendDay3Email(apiKey, {
    from: fromAddress,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
  });

  if (!result.ok) {
    const code = result.error?.code ?? "unknown_error";
    // Day3 v1 has no webhooks, so a synchronous suppression rejection is the
    // only bounce signal it ever gives us. Deliberately NOT written into
    // `emailSuppressions`: that store is shared with Resend and its permanent
    // state is only cleared by hand, so importing another provider's
    // suppression verdict could silently kill a paying customer's alerts on
    // both providers at once. Surfaced as its own metric instead so the gap is
    // measurable while it stays a review decision rather than an automatic one.
    if (code === DAY3_EMAIL_SUPPRESSED) {
      emitAlertMetric("email_day3_suppressed", { to: input.to, category: input.category });
    }
    throw new TransactionalEmailError("day3", code, result.error?.message ?? "Day3 send failed");
  }
  return result.id;
}

const send = (provider: EmailProvider, input: TransactionalEmailInput) =>
  provider === "day3" ? sendViaDay3(input) : sendViaResend(input);

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

/**
 * Deliver one transactional email through whichever provider the flag selects.
 * Throws `TransactionalEmailError` when every attempted provider failed.
 */
export async function sendTransactionalEmail(
  input: TransactionalEmailInput,
): Promise<TransactionalSendResult> {
  if (!input.html && !input.text) {
    throw new TransactionalEmailError("resend", "empty_body", "Message has neither html nor text");
  }

  const settings = await getEmailProviderSettings();
  const primary = resolveProvider(settings, input.category, input.to);

  try {
    const id = await send(primary, input);
    emitAlertMetric("email_provider_send", {
      provider: primary,
      category: input.category,
      ...input.meta,
    });
    return { provider: primary, id, fellBack: false };
  } catch (primaryError) {
    const canFallBack = primary === "day3" && settings.fallbackToResend;
    if (!canFallBack) {
      emitAlertMetric("email_provider_failed", {
        provider: primary,
        category: input.category,
        ...input.meta,
      });
      throw primaryError;
    }

    logger.warn("Day3 send failed — falling back to Resend", {
      to: input.to,
      category: input.category,
      error: primaryError instanceof Error ? primaryError.message : String(primaryError),
      ...input.meta,
    });

    try {
      const id = await sendViaResend(input);
      emitAlertMetric("email_provider_fallback", {
        from: "day3",
        to: "resend",
        category: input.category,
        ...input.meta,
      });
      return { provider: "resend", id, fellBack: true };
    } catch (fallbackError) {
      emitAlertMetric("email_provider_failed", {
        provider: "day3+resend",
        category: input.category,
        ...input.meta,
      });
      // Surface the fallback's error: it is the one that decided the outcome,
      // and the Day3 failure is already in the warn above.
      throw fallbackError;
    }
  }
}

/**
 * True when at least one provider could send right now. Used by the callables
 * that pre-flight configuration before building a message.
 */
export function isTransactionalEmailConfigured(): boolean {
  return Boolean(getResendCredentials().apiKey || getDay3EmailCredentials().apiKey);
}
