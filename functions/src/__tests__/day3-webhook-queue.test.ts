import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDay3Event,
  buildEventRecord,
  enqueueDay3Event,
  isClaimable,
  type ClaimEventFn,
  type Day3EventRecord,
} from "../day3-webhook-queue";
import type { BounceKind } from "../email-suppression-policy";
import type { Day3WebhookEvent } from "../day3-webhook-policy";

const NOW = 1_755_264_000_000;

const suppressionEvent = (id: string, reason = "hard_bounce"): Day3WebhookEvent => ({
  id,
  type: "suppression.created",
  created_at: "2026-08-15T09:14:03.221Z",
  data: { object: "suppression", email: "user@example.com", reason, source: "ses-sns-webhook" },
});

/**
 * The Firestore claim, swapped for a Map. Same contract: keyed on the event id,
 * create-if-absent, "duplicate" otherwise.
 */
const inMemoryClaim = () => {
  const store = new Map<string, Day3EventRecord>();
  const claim: ClaimEventFn = async (eventId, record) => {
    if (store.has(eventId)) return "duplicate";
    store.set(eventId, record);
    return "queued";
  };
  return { store, claim };
};

/** Stand-in for recordEmailBounce that counts writes per address. */
const recordingBounceFn = () => {
  const writes: Array<{ email: string; kind: BounceKind; reason: string | null }> = [];
  const fn = (async (email: string, kind: BounceKind, reason?: string | null) => {
    writes.push({ email, kind, reason: reason ?? null });
    return {
      state: {
        email, permanent: kind !== "transient", suppressedUntil: null,
        transientCount: 0, windowStart: NOW, escalations: 0,
        lastBounceKind: kind, lastBounceAt: NOW, lastReason: reason ?? null,
        totalBounces: writes.filter((w) => w.email === email).length,
        createdAt: NOW, updatedAt: NOW,
      },
      becameSuppressed: true,
    };
  }) as unknown as Parameters<typeof applyDay3Event>[1];
  return { writes, fn };
};

// ── Dedupe ──────────────────────────────────────────────────────────────────

test("a replayed event id is a no-op", async () => {
  const { claim, store } = inMemoryClaim();
  const event = suppressionEvent("evt_2k4h9x");

  const first = await enqueueDay3Event({ event, deliveryAttempt: 1, now: NOW }, claim);
  const second = await enqueueDay3Event({ event, deliveryAttempt: 2, now: NOW + 30_000 }, claim);

  assert.equal(first, "queued");
  assert.equal(second, "duplicate");
  assert.equal(store.size, 1, "the replay must not create a second work item");
});

test("a replay results in one suppression write, not two", async () => {
  // The end-to-end version of the guarantee: Day3 delivers at-least-once, so
  // the same bounce arriving twice must not double-count in emailSuppressions.
  const { claim, store } = inMemoryClaim();
  const { writes, fn } = recordingBounceFn();
  const event = suppressionEvent("evt_2k4h9x");

  for (const attempt of [1, 2, 3]) {
    const outcome = await enqueueDay3Event(
      { event, deliveryAttempt: attempt, now: NOW },
      claim,
    );
    if (outcome === "queued") {
      await applyDay3Event(store.get(event.id)!, fn);
    }
  }

  assert.equal(writes.length, 1, `expected one write, got ${writes.length}`);
  assert.equal(writes[0].email, "user@example.com");
  assert.equal(writes[0].kind, "permanent");
});

test("distinct event ids are each processed", async () => {
  const { claim, store } = inMemoryClaim();
  await enqueueDay3Event({ event: suppressionEvent("evt_a"), deliveryAttempt: 1, now: NOW }, claim);
  await enqueueDay3Event({ event: suppressionEvent("evt_b"), deliveryAttempt: 1, now: NOW }, claim);
  assert.equal(store.size, 2);
});

// ── The request path stays off the work ─────────────────────────────────────

test("enqueuing does no suppression work — that is what keeps the 2xx fast", async () => {
  // Day3 times out at 10s. The guarantee is structural: the request path only
  // claims and persists, so no Clerk lookup or Firestore transaction on
  // emailSuppressions can ever sit between the POST and the response.
  const { claim, store } = inMemoryClaim();
  const { writes, fn } = recordingBounceFn();

  await enqueueDay3Event({ event: suppressionEvent("evt_1"), deliveryAttempt: 1, now: NOW }, claim);

  assert.equal(writes.length, 0, "the handler wrote a suppression inline");
  assert.equal(store.size, 1, "but the event is durably persisted");

  // The work happens later, off the request path.
  await applyDay3Event(store.get("evt_1")!, fn);
  assert.equal(writes.length, 1);
});

test("a slow suppression write cannot delay the enqueue", async () => {
  const { claim, store } = inMemoryClaim();
  let applyFinished = false;
  const slowFn = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    applyFinished = true;
    return { state: {}, becameSuppressed: true };
  }) as unknown as Parameters<typeof applyDay3Event>[1];

  const startedAt = Date.now();
  await enqueueDay3Event({ event: suppressionEvent("evt_1"), deliveryAttempt: 1, now: NOW }, claim);
  const enqueueMs = Date.now() - startedAt;

  assert.equal(applyFinished, false, "enqueue waited on the slow work");
  assert.ok(enqueueMs < 100, `enqueue took ${enqueueMs}ms`);

  await applyDay3Event(store.get("evt_1")!, slowFn);
  assert.equal(applyFinished, true);
});

