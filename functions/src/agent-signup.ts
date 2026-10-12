/**
 * Agent signup: an AI agent creates an exit1 account for a person and gets a
 * working token straight away, with no human in the loop.
 *
 *   POST /oauth/agent-signup  { email, agent_name }  (served by mcpOauth)
 *     → Clerk user + users/{uid}.agentSignup + an OAuth token pair
 *     → claim email to the address, carrying a one-time Clerk sign-in ticket
 *
 * The account is "unclaimed" until the owner opens that email and decides on
 * /claim whether the agent keeps access. Until then:
 *   - checks the agent creates carry `agentUnclaimed`, so probes run but no
 *     alert is delivered (verifyAlertable, alert-dns, alert-domain);
 *   - test alerts are refused, and the account stays out of Resend/Day3;
 *   - the agent's token stops working the moment anyone signs in as the user
 *     without claiming (agentTokenAllowed), which closes the pre-account
 *     takeover an agent could otherwise mount with someone else's address.
 * Unclaimed accounts are paused after 7 days and deleted after 30
 * (runAgentSignupExpiry, a VPS cron).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { FieldValue } from "firebase-admin/firestore";
import { firestore, getClerkClient } from "./init";
import { FixedWindowRateLimiter, getClientIp } from "./rate-limit";
import { DEFAULT_MCP_SCOPES } from "./mcp-oauth-policy";
import type { ApiScope } from "./api-scopes";
import {
  agentSignupExpiryAction,
  agentTokenAllowed,
  buildClaimEmail,
  normalizeSignupEmail,
  sanitizeAgentName,
  type AgentSignupState,
} from "./agent-signup-policy";
import { sendTransactionalEmail, isTransactionalEmailConfigured } from "./email-send";
import { getActiveSuppressions } from "./email-suppression";
import { notifyCheckEdit } from "./checks";
import { notifySettingsEdit } from "./check-helpers";
import { deleteAllUserData } from "./users";
import { syncSignupToEmailProviders } from "./clerk-webhook";
import {
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
  RESEND_API_KEY,
  RESEND_FROM,
  DAY3_API_KEY,
  DAY3_FROM,
} from "./env";

const APP_ORIGIN = "https://app.exit1.dev";
export const AGENT_SIGNUP_CLIENT_ID = "agent-signup";
const CLAIM_TICKET_TTL_SECONDS = 30 * 24 * 60 * 60;
const PAUSED_REASON = "Unclaimed agent account: open the claim email to resume";

const MAX_SIGNUPS_PER_IP_PER_HOUR = 3;
const MAX_SIGNUPS_PER_DAY = 200;
const signupLimiter = new FixedWindowRateLimiter({ windowMs: 60 * 60 * 1000, maxKeys: 10_000 });

type ClerkInstance = "prod" | "dev";

interface StoredAgentSignup extends AgentSignupState {
  clerkInstance: ClerkInstance;
}

function clerkFor(instance: ClerkInstance) {
  return getClerkClient(instance);
}

/** Prod when its key is loaded, else dev (local emulator runs). */
function defaultInstance(): ClerkInstance | null {
  if (clerkFor("prod")) return "prod";
  if (clerkFor("dev")) return "dev";
  return null;
}

async function readState(uid: string): Promise<StoredAgentSignup | null> {
  const snap = await firestore.collection("users").doc(uid).get();
  const state = snap.exists ? (snap.data()?.agentSignup as StoredAgentSignup | undefined) : undefined;
  return state ?? null;
}

// ── Token gate (called by resolveBearerToken for agent-signup tokens) ──

/**
 * Whether an agent-signup token may act right now, and whether its account is
 * still unclaimed (new checks are then created with alerts held). Fails closed:
 * if we can't ask Clerk whether someone has signed in, the token doesn't work.
 */
