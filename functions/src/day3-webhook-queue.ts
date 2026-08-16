// ============================================================================
// DAY3 WEBHOOK QUEUE (Firestore: day3WebhookEvents)
//
// The endpoint verifies, claims, persists and returns 2xx; this module does
// the actual work later. Day3 times out at 10s and retries a non-2xx seven
// times over ~8 hours before dropping the event for good, so the receiver must
// never do a Clerk lookup or send an email on the request path.
//
// One collection does double duty as the dedupe ledger and the work queue: the
// doc id IS the Day3 event id, so a transactional create both claims the event
// and rejects the replay. Two collections would need the two writes to stay in
// sync; one cannot drift.
//
// Imported by the runner's drain timer, so no Cloud Function definitions here.
// ============================================================================

import { Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { recordEmailBounce } from "./email-suppression";
import { normalizeEmail } from "./email-suppression-policy";
import { classifyDay3Event, type Day3WebhookEvent } from "./day3-webhook-policy";

const COLLECTION = "day3WebhookEvents";

// Day3 gives up retrying after ~8h. Two days of history is plenty to absorb a
// duplicate and still short enough that the collection stays small.
//
// NOTE: the TTL policy on `expireAt` must be created in the GCP console for
// this collection — Firestore TTL is not declared in firestore.indexes.json.
// Without it the docs simply accumulate; nothing breaks, but nothing is
// reclaimed either.
export const DAY3_EVENT_TTL_MS = 2 * 24 * 60 * 60 * 1000;

/** How long a claimed-but-unfinished doc may sit before another drain retries it. */
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

const DRAIN_BATCH_SIZE = 50;
const DRAIN_MIN_INTERVAL_MS = 10_000;

type EventStatus = "queued" | "processing" | "done" | "failed";

export interface Day3EventRecord {
  eventId: string;
  type: string;
  status: EventStatus;
  /** The verified payload, stored whole so a drain-side bug can be replayed. */
  payload: Day3WebhookEvent;
  receivedAt: number;
  deliveryAttempt: number | null;
  claimedAt?: number;
  processedAt?: number;
  attempts: number;
  lastError?: string | null;
  expireAt: Timestamp;
}

// ----------------------------------------------------------------------------
// Enqueue (request path — must stay fast)
// ----------------------------------------------------------------------------

export type EnqueueOutcome = "queued" | "duplicate";

/**
 * The claim-and-persist step, injectable as a unit. It has to stay one
 * operation rather than a get/create pair on an interface, because its whole
 * job is atomicity: two concurrent deliveries of the same id race on the same
 * doc and exactly one must win.
 */
export type ClaimEventFn = (
  eventId: string,
  record: Day3EventRecord,
) => Promise<EnqueueOutcome>;

export function buildEventRecord(input: {
  event: Day3WebhookEvent;
  deliveryAttempt: number | null;
  now: number;
}): Day3EventRecord {
  return {
    eventId: input.event.id,
    type: input.event.type,
    status: "queued",
    payload: input.event,
    receivedAt: input.now,
    deliveryAttempt: input.deliveryAttempt,
    attempts: 0,
    lastError: null,
    expireAt: Timestamp.fromMillis(input.now + DAY3_EVENT_TTL_MS),
  };
}

const claimViaFirestore: ClaimEventFn = async (eventId, record) => {
  // Doc id IS the event id, which is what makes the create both the dedupe
  // check and the claim.
  const docRef = firestore.collection(COLLECTION).doc(encodeURIComponent(eventId));
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (snap.exists) return "duplicate" as const;
    tx.set(docRef, record);
    return "queued" as const;
  });
};

/**
 * Claim an event id and persist the payload. Returns "duplicate" when this id
 * has been seen before — delivery is at-least-once, so that is expected
 * traffic, not an error.
 *
 * Note what this does NOT do: apply the event. The request path stops here so
 * Day3 gets its 2xx well inside the 10s budget.
 */
export async function enqueueDay3Event(
  input: {
    event: Day3WebhookEvent;
    deliveryAttempt: number | null;
    now: number;
  },
  claim: ClaimEventFn = claimViaFirestore,
): Promise<EnqueueOutcome> {
  return claim(input.event.id, buildEventRecord(input));
}

// ----------------------------------------------------------------------------
// Drain (background)
// ----------------------------------------------------------------------------

/**
 * The one side effect this module has. Injectable so the queue's behaviour can
 * be tested without Firestore — every test in this repo is pure-logic, and
 * standing up an emulator for two assertions would be worse than this seam.
 */
export type RecordBounceFn = typeof recordEmailBounce;

/**
 * Decide whether this drain may take the doc. Pure, so the two-region race is
 * testable: a doc already claimed by the other runner must be skipped, and one
 * whose claim has gone stale must be reclaimable.
 */