// ── What gets written ───────────────────────────────────────────────────────

test("suppression.created writes the row with the mapped reason", async () => {
  const cases: Array<[string, BounceKind]> = [
    ["hard_bounce", "permanent"],
    ["complaint", "complaint"],
    ["unsubscribe", "permanent"],
    ["manual", "permanent"],
    ["provider_suppressed", "permanent"],
  ];

  for (const [reason, expected] of cases) {
    const { writes, fn } = recordingBounceFn();
    await applyDay3Event(
      buildEventRecord({ event: suppressionEvent(`evt_${reason}`, reason), deliveryAttempt: 1, now: NOW }),
      fn,
    );
    assert.equal(writes.length, 1, reason);
    assert.equal(writes[0].kind, expected, reason);
    assert.match(writes[0].reason ?? "", new RegExp(reason), "reason must carry through");
  }
});

test("a Transient bounce writes nothing", async () => {
  const { writes, fn } = recordingBounceFn();
  await applyDay3Event(
    buildEventRecord({
      event: {
        id: "evt_soft", type: "email.bounced", created_at: "",
        data: { object: "email", email: "user@example.com", bounce_type: "Transient" },
      },
      deliveryAttempt: 1,
      now: NOW,
    }),
    fn,
  );
  assert.equal(writes.length, 0, "a soft bounce must not suppress the address");
});

test("a Permanent bounce also writes nothing — suppression.created is the sole writer", async () => {
  // Keeping one writer is what makes the handler order-independent, which is
  // the "do not assume ordering" requirement.
  const { writes, fn } = recordingBounceFn();
  await applyDay3Event(
    buildEventRecord({
      event: {
        id: "evt_hard", type: "email.bounced", created_at: "",
        data: { object: "email", email: "user@example.com", bounce_type: "Permanent" },
      },
      deliveryAttempt: 1,
      now: NOW,
    }),
    fn,
  );
  assert.equal(writes.length, 0);
});

test("bounced and suppression.created in either order produce one write", async () => {
  const bounce = {
    id: "evt_bounce", type: "email.bounced", created_at: "",
    data: { object: "email", email: "user@example.com", bounce_type: "Permanent" },
  } as Day3WebhookEvent;
  const suppression = suppressionEvent("evt_supp");

  for (const order of [[bounce, suppression], [suppression, bounce]]) {
    const { writes, fn } = recordingBounceFn();
    for (const event of order) {
      await applyDay3Event(buildEventRecord({ event, deliveryAttempt: 1, now: NOW }), fn);
    }
    assert.equal(writes.length, 1, "exactly one write regardless of arrival order");
  }
});

test("delivery events write nothing and do not throw", async () => {
  for (const type of ["email.sent", "email.delivered", "email.failed", "email.complained"]) {
    const { writes, fn } = recordingBounceFn();
    await applyDay3Event(
      buildEventRecord({
        event: {
          id: `evt_${type}`, type, created_at: "",
          data: { object: "email", email: "user@example.com" },
        },
        deliveryAttempt: 1,
        now: NOW,
      }),
      fn,
    );
    assert.equal(writes.length, 0, type);
  }
});

test("a campaign_recipient event is inert", async () => {
  const { writes, fn } = recordingBounceFn();
  await applyDay3Event(
    buildEventRecord({
      event: {
        id: "evt_campaign", type: "email.bounced", created_at: "",
        data: { object: "campaign_recipient", campaign_id: "cmp_1", recipient_id: "rcp_1" },
      } as Day3WebhookEvent,
      deliveryAttempt: 1,
      now: NOW,
    }),
    fn,
  );
  assert.equal(writes.length, 0);
});

// ── Two-region claim ────────────────────────────────────────────────────────

test("a queued doc is claimable", () => {
  assert.equal(isClaimable({ status: "queued", claimedAt: undefined }, NOW), true);
});

test("a doc the other region just claimed is skipped", () => {
  assert.equal(isClaimable({ status: "processing", claimedAt: NOW - 1_000 }, NOW), false);
});

test("a stale claim is reclaimable so a dead runner cannot strand an event", () => {
  assert.equal(isClaimable({ status: "processing", claimedAt: NOW - 10 * 60_000 }, NOW), true);
});

test("finished docs are never reprocessed", () => {
  assert.equal(isClaimable({ status: "done", claimedAt: NOW - 10 * 60_000 }, NOW), false);
  assert.equal(isClaimable({ status: "failed", claimedAt: NOW - 10 * 60_000 }, NOW), false);
});

// ── Record shape ────────────────────────────────────────────────────────────

test("the persisted record keys on the event id and carries the whole payload", () => {
  // Storing the payload whole is what makes a drain-side bug replayable
  // instead of a lost event.
  const event = suppressionEvent("evt_2k4h9x");
  const record = buildEventRecord({ event, deliveryAttempt: 3, now: NOW });

  assert.equal(record.eventId, "evt_2k4h9x");
  assert.equal(record.status, "queued");
  assert.equal(record.deliveryAttempt, 3);
  assert.deepEqual(record.payload, event);
  assert.ok(record.expireAt.toMillis() > NOW, "TTL must be in the future");
});
