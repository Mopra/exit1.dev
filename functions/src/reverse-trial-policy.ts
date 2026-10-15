/**
 * Reverse trial: every new account gets Nano entitlements for 7 days, with no
 * card and no Clerk checkout, then drops to Free unless it subscribed.
 *
 * The trial lives on the user doc, not in Clerk:
 *   reverseTrialStartedAt    when it started (set once, by the user.created webhook)
 *   reverseTrialEndsAt       when it ends
 *   reverseTrialConvertedAt  first time a paid Clerk plan was seen during or after it
 *   reverseTrialExpiredAt    when the expiry job closed it out
 *   reverseTrialOutcome      'free' (dropped to Free) or 'paid' (kept a paid plan)
 *   tierSource               'reverse_trial' when the cached `tier` came from the trial
 *
 * Pure and firestore-free so the rules are unit-tested
 * (__tests__/reverse-trial.test.ts). Two rules carry the safety:
 *   1. The trial only ever lifts FREE to Nano. A paid Clerk tier always wins,
 *      so a paying customer can never be moved by this code, up or down.
 *   2. Expiry only downgrades on a positive, successful Clerk answer of "free".
 *      A failed or unknown lookup is retried, never read as free.
 */

export type Tier = "free" | "indie" | "nano" | "pro";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The tier a reverse trial grants. Nano, not Pro: SMS costs real money. */
export const REVERSE_TRIAL_TIER: Tier = "nano";

export const REVERSE_TRIAL_DURATION_MS = 7 * DAY_MS;

/**
 * Only accounts created at or after this moment get a trial. It is the deploy
 * time of the feature, so the existing base is never touched, and a webhook
 * replay for an old account cannot start one.
 */
export const REVERSE_TRIAL_FEATURE_START_MS = Date.UTC(2026, 9, 15, 16, 0, 0);

/**
 * A user.created webhook older than this is a replay, not a signup. Svix retries
 * for about three days; a trial that starts days late would still be 7 days
 * long, but it would no longer be "the first week".
 */
export const REVERSE_TRIAL_START_MAX_DELAY_MS = 1 * DAY_MS;

/** The day-5 reminder goes out when this much (or less) of the trial is left. */
export const REVERSE_TRIAL_REMINDER_BEFORE_MS = 2 * DAY_MS;

/** A reminder this close to the end is pointless; the expiry email follows soon. */
export const REVERSE_TRIAL_REMINDER_MIN_LEFT_MS = 6 * 60 * 60 * 1000;

/** The expiry email is only sent this long after expiry; after that it is stale news. */
export const REVERSE_TRIAL_ENDED_EMAIL_WINDOW_MS = 3 * DAY_MS;

/** How far back the expiry job looks for trials that ended. Bounds the query. */
export const REVERSE_TRIAL_EXPIRY_LOOKBACK_MS = 30 * DAY_MS;

/** The free plan's Clerk slug. Any other slug means a paid plan. */
const FREE_PLAN_SLUG = "free_user";