export async function checkAgentToken(uid: string): Promise<{ allowed: boolean; unclaimed: boolean }> {
  const state = await readState(uid);
  if (!state) return { allowed: false, unclaimed: false };
  if (state.status === "claimed") return { allowed: true, unclaimed: false };

  const clerk = clerkFor(state.clerkInstance);
  if (!clerk) {
    logger.error("Agent token check: no Clerk client for instance", { uid, instance: state.clerkInstance });
    return { allowed: false, unclaimed: true };
  }
  try {
    const user = await clerk.users.getUser(uid);
    return { allowed: agentTokenAllowed(state, user.lastSignInAt ?? null), unclaimed: true };
  } catch (error) {
    logger.warn("Agent token check: Clerk lookup failed, refusing", { uid, error });
    return { allowed: false, unclaimed: true };
  }
}

// ── POST /oauth/agent-signup ──

type HttpReq = { body?: unknown; headers?: Record<string, unknown>; ip?: unknown };
type HttpRes = { status: (n: number) => { json: (b: unknown) => void } };

type IssueTokens = (params: {
  userId: string;
  clientId: string;
  clientName: string;
  scopes: ApiScope[];
  provisional: boolean;
}) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;

function fail(res: HttpRes, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

/** Global cap per UTC day, so a distributed signup flood stops at a known size. */
async function consumeDailySignup(): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const ref = firestore.collection("system_counters").doc(`agent_signups_${day}`);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number(snap.data()?.count) || 0 : 0;
    if (count >= MAX_SIGNUPS_PER_DAY) return false;
    tx.set(ref, { count: count + 1, expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) }, { merge: true });
    return true;
  });
}