export function isClaimable(
  data: Pick<Day3EventRecord, "status" | "claimedAt">,
  now: number,
  leaseMs: number = PROCESSING_LEASE_MS,
): boolean {
  if (data.status === "queued") return true;
  if (data.status === "processing") return (data.claimedAt ?? 0) <= now - leaseMs;
  return false;
}

/**
 * Apply one event. Only `suppression.created` writes — see classifyDay3Event
 * for why bounces and complaints are informational.
 */
export async function applyDay3Event(
  record: Day3EventRecord,
  recordBounce: RecordBounceFn = recordEmailBounce,
): Promise<void> {
  const action = classifyDay3Event(record.payload);

  switch (action.kind) {
    case "suppress": {
      const { state, becameSuppressed } = await recordBounce(
        action.email,
        action.bounceKind,
        action.reason,
      );
      logger.info("Day3 suppression recorded", {
        eventId: record.eventId,
        email: normalizeEmail(action.email),
        bounceKind: action.bounceKind,
        permanent: state.permanent,
        suppressedUntil: state.suppressedUntil,
        totalBounces: state.totalBounces,
        becameSuppressed,
      });
      // Deliberately no owner-notification email here. The Resend path sends
      // one from resend-webhook.ts, and Day3 emits `suppression.created`
      // alongside the bounce that Resend would also report — wiring both would
      // mail the user twice for one dead address. Revisit when Resend stops
      // carrying alert traffic.
      break;
    }

    case "informational":
      logger.info("Day3 email event", {
        eventId: record.eventId,
        type: record.type,
        email: action.email ? normalizeEmail(action.email) : null,
        note: action.note,
      });
      break;

    case "ignore":
      logger.debug("Day3 event ignored", {
        eventId: record.eventId,
        type: record.type,
        note: action.note,
      });
      break;
  }
}

let isDraining = false;
let lastDrainAt = 0;

/**
 * Process queued events. Safe to call from both VPS regions concurrently: each
 * doc is claimed in a transaction, so only one drain gets it. A claim older
 * than PROCESSING_LEASE_MS is reclaimable, which is what recovers events
 * stranded by a runner that died mid-process.
 *
 * Returns the number of events processed, for the runner's /health snapshot.
 */
export async function drainDay3WebhookEvents(options?: { force?: boolean }): Promise<number> {
  const now = Date.now();
  if (isDraining) return 0;
  if (!options?.force && now - lastDrainAt < DRAIN_MIN_INTERVAL_MS) return 0;

  isDraining = true;
  lastDrainAt = now;
  let processed = 0;

  try {
    // `queued` and stale `processing` are two different queries; run the
    // common one first and only reach for strays when it comes back empty.
    let snapshot = await firestore
      .collection(COLLECTION)
      .where("status", "==", "queued")
      .limit(DRAIN_BATCH_SIZE)
      .get();

    if (snapshot.empty) {
      snapshot = await firestore
        .collection(COLLECTION)
        .where("status", "==", "processing")
        .where("claimedAt", "<=", now - PROCESSING_LEASE_MS)
        .limit(DRAIN_BATCH_SIZE)
        .get();
    }

    if (snapshot.empty) return 0;

    for (const doc of snapshot.docs) {
      // Claim first. If another region already took it, skip without touching
      // it — double-processing a suppression is harmless today, but it would
      // stop being harmless the moment this path sends a notification.
      const claimed = await firestore.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return null;
        const data = fresh.data() as Day3EventRecord;

        if (!isClaimable(data, now)) return null;

        tx.update(doc.ref, {
          status: "processing" satisfies EventStatus,
          claimedAt: Date.now(),
          attempts: (data.attempts ?? 0) + 1,
        });
        return data;
      });

      if (!claimed) continue;

      try {
        await applyDay3Event(claimed);
        await doc.ref.update({
          status: "done" satisfies EventStatus,
          processedAt: Date.now(),
          lastError: null,
        });
        processed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Loud on purpose. Day3 already got its 2xx, so nothing will re-deliver
        // this — if the drain is broken, these logs are the only signal.
        logger.error("Failed to process Day3 webhook event", {
          eventId: claimed.eventId,
          type: claimed.type,
          attempts: (claimed.attempts ?? 0) + 1,
          error: message,
        });
        await doc.ref.update({
          status: "queued" satisfies EventStatus,
          lastError: message,
        });
      }
    }
  } catch (error) {
    logger.error("Error draining Day3 webhook queue", error);
  } finally {
    isDraining = false;
  }

  return processed;
}

/** Queue depth for /health. A number that only grows means the drain is stuck. */
export async function getDay3QueueDepth(): Promise<number> {
  const snapshot = await firestore
    .collection(COLLECTION)
    .where("status", "==", "queued")
    .count()
    .get();
  return snapshot.data().count;
}
