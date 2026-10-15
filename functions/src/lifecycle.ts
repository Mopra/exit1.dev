/**
 * Lifecycle events and activation properties.
 *
 * Before this module the only lifecycle signals were user.created,
 * user.onboarding_completed, user.webhook_created, user.alert_connected and
 * user.deleted. All five describe setup. None describe whether the product ever
 * did anything for the user, so the two moments that actually decide retention
 * and conversion were invisible:
 *
 *   user.first_incident_caught  we found an outage for them, recently. The single
 *                               most convertible moment an uptime product has.
 *   no-alert-channel notice     they own a live monitor that can reach nobody.
 *                               Silent failure of the core promise. Sent as our
 *                               own transactional mail, not as a provider event:
 *                               the Resend `user.no_alert_channel` event this
 *                               used to fire had no automation behind it, so
 *                               381 users were "notified" and nobody was told.
 *
 * Deliberately a scheduled sweep rather than a hook on the alert path: alert
 * delivery executes inside the VPS runner (it imports functions/lib), so a hook
 * there would need a VPS rebuild to ship and would add a provider call to the
 * hot path during an incident. A daily sweep is a day late and cannot hurt
 * anyone mid-outage.
 *
 * Every event is stamped once per user under `lifecycle.*` on the user doc, and a
 * run holds a lease so the scheduled tick and an admin-triggered run cannot
 * overlap and double-fire.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore, fetchTierFromClerkStrict } from "./init";
import {
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
  RESEND_API_KEY,
  RESEND_FROM,
  DAY3_API_KEY,
  DAY3_FROM,
  getClerkSecretKey,
  getResendCredentials,
  getDay3ApiKey,
} from "./env";
import { CONFIG, TIER_LIMITS } from "./config";
import { requireAdmin } from "./require-admin";
import { triggerResendEvent, RESEND_RATE_LIMIT_MS } from "./resend-sync";
import { syncContactToProviders } from "./contact-sync";
import { buildPropertiesForUser, formatSignupDate, sleep, type ActivationState } from "./contact-model";
import { fetchClerkUserFacts, type ClerkUserFacts } from "./clerk-users";
import {
  loadCoverageRows,
  summarizeCoverage,
  type UserCoverage,
  type CoverageUser,
} from "./alert-coverage";
import {
  decideFirstIncident,
  isWithinGrace,
  mailerShouldSkip,
  pastSoftDeadline,
  NIGHTLY_NO_CHANNEL_CAP,
  NIGHTLY_TRIAL_INVITE_CAP,
  decideTrialInvite,
  isTrialInviteEligible,
  minutesSoonerOnIndie,
  type BillingFacts,
} from "./lifecycle-policy";
import { createClerkClient } from "@clerk/backend";
import { sendDay3Email } from "./day3-email";
import { getDay3Contact } from "./day3-sync";
import {
  buildTrialInvite1,
  buildTrialInvite2,
  hostnameOf,
  TRIAL_INVITE_FROM,
  TRIAL_INVITE_REPLY_TO,
} from "./trial-invite-email";
import { sendTransactionalEmail, isTransactionalEmailConfigured } from "./email-send";
import { decideReverseTrialReminder, hadReverseTrial } from "./reverse-trial-policy";
import { buildReverseTrialReminder } from "./reverse-trial-email";
import { loadTrialChecks, summarizeUsage } from "./reverse-trial";
import { getActiveSuppressions } from "./email-suppression";

const APP_URL = process.env.FRONTEND_URL || "https://app.exit1.dev";
const EMAILS_URL = `${APP_URL}/emails`;

/** Lease document shared by the scheduled sweep and the admin-triggered run. */
const LOCK_DOC = "system_settings/lifecycle_sweep_lock";
const LOCK_LEASE_MS = 10 * 60 * 1000;

// ----------------------------------------------------------------------------
// Run lease
// ----------------------------------------------------------------------------

/**
 * Take the run lease or return null if another run holds it. `maxInstances: 1` is
 * per function, so without this the 07:00 schedule and an admin clicking "run"
 * could both load the same snapshot and both fire the same events.
 */