export async function handleAgentSignup(req: HttpReq, res: HttpRes, issueTokens: IssueTokens): Promise<void> {
  const ip = getClientIp(req);
  if (!signupLimiter.consume(`signup:${ip}`, MAX_SIGNUPS_PER_IP_PER_HOUR).allowed) {
    fail(res, 429, "temporarily_unavailable", "Too many signups from this address. Try again later.");
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const email = normalizeSignupEmail(body.email);
  if (!email) {
    fail(res, 400, "invalid_request", "email is required and must be a valid address");
    return;
  }
  const agentName = sanitizeAgentName(body.agent_name);

  const instance = defaultInstance();
  const clerk = instance ? clerkFor(instance) : null;
  if (!instance || !clerk || !isTransactionalEmailConfigured()) {
    logger.error("Agent signup unavailable: Clerk or email not configured", { instance });
    fail(res, 503, "temporarily_unavailable", "Signup is unavailable right now.");
    return;
  }

  if ((await getActiveSuppressions([email])).length > 0) {
    fail(res, 400, "invalid_request", "This address can't receive email from exit1, so it can't be used to sign up.");
    return;
  }

  const existing = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  if (existing.data.length > 0) {
    fail(
      res,
      409,
      "account_exists",
      "An exit1 account already uses this email. Connect to it with OAuth instead: add the MCP server " +
        `${APP_ORIGIN}/mcp/v1 to your client and sign in, or ask the owner for an API key.`
    );
    return;
  }

  if (!(await consumeDailySignup())) {
    fail(res, 429, "temporarily_unavailable", "Agent signups are at today's limit. Try again tomorrow.");
    return;
  }

  const now = Date.now();
  const user = await clerk.users.createUser({
    emailAddress: [email],
    skipPasswordRequirement: true,
    // Terms are accepted by the owner on the claim page, not by the agent.
    skipLegalChecks: true,
    publicMetadata: { agentSignup: { status: "unclaimed" } },
  });
  const uid = user.id;

  const state: StoredAgentSignup = { status: "unclaimed", agentName, email, createdAt: now, clerkInstance: instance };
  await firestore
    .collection("users")
    .doc(uid)
    .set({ agentSignup: state, acquisitionOrigin: "agent_signup" }, { merge: true });

  const tokens = await issueTokens({
    userId: uid,
    clientId: AGENT_SIGNUP_CLIENT_ID,
    clientName: agentName,
    scopes: [...DEFAULT_MCP_SCOPES],
    provisional: true,
  });

  // The ticket goes to the inbox only. Handing it to the agent would give it a
  // browser session on an address it hasn't proven it owns.
  let claimEmailSent = false;
  try {
    const ticket = await clerk.signInTokens.createSignInToken({ userId: uid, expiresInSeconds: CLAIM_TICKET_TTL_SECONDS });
    const claimUrl = `${APP_ORIGIN}/claim?ticket=${encodeURIComponent(ticket.token)}`;
    const mail = buildClaimEmail({ agentName, email, claimUrl });
    await sendTransactionalEmail({
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      category: "account",
      meta: { kind: "agent_signup_claim", userId: uid },
    });
    claimEmailSent = true;
  } catch (error) {
    // The owner can still sign in with an email code; the app routes an
    // unclaimed account to /claim either way.
    logger.error("Agent signup: claim email failed", { uid, error });
  }

  logger.info("Agent signup created account", { uid, agentName, instance, claimEmailSent });

  res.status(201).json({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: DEFAULT_MCP_SCOPES.join(" "),
    account: { email, status: "unclaimed", claim_email_sent: claimEmailSent },
    mcp_url: `${APP_ORIGIN}/mcp/v1`,
    api_base: `${APP_ORIGIN}/v1/public`,
    next_steps:
      `Tell the user to open the email sent to ${email} and claim the account. Until they do, checks run but ` +
      "no alerts are delivered and test alerts are refused. The token stops working if the user signs in without " +
      "claiming. Unclaimed accounts are paused after 7 days and deleted after 30.",
  });
}

// ── Claim callables (the /claim page) ──

export const getAgentClaim = onCall(
  { cors: true, maxInstances: 10, secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
    const state = await readState(uid);
    if (!state) throw new HttpsError("not-found", "This account wasn't created by an agent");

    const count = await firestore.collection("checks").where("userId", "==", uid).count().get();
    return {
      success: true,
      data: {
        status: state.status,
        agentName: state.agentName,
        email: state.email,
        checkCount: count.data().count,
        createdAt: state.createdAt,
      },
    };
  }
);

async function setChecksClaimed(uid: string): Promise<number> {
  const snap = await firestore.collection("checks").where("userId", "==", uid).get();
  const touched: string[] = [];
  const batchSize = 400;
  for (let i = 0; i < snap.docs.length; i += batchSize) {
    const batch = firestore.batch();
    for (const doc of snap.docs.slice(i, i + batchSize)) {
      const data = doc.data();
      const update: { [field: string]: FirebaseFirestore.FieldValue | boolean } = {
        agentUnclaimed: FieldValue.delete(),
      };
      // Undo the expiry sweep's pause, and only that pause.
      if (data.disabled === true && data.disabledReason === PAUSED_REASON) {
        update.disabled = false;
        update.disabledReason = FieldValue.delete();
        update.disabledAt = FieldValue.delete();
      }
      batch.update(doc.ref, update);
      touched.push(doc.id);
    }
    await batch.commit();
  }
  await Promise.all(touched.map((id) => notifyCheckEdit(id, "modified")));
  return touched.length;
}

async function revokeAgentTokens(uid: string): Promise<void> {
  const snap = await firestore
    .collection("mcp_oauth_tokens")
    .where("userId", "==", uid)
    .where("clientId", "==", AGENT_SIGNUP_CLIENT_ID)
    .get();
  const batch = firestore.batch();
  snap.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  if (!snap.empty) await batch.commit();
}

async function enableEmailAlertsTo(uid: string, email: string): Promise<void> {
  const ref = firestore.collection("emailSettings").doc(uid);
  const now = Date.now();
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() || {} : {};
    const recipients: string[] = Array.isArray(existing.recipients) ? existing.recipients : [];
    const merged = recipients.some((r) => r.toLowerCase() === email) ? recipients : [...recipients, email];
    const events: string[] =
      Array.isArray(existing.events) && existing.events.length ? existing.events : ["website_down", "website_up"];
    tx.set(
      ref,
      {
        userId: uid,
        enabled: true,
        recipients: merged,
        events,
        ...(existing.checkFilter ? {} : { checkFilter: { mode: "all" } }),
        updatedAt: now,
        ...(snap.exists ? {} : { createdAt: now }),
      },
      { merge: true }
    );
  });
  await notifySettingsEdit(uid);
}

