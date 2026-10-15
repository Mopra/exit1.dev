/**
 * Reverse trial, the Firestore side: start it on signup, end it after 7 days.
 * The rules live in reverse-trial-policy.ts; tier resolution (init.ts) lays the
 * trial over Clerk's answer, so while it runs every tier check sees Nano.
 *
 * Expiry runs hourly from the VPS cron host (vps/src/cron.ts). It drops a
 * trial account to Free through the same enforcement a lapsed subscription
 * takes (handlePlanDowngrade: clamp intervals, prune to the Free caps, never
 * delete), then sends one short email. The day-5 reminder is sent by the
 * nightly lifecycle sweep (lifecycle.ts).
 */
import * as logger from "firebase-functions/logger";
import { firestore, fetchTierFromClerkStrict, normalizeTier, type UserTier } from "./init";
import { ceilingTightens, enforceTierCeiling, handlePlanDowngrade } from "./plan-enforcement";
import { TIER_LIMITS } from "./config";
import {
  decideReverseTrialExpiry,
  decideReverseTrialStart,
  readReverseTrial,
  shouldSendEndedEmail,
  REVERSE_TRIAL_EXPIRY_LOOKBACK_MS,
  type ReverseTrialStartDecision,
} from "./reverse-trial-policy";
import { buildReverseTrialEnded, type DowngradeChanges, type TrialUsage } from "./reverse-trial-email";
import { hostnameOf, TRIAL_INVITE_FROM, TRIAL_INVITE_REPLY_TO } from "./trial-invite-email";
import { sendDay3Email } from "./day3-email";
import { getClerkSecretKey, getDay3ApiKey } from "./env";
import { fetchClerkUserFacts } from "./clerk-users";
import { getActiveSuppressions } from "./email-suppression";

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------

/**
 * Start the trial for a new account. Idempotent: a webhook retry finds the
 * stamp and does nothing. Throws on a Firestore failure so the webhook can
 * answer 500 and let Clerk retry.
 */
export async function startReverseTrial(opts: {
  uid: string;
  createdAt: number | null;
  agentUnclaimed: boolean;
}): Promise<ReverseTrialStartDecision> {
  const ref = firestore.collection("users").doc(opts.uid);
  const decision = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = decideReverseTrialStart({
      createdAt: opts.createdAt,
      now: Date.now(),
      existing: readReverseTrial(snap.exists ? snap.data() : null),
      agentUnclaimed: opts.agentUnclaimed,
    });
    if ("start" in d) {
      tx.set(ref, {
        reverseTrialStartedAt: d.start.startedAt,
        reverseTrialEndsAt: d.start.endsAt,
        // Any tier cached before this write said Free; make the next lookup
        // resolve again so it picks the trial up and syncs it onto the checks.
        tierUpdatedAt: 0,
      }, { merge: true });
    }
    return d;
  });
  if ("start" in decision) {
    logger.info("[reverse-trial] started", { uid: opts.uid, endsAt: decision.start.endsAt });
  } else {
    logger.info("[reverse-trial] not started", { uid: opts.uid, reason: decision.skip });
  }
  return decision;
}

// ----------------------------------------------------------------------------
// What the account used
// ----------------------------------------------------------------------------

export interface TrialCheck {
  host: string | null;
  frequencyMinutes: number;
  domainIntel: boolean;
  pinnedRegion: boolean;
  disabled: boolean;
}

export async function loadTrialChecks(uid: string): Promise<TrialCheck[]> {
  const snap = await firestore
    .collection("checks")
    .where("userId", "==", uid)
    .select("url", "name", "checkFrequency", "domainExpiry", "checkRegionOverride", "disabled")
    .limit(500)
    .get();
  return snap.docs.map((d) => {
    const name = ((d.get("name") as string | undefined) ?? "").trim();
    const freq = Number(d.get("checkFrequency"));
    return {
      host: hostnameOf(d.get("url") as string | undefined) ?? (name || null),
      frequencyMinutes: Number.isFinite(freq) && freq > 0 ? freq : TIER_LIMITS.free.minCheckIntervalMinutes,
      domainIntel: (d.get("domainExpiry") as { enabled?: unknown } | undefined)?.enabled === true,
      pinnedRegion: typeof d.get("checkRegionOverride") === "string" && Boolean(d.get("checkRegionOverride")),
      disabled: d.get("disabled") === true,
    };
  });
}

