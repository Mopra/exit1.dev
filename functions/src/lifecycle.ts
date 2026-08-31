/**
 * Lifecycle events and activation properties.
 *
 * Before this module the only lifecycle signals were user.created,
 * user.onboarding_completed, user.webhook_created, user.alert_connected and
 * user.deleted. All five describe setup. None describe whether the product ever
 * did anything for the user, so the two moments that actually decide retention
 * and conversion were invisible:
 *
 *   user.first_incident_caught  we found an outage for them. The single most
 *                               convertible moment an uptime product has.
 *   user.no_alert_channel       they own a live monitor that can reach nobody.
 *                               Silent failure of the core promise.
 *
 * Deliberately a scheduled sweep rather than a hook on the alert path: alert
 * delivery executes inside the VPS runner (it imports functions/lib), so a hook
 * there would need a VPS rebuild to ship and would add a provider call to the
 * hot path during an incident. A daily sweep is a day late and cannot hurt
 * anyone mid-outage.
 *
 * Every event is stamped once per user under `lifecycle.*` on the user doc, so a
 * re-run, a retry or a manual invocation cannot re-send.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { createClerkClient } from "@clerk/backend";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { firestore } from "./init";
import {
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
  RESEND_API_KEY,
  RESEND_FROM,
  DAY3_API_KEY,
  DAY3_FROM,
} from "./env";
import { requireAdmin } from "./require-admin";
import { triggerResendEvent } from "./resend-sync";
import { syncContactToProviders } from "./contact-sync";
import { buildPropertiesForUser, formatSignupDate, type ActivationState } from "./contact-model";
import {
  loadCoverageInputs,
  computeUserCoverage,
  summarizeCoverage,
  type UserCoverage,
  type CoverageInputs,
} from "./alert-coverage";
import { sendTransactionalEmail, isTransactionalEmailConfigured } from "./email-send";
import { isEmailSuppressedCached } from "./email-suppression";
import type { Tier } from "./config";

const APP_URL = "https://app.exit1.dev";
const EMAILS_URL = `${APP_URL}/emails`;

/** Wait this long after signup before telling someone their alerts are unset. */
const NO_CHANNEL_GRACE_MS = 24 * 60 * 60 * 1000;

/** Clerk's getUserList accepts up to 100 ids per call. */
const CLERK_CHUNK = 100;

interface ClerkUserFacts {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  signupDate: string | null;
  createdAt: number | null;
  lastActiveAt: number | null;
}

/**
 * Batch-resolve the Clerk facts the sweep needs. One call per 100 users returns
 * email (for sends), createdAt (for the grace window) and lastSignInAt (the only
 * honest "last active" signal we have: check documents are rewritten by the
 * scheduler, so their timestamps say nothing about the human).
 */
async function fetchClerkFacts(
  userIds: string[],
  secretKey: string,
): Promise<Map<string, ClerkUserFacts>> {
  const out = new Map<string, ClerkUserFacts>();
  if (userIds.length === 0) return out;

  const client = createClerkClient({ secretKey });

  for (let i = 0; i < userIds.length; i += CLERK_CHUNK) {
    const chunk = userIds.slice(i, i + CLERK_CHUNK);
    try {
      const res = await client.users.getUserList({ userId: chunk, limit: chunk.length });
      for (const u of res.data ?? []) {
        const primary = u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId)
          ?? u.emailAddresses?.[0];
        out.set(u.id, {
          email: primary?.emailAddress ?? null,
          firstName: u.firstName ?? null,
          lastName: u.lastName ?? null,
          signupDate: formatSignupDate(u.createdAt),
          createdAt: u.createdAt ?? null,
          lastActiveAt: u.lastSignInAt ?? null,
        });
      }
    } catch (e) {
      logger.warn("[lifecycle] Clerk user batch failed; those users are skipped this run", {
        error: (e as Error)?.message ?? String(e),
        chunkSize: chunk.length,
      });
    }
  }
  return out;
}

function readClerkSecret(): string | null {
  for (const secret of [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV]) {
    try {
      const v = secret.value()?.trim();
      if (v) return v;
    } catch {
      // Not bound to this function; fall through to the env read below.
    }
  }
  const envVal = process.env.CLERK_SECRET_KEY_PROD?.trim();
  return envVal ? envVal : null;
}

