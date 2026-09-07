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
 *   user.no_alert_channel       they own a live monitor that can reach nobody.
 *                               Silent failure of the core promise.
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
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
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
import { CONFIG } from "./config";
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
} from "./lifecycle-policy";
import { sendTransactionalEmail, isTransactionalEmailConfigured } from "./email-send";
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
  /** Skipped because the sweep already fired the Resend automation event for them. */
  skippedAutomationEvent: number;
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
 * `dryRun` defaults to TRUE on purpose. This reaches real inboxes at a volume
 * (hundreds) where a mistake is not retractable, so the safe call has to be the
 * default and the send has to be typed out explicitly.
 *
 * `includeAutomationRecipients` defaults to FALSE: the nightly sweep has already
 * fired `user.no_alert_channel` for most of these users, and if a Resend automation
 * mails on that event this would be their second notice. Only set it when you know
 * the automation is not configured to send.
 */
export async function notifyNoChannelUsers(opts: {
  dryRun: boolean;
  limit: number;
  includeAutomationRecipients: boolean;
}): Promise<NoChannelNotifyResult> {
  const { dryRun, limit, includeAutomationRecipients } = opts;
  const startedAt = Date.now();

  const { users, rows } = await loadCoverageRows();
  const coverage = summarizeCoverage(rows);

  const result: NoChannelNotifyResult = {
    dryRun,
    candidates: 0,
    sent: 0,
    skippedAlreadyNotified: 0,
    skippedAutomationEvent: 0,
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
    const skip = mailerShouldSkip({
      notifiedAt: u.lifecycle.noChannelNotifiedAt,
      automationEventAt: u.lifecycle.noChannelEventAt,
      includeAutomationRecipients,
    });
    if (skip === "already_notified") result.skippedAlreadyNotified++;
    else if (skip === "automation_event") result.skippedAutomationEvent++;
    else pending.push(r);
  }

  const secretKey = getClerkSecretKey();
  if (!secretKey) {
    throw new HttpsError("failed-precondition", "No Clerk secret key is configured");
  }
  if (!dryRun && !isTransactionalEmailConfigured()) {
    throw new HttpsError("failed-precondition", "No transactional email provider is configured");
  }

  const facts = await fetchClerkUserFacts(pending.map((r) => r.userId), secretKey, "lifecycle");

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
        category: "account",
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
      includeAutomationRecipients?: unknown;
    };
    // Anything other than an explicit `false` is a dry run.
    const dryRun = data.dryRun !== false;
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(data.limit) || 1000)));
    const includeAutomationRecipients = data.includeAutomationRecipients === true;

    const token = await acquireLease(`notify:${uid}`);
    if (!token) {
      throw new HttpsError("aborted", "Another lifecycle run is in progress. Try again in a few minutes.");
    }
    try {
      return await notifyNoChannelUsers({ dryRun, limit, includeAutomationRecipients });
    } finally {
      await releaseLease(token);
    }
  },
);

// ----------------------------------------------------------------------------
// The sweep
// ----------------------------------------------------------------------------

export interface LifecycleSweepResult {
  dryRun: boolean;
  usersExamined: number;
  firstIncidentEvents: number;
  /** Historical incidents stamped without firing (older than the freshness window). */
  firstIncidentStampedSilently: number;
  noChannelEvents: number;
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

  // ---- user.no_alert_channel ----
  const wantsNoChannel = row.enabledCheckCount > 0
    && !row.covered
    && u.lifecycle.noChannelEventAt === 0
    && !isWithinGrace(f.createdAt, now);
  if (wantsNoChannel) {
    result.noChannelEvents++;
    if (!dryRun && keys.resend) {
      const ok = await fireEvent(keys.resend, f.email, "user.no_alert_channel", {
        userId: row.userId,
        checkCount: row.enabledCheckCount,
      }, result);
      if (ok) stamps["lifecycle.noChannelEventAt"] = now;
    }
  }

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
      noChannelEvents: 0,
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
      noChannelEvents: 0,
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
    const facts = await fetchClerkUserFacts(interesting.map((r) => r.userId), secretKey, "lifecycle");
    const keys = { resend: getResendCredentials().apiKey ?? null, day3: getDay3ApiKey() };

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

export const lifecycleSweep = onSchedule(
  {
    schedule: "every day 07:00",
    timeZone: "UTC",
    region: "us-central1",
    timeoutSeconds: CONFIG.SCHEDULER_TIMEOUT_SECONDS,
    // Full-collection scans; see the note on notifyUsersWithoutAlertChannel.
    memory: "512MiB",
    maxInstances: CONFIG.SCHEDULER_MAX_INSTANCES,
    secrets: [
      CLERK_SECRET_KEY_PROD,
      CLERK_SECRET_KEY_DEV,
      RESEND_API_KEY,
      DAY3_API_KEY,
    ],
  },
  async () => {
    await runSweep({ dryRun: false, owner: "schedule" });
  },
);

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
      DAY3_API_KEY,
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