export const claimAgentAccount = onCall(
  {
    cors: true,
    maxInstances: 10,
    secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV, RESEND_API_KEY, RESEND_FROM, DAY3_API_KEY, DAY3_FROM],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
    const keepAgentAccess = request.data?.keepAgentAccess === true;
    const emailAlerts = request.data?.emailAlerts !== false;

    const state = await readState(uid);
    if (!state) throw new HttpsError("not-found", "This account wasn't created by an agent");
    if (state.status === "claimed") return { success: true };

    if (!keepAgentAccess) await revokeAgentTokens(uid);

    const now = Date.now();
    await firestore
      .collection("users")
      .doc(uid)
      .set(
        {
          // The claim page states that claiming accepts the Terms; the agent never could.
          agentSignup: { status: "claimed", claimedAt: now, termsAcceptedAt: now, keptAgentAccess: keepAgentAccess },
          onboardingCompletedAt: now,
        },
        { merge: true }
      );

    const checks = await setChecksClaimed(uid);
    if (emailAlerts) await enableEmailAlertsTo(uid, state.email);

    const clerk = clerkFor(state.clerkInstance);
    if (clerk) {
      try {
        await clerk.users.updateUserMetadata(uid, {
          publicMetadata: { agentSignup: { status: "claimed" }, onboardingCompletedAt: now },
        });
        const user = await clerk.users.getUser(uid);
        await syncSignupToEmailProviders({
          userId: uid,
          email: state.email,
          firstName: user.firstName,
          lastName: user.lastName,
          createdAt: user.createdAt,
        });
      } catch (error) {
        // The claim itself is done; a stale metadata flag only means one more
        // trip through /claim, which returns straight to the dashboard.
        logger.warn("Agent claim: Clerk/provider follow-up failed", { uid, error });
      }
    }

    logger.info("Agent account claimed", { uid, keepAgentAccess, emailAlerts, checks });
    return { success: true };
  }
);

// ── Expiry (VPS cron) ──

export async function runAgentSignupExpiry(): Promise<void> {
  const now = Date.now();
  const snap = await firestore.collection("users").where("agentSignup.status", "==", "unclaimed").get();
  let paused = 0;
  let deleted = 0;

  for (const doc of snap.docs) {
    const state = doc.data().agentSignup as StoredAgentSignup;
    const action = agentSignupExpiryAction(state, now);
    try {
      if (action === "pause") {
        const checks = await firestore.collection("checks").where("userId", "==", doc.id).get();
        const batch = firestore.batch();
        const ids: string[] = [];
        for (const c of checks.docs) {
          if (c.data().disabled === true) continue;
          batch.update(c.ref, { disabled: true, disabledReason: PAUSED_REASON, disabledAt: now });
          ids.push(c.id);
        }
        batch.update(doc.ref, { "agentSignup.pausedAt": now });
        await batch.commit();
        await Promise.all(ids.map((id) => notifyCheckEdit(id, "modified")));
        paused++;
      } else if (action === "delete") {
        await deleteAllUserData(doc.id);
        const clerk = clerkFor(state.clerkInstance);
        await clerk?.users.deleteUser(doc.id).catch((error: unknown) => {
          logger.warn("Agent signup expiry: Clerk delete failed", { uid: doc.id, error });
        });
        deleted++;
      }
    } catch (error) {
      logger.error("Agent signup expiry failed for user", { uid: doc.id, action, error });
    }
  }

  logger.info("Agent signup expiry sweep", { unclaimed: snap.size, paused, deleted });
}
