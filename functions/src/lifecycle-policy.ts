/**
 * Pure decisions for the lifecycle sweep, kept firestore-free so they can be
 * unit-tested (__tests__/lifecycle-policy.test.ts).
 */

/**
 * `user.first_incident_caught` only means something if it is timely. On the first
 * deploy the sweep fired it retroactively for 681 accounts whose outage could be
 * months old, because the only guard was "has the stamp been written". Anything
 * older than this window is stamped without firing, so the event keeps meaning
 * "we caught this recently" and a stamp reset can never re-blast the base.
 */
export const FIRST_INCIDENT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export type FirstIncidentDecision = "fire" | "stamp_silently" | "nothing";

export function decideFirstIncident(opts: {
  firstIncidentAt: number | null;
  alreadyStampedAt: number;
  now: number;
}): FirstIncidentDecision {
  const { firstIncidentAt, alreadyStampedAt, now } = opts;
  if (firstIncidentAt === null) return "nothing";
  if (alreadyStampedAt > 0) return "nothing";
  return now - firstIncidentAt <= FIRST_INCIDENT_FRESHNESS_MS ? "fire" : "stamp_silently";
}

/** Wait this long after signup before telling someone their alerts are unset. */
export const NO_CHANNEL_GRACE_MS = 24 * 60 * 60 * 1000;

export function isWithinGrace(createdAt: number | null, now: number): boolean {
  return createdAt !== null && now - createdAt < NO_CHANNEL_GRACE_MS;
}

/**
 * One notice per user, ever. `lifecycle.noChannelNotifiedAt` is the only key that
 * decides it, and there is exactly one sender writing it.
 *
 * It used to also skip anyone the sweep had fired `user.no_alert_channel` at, on
 * the assumption that a Resend automation would mail them. No such automation was
 * sending, so that check silently disqualified 378 of 381 uncovered users from the
 * only notice they would ever get. The event is gone and the sweep now sends the
 * mail itself; `noChannelEventAt` is left unread on old user documents.
 */
export function mailerShouldSkip(opts: {
  notifiedAt: number;
}): "already_notified" | null {
  return opts.notifiedAt > 0 ? "already_notified" : null;
}

/**
 * How many no-channel notices one nightly sweep may send.
 *
 * The backlog is ~378 users, and mailing all of them on one tick is a send nobody
 * gets to review and nothing can call back. At this cap the backlog drains over
 * roughly a week while every newly uncovered account still gets its notice within
 * a day, and any copy or deliverability mistake shows up on a batch of 50 rather
 * than on the whole base. The admin button takes an explicit limit and is not
 * bound by this.
 */
export const NIGHTLY_NO_CHANNEL_CAP = 50;

/**
 * A run has a hard 540 s ceiling. Stopping a little early with an honest
 * `truncated: true` beats being killed mid-loop with nothing logged, which is what
 * happened on the first night: 308 events, then 70 the next night as the tail
 * rolled over, and no summary line for either.
 */
export const RUN_SOFT_DEADLINE_MS = 480 * 1000;

export function pastSoftDeadline(startedAt: number, now: number): boolean {
  return now - startedAt >= RUN_SOFT_DEADLINE_MS;
}
