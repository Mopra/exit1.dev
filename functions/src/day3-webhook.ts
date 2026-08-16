// ============================================================================
// DAY3 WEBHOOK ENDPOINT
//
// Receives delivery events from Day3 (email.sent/delivered/bounced/complained/
// failed, suppression.created) and feeds `emailSuppressions` — the same store
// the Resend webhook writes to, not a parallel system.
//
// Shape mirrors resend-webhook.ts: onRequest with cors:false, signature
// verified against the RAW body, 401 on failure, never process an unverified
// payload. The difference is that this one enqueues instead of processing
// inline — see day3-webhook-queue.ts for why.
//
// Registration: created by hand in the Day3 dashboard (API keys → Webhooks),
// pointing at this function's URL. The `whsec_…` it returns goes into Secret
// Manager as DAY3_WEBHOOK_SECRET.
// ============================================================================

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { DAY3_WEBHOOK_SECRET } from "./env";
import { verifyDay3Signature, type Day3WebhookEvent } from "./day3-webhook-policy";
import { enqueueDay3Event } from "./day3-webhook-queue";

const getWebhookSecret = (): string | undefined => {
  try {
    return DAY3_WEBHOOK_SECRET.value()?.trim() || undefined;
  } catch {
    return process.env.DAY3_WEBHOOK_SECRET?.trim() || undefined;
  }
};

const readHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export const day3Webhook = onRequest({
  secrets: [DAY3_WEBHOOK_SECRET],
  cors: false,
}, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secret = getWebhookSecret();
  if (!secret) {
    // 500 rather than 401: this is our misconfiguration, and a 5xx makes Day3
    // retry over the next ~8h, which is exactly the window in which we'd want
    // to fix the secret and still keep the events.
    logger.error("Day3 webhook secret not configured");
    res.status(500).json({ error: "Webhook secret not configured" });
    return;
  }

  // The signed string is `${t}.${rawBody}`, so this must be the exact bytes
  // Day3 sent. req.body is the framework's re-parse and would not match.
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8");
  if (!rawBody) {
    logger.error("Day3 webhook received without a raw body — cannot verify");
    res.status(400).json({ error: "Missing request body" });
    return;
  }

  const verification = verifyDay3Signature({
    header: readHeader(req.headers["day3-signature"]),
    rawBody,
    secret,
    nowMs: Date.now(),
  });

  if (!verification.ok) {
    logger.warn("Day3 webhook signature rejected", {
      reason: verification.reason,
      eventId: readHeader(req.headers["day3-event-id"]) ?? null,
      eventType: readHeader(req.headers["day3-event-type"]) ?? null,
    });
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  let event: Day3WebhookEvent;
  try {
    event = JSON.parse(rawBody) as Day3WebhookEvent;
  } catch {
    logger.error("Day3 webhook body passed verification but is not JSON");
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }

  // Prefer the body's id; the header is a convenience copy of it. Falling back
  // keeps a body without an id from silently bypassing dedupe.
  const eventId = event?.id || readHeader(req.headers["day3-event-id"]);
  if (!eventId || !event?.type) {
    logger.warn("Day3 webhook event missing id or type", { eventId: eventId ?? null });
    res.status(400).json({ error: "Event is missing id or type" });
    return;
  }
  event.id = eventId;

  const attemptHeader = readHeader(req.headers["day3-delivery-attempt"]);
  const deliveryAttempt = attemptHeader && /^\d+$/.test(attemptHeader)
    ? Number(attemptHeader)
    : null;

  try {
    const outcome = await enqueueDay3Event({
      event,
      deliveryAttempt,
      now: Date.now(),
    });

    if (outcome === "duplicate") {
      // At-least-once delivery makes this ordinary traffic, not an error.
      logger.debug("Day3 webhook event already seen — no-op", {
        eventId,
        type: event.type,
        deliveryAttempt,
      });
      res.status(200).json({ received: true, queued: false, reason: "duplicate" });
      return;
    }

    logger.info("Day3 webhook event queued", { eventId, type: event.type, deliveryAttempt });
    res.status(200).json({ received: true, queued: true });
  } catch (error) {
    // A 5xx here is the right answer: the event is not persisted, and Day3's
    // retry schedule is our recovery path.
    logger.error("Failed to enqueue Day3 webhook event", {
      eventId,
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: "Failed to enqueue event" });
  }
});