function readResendKey(): string | null {
  try {
    const v = RESEND_API_KEY.value()?.trim();
    if (v) return v;
  } catch {
    // Not bound; fall through.
  }
  const envVal = process.env.RESEND_API_KEY?.trim();
  return envVal ? envVal : null;
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
 */
export async function notifyNoChannelUsers(opts: {
  dryRun: boolean;
  limit: number;
}): Promise<NoChannelNotifyResult> {
  const { dryRun, limit } = opts;

  const [inputs, usersSnap] = await Promise.all([
    loadCoverageInputs(),
    firestore.collection("users").get(),
  ]);

  const tierByUser = new Map<string, Tier>();
  for (const doc of usersSnap.docs) {
    const raw = doc.get("tier");
    tierByUser.set(doc.id, (typeof raw === "string" ? raw : "free") as Tier);
  }

  const rows: UserCoverage[] = [];
  for (const userId of inputs.checksByUser.keys()) {
    rows.push(computeUserCoverage(userId, inputs, tierByUser.get(userId) ?? "free"));
  }
  const coverage = summarizeCoverage(rows);

  const alreadyNotified = new Set<string>();
  for (const doc of usersSnap.docs) {
    const at = doc.get("lifecycle.noChannelNotifiedAt");
    if (typeof at === "number" && at > 0) alreadyNotified.add(doc.id);
  }

  const uncovered = rows.filter((r) => r.enabledCheckCount > 0 && !r.covered);

  const result: NoChannelNotifyResult = {
    dryRun,
    candidates: uncovered.length,
    sent: 0,
    skippedAlreadyNotified: 0,
    skippedTooNew: 0,
    skippedSuppressed: 0,
    skippedNoEmail: 0,
    failed: 0,
    coverage,
    sampleUserIds: [],
  };

  const pending = uncovered.filter((r) => {
    if (alreadyNotified.has(r.userId)) {
      result.skippedAlreadyNotified++;
      return false;
    }
    return true;
  });

  const secretKey = readClerkSecret();
  if (!secretKey) {
    throw new HttpsError("failed-precondition", "No Clerk secret key is configured");
  }
  if (!dryRun && !isTransactionalEmailConfigured()) {
    throw new HttpsError("failed-precondition", "No transactional email provider is configured");
  }

  const facts = await fetchClerkFacts(pending.map((r) => r.userId), secretKey);
  const now = Date.now();
  let budget = limit;

  for (const row of pending) {
    if (budget <= 0) break;
    const f = facts.get(row.userId);
    if (!f?.email) {
      result.skippedNoEmail++;
      continue;
    }
    // A brand-new account is mid-setup, not neglected.
    if (f.createdAt && now - f.createdAt < NO_CHANNEL_GRACE_MS) {
      result.skippedTooNew++;
      continue;
    }
    if (await isEmailSuppressedCached(f.email)) {
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
    try {
      await sendTransactionalEmail({
        to: f.email,
        subject: body.subject,
        html: body.html,
        text: body.text,
        category: "account",
        meta: { kind: "no_alert_channel", userId: row.userId, checks: row.enabledCheckCount },
      });
      // Stamp only after the provider accepted it, so a failed send is retried
      // on the next run instead of being silently marked done.
      await firestore.collection("users").doc(row.userId).set(
        { lifecycle: { noChannelNotifiedAt: Date.now() } },
        { merge: true },
      );
      result.sent++;
      budget--;
      // Resend allows 2 requests/second; the alert path uses the same spacing.
      await new Promise((r) => setTimeout(r, 600));
    } catch (e) {
      result.failed++;
      logger.warn("[lifecycle] no-channel notice failed", {
        userId: row.userId,
        error: (e as Error)?.message ?? String(e),
      });
    }
  }

  logger.info("[lifecycle] no-channel notify complete", result as unknown as Record<string, unknown>);
  return result;
}

/**
 * Admin-only. Sends the alert-coverage notice to affected users.
 *
 * Call with `{ dryRun: true }` first: the response reports exactly how many
 * messages a real run would send, and to how many brand-new or suppressed
 * addresses it would not.
 */
export const notifyUsersWithoutAlertChannel = onCall(
  {
    cors: true,
    timeoutSeconds: 540,
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

    const data = (request.data ?? {}) as { dryRun?: unknown; limit?: unknown };
    // Anything other than an explicit `false` is a dry run.
    const dryRun = data.dryRun !== false;
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(data.limit) || 1000)));

    return notifyNoChannelUsers({ dryRun, limit });
  },
);

// ----------------------------------------------------------------------------
// The sweep
// ----------------------------------------------------------------------------

export interface LifecycleSweepResult {
  dryRun: boolean;
  usersExamined: number;
  firstIncidentEvents: number;
  noChannelEvents: number;
  propertiesSynced: number;
  errors: number;
  coverage: ReturnType<typeof summarizeCoverage>;
}

