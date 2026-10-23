import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createClerkClient } from "@clerk/backend";
import { firestore } from "./init";
import { Website, WebhookEvent } from "./types";
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV, getClerkSecretKey } from "./env";
import { fetchClerkEmails } from "./clerk-users";
import { sendTransactionalEmail } from "./email-send";
import { isEmailSuppressedCached } from "./email-suppression";
import { formatStatusCode } from "./alert-helpers";
import {
  decideFollowerNotification,
  normalizeFollowerAlertState,
  type FollowerEvent,
} from "./public-follow-policy";
import { isProbeRefusal } from "./public-monitor-blocked";
import { confirmedEmailFollowers, emailFollowUnsubscribeUrl } from "./public-email-follows";

/**
 * Followed services: any exit1 user can follow a public monitor (the curated
 * checks behind exit1.dev/status/<slug>) and get an email when it goes down
 * and when it recovers. The checks already run for the status pages, so a
 * follow costs one Firestore doc and never counts against plan limits.
 *
 *   public_monitor_follows/{uid}__{checkId}   one doc per follow
 *   public_monitor_alert_state/{checkId}      last announced event, dedupe key
 *
 * People without an account can follow by email too (public-email-follows.ts).
 * Both kinds get the same transitions from the fan-out below.
 *
 * Fan-out is triggered from triggerAlert (alert.ts), which runs on the VPS.
 */

const FOLLOWS = "public_monitor_follows";
const ALERT_STATE = "public_monitor_alert_state";
const PAGES = "public_monitor_pages";
const INDEX_DOC = "public_monitors/index";

/** Abuse guard, far above anything a person would follow by hand. */
const MAX_FOLLOWS_PER_USER = 200;

/**
 * Pace follower emails at one per second. Resend's rate limit is shared with
 * paying customers' own alerts, and a big fan-out must not starve them.
 */
const SEND_SPACING_MS = 1000;

const APP_URL = process.env.FRONTEND_URL || "https://app.exit1.dev";
const SITE_URL = "https://exit1.dev";

type FollowDoc = {
  userId: string;
  checkId: string;
  slug: string;
  name: string;
  host: string;
  /** Primary email at follow time. Fallback when Clerk is unreachable at send time. */
  email: string | null;
  createdAt: number;
};

export type PublicMonitorFollow = {
  checkId: string;
  slug: string;
  name: string;
  host: string;
  status: string;
  uptime30d: number | null;
  createdAt: number;
};

const followId = (uid: string, checkId: string) => `${uid}__${checkId}`;

const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function requireUid(request: { auth?: { uid?: string } }): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
  return uid;
}

async function primaryEmailFor(uid: string): Promise<string | null> {
  const secretKey = getClerkSecretKey();
  if (!secretKey) return null;
  try {
    const user = await createClerkClient({ secretKey }).users.getUser(uid);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
    return primary?.emailAddress ?? null;
  } catch (error) {
    logger.warn("[follows] Clerk lookup failed", { uid, error: (error as Error)?.message });
    return null;
  }
}

// ── Callables ───────────────────────────────────────────────────────────────

export const followPublicMonitor = onCall(
  { cors: true, maxInstances: 10, secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
    const uid = requireUid(request);
    const slug = slugify(String(request.data?.slug ?? ""));
    if (!slug) throw new HttpsError("invalid-argument", "slug is required");

    const page = await firestore.collection(PAGES).doc(slug).get();
    if (!page.exists) throw new HttpsError("not-found", "No public monitor with that name");
    const p = page.data() as { checkId: string; name: string; host: string; status?: string; uptime30d?: number | null };

    const ref = firestore.collection(FOLLOWS).doc(followId(uid, p.checkId));
    const existing = await ref.get();
    if (!existing.exists) {
      const count = await firestore.collection(FOLLOWS).where("userId", "==", uid).count().get();
      if (count.data().count >= MAX_FOLLOWS_PER_USER) {
        throw new HttpsError("resource-exhausted", `You can follow up to ${MAX_FOLLOWS_PER_USER} services`);
      }
    }

    const createdAt = existing.exists ? (existing.data() as FollowDoc).createdAt : Date.now();
    const doc: FollowDoc = {
      userId: uid,
      checkId: p.checkId,
      slug,
      name: p.name,
      host: p.host,
      email: await primaryEmailFor(uid),
      createdAt,
    };
    await ref.set(doc);
    if (!existing.exists) logger.info("[follows] followed", { uid, slug });

    const follow: PublicMonitorFollow = {
      checkId: p.checkId,
      slug,
      name: p.name,
      host: p.host,
      status: p.status ?? "unknown",
      uptime30d: p.uptime30d ?? null,
      createdAt,
    };
    return { success: true, data: follow };
  },
);