export function summarizeUsage(checks: TrialCheck[]): TrialUsage {
  const live = checks.filter((c) => !c.disabled);
  const freeFloor = TIER_LIMITS.free.minCheckIntervalMinutes;
  return {
    checkCount: checks.length,
    hostnames: live.map((c) => c.host).filter((h): h is string => Boolean(h)),
    fastChecks: live.filter((c) => c.frequencyMinutes < freeFloor).length,
    domainIntel: live.filter((c) => c.domainIntel).length,
    pinnedRegions: live.filter((c) => c.pinnedRegion).length,
  };
}

// ----------------------------------------------------------------------------
// Expiry
// ----------------------------------------------------------------------------

export interface ReverseTrialExpiryResult {
  examined: number;
  downgraded: number;
  keptPaid: number;
  retried: number;
  failed: number;
  endedEmails: number;
  endedEmailsFailed: number;
}

async function sendEndedEmail(uid: string, changes: DowngradeChanges): Promise<"sent" | "skipped" | "failed"> {
  const secretKey = getClerkSecretKey();
  const day3Key = getDay3ApiKey();
  if (!secretKey || !day3Key) {
    logger.warn("[reverse-trial] ended email not sent: Clerk or Day3 key missing", { uid });
    return "failed";
  }
  const facts = (await fetchClerkUserFacts([uid], secretKey, "reverse-trial")).get(uid);
  if (!facts) return "failed";
  if (!facts.email) return "skipped";
  // A hard-bounced or complained address gets nothing. This is an account
  // notice (the plan changed), so a marketing opt-out does not stop it.
  const suppressed = await getActiveSuppressions([facts.email]);
  if (suppressed.length > 0) return "skipped";

  const body = buildReverseTrialEnded({ firstName: facts.firstName, changes });
  const sent = await sendDay3Email(day3Key, {
    from: TRIAL_INVITE_FROM,
    to: facts.email,
    subject: body.subject,
    text: body.text,
    replyTo: TRIAL_INVITE_REPLY_TO,
    idempotencyKey: `reverse-trial-ended:${uid}`,
  });
  if (!sent.ok) {
    logger.warn("[reverse-trial] ended email failed", { uid, status: sent.status, error: sent.error });
    return "failed";
  }
  return "sent";
}

/**
 * Close out every trial whose week is over. For each:
 *   - a STRICT Clerk lookup (a failure is retried next hour, never read as Free)
 *   - paid: the trial is marked converted and the account stays on its plan
 *   - free: the same enforcement a lapsed subscription gets, then the email
 */