interface SweepUser {
  userId: string;
  tier: Tier;
  onboarding: { sources: string[]; useCases: string[]; teamSize: string | null } | null;
  firstIncidentEventAt: number;
  noChannelEventAt: number;
  activationSyncedAt: number;
  activationFingerprint: string | null;
}

function readSweepUser(doc: QueryDocumentSnapshot): SweepUser {
  const rawTier = doc.get("tier");
  const rawOnboarding = doc.get("onboarding") as
    | { sources?: unknown; useCases?: unknown; teamSize?: unknown }
    | undefined;

  const onboarding = rawOnboarding && Array.isArray(rawOnboarding.sources)
    ? {
      sources: (rawOnboarding.sources as string[]).filter((s) => typeof s === "string"),
      useCases: Array.isArray(rawOnboarding.useCases)
        ? (rawOnboarding.useCases as string[]).filter((s) => typeof s === "string")
        : [],
      teamSize: typeof rawOnboarding.teamSize === "string" ? rawOnboarding.teamSize : null,
    }
    : null;

  return {
    userId: doc.id,
    tier: (typeof rawTier === "string" ? rawTier : "free") as Tier,
    onboarding,
    firstIncidentEventAt: Number(doc.get("lifecycle.firstIncidentEventAt")) || 0,
    noChannelEventAt: Number(doc.get("lifecycle.noChannelEventAt")) || 0,
    activationSyncedAt: Number(doc.get("lifecycle.activationSyncedAt")) || 0,
    activationFingerprint: (doc.get("lifecycle.activationFingerprint") as string | undefined) ?? null,
  };
}

/**
 * A cheap change detector so an unchanged user costs zero provider calls. Without
 * it the sweep would rewrite ~1600 contacts every night for no reason and burn
 * through provider rate limits.
 */
function activationFingerprint(a: ActivationState, tier: Tier): string {
  return [
    tier,
    a.checkCount ?? "",
    a.checksAlertable ?? "",
    a.hasAlertChannel === undefined ? "" : String(a.hasAlertChannel),
    formatSignupDate(a.firstIncidentAt ?? null) ?? "",
    formatSignupDate(a.lastActiveAt ?? null) ?? "",
  ].join("|");
}