export const unfollowPublicMonitor = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const uid = requireUid(request);
  const checkId = typeof request.data?.checkId === "string" ? request.data.checkId : "";
  if (!checkId) throw new HttpsError("invalid-argument", "checkId is required");
  await firestore.collection(FOLLOWS).doc(followId(uid, checkId)).delete();
  return { success: true };
});

export const listPublicMonitorFollows = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const uid = requireUid(request);
  const [snap, index] = await Promise.all([
    firestore.collection(FOLLOWS).where("userId", "==", uid).get(),
    firestore.doc(INDEX_DOC).get(),
  ]);

  // Live status comes from the hourly index; the follow doc only pins identity.
  const bySlug = new Map<string, { status?: string; uptime30d?: number | null; name?: string }>();
  for (const m of (index.data()?.monitors ?? []) as Array<{ slug: string; status?: string; uptime30d?: number | null; name?: string }>) {
    bySlug.set(m.slug, m);
  }

  const follows: PublicMonitorFollow[] = snap.docs.map((d) => {
    const f = d.data() as FollowDoc;
    const live = bySlug.get(f.slug);
    return {
      checkId: f.checkId,
      slug: f.slug,
      name: live?.name ?? f.name,
      host: f.host,
      status: live?.status ?? "unknown",
      uptime30d: live?.uptime30d ?? null,
      createdAt: f.createdAt,
    };
  });
  follows.sort((a, b) => a.name.localeCompare(b.name));
  return { success: true, data: follows };
});

// ── Fan-out ─────────────────────────────────────────────────────────────────

/**
 * Claim the right to announce this transition. The transaction makes retries
 * and concurrent probes of the same check collapse to one email per follower.
 */
async function claimAnnouncement(checkId: string, event: FollowerEvent): Promise<boolean> {
  const ref = firestore.collection(ALERT_STATE).doc(checkId);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const decision = decideFollowerNotification(normalizeFollowerAlertState(snap.data()), event, Date.now());
    if (!decision.send) return false;
    tx.set(ref, { ...decision.next, updatedAt: Date.now() });
    return true;
  });
}

async function resolveRecipients(follows: FollowDoc[]): Promise<string[]> {
  const secretKey = getClerkSecretKey();
  const fresh = secretKey
    ? await fetchClerkEmails(follows.map((f) => f.userId), secretKey, "follows")
    : new Map<string, string>();

  // An empty result for a non-empty list means Clerk was unreachable, not that
  // every follower deleted their account. Fall back to the addresses stored at
  // follow time. Otherwise a user missing from a good response is gone.
  const useStored = fresh.size === 0;
  const out = new Set<string>();
  for (const f of follows) {
    const email = useStored ? f.email : fresh.get(f.userId);
    if (email) out.add(email.toLowerCase());
  }
  return [...out];
}

/** Who an email goes to decides its footer: account followers manage follows in the app. */
type Audience = { kind: "account" } | { kind: "email"; unsubscribeUrl: string };