export interface ReverseTrialState {
  startedAt: number;
  endsAt: number;
  convertedAt: number;
  expiredAt: number;
  outcome: "free" | "paid" | null;
  /** 'reverse_trial' when the cached `tier` on the user doc came from the trial. */
  tierSource: "reverse_trial" | "clerk" | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Read the trial fields off a user doc. Missing or junk fields read as "no trial". */
export function readReverseTrial(data: unknown): ReverseTrialState {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const outcome = d.reverseTrialOutcome === "free" || d.reverseTrialOutcome === "paid" ? d.reverseTrialOutcome : null;
  const tierSource = d.tierSource === "reverse_trial" || d.tierSource === "clerk" ? d.tierSource : null;
  return {
    startedAt: num(d.reverseTrialStartedAt),
    endsAt: num(d.reverseTrialEndsAt),
    convertedAt: num(d.reverseTrialConvertedAt),
    expiredAt: num(d.reverseTrialExpiredAt),
    outcome,
    tierSource,
  };
}

/** True while the account is inside its trial week and has neither subscribed nor been expired. */
export function isReverseTrialActive(s: ReverseTrialState, now: number): boolean {
  return s.startedAt > 0 && s.endsAt > now && s.convertedAt === 0 && s.expiredAt === 0;
}

/** True for any account that has ever had a reverse trial, running or over. */
export function hadReverseTrial(s: ReverseTrialState): boolean {
  return s.startedAt > 0;
}

/**
 * Overlay the trial on the tier Clerk reports. Only Free is ever lifted, and
 * only to Nano. Any paid tier, Indie included, comes back unchanged: a user who
 * buys Indie during the trial is on Indie.
 */
export function applyReverseTrial(
  paidTier: Tier,
  s: ReverseTrialState,
  now: number,
): { tier: Tier; source: "reverse_trial" | "clerk" } {
  if (paidTier === "free" && isReverseTrialActive(s, now)) {
    return { tier: REVERSE_TRIAL_TIER, source: "reverse_trial" };
  }
  return { tier: paidTier, source: "clerk" };
}

/**
 * What the cached `tier` says Clerk last reported. When the cache was written by
 * the trial, Clerk's own answer was Free.
 */
export function cachedPaidTier(cachedTier: Tier, s: ReverseTrialState): Tier {
  return s.tierSource === "reverse_trial" ? "free" : cachedTier;
}

/**
 * The cached tier came from a trial that is no longer running, so it must not
 * be served from cache however fresh its timestamp is.
 */
export function trialCacheExpired(s: ReverseTrialState, now: number): boolean {
  return s.tierSource === "reverse_trial" && !isReverseTrialActive(s, now);
}

/**
 * Stamp the conversion the first time a paid Clerk tier shows up on an account
 * that had a trial. Ends the trial for good, so a later cancellation drops to
 * Free rather than back into the trial.
 */
export function shouldStampConversion(paidTier: Tier, s: ReverseTrialState): boolean {
  return paidTier !== "free" && s.startedAt > 0 && s.convertedAt === 0;
}

export type ReverseTrialStartDecision =
  | { start: { startedAt: number; endsAt: number } }
  | { skip: "already_started" | "before_feature" | "unknown_signup" | "stale_signup" | "agent_unclaimed" };

/** Should this new account get a trial? Called from the user.created webhook. */
export function decideReverseTrialStart(opts: {
  createdAt: number | null;
  now: number;
  existing: ReverseTrialState;
  agentUnclaimed: boolean;
}): ReverseTrialStartDecision {
  const { createdAt, now, existing, agentUnclaimed } = opts;
  if (existing.startedAt > 0) return { skip: "already_started" };
  if (agentUnclaimed) return { skip: "agent_unclaimed" };
  if (createdAt === null || !Number.isFinite(createdAt) || createdAt <= 0) return { skip: "unknown_signup" };
  if (createdAt < REVERSE_TRIAL_FEATURE_START_MS) return { skip: "before_feature" };
  if (now - createdAt > REVERSE_TRIAL_START_MAX_DELAY_MS) return { skip: "stale_signup" };
  return { start: { startedAt: now, endsAt: now + REVERSE_TRIAL_DURATION_MS } };
}

export type ReverseTrialExpiryDecision =
  | { action: "not_due" }
  | { action: "retry"; reason: "lookup_failed" | "unknown_plan" }
  | { action: "keep_paid"; tier: Tier }
  | { action: "close_converted" }
  | { action: "downgrade" };

/**
 * What the expiry job does with one account whose trial end has passed.
 * `paid` is a STRICT Clerk lookup: null means it failed, and a failure is a
 * retry, never a downgrade.
 */
export function decideReverseTrialExpiry(opts: {
  s: ReverseTrialState;
  now: number;
  paid: { tier: Tier; planKey: string | null } | null;
}): ReverseTrialExpiryDecision {
  const { s, now, paid } = opts;
  if (s.startedAt === 0 || s.expiredAt > 0 || s.endsAt === 0 || now < s.endsAt) return { action: "not_due" };
  // They subscribed during the trial. Whatever their plan is now, it is Clerk's
  // and the subscription webhook's to manage: close the trial, touch nothing.
  if (s.convertedAt > 0) return { action: "close_converted" };
  if (!paid) return { action: "retry", reason: "lookup_failed" };
  if (paid.tier !== "free") return { action: "keep_paid", tier: paid.tier };
  // Free tier but a plan slug we do not know: someone may be paying for a plan
  // this code has not heard of. Leave it alone and say so in the logs.
  if (paid.planKey && paid.planKey !== FREE_PLAN_SLUG) return { action: "retry", reason: "unknown_plan" };
  return { action: "downgrade" };
}

export type ReverseTrialReminderDecision =
  | { send: true; daysLeft: number }
  | { skip: "no_trial" | "not_active" | "too_early" | "too_late" | "done" };

/** The day-5 "2 days left" email. One per account, ever. */
export function decideReverseTrialReminder(opts: {
  s: ReverseTrialState;
  now: number;
  reminderAt: number;
}): ReverseTrialReminderDecision {
  const { s, now, reminderAt } = opts;
  if (!hadReverseTrial(s)) return { skip: "no_trial" };
  if (reminderAt > 0) return { skip: "done" };
  if (!isReverseTrialActive(s, now)) return { skip: "not_active" };
  const left = s.endsAt - now;
  if (left > REVERSE_TRIAL_REMINDER_BEFORE_MS) return { skip: "too_early" };
  if (left < REVERSE_TRIAL_REMINDER_MIN_LEFT_MS) return { skip: "too_late" };
  return { send: true, daysLeft: reverseTrialDaysLeft(s.endsAt, now) };
}

/** Whole days left, rounded up: 47 hours left reads "2 days". Never negative. */
export function reverseTrialDaysLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
}

/** Should the "your trial ended" email go out now? */
export function shouldSendEndedEmail(opts: {
  s: ReverseTrialState;
  now: number;
  endedEmailAt: number;
}): boolean {
  const { s, now, endedEmailAt } = opts;
  return s.outcome === "free"
    && s.expiredAt > 0
    && endedEmailAt === 0
    && now - s.expiredAt <= REVERSE_TRIAL_ENDED_EMAIL_WINDOW_MS;
}