export async function runSweep(opts: { dryRun: boolean }): Promise<LifecycleSweepResult> {
  const { dryRun } = opts;

  const [inputs, usersSnap] = await Promise.all([
    loadCoverageInputs(),
    firestore.collection("users").get(),
  ]);

  const users = usersSnap.docs.map(readSweepUser);
  const byId = new Map(users.map((u) => [u.userId, u]));

  const rows: UserCoverage[] = users.map((u) =>
    computeUserCoverage(u.userId, inputs as CoverageInputs, u.tier));
  const coverage = summarizeCoverage(rows);

  const result: LifecycleSweepResult = {
    dryRun,
    usersExamined: users.length,
    firstIncidentEvents: 0,
    noChannelEvents: 0,
    propertiesSynced: 0,
    errors: 0,
    coverage,
  };

  // A user with no checks has no activation state worth reporting and can trigger
  // neither event, so they never need the Clerk lookup. Everyone else does: the
  // activation properties are refreshed for all of them, and the fingerprint
  // check below is what keeps an unchanged user from costing a provider write.
  const interesting = rows.filter((r) => r.checkCount > 0 && byId.has(r.userId));

  const secretKey = readClerkSecret();
  if (!secretKey) {
    logger.warn("[lifecycle] no Clerk secret configured; sweep cannot resolve emails");
    return result;
  }
  const facts = await fetchClerkFacts(interesting.map((r) => r.userId), secretKey);
  const resendKey = readResendKey();

  let day3Key: string | undefined;
  try {
    day3Key = DAY3_API_KEY.value()?.trim() || undefined;
  } catch {
    day3Key = process.env.DAY3_API_KEY?.trim() || undefined;
  }

  for (const row of interesting) {
    const u = byId.get(row.userId);
    const f = facts.get(row.userId);
    if (!u || !f?.email) continue;

    const activation: ActivationState = {
      checkCount: row.checkCount,
      checksAlertable: row.emailCoveredCheckCount,
      hasAlertChannel: row.covered,
      firstIncidentAt: row.firstIncidentAt,
      lastActiveAt: f.lastActiveAt,
    };

    const stamps: Record<string, number | string> = {};

    // ---- Activation properties ----
    const fingerprint = activationFingerprint(activation, u.tier);
    if (fingerprint !== u.activationFingerprint) {
      if (!dryRun) {
        try {
          const properties = buildPropertiesForUser({
            signupDate: f.signupDate,
            tier: u.tier,
            onboarding: u.onboarding,
            activation,
          });
          const sync = await syncContactToProviders({
            email: f.email,
            firstName: f.firstName,
            lastName: f.lastName,
            properties,
            resendApiKey: resendKey ?? undefined,
            day3ApiKey: day3Key,
            userId: row.userId,
          });
          if (sync.resend.success || sync.day3.success) {
            stamps["lifecycle.activationSyncedAt"] = Date.now();
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
      } else {
        result.propertiesSynced++;
      }
    }

    // ---- user.first_incident_caught ----
    if (row.firstIncidentAt !== null && u.firstIncidentEventAt === 0) {
      result.firstIncidentEvents++;
      if (!dryRun && resendKey) {
        const ev = await triggerResendEvent(resendKey, f.email, "user.first_incident_caught", {
          userId: row.userId,
          firstIncidentAt: row.firstIncidentAt,
          checkCount: row.checkCount,
          hasAlertChannel: row.covered,
        });
        if (ev.success) {
          stamps["lifecycle.firstIncidentEventAt"] = Date.now();
        } else {
          result.errors++;
          logger.warn("[lifecycle] user.first_incident_caught failed", {
            userId: row.userId,
            error: ev.error,
          });
        }
      }
    }

    // ---- user.no_alert_channel ----
    const tooNew = f.createdAt !== null && Date.now() - f.createdAt < NO_CHANNEL_GRACE_MS;
    if (row.enabledCheckCount > 0 && !row.covered && u.noChannelEventAt === 0 && !tooNew) {
      result.noChannelEvents++;
      if (!dryRun && resendKey) {
        const ev = await triggerResendEvent(resendKey, f.email, "user.no_alert_channel", {
          userId: row.userId,
          checkCount: row.enabledCheckCount,
        });
        if (ev.success) {
          stamps["lifecycle.noChannelEventAt"] = Date.now();
        } else {
          result.errors++;
          logger.warn("[lifecycle] user.no_alert_channel failed", {
            userId: row.userId,
            error: ev.error,
          });
        }
      }
    }

    if (!dryRun && Object.keys(stamps).length > 0) {
      try {
        await firestore.collection("users").doc(row.userId).update(stamps);
      } catch (e) {
        result.errors++;
        logger.debug("[lifecycle] failed to stamp lifecycle state", {
          userId: row.userId,
          error: (e as Error)?.message ?? String(e),
        });
      }
    }
  }

  logger.info("[lifecycle] sweep complete", result as unknown as Record<string, unknown>);
  return result;
}

export const lifecycleSweep = onSchedule(
  {
    schedule: "every day 07:00",
    timeZone: "UTC",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    secrets: [
      CLERK_SECRET_KEY_PROD,
      CLERK_SECRET_KEY_DEV,
      RESEND_API_KEY,
      DAY3_API_KEY,
    ],
  },
  async () => {
    await runSweep({ dryRun: false });
  },
);

/** Admin-only on-demand run. Defaults to a dry run, like the notifier. */
export const runLifecycleSweep = onCall(
  {
    cors: true,
    timeoutSeconds: 540,
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
    return runSweep({ dryRun });
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

    const [inputs, usersSnap] = await Promise.all([
      loadCoverageInputs(),
      firestore.collection("users").select("tier", "onboarding").get(),
    ]);

    const tierByUser = new Map<string, Tier>();
    const hasAnswers = new Set<string>();
    for (const doc of usersSnap.docs) {
      const raw = doc.get("tier");
      tierByUser.set(doc.id, (typeof raw === "string" ? raw : "free") as Tier);
      const onboarding = doc.get("onboarding") as { sources?: unknown } | undefined;
      if (onboarding && Array.isArray(onboarding.sources)) hasAnswers.add(doc.id);
    }

    const rows = [...inputs.checksByUser.keys()].map((userId) =>
      computeUserCoverage(userId, inputs, tierByUser.get(userId) ?? "free"));

    const active = rows.filter((r) => r.enabledCheckCount > 0);
    const bucket = (predicate: (r: UserCoverage) => boolean) => {
      const set = active.filter(predicate);
      return {
        users: set.length,
        covered: set.filter((r) => r.covered).length,
      };
    };

    return {
      ...summarizeCoverage(rows),
      byCohort: {
        onboardedPaid: bucket((r) =>
          hasAnswers.has(r.userId) && (tierByUser.get(r.userId) ?? "free") !== "free"),
        onboardedFree: bucket((r) =>
          hasAnswers.has(r.userId) && (tierByUser.get(r.userId) ?? "free") === "free"),
        preOnboarding: bucket((r) => !hasAnswers.has(r.userId)),
      },
    };
  },
);