async function acquireLease(owner: string): Promise<string | null> {
  const ref = firestore.doc(LOCK_DOC);
  const token = `${owner}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const got = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as { token?: string; expiresAt?: number }) : {};
      if (data.token && typeof data.expiresAt === "number" && data.expiresAt > Date.now()) {
        return false;
      }
      tx.set(ref, { token, owner, acquiredAt: Date.now(), expiresAt: Date.now() + LOCK_LEASE_MS });
      return true;
    });
    return got ? token : null;
  } catch (e) {
    logger.warn("[lifecycle] lease acquisition failed; refusing to run without it", {
      error: (e as Error)?.message ?? String(e),
    });
    return null;
  }
}

async function releaseLease(token: string): Promise<void> {
  const ref = firestore.doc(LOCK_DOC);
  try {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { token?: string }).token === token) {
        tx.set(ref, { token: null, expiresAt: 0, releasedAt: Date.now() }, { merge: true });
      }
    });
  } catch (e) {
    // The lease expires on its own in ten minutes; log and move on.
    logger.debug("[lifecycle] lease release failed", { error: (e as Error)?.message ?? String(e) });
  }
}

// ----------------------------------------------------------------------------
// Stamps
// ----------------------------------------------------------------------------

/**
 * Write lifecycle stamps in their own try so a failed stamp after a successful
 * provider call is reported loudly instead of being silently retried as a fresh
 * send next run. Returns false when the write failed.
 */
async function writeStamps(userId: string, stamps: Record<string, number | string>): Promise<boolean> {
  if (Object.keys(stamps).length === 0) return true;
  try {
    await firestore.collection("users").doc(userId).update(stamps);
    return true;
  } catch (e) {
    logger.error("[lifecycle] STAMP FAILED after a successful send; this user may be contacted again", {
      userId,
      stamps: Object.keys(stamps),
      error: (e as Error)?.message ?? String(e),
    });
    return false;
  }
}

// ----------------------------------------------------------------------------
// The "nobody will be told" email
// ----------------------------------------------------------------------------

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Copy is deliberately plain and non-promotional. This is an account-integrity
 * notice, not a campaign: the user has monitors that cannot reach them, and the
 * only useful action is two clicks on the Emails page.
 */
function buildNoChannelEmail(checkCount: number): { subject: string; html: string; text: string } {
  const monitors = checkCount === 1 ? "1 monitor" : `${checkCount} monitors`;
  const subject = checkCount === 1
    ? "Your monitor cannot reach you yet"
    : "Your monitors cannot reach you yet";

  const text = [
    `You have ${monitors} running on exit1, but no alert channel set up.`,
    "",
    "That means if one of them goes down, we have no way to tell you. Checks keep",
    "running and the history keeps recording, but no email, SMS or webhook is sent.",
    "",
    `Fix it in about two clicks: ${EMAILS_URL}`,
    "",
    "Add your email address, switch the check filter to 'All checks', and you are done.",
    "",
    "If you are watching things through the API, a webhook or the MCP server instead,",
    "you can ignore this. We will not send it again.",
    "",
    "Morten",
    "exit1.dev",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#0d1114;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#151a1f;border:1px solid #242d34;border-radius:10px;">
    <tr><td style="padding:28px 28px 8px;">
      <p style="margin:0 0 14px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#8a97a2;">exit1 &middot; account notice</p>
      <h1 style="margin:0 0 16px;font-size:21px;line-height:1.3;color:#e8edf0;font-weight:600;">${escapeHtml(subject)}</h1>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#b7c3cb;">
        You have <strong style="color:#e8edf0;">${escapeHtml(monitors)}</strong> running on exit1, but no alert channel set up.
      </p>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#b7c3cb;">
        That means if one of them goes down, we have no way to tell you. The checks keep running
        and the history keeps recording, but no email, SMS or webhook is sent.
      </p>
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#b7c3cb;">
        Add your email address, switch the check filter to &lsquo;All checks&rsquo;, and you are done.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${EMAILS_URL}" style="display:inline-block;background:#5cc4d5;color:#0d1114;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:7px;">Set up alerts</a>
      </p>
      <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#8a97a2;">
        If you are watching things through the API, a webhook or the MCP server instead, you can
        ignore this. We will not send it again.
      </p>
      <p style="margin:18px 0 0;font-size:13px;color:#8a97a2;">Morten<br>exit1.dev</p>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

export interface NoChannelNotifyResult {
  dryRun: boolean;
  candidates: number;
  sent: number;
  skippedAlreadyNotified: number;
  skippedTooNew: number;
  skippedSuppressed: number;
  skippedNoEmail: number;
  failed: number;
  /** Provider accepted the message but the stamp write failed. Check logs before re-running. */
  stampFailed: number;
  /** True when the run stopped at the soft deadline with candidates left. */
  truncated: boolean;
  coverage: ReturnType<typeof summarizeCoverage>;
  sampleUserIds: string[];
}

/**
 * Find every user holding a live check with no reachable alert channel and send
 * them one notice.
 *
 * `dryRun` defaults to TRUE at every caller. This reaches real inboxes at a volume
 * where a mistake is not retractable, so the safe call has to be the default and
 * the send has to be typed out explicitly.
 *
 * `preloaded` lets the nightly sweep hand over the scan it has already paid for.
 * Without it this repeats a full pass over users, checks, settings and webhooks
 * plus a second Clerk fetch, which on a 540 s budget is time the sweep needs.
 */
export async function notifyNoChannelUsers(opts: {
  dryRun: boolean;
  limit: number;
  preloaded?: {
    users: Map<string, CoverageUser>;
    rows: UserCoverage[];
    facts: Map<string, ClerkUserFacts>;
  };
  /** Deadline anchor. A caller that already burned time must not get a fresh budget. */
  startedAt?: number;
}): Promise<NoChannelNotifyResult> {
  const { dryRun, limit, preloaded } = opts;
  const startedAt = opts.startedAt ?? Date.now();

  const { users, rows } = preloaded ?? (await loadCoverageRows());
  const coverage = summarizeCoverage(rows);

  const result: NoChannelNotifyResult = {
    dryRun,
    candidates: 0,
    sent: 0,
    skippedAlreadyNotified: 0,
    skippedTooNew: 0,
    skippedSuppressed: 0,
    skippedNoEmail: 0,
    failed: 0,
    stampFailed: 0,
    truncated: false,
    coverage,
    sampleUserIds: [],
  };

  const uncovered = rows.filter((r) => r.enabledCheckCount > 0 && !r.covered);
  result.candidates = uncovered.length;

  const pending: UserCoverage[] = [];
  for (const r of uncovered) {
    const u = users.get(r.userId);
    if (!u) continue;
    const skip = mailerShouldSkip({ notifiedAt: u.lifecycle.noChannelNotifiedAt });
    if (skip === "already_notified") result.skippedAlreadyNotified++;
    else pending.push(r);
  }

  if (!dryRun && !isTransactionalEmailConfigured()) {
    throw new HttpsError("failed-precondition", "No transactional email provider is configured");
  }

  let facts = preloaded?.facts;
  if (!facts) {
    const secretKey = getClerkSecretKey();
    if (!secretKey) {
      throw new HttpsError("failed-precondition", "No Clerk secret key is configured");
    }
    facts = await fetchClerkUserFacts(pending.map((r) => r.userId), secretKey, "lifecycle");
  }

  // One batched suppression lookup for every pending address, not a read per user.
  const suppressed = new Set<string>();
  const pendingEmails = pending.map((r) => facts.get(r.userId)?.email).filter((e): e is string => Boolean(e));
  if (pendingEmails.length > 0) {
    for (const s of await getActiveSuppressions(pendingEmails)) {
      if (s.email) suppressed.add(s.email.toLowerCase());
    }
  }

  const now = Date.now();
  let budget = limit;

  for (const row of pending) {
    if (budget <= 0) break;
    if (pastSoftDeadline(startedAt, Date.now())) {
      result.truncated = true;
      break;
    }
    const f = facts.get(row.userId);
    if (!f?.email) {
      result.skippedNoEmail++;
      continue;
    }
    if (isWithinGrace(f.createdAt, now)) {
      result.skippedTooNew++;
      continue;
    }
    if (suppressed.has(f.email.trim().toLowerCase())) {
      result.skippedSuppressed++;
      continue;
    }

    if (result.sampleUserIds.length < 10) result.sampleUserIds.push(row.userId);

    if (dryRun) {
      result.sent++;
      budget--;
      continue;
    }

    const body = buildNoChannelEmail(row.enabledCheckCount);
    const sendStarted = Date.now();
    try {
      await sendTransactionalEmail({
        to: f.email,
        subject: body.subject,
        html: body.html,
        text: body.text,
        category: "lifecycle",
        meta: { kind: "no_alert_channel", userId: row.userId, checks: row.enabledCheckCount },
      });
    } catch (e) {
      result.failed++;
      logger.warn("[lifecycle] no-channel notice failed", {
        userId: row.userId,
        error: (e as Error)?.message ?? String(e),
      });
      continue;
    }

    // Provider accepted it. Stamp in its own try so a stamp failure is reported as
    // exactly that, and never as "failed send, retry next time".
    const ok = await writeStamps(row.userId, { "lifecycle.noChannelNotifiedAt": Date.now() });
    if (ok) result.sent++;
    else result.stampFailed++;
    budget--;

    // Pace to the provider limit, counting the time the send itself already took.
    const remaining = RESEND_RATE_LIMIT_MS - (Date.now() - sendStarted);
    if (remaining > 0) await sleep(remaining);
  }

  logger.info("[lifecycle] no-channel notify complete", result as unknown as Record<string, unknown>);
  return result;
}

/**
 * Admin-only. Sends the alert-coverage notice to affected users.
 *
 * Call with `{ dryRun: true }` first: the response reports exactly how many
 * messages a real run would send, and how many it would skip and why.
 */
export const notifyUsersWithoutAlertChannel = onCall(
  {
    cors: true,
    timeoutSeconds: CONFIG.SCHEDULER_TIMEOUT_SECONDS,
    maxInstances: 1,
    // Full-collection scans of users, checks and every settings document; the
    // 256MiB scheduler default is sized for the check loop, not for this.
    memory: "512MiB",
    secrets: [
      CLERK_SECRET_KEY_PROD,
      CLERK_SECRET_KEY_DEV,
      RESEND_API_KEY,
      RESEND_FROM,
      DAY3_API_KEY,
      DAY3_FROM,
    ],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
    await requireAdmin(uid);

    const data = (request.data ?? {}) as {
      dryRun?: unknown;
      limit?: unknown;
    };
    // Anything other than an explicit `false` is a dry run.
    const dryRun = data.dryRun !== false;
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(data.limit) || 1000)));

    const token = await acquireLease(`notify:${uid}`);
    if (!token) {
      throw new HttpsError("aborted", "Another lifecycle run is in progress. Try again in a few minutes.");
    }
    try {
      return await notifyNoChannelUsers({ dryRun, limit });
    } finally {
      await releaseLease(token);
    }
  },
);

// ----------------------------------------------------------------------------
// Trial invites: day 3 and day 10 for new free users
// ----------------------------------------------------------------------------

/** Read Clerk's billing subscription for one user, reduced to what eligibility needs. Null when unknown. */
async function fetchBillingFacts(uid: string, secretKey: string): Promise<BillingFacts | null> {
  try {
    const client = createClerkClient({ secretKey });
    const sub = (await client.billing.getUserBillingSubscription(uid)) as unknown as {
      eligibleForFreeTrial?: unknown;
      subscriptionItems?: Array<{
        plan?: { slug?: unknown } | null;
        lifetimePaid?: { amount?: unknown } | null;
      }>;
    } | null;
    if (!sub || typeof sub !== "object") return null;
    const items = Array.isArray(sub.subscriptionItems) ? sub.subscriptionItems : [];
    return {
      eligibleForFreeTrial: typeof sub.eligibleForFreeTrial === "boolean" ? sub.eligibleForFreeTrial : null,
      items: items.map((i) => ({
        planSlug: typeof i?.plan?.slug === "string" && i.plan.slug.trim() ? i.plan.slug.trim() : null,
        lifetimePaidCents: Number(i?.lifetimePaid?.amount) || 0,
      })),
    };
  } catch (e) {
    logger.warn("[lifecycle] trial invite billing lookup failed; skipping user this run", {
      userId: uid,
      error: (e as Error)?.message ?? String(e),
    });
    return null;
  }
}

/** The user's checks with the fields the copy needs. Only read for users about to be mailed. */
async function loadInviteChecks(
  uid: string,
): Promise<Array<{ host: string | null; lastDowntime: number | null; disabled: boolean }>> {
  const snap = await firestore
    .collection("checks")
    .where("userId", "==", uid)
    .select("url", "name", "lastDowntime", "disabled")
    .limit(200)
    .get();
  return snap.docs.map((d) => {
    const name = ((d.get("name") as string | undefined) ?? "").trim();
    return {
      host: hostnameOf(d.get("url") as string | undefined) ?? (name || null),
      lastDowntime: typeof d.get("lastDowntime") === "number" ? (d.get("lastDowntime") as number) : null,
      disabled: d.get("disabled") === true,
    };
  });
}

export interface TrialInviteResult {
  dryRun: boolean;
  /** Users the date and tier rules made due tonight, before billing and suppression checks. */
  due: number;
  invite1Sent: number;
  invite2Sent: number;
  skippedEverSubscribed: number;
  skippedSuppressed: number;
  skippedUnsubscribed: number;
  skippedNoEmail: number;
  failed: number;
  stampFailed: number;
  truncated: boolean;
  sampleUserIds: string[];
}

/**
 * Invite new free users to start the 7-day trial: once on day 3, once more on
 * day 10 if they are still free. Same safety as the no-channel notice: dry-run,
 * one stamp per user per email (`lifecycle.trialInvite1At` / `trialInvite2At`),
 * a nightly cap, suppressions skipped, and only accounts created after
 * TRIAL_INVITE_FEATURE_START_MS. On a dry run `invite1Sent` / `invite2Sent` are
 * what a real run would send; the Clerk and Day3 lookups still run, read-only,
 * so the counts are honest.
 */
export async function sendTrialInvites(opts: {
  dryRun: boolean;
  limit: number;
  users: Map<string, CoverageUser>;
  rows: UserCoverage[];
  facts: Map<string, ClerkUserFacts>;
  startedAt: number;
}): Promise<TrialInviteResult> {
  const { dryRun, limit, users, rows, facts, startedAt } = opts;
  const result: TrialInviteResult = {
    dryRun,
    due: 0,
    invite1Sent: 0,
    invite2Sent: 0,
    skippedEverSubscribed: 0,
    skippedSuppressed: 0,
    skippedUnsubscribed: 0,
    skippedNoEmail: 0,
    failed: 0,
    stampFailed: 0,
    truncated: false,
    sampleUserIds: [],
  };

  const now = Date.now();
  const due: Array<{ row: UserCoverage; f: ClerkUserFacts; which: "invite1" | "invite2" }> = [];
  for (const row of rows) {
    const u = users.get(row.userId);
    const f = facts.get(row.userId);
    if (!u || !f) continue;
    const d = decideTrialInvite({
      tier: u.tier,
      subscribedPlanKey: u.subscribedPlanKey,
      checkCount: row.checkCount,
      createdAt: f.createdAt,
      invite1At: u.lifecycle.trialInvite1At,
      invite2At: u.lifecycle.trialInvite2At,
      now,
      hadReverseTrial: hadReverseTrial(u.reverseTrial),
    });
    if ("send" in d) due.push({ row, f, which: d.send });
  }
  result.due = due.length;
  if (due.length === 0) {
    logger.info("[lifecycle] trial invites complete", result as unknown as Record<string, unknown>);
    return result;
  }

  const secretKey = getClerkSecretKey();
  const day3Key = getDay3ApiKey();
  if (!secretKey) throw new HttpsError("failed-precondition", "No Clerk secret key is configured");
  if (!day3Key) throw new HttpsError("failed-precondition", "DAY3_API_KEY is not configured");

  const suppressed = new Set<string>();
  const emails = due.map((d) => d.f.email).filter((e): e is string => Boolean(e));
  if (emails.length > 0) {
    for (const s of await getActiveSuppressions(emails)) {
      if (s.email) suppressed.add(s.email.toLowerCase());
    }
  }

  const minutesSooner = minutesSoonerOnIndie(
    TIER_LIMITS.free.minCheckIntervalMinutes,
    TIER_LIMITS.indie.minCheckIntervalMinutes,
  );
  let budget = limit;

  for (const { row, f, which } of due) {
    if (budget <= 0) break;
    if (pastSoftDeadline(startedAt, Date.now())) {
      result.truncated = true;
      break;
    }
    if (!f.email) {
      result.skippedNoEmail++;
      continue;
    }
    if (suppressed.has(f.email.trim().toLowerCase())) {
      result.skippedSuppressed++;
      continue;
    }

    // Never paid, never trialled, not Founders: Clerk's own trial verdict plus
    // the subscription items. Unknown counts as "skip".
    if (!isTrialInviteEligible(await fetchBillingFacts(row.userId, secretKey))) {
      result.skippedEverSubscribed++;
      continue;
    }

    // Marketing opt-outs live on the Day3 contact. A missing contact is fine;
    // any other lookup failure skips the user this run.
    const contact = await getDay3Contact(day3Key, f.email);
    if (contact.ok && contact.contact?.status === "unsubscribed") {
      result.skippedUnsubscribed++;
      continue;
    }
    const lookupCode = String(contact.error ?? "").toLowerCase();
    if (!contact.ok && !lookupCode.includes("not_found") && lookupCode !== "http_404") {
      result.failed++;
      logger.warn("[lifecycle] trial invite contact lookup failed; skipping user this run", {
        userId: row.userId,
        error: contact.error,
      });
      continue;
    }

    if (result.sampleUserIds.length < 10) result.sampleUserIds.push(row.userId);

    if (dryRun) {
      if (which === "invite1") result.invite1Sent++;
      else result.invite2Sent++;
      budget--;
      continue;
    }

    let body: { subject: string; text: string };
    try {
      const checks = await loadInviteChecks(row.userId);
      if (which === "invite1") {
        body = buildTrialInvite1({
          firstName: f.firstName,
          checkCount: row.checkCount,
          hostnames: checks
            .filter((c) => !c.disabled)
            .map((c) => c.host)
            .filter((h): h is string => Boolean(h)),
        });
      } else {
        // The latest outage since signup, on any of their monitors.
        const since = f.createdAt ?? 0;
        const incident = checks
          .filter((c) => c.lastDowntime !== null && c.lastDowntime >= since)
          .sort((a, b) => (b.lastDowntime ?? 0) - (a.lastDowntime ?? 0))[0];
        body = buildTrialInvite2({
          firstName: f.firstName,
          hadIncident: Boolean(incident),
          incidentHost: incident?.host ?? null,
          minutesSooner,
        });
      }
    } catch (e) {
      result.failed++;
      logger.warn("[lifecycle] trial invite could not be built", {
        userId: row.userId,
        error: (e as Error)?.message ?? String(e),
      });
      continue;
    }

    const sendStarted = Date.now();
    const sent = await sendDay3Email(day3Key, {
      from: TRIAL_INVITE_FROM,
      to: f.email,
      subject: body.subject,
      text: body.text,
      replyTo: TRIAL_INVITE_REPLY_TO,
      idempotencyKey: `trial-${which}:${row.userId}`,
    });
    if (!sent.ok) {
      result.failed++;
      logger.warn("[lifecycle] trial invite send failed", {
        userId: row.userId,
        which,
        status: sent.status,
        error: sent.error,
      });
      continue;
    }

    // Provider accepted it. Stamp in its own try, exactly as the no-channel notice does.
    const stampKey = which === "invite1" ? "lifecycle.trialInvite1At" : "lifecycle.trialInvite2At";
    const ok = await writeStamps(row.userId, { [stampKey]: Date.now() });
    if (!ok) result.stampFailed++;
    else if (which === "invite1") result.invite1Sent++;
    else result.invite2Sent++;
    budget--;

    const remaining = RESEND_RATE_LIMIT_MS - (Date.now() - sendStarted);
    if (remaining > 0) await sleep(remaining);
  }

  logger.info("[lifecycle] trial invites complete", result as unknown as Record<string, unknown>);
  return result;
}

// ----------------------------------------------------------------------------
// Reverse trial: the day-5 reminder
// ----------------------------------------------------------------------------

/** Reverse-trial accounts due their "N days left" email now, with the days left. User doc fields only. */
export function reverseTrialReminderDue(
  users: Map<string, CoverageUser>,
  now: number,
): Array<{ uid: string; daysLeft: number }> {
  const out: Array<{ uid: string; daysLeft: number }> = [];
  for (const u of users.values()) {
    const d = decideReverseTrialReminder({ s: u.reverseTrial, now, reminderAt: u.lifecycle.reverseTrialReminderAt });
    if ("send" in d) out.push({ uid: u.userId, daysLeft: d.daysLeft });
  }
  return out;
}

export interface ReverseTrialReminderResult {
  dryRun: boolean;
  due: number;
  sent: number;
  skippedSubscribed: number;
  skippedSuppressed: number;
  skippedUnsubscribed: number;
  skippedNoEmail: number;
  failed: number;
  stampFailed: number;
  truncated: boolean;
}

/**
 * Day 5 of the 7-day reverse trial: one plain-text email from Morten saying how
 * many days are left, what the account used, and where to keep Nano. Same
 * safety as the trial invites: dry-run, one stamp ever
 * (lifecycle.reverseTrialReminderAt), suppressions and Day3 opt-outs skipped.
 * A strict Clerk lookup runs first, so someone who already subscribed is not
 * asked to.
 */
export async function sendReverseTrialReminders(opts: {
  dryRun: boolean;
  users: Map<string, CoverageUser>;
  facts: Map<string, ClerkUserFacts>;
  startedAt: number;
}): Promise<ReverseTrialReminderResult> {
  const { dryRun, users, facts, startedAt } = opts;
  const result: ReverseTrialReminderResult = {
    dryRun,
    due: 0,
    sent: 0,
    skippedSubscribed: 0,
    skippedSuppressed: 0,
    skippedUnsubscribed: 0,
    skippedNoEmail: 0,
    failed: 0,
    stampFailed: 0,
    truncated: false,
  };

  const due = reverseTrialReminderDue(users, Date.now());
  result.due = due.length;
  if (due.length === 0) return result;

  const day3Key = getDay3ApiKey();
  if (!day3Key) throw new HttpsError("failed-precondition", "DAY3_API_KEY is not configured");

  const suppressed = new Set<string>();
  const emails = due.map((d) => facts.get(d.uid)?.email).filter((e): e is string => Boolean(e));
  if (emails.length > 0) {
    for (const s of await getActiveSuppressions(emails)) {
      if (s.email) suppressed.add(s.email.toLowerCase());
    }
  }

  for (const { uid, daysLeft } of due) {
    if (pastSoftDeadline(startedAt, Date.now())) {
      result.truncated = true;
      break;
    }
    const f = facts.get(uid);
    if (!f?.email) {
      result.skippedNoEmail++;
      continue;
    }
    if (suppressed.has(f.email.trim().toLowerCase())) {
      result.skippedSuppressed++;
      continue;
    }

    // Already paying? Then there is nothing to keep. Unknown means try again next run.
    try {
      const paid = await fetchTierFromClerkStrict(uid);
      if (paid.tier !== "free") {
        result.skippedSubscribed++;
        continue;
      }
    } catch (e) {
      result.failed++;
      logger.warn("[lifecycle] reverse-trial reminder billing lookup failed; skipping this run", {
        userId: uid,
        error: (e as Error)?.message ?? String(e),
      });
      continue;
    }

    const contact = await getDay3Contact(day3Key, f.email);
    if (contact.ok && contact.contact?.status === "unsubscribed") {
      result.skippedUnsubscribed++;
      continue;
    }
    const lookupCode = String(contact.error ?? "").toLowerCase();
    if (!contact.ok && !lookupCode.includes("not_found") && lookupCode !== "http_404") {
      result.failed++;
      continue;
    }

    if (dryRun) {
      result.sent++;
      continue;
    }

    let body: { subject: string; text: string };
    try {
      body = buildReverseTrialReminder({
        firstName: f.firstName,
        daysLeft,
        usage: summarizeUsage(await loadTrialChecks(uid)),
      });
    } catch (e) {
      result.failed++;
      logger.warn("[lifecycle] reverse-trial reminder could not be built", {
        userId: uid,
        error: (e as Error)?.message ?? String(e),
      });
      continue;
    }

    const sendStarted = Date.now();
    const sent = await sendDay3Email(day3Key, {
      from: TRIAL_INVITE_FROM,
      to: f.email,
      subject: body.subject,
      text: body.text,
      replyTo: TRIAL_INVITE_REPLY_TO,
      idempotencyKey: "reverse-trial-reminder:" + uid,
    });
    if (!sent.ok) {
      result.failed++;
      logger.warn("[lifecycle] reverse-trial reminder send failed", { userId: uid, status: sent.status, error: sent.error });
      continue;
    }
    const ok = await writeStamps(uid, { "lifecycle.reverseTrialReminderAt": Date.now() });
    if (ok) result.sent++;
    else result.stampFailed++;

    const remaining = RESEND_RATE_LIMIT_MS - (Date.now() - sendStarted);
    if (remaining > 0) await sleep(remaining);
  }

  logger.info("[lifecycle] reverse-trial reminders complete", result as unknown as Record<string, unknown>);
  return result;
}

// ----------------------------------------------------------------------------
// The sweep
// ----------------------------------------------------------------------------

export interface LifecycleSweepResult {
  dryRun: boolean;
  usersExamined: number;
  firstIncidentEvents: number;
  /** Historical incidents stamped without firing (older than the freshness window). */
  firstIncidentStampedSilently: number;
  /** No-alert-channel notices this run actually mailed (capped per run). */
  noChannelNotices: number;
  /** Notices the provider rejected. They stay unstamped and retry tomorrow. */
  noChannelFailed: number;
  /** Day-3 trial invites mailed (or, on a dry run, that would be). */
  trialInvites1: number;
  /** Day-10 trial invites mailed (or, on a dry run, that would be). */
  trialInvites2: number;
  /** Trial invites that failed to send or could not be checked. Unstamped, so they retry. */
  trialInvitesFailed: number;
  /** Day-5 reverse-trial reminders mailed (or, on a dry run, that would be). */
  reverseTrialReminders: number;
  /** Reverse-trial reminders that failed or could not be checked. Unstamped, so they retry. */
  reverseTrialRemindersFailed: number;
  propertiesSynced: number;
  errors: number;
  stampFailed: number;
  truncated: boolean;
  /** True when another run held the lease and this one did nothing. */
  skippedLocked?: boolean;
  coverage: ReturnType<typeof summarizeCoverage>;
}

/**
 * A cheap change detector so an unchanged user costs zero provider calls. Without
 * it the sweep would rewrite ~1600 contacts every night for no reason and burn
 * through provider rate limits.
 */
function activationFingerprint(a: ActivationState, tier: string): string {
  return [
    tier,
    a.checkCount ?? "",
    a.checksAlertable ?? "",
    a.hasAlertChannel === undefined ? "" : String(a.hasAlertChannel),
    formatSignupDate(a.firstIncidentAt ?? null) ?? "",
    formatSignupDate(a.lastActiveAt ?? null) ?? "",
  ].join("|");
}

/** Fire one Resend automation event, paced, and report whether to stamp it. */
async function fireEvent(
  resendKey: string,
  email: string,
  name: string,
  payload: Record<string, unknown>,
  result: { errors: number },
): Promise<boolean> {
  const started = Date.now();
  const ev = await triggerResendEvent(resendKey, email, name, payload);
  const remaining = RESEND_RATE_LIMIT_MS - (Date.now() - started);
  if (remaining > 0) await sleep(remaining);
  if (ev.success) return true;
  result.errors++;
  logger.warn(`[lifecycle] ${name} failed`, { email, error: ev.error });
  return false;
}

async function sweepOneUser(
  row: UserCoverage,
  u: CoverageUser,
  f: ClerkUserFacts,
  keys: { resend: string | null; day3: string | undefined },
  dryRun: boolean,
  result: LifecycleSweepResult,
): Promise<void> {
  if (!f.email) return;
  const now = Date.now();

  const activation: ActivationState = {
    checkCount: row.checkCount,
    checksAlertable: row.emailCoveredCheckCount,
    hasAlertChannel: row.covered,
    firstIncidentAt: row.firstIncidentAt,
    lastActiveAt: f.lastSignInAt,
  };

  const stamps: Record<string, number | string> = {};

  // ---- Activation properties ----
  const fingerprint = activationFingerprint(activation, u.tier);
  if (fingerprint !== u.lifecycle.activationFingerprint) {
    if (dryRun) {
      result.propertiesSynced++;
    } else {
      try {
        const properties = buildPropertiesForUser({
          signupDate: formatSignupDate(f.createdAt),
          tier: u.tier,
          onboarding: u.onboarding,
          activation,
        });
        const started = Date.now();
        const sync = await syncContactToProviders({
          email: f.email,
          firstName: f.firstName,
          lastName: f.lastName,
          properties,
          resendApiKey: keys.resend ?? undefined,
          day3ApiKey: keys.day3,
          userId: row.userId,
        });
        const remaining = RESEND_RATE_LIMIT_MS - (Date.now() - started);
        if (remaining > 0) await sleep(remaining);
        if (sync.resend.success || sync.day3.success) {
          stamps["lifecycle.activationSyncedAt"] = now;
          stamps["lifecycle.activationFingerprint"] = fingerprint;
          result.propertiesSynced++;
        }
      } catch (e) {
        result.errors++;
        logger.warn("[lifecycle] activation property sync failed", {
          userId: row.userId,
          error: (e as Error)?.message ?? String(e),
        });
      }
    }
  }

  // ---- user.first_incident_caught ----
  const incident = decideFirstIncident({
    firstIncidentAt: row.firstIncidentAt,
    alreadyStampedAt: u.lifecycle.firstIncidentEventAt,
    now,
  });
  if (incident === "stamp_silently") {
    result.firstIncidentStampedSilently++;
    if (!dryRun) stamps["lifecycle.firstIncidentEventAt"] = now;
  } else if (incident === "fire") {
    result.firstIncidentEvents++;
    if (!dryRun && keys.resend) {
      const ok = await fireEvent(keys.resend, f.email, "user.first_incident_caught", {
        userId: row.userId,
        firstIncidentAt: row.firstIncidentAt,
        checkCount: row.checkCount,
        hasAlertChannel: row.covered,
      }, result);
      if (ok) stamps["lifecycle.firstIncidentEventAt"] = now;
    }
  }

  // The no-alert-channel notice is not handled here: it is a real email with a
  // per-run cap, sent once for the whole run by notifyNoChannelUsers before this
  // loop starts.

  if (!dryRun && !(await writeStamps(row.userId, stamps))) {
    result.stampFailed++;
  }
}

export async function runSweep(opts: { dryRun: boolean; owner: string }): Promise<LifecycleSweepResult> {
  const { dryRun } = opts;
  const startedAt = Date.now();

  const token = await acquireLease(opts.owner);
  if (!token) {
    logger.warn("[lifecycle] sweep skipped: another run holds the lease");
    return {
      dryRun,
      usersExamined: 0,
      firstIncidentEvents: 0,
      firstIncidentStampedSilently: 0,
      noChannelNotices: 0,
      noChannelFailed: 0,
      trialInvites1: 0,
      trialInvites2: 0,
      trialInvitesFailed: 0,
      reverseTrialReminders: 0,
      reverseTrialRemindersFailed: 0,
      propertiesSynced: 0,
      errors: 0,
      stampFailed: 0,
      truncated: false,
      skippedLocked: true,
      coverage: { usersWithEnabledChecks: 0, usersCovered: 0, usersUncovered: 0, enabledChecks: 0, emailCoveredChecks: 0 },
    };
  }

  try {
    const { users, rows } = await loadCoverageRows();
    const coverage = summarizeCoverage(rows);

    const result: LifecycleSweepResult = {
      dryRun,
      usersExamined: users.size,
      firstIncidentEvents: 0,
      firstIncidentStampedSilently: 0,
      noChannelNotices: 0,
      noChannelFailed: 0,
      trialInvites1: 0,
      trialInvites2: 0,
      trialInvitesFailed: 0,
      reverseTrialReminders: 0,
      reverseTrialRemindersFailed: 0,
      propertiesSynced: 0,
      errors: 0,
      stampFailed: 0,
      truncated: false,
      coverage,
    };

    // A user with no checks has no activation state worth reporting and can trigger
    // neither event, so they never need the Clerk lookup. Everyone else does: the
    // activation properties are refreshed for all of them, and the fingerprint
    // check in sweepOneUser is what keeps an unchanged user from costing a provider
    // write.
    const interesting = rows.filter((r) => r.checkCount > 0);

    const secretKey = getClerkSecretKey();
    if (!secretKey) {
      logger.warn("[lifecycle] no Clerk secret configured; sweep cannot resolve emails");
      return result;
    }
    // Reverse-trial reminders go to accounts with no checks too, so they join the lookup.
    const lookupIds = new Set(interesting.map((r) => r.userId));
    for (const d of reverseTrialReminderDue(users, Date.now())) lookupIds.add(d.uid);
    const facts = await fetchClerkUserFacts([...lookupIds], secretKey, "lifecycle");
    const keys = { resend: getResendCredentials().apiKey ?? null, day3: getDay3ApiKey() };

    // Notices before properties, deliberately. This is the only thing in the run a
    // user ever sees, and the property loop below is the unbounded half: if the run
    // is going to run out of clock, the cosmetic half is the one that should lose.
    // Wrapped so a mailer failure cannot take the property sync down with it.
    try {
      const notify = await notifyNoChannelUsers({
        dryRun,
        limit: NIGHTLY_NO_CHANNEL_CAP,
        preloaded: { users, rows, facts },
        startedAt,
      });
      result.noChannelNotices = notify.sent;
      result.noChannelFailed = notify.failed;
      result.stampFailed += notify.stampFailed;
      if (notify.truncated) result.truncated = true;
    } catch (e) {
      result.errors++;
      logger.error("[lifecycle] no-channel notices failed", {
        error: (e as Error)?.message ?? String(e),
      });
    }

    // Trial invites next, for the same reason: they are user-visible and capped.
    try {
      const invites = await sendTrialInvites({
        dryRun,
        limit: NIGHTLY_TRIAL_INVITE_CAP,
        users,
        rows: interesting,
        facts,
        startedAt,
      });
      result.trialInvites1 = invites.invite1Sent;
      result.trialInvites2 = invites.invite2Sent;
      result.trialInvitesFailed = invites.failed;
      result.stampFailed += invites.stampFailed;
      if (invites.truncated) result.truncated = true;
    } catch (e) {
      result.errors++;
      logger.error("[lifecycle] trial invites failed", {
        error: (e as Error)?.message ?? String(e),
      });
    }

    // The day-5 reverse-trial reminder: user-visible and time-bound, so it also goes before the properties.
    try {
      const reminders = await sendReverseTrialReminders({ dryRun, users, facts, startedAt });
      result.reverseTrialReminders = reminders.sent;
      result.reverseTrialRemindersFailed = reminders.failed;
      result.stampFailed += reminders.stampFailed;
      if (reminders.truncated) result.truncated = true;
    } catch (e) {
      result.errors++;
      logger.error("[lifecycle] reverse-trial reminders failed", {
        error: (e as Error)?.message ?? String(e),
      });
    }

    for (const row of interesting) {
      if (pastSoftDeadline(startedAt, Date.now())) {
        result.truncated = true;
        break;
      }
      const u = users.get(row.userId);
      const f = facts.get(row.userId);
      if (!u || !f) continue;
      await sweepOneUser(row, u, f, keys, dryRun, result);
    }

    logger.info("[lifecycle] sweep complete", result as unknown as Record<string, unknown>);
    return result;
  } finally {
    await releaseLease(token);
  }
}

// The daily 07:00 UTC run, driven by the VPS cron host (vps/src/cron.ts). It
// sends the no-channel notice, so the VPS env must carry RESEND_FROM and
// DAY3_FROM; without them getDay3EmailCredentials() falls back to a default
// from-address.
export async function runScheduledLifecycleSweep(): Promise<void> {
  await runSweep({ dryRun: false, owner: "schedule" });
}

/** Admin-only on-demand run. Defaults to a dry run, like the notifier. */
export const runLifecycleSweep = onCall(
  {
    cors: true,
    timeoutSeconds: CONFIG.SCHEDULER_TIMEOUT_SECONDS,
    maxInstances: 1,
    memory: "512MiB",
    secrets: [
      CLERK_SECRET_KEY_PROD,
      CLERK_SECRET_KEY_DEV,
      RESEND_API_KEY,
      RESEND_FROM,
      DAY3_API_KEY,
      DAY3_FROM,
    ],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
    await requireAdmin(uid);
    const dryRun = (request.data as { dryRun?: unknown } | undefined)?.dryRun !== false;
    return runSweep({ dryRun, owner: `admin:${uid}` });
  },
);

// ----------------------------------------------------------------------------
// Coverage report (read-only)
// ----------------------------------------------------------------------------

/**
 * Admin-only. Answers "how many of our users can actually be alerted?" without
 * sending anything. This is the number the audit was built on; keeping it a
 * callable means it can be re-checked after each fix instead of re-derived by
 * hand against production.
 */
export const getAlertCoverageReport = onCall(
  {
    cors: true,
    timeoutSeconds: 300,
    maxInstances: 2,
    memory: "512MiB",
    secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
    await requireAdmin(uid);

    const { users, rows, inputs, orphanCheckOwners } = await loadCoverageRows();

    const active = rows.filter((r) => r.enabledCheckCount > 0);
    const bucket = (predicate: (r: UserCoverage, u: CoverageUser) => boolean) => {
      const set = active.filter((r) => {
        const u = users.get(r.userId);
        return u ? predicate(r, u) : false;
      });
      return { users: set.length, covered: set.filter((r) => r.covered).length };
    };

    return {
      ...summarizeCoverage(rows),
      orphanCheckOwners,
      suppressionsApplied: inputs.suppressionsApplied,
      byCohort: {
        onboardedPaid: bucket((_, u) => u.onboarding !== null && u.tier !== "free"),
        onboardedFree: bucket((_, u) => u.onboarding !== null && u.tier === "free"),
        preOnboarding: bucket((_, u) => u.onboarding === null),
      },
    };
  },
);
