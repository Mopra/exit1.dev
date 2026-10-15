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

// ----------------------------------------------------------------------------
// Trial invites (day 3 and day 10)
// ----------------------------------------------------------------------------

/**
 * Only accounts created at or after this moment are ever invited. It is the
 * deploy time of the feature, so the existing base is never mailed: a stamp
 * reset or a bug in the windows below can at worst reach recent signups.
 */
export const TRIAL_INVITE_FEATURE_START_MS = Date.UTC(2026, 9, 15, 10, 0, 0);

const DAY_MS = 24 * 60 * 60 * 1000;

/** First invite: three days after signup. */
export const TRIAL_INVITE_1_AFTER_MS = 3 * DAY_MS;
/** Second invite: ten days after signup, only if the first went out. */
export const TRIAL_INVITE_2_AFTER_MS = 10 * DAY_MS;
/**
 * How long after its due date an invite may still go out. A missed night (a
 * Clerk outage, the cap, a failed send) is retried, but a "day 3" email is never
 * sent on day 20. It also bounds how many accounts the sweep looks up in Clerk.
 */
export const TRIAL_INVITE_LATE_MS = 4 * DAY_MS;

/** Both invites together, per nightly run. Same reasoning as the no-channel cap. */
export const NIGHTLY_TRIAL_INVITE_CAP = 50;

/** The free plan's Clerk slug. Any other slug on the account means it has had a paid plan or a trial. */
export const FREE_PLAN_SLUG = "free_user";

export type TrialInviteDecision =
  | { send: "invite1" | "invite2" }
  | {
    skip:
      | "not_free"
      | "plan_history"
      | "no_checks"
      | "unknown_signup"
      | "before_feature"
      | "too_new"
      | "too_late"
      | "invite1_missing"
      | "done";
  };

/**
 * Which invite, if any, this user is due tonight. Everything the user doc and
 * Clerk's user record can tell us; the Clerk billing check (has this account
 * ever paid or trialled) runs only for users this returns `send` for, because it
 * costs a request per user.
 */
export function decideTrialInvite(opts: {
  tier: string;
  subscribedPlanKey: string | null;
  checkCount: number;
  createdAt: number | null;
  invite1At: number;
  invite2At: number;
  now: number;
}): TrialInviteDecision {
  const { tier, subscribedPlanKey, checkCount, createdAt, invite1At, invite2At, now } = opts;
  if (tier !== "free") return { skip: "not_free" };
  if (subscribedPlanKey && subscribedPlanKey !== FREE_PLAN_SLUG) return { skip: "plan_history" };
  if (checkCount < 1) return { skip: "no_checks" };
  if (createdAt === null || !Number.isFinite(createdAt) || createdAt <= 0) return { skip: "unknown_signup" };
  if (createdAt < TRIAL_INVITE_FEATURE_START_MS) return { skip: "before_feature" };
  if (invite2At > 0) return { skip: "done" };

  const age = now - createdAt;
  if (invite1At > 0) {
    if (age < TRIAL_INVITE_2_AFTER_MS) return { skip: "too_new" };
    if (age > TRIAL_INVITE_2_AFTER_MS + TRIAL_INVITE_LATE_MS) return { skip: "too_late" };
    return { send: "invite2" };
  }
  if (age < TRIAL_INVITE_1_AFTER_MS) return { skip: "too_new" };
  // A missed first invite is never replaced by the follow-up: the second email
  // reads as a follow-up and makes no sense alone.
  if (age >= TRIAL_INVITE_2_AFTER_MS) return { skip: "invite1_missing" };
  if (age > TRIAL_INVITE_1_AFTER_MS + TRIAL_INVITE_LATE_MS) return { skip: "too_late" };
  return { send: "invite1" };
}

/** The parts of Clerk's billing subscription that decide trial eligibility. */
export interface BillingFacts {
  /** Clerk's own verdict; the Billing page trial wording rests on the same rule. */
  eligibleForFreeTrial: boolean | null;
  items: Array<{ planSlug: string | null; lifetimePaidCents: number }>;
}

/**
 * True only when Clerk says the account can still start a free trial AND
 * nothing on the subscription shows a paid plan, a past trial, or money paid.
 * Unknown (null) is not eligible: if unsure, skip.
 */
export function isTrialInviteEligible(billing: BillingFacts | null): boolean {
  if (!billing) return false;
  if (billing.eligibleForFreeTrial !== true) return false;
  for (const item of billing.items) {
    if (item.planSlug && item.planSlug !== FREE_PLAN_SLUG) return false;
    if (item.lifetimePaidCents > 0) return false;
  }
  return true;
}

/**
 * How many minutes sooner a 1-minute check hears about an outage than a check
 * on `freeIntervalMinutes`, in the worst case. Free is 5, so 4.
 */
export function minutesSoonerOnIndie(freeIntervalMinutes: number, indieIntervalMinutes: number): number {
  return Math.max(0, Math.round(freeIntervalMinutes - indieIntervalMinutes));
}