export async function runReverseTrialExpiry(): Promise<ReverseTrialExpiryResult> {
  const now = Date.now();
  const result: ReverseTrialExpiryResult = {
    examined: 0, downgraded: 0, keptPaid: 0, retried: 0, failed: 0, endedEmails: 0, endedEmailsFailed: 0,
  };

  // Single-field range, so no composite index. The lookback bounds the scan to
  // recent trials; the email window inside it is shorter still.
  const snap = await firestore
    .collection("users")
    .where("reverseTrialEndsAt", ">=", now - REVERSE_TRIAL_EXPIRY_LOOKBACK_MS)
    .where("reverseTrialEndsAt", "<=", now)
    .get();

  for (const doc of snap.docs) {
    const uid = doc.id;
    const data = doc.data() || {};
    let s = readReverseTrial(data);
    result.examined++;

    if (s.expiredAt === 0) {
      let paid: { tier: UserTier; planKey: string | null } | null = null;
      if (s.convertedAt === 0) {
        try {
          paid = await fetchTierFromClerkStrict(uid);
        } catch (e) {
          logger.warn("[reverse-trial] Clerk lookup failed; will retry", { uid, error: (e as Error)?.message ?? String(e) });
        }
      }
      const decision = decideReverseTrialExpiry({ s, now, paid });

      if (decision.action === "retry") {
        result.retried++;
        logger.warn("[reverse-trial] expiry deferred", { uid, reason: decision.reason, planKey: paid?.planKey ?? null });
        continue;
      }
      if (decision.action === "not_due") continue;

      const previousTier = normalizeTier(data.tier) ?? "nano";
      try {
        if (decision.action === "close_converted") {
          await doc.ref.set({ reverseTrialExpiredAt: Date.now(), reverseTrialOutcome: "paid" }, { merge: true });
          result.keptPaid++;
          continue;
        }
        if (decision.action === "keep_paid") {
          // Paying: never downgraded by this code. Only the ceiling for the plan
          // they actually bought applies (Nano trial, then Indie bought: Indie).
          await doc.ref.set({
            tier: decision.tier,
            subscribedPlanKey: paid?.planKey ?? null,
            tierSource: "clerk",
            tierUpdatedAt: Date.now(),
            reverseTrialExpiredAt: Date.now(),
            reverseTrialOutcome: "paid",
            ...(s.convertedAt === 0 ? { reverseTrialConvertedAt: Date.now() } : {}),
          }, { merge: true });
          // Only when the cached tier still came from the trial, i.e. the
          // subscription webhook that normally does this never landed.
          if (
            s.tierSource === "reverse_trial"
            && previousTier !== decision.tier
            && ceilingTightens(previousTier, decision.tier)
          ) {
            await enforceTierCeiling(uid, decision.tier);
          }
          result.keptPaid++;
          logger.info("[reverse-trial] ended on a paid plan", { uid, tier: decision.tier });
          continue;
        }

        // Free. Record what the account had before enforcement changes it, so
        // the email can say what moved.
        const before = await loadTrialChecks(uid);
        await doc.ref.set({
          tier: "free",
          subscribedPlanKey: paid?.planKey ?? null,
          tierSource: "clerk",
          tierUpdatedAt: Date.now(),
        }, { merge: true });
        // The lapsed-subscription path: clamp to the Free floor, prune to the
        // Free caps oldest-first, reset pinned regions. Disables, never deletes.
        const enforced = await handlePlanDowngrade(uid);
        const usage = summarizeUsage(before);
        const changes: DowngradeChanges = {
          slowedChecks: usage.fastChecks,
          pausedChecks: enforced.checksDisabled,
          domainIntelOff: usage.domainIntel,
          regionsReset: usage.pinnedRegions,
          freeMaxChecks: TIER_LIMITS.free.maxChecks,
        };
        const expiredAt = Date.now();
        await doc.ref.set({
          reverseTrialExpiredAt: expiredAt,
          reverseTrialOutcome: "free",
          reverseTrialChanges: changes,
        }, { merge: true });
        s = { ...s, expiredAt, outcome: "free" };
        result.downgraded++;
        logger.info("[reverse-trial] dropped to free", { uid, previousTier, ...changes });
      } catch (e) {
        result.failed++;
        logger.error("[reverse-trial] expiry failed; will retry", { uid, error: (e as Error)?.message ?? String(e) });
        continue;
      }
    }

    const lc = (data.lifecycle as Record<string, unknown> | undefined) ?? {};
    const endedEmailAt = Number(lc.reverseTrialEndedEmailAt) || 0;
    if (!shouldSendEndedEmail({ s, now: Date.now(), endedEmailAt })) continue;

    // Re-read: when the downgrade ran in this same pass, `data` predates it.
    const stored = (await doc.ref.get()).get("reverseTrialChanges") as Partial<DowngradeChanges> | undefined;
    const changes: DowngradeChanges = {
      slowedChecks: Number(stored?.slowedChecks) || 0,
      pausedChecks: Number(stored?.pausedChecks) || 0,
      domainIntelOff: Number(stored?.domainIntelOff) || 0,
      regionsReset: Number(stored?.regionsReset) || 0,
      freeMaxChecks: TIER_LIMITS.free.maxChecks,
    };

    try {
      const outcome = await sendEndedEmail(uid, changes);
      if (outcome === "failed") {
        result.endedEmailsFailed++;
        continue;
      }
      // Stamp skipped sends too, so a missing address is not retried hourly.
      await doc.ref.update({ "lifecycle.reverseTrialEndedEmailAt": Date.now() });
      if (outcome === "sent") result.endedEmails++;
    } catch (e) {
      result.endedEmailsFailed++;
      logger.warn("[reverse-trial] ended email error", { uid, error: (e as Error)?.message ?? String(e) });
    }
  }

  logger.info("[reverse-trial] expiry run complete", result as unknown as Record<string, unknown>);
  return result;
}
