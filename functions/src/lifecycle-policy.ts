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
 * The sweep and the direct mailer both tell a user about the same gap. Without a
 * shared key the same person could be mailed twice by two senders. The mailer
 * therefore treats a fired automation event as "already told" unless the operator
 * explicitly says the automation is not configured to send anything.
 */
export function mailerShouldSkip(opts: {
  notifiedAt: number;
  automationEventAt: number;
  includeAutomationRecipients: boolean;
}): "already_notified" | "automation_event" | null {
  if (opts.notifiedAt > 0) return "already_notified";
  if (opts.automationEventAt > 0 && !opts.includeAutomationRecipients) return "automation_event";
  return null;
}

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