function buildEmail(website: Website, event: FollowerEvent, slug: string, audience: Audience) {
  const name = website.name;
  const isDown = event === "website_down";
  const subject = isDown ? `${name} is down` : `${name} is back up`;
  const utm = "utm_source=follow_email&utm_medium=email&utm_campaign=followed_service";
  const statusUrl = `${SITE_URL}/status/${encodeURIComponent(slug)}?${utm}`;
  const manageUrl = `${APP_URL}/following`;
  const monitorOwnUrl = audience.kind === "account" ? `${APP_URL}/checks?${utm}` : `${APP_URL}/sign-up?${utm}`;
  const unfollowUrl = audience.kind === "account" ? manageUrl : audience.unsubscribeUrl;
  const ownCta = audience.kind === "account" ? "Add a check" : "Create a free account";

  const when = new Date().toUTCString();
  const code = formatStatusCode(website.lastStatusCode);
  const detailLines: string[] = [];
  if (isDown && code) detailLines.push(`Status code: ${code}`);
  if (isDown && website.lastError) detailLines.push(`Error: ${String(website.lastError).slice(0, 300)}`);
  if (isDown && website.peerReachable === true && website.peerStatus === "offline" && website.peerRegion) {
    detailLines.push("Confirmed from two regions.");
  }

  const lead = isDown
    ? `exit1 can't reach ${name} (${website.url}). We noticed at ${when}.`
    : `${name} (${website.url}) is responding again as of ${when}.`;

  const text = [
    subject,
    "",
    lead,
    ...(detailLines.length ? ["", ...detailLines] : []),
    "",
    `Live status and outage history: ${statusUrl}`,
    "",
    `Want the same alert for your own site? ${monitorOwnUrl}`,
    "",
    `You get this because you follow ${name} on exit1. Unfollow: ${unfollowUrl}`,
  ].join("\n");

  const detailsHtml = detailLines.map((l) => `<div style="color:#94a3b8;font-size:14px">${escapeHtml(l)}</div>`).join("");
  const accent = isDown ? "#f87171" : "#4ade80";
  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${accent};margin-right:8px;vertical-align:middle"></span>${escapeHtml(subject)}</h2>
        <p style="margin:0 0 12px 0">${escapeHtml(lead)}</p>
        ${detailsHtml ? `<div style="margin:12px 0">${detailsHtml}</div>` : ""}
        <div style="margin:16px 0 0 0">
          <a href="${statusUrl}" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:12px;font-weight:500">Live status and outage history</a>
        </div>
        <p style="margin:20px 0 0 0;color:#cbd5e1;font-size:14px">Want this for your own site? <a href="${monitorOwnUrl}" style="color:#38bdf8;text-decoration:none">${ownCta}</a>. It's free for 50 sites.</p>
        <p style="margin:16px 0 0 0;color:#64748b;font-size:12px">You get this because you follow ${escapeHtml(name)} on exit1. <a href="${unfollowUrl}" style="color:#64748b">Unfollow</a></p>
      </div>
    </div>`;

  return { subject, text, html };
}

/**
 * Email every follower of a public monitor about a status transition. Called
 * fire-and-forget from triggerAlert, so it never throws and never delays the
 * owner's own alert path.
 */
export async function notifyPublicMonitorFollowers(website: Website, eventType: WebhookEvent): Promise<void> {
  if (eventType !== "website_down" && eventType !== "website_up") return;
  // A bot firewall or a 4xx refusing our probe says nothing about the service.
  // Never tell followers openai.com is down because Cloudflare challenged us,
  // or homebrew.sh because it rate-limited us. The matching recovery is then
  // skipped as no_prior_down.
  if (eventType === "website_down" && isProbeRefusal(website.lastError, website.lastStatusCode)) return;
  try {
    // Claim before looking for followers. A down nobody followed still has to
    // be recorded, or whoever follows mid-outage (the people on the status page
    // right then) gets no recovery email: it would read as no_prior_down.
    if (!(await claimAnnouncement(website.id, eventType))) return;

    const [snap, emailFollows] = await Promise.all([
      firestore.collection(FOLLOWS).where("checkId", "==", website.id).get(),
      confirmedEmailFollowers(website.id),
    ]);
    if (snap.empty && emailFollows.length === 0) return;

    const follows = snap.docs.map((d) => d.data() as FollowDoc);
    const slug = follows[0]?.slug ?? emailFollows[0].slug;
    const accountRecipients = follows.length ? await resolveRecipients(follows) : [];
    const seen = new Set(accountRecipients);
    const sends: Array<{ to: string; audience: Audience }> = accountRecipients.map((to) => ({ to, audience: { kind: "account" } }));
    for (const f of emailFollows) {
      if (seen.has(f.email)) continue;
      seen.add(f.email);
      sends.push({ to: f.email, audience: { kind: "email", unsubscribeUrl: emailFollowUnsubscribeUrl(f.token) } });
    }

    let sent = 0;
    let failed = 0;
    for (const { to, audience } of sends) {
      if (await isEmailSuppressedCached(to)) continue;
      const { subject, text, html } = buildEmail(website, eventType, slug, audience);
      try {
        await sendTransactionalEmail({
          to,
          subject,
          html,
          text,
          category: "alerts",
          meta: { checkId: website.id, eventType, kind: audience.kind === "account" ? "follower" : "email_follower" },
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        logger.warn("[follows] follower email failed", { checkId: website.id, error: (error as Error)?.message });
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_SPACING_MS));
    }
    logger.info(`[follows] ${website.name} ${eventType}: ${sent} sent, ${failed} failed, ${follows.length} account + ${emailFollows.length} email followers`);
  } catch (error) {
    logger.error("[follows] fan-out failed", { checkId: website.id, error: (error as Error)?.message });
  }
}
