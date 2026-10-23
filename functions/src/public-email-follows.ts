import { onRequest, type Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import * as logger from "firebase-functions/logger";
import { createHash, randomBytes } from "crypto";
import { firestore } from "./init";
import { sendTransactionalEmail } from "./email-send";
import { isEmailSuppressedCached } from "./email-suppression";
import { FixedWindowRateLimiter, getClientIp } from "./rate-limit";
import {
  normalizeEmail,
  decideConfirmSend,
  normalizeEmailSendWindow,
  isConfirmTokenExpired,
} from "./public-email-follow-policy";

/**
 * Email-only follows: someone on exit1.dev/status/<slug> types an address and
 * gets the same down/up emails an account follower gets, without signing up.
 * Built because outage visitors clicked "Alert me" and none of them finished
 * the account sign-up (2026-10-21, PECL and Launchpad).
 *
 *   public_monitor_email_follows/{emailHash}__{checkId}   one doc per follow
 *   public_follow_email_limits/{emailHash}                confirm-send window
 *
 * Double opt-in: nothing but the confirmation email goes out until the link in
 * it is clicked. The same token later unsubscribes.
 *
 * Routes (hosting rewrites /v1/public/follow and /v1/public/follow/**):
 *   POST /v1/public/follow                 { email, slug, company }
 *   GET  /v1/public/follow/confirm?token=  302 to exit1.dev/follow
 *   GET|POST /v1/public/follow/unsubscribe?token=
 */

export const EMAIL_FOLLOWS = "public_monitor_email_follows";
const EMAIL_LIMITS = "public_follow_email_limits";
const PAGES = "public_monitor_pages";

const API_URL = process.env.FRONTEND_URL || "https://app.exit1.dev";
const SITE_URL = "https://exit1.dev";

const MAX_FOLLOWS_PER_IP_PER_HOUR = 20;
const ipLimiter = new FixedWindowRateLimiter({ windowMs: 60 * 60 * 1000, maxKeys: 10_000 });

export type EmailFollowDoc = {
  email: string;
  emailHash: string;
  checkId: string;
  slug: string;
  name: string;
  host: string;
  token: string;
  confirmed: boolean;
  createdAt: number;
  confirmedAt: number | null;
};

const hashEmail = (email: string) => createHash("sha256").update(email).digest("hex").slice(0, 32);

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

export function emailFollowUnsubscribeUrl(token: string): string {
  return `${API_URL}/v1/public/follow/unsubscribe?token=${encodeURIComponent(token)}`;
}

function landingUrl(state: "confirmed" | "unsubscribed" | "invalid", follow?: Pick<EmailFollowDoc, "slug" | "name">): string {
  const params = new URLSearchParams({ state });
  if (follow) {
    params.set("slug", follow.slug);
    params.set("name", follow.name);
  }
  return `${SITE_URL}/follow?${params.toString()}`;
}

/** Confirmed email followers of one check. Read by the fan-out in public-monitor-follows.ts. */
export async function confirmedEmailFollowers(checkId: string): Promise<EmailFollowDoc[]> {
  const snap = await firestore.collection(EMAIL_FOLLOWS).where("checkId", "==", checkId).get();
  return snap.docs.map((d) => d.data() as EmailFollowDoc).filter((f) => f.confirmed);
}

/** Atomically spend one confirmation send for this address, or refuse. */
async function claimConfirmSend(emailHash: string): Promise<boolean> {
  const ref = firestore.collection(EMAIL_LIMITS).doc(emailHash);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const decision = decideConfirmSend(normalizeEmailSendWindow(snap.data()), Date.now());
    if (!decision.allowed) return false;
    tx.set(ref, decision.next);
    return true;
  });
}

function buildConfirmEmail(follow: EmailFollowDoc, isDown: boolean) {
  const name = follow.name;
  const confirmUrl = `${API_URL}/v1/public/follow/confirm?token=${encodeURIComponent(follow.token)}`;
  const subject = isDown ? `Confirm: email me when ${name} is back up` : `Confirm: email me when ${name} goes down`;
  const lead = isDown
    ? `${name} (${follow.host}) is down right now. Confirm and we'll email you the moment it responds again, and again the next time it breaks.`
    : `Confirm and we'll email you when ${name} (${follow.host}) goes down, and again when it's back.`;
  const ignore = "Didn't ask for this? Ignore this email and you won't hear from us.";

  const text = [subject, "", lead, "", `Confirm: ${confirmUrl}`, "", ignore].join("\n");
  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">${escapeHtml(subject)}</h2>
        <p style="margin:0 0 16px 0">${escapeHtml(lead)}</p>
        <a href="${confirmUrl}" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:12px;font-weight:500">Confirm</a>
        <p style="margin:20px 0 0 0;color:#64748b;font-size:12px">${escapeHtml(ignore)}</p>
      </div>
    </div>`;
  return { subject, text, html };
}

async function findByToken(token: unknown) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const snap = await firestore.collection(EMAIL_FOLLOWS).where("token", "==", token).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

async function handleFollow(req: Request, res: Response) {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  // Honeypot. Answer like a success so a bot learns nothing.
  if (typeof body.company === "string" && body.company.trim()) {
    res.json({ ok: true, status: "pending" });
    return;
  }

  if (!ipLimiter.consume(`follow:${getClientIp(req)}`, MAX_FOLLOWS_PER_IP_PER_HOUR).allowed) {
    res.status(429).json({ ok: false, error: "rate_limited" });
    return;
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    res.status(400).json({ ok: false, error: "invalid_email" });
    return;
  }
  const slug = slugify(String(body.slug ?? ""));
  if (!slug) {
    res.status(400).json({ ok: false, error: "invalid_slug" });
    return;
  }

  const page = await firestore.collection(PAGES).doc(slug).get();
  if (!page.exists) {
    res.status(404).json({ ok: false, error: "not_found" });
    return;
  }
  const p = page.data() as { checkId: string; name: string; host: string; status?: string };

  const emailHash = hashEmail(email);
  const ref = firestore.collection(EMAIL_FOLLOWS).doc(`${emailHash}__${p.checkId}`);
  const existing = await ref.get();
  const prev = existing.exists ? (existing.data() as EmailFollowDoc) : null;
  if (prev?.confirmed) {
    res.json({ ok: true, status: "already_confirmed" });
    return;
  }

  // A bounced or complained address never gets a confirmation. Same answer as
  // success, so the form cannot be used to probe the suppression list.
  if (await isEmailSuppressedCached(email)) {
    res.json({ ok: true, status: "pending" });
    return;
  }

  if (!(await claimConfirmSend(emailHash))) {
    res.status(429).json({ ok: false, error: "rate_limited" });
    return;
  }

  // A repeat request for a pending follow keeps its token, so an earlier
  // confirmation email still works, and restarts the expiry clock.
  const follow: EmailFollowDoc = {
    email,
    emailHash,
    checkId: p.checkId,
    slug,
    name: p.name,
    host: p.host,
    token: prev?.token ?? randomBytes(32).toString("hex"),
    confirmed: false,
    createdAt: Date.now(),
    confirmedAt: null,
  };
  await ref.set(follow);

  const { subject, text, html } = buildConfirmEmail(follow, p.status === "offline");
  try {
    await sendTransactionalEmail({ to: email, subject, html, text, category: "account", meta: { slug, kind: "follow_confirm" } });
  } catch (error) {
    logger.error("[email-follows] confirmation send failed", { slug, error: (error as Error)?.message });
    res.status(502).json({ ok: false, error: "send_failed" });
    return;
  }

  logger.info("[email-follows] confirmation sent", { slug });
  res.json({ ok: true, status: "pending" });
}

export const publicFollow = onRequest(
  {
    cors: [/^https:\/\/(www\.)?exit1\.dev$/, /^http:\/\/localhost(:\d+)?$/],
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 10,
  },
  async (req, res) => {
    try {
      const path = req.path.replace(/\/+$/, "");

      if (path.endsWith("/confirm") && req.method === "GET") {
        const doc = await findByToken(req.query.token);
        const follow = doc?.data() as EmailFollowDoc | undefined;
        if (!doc || !follow) {
          res.redirect(302, landingUrl("invalid"));
          return;
        }
        if (!follow.confirmed) {
          if (isConfirmTokenExpired(follow.createdAt, Date.now())) {
            await doc.ref.delete();
            res.redirect(302, landingUrl("invalid"));
            return;
          }
          await doc.ref.update({ confirmed: true, confirmedAt: Date.now() });
          logger.info("[email-follows] confirmed", { slug: follow.slug });
        }
        res.redirect(302, landingUrl("confirmed", follow));
        return;
      }

      if (path.endsWith("/unsubscribe") && (req.method === "GET" || req.method === "POST")) {
        const doc = await findByToken(req.query.token);
        const follow = doc?.data() as EmailFollowDoc | undefined;
        if (doc) await doc.ref.delete();
        if (follow) logger.info("[email-follows] unsubscribed", { slug: follow.slug });
        if (req.method === "POST") {
          res.json({ ok: true });
          return;
        }
        res.redirect(302, follow ? landingUrl("unsubscribed", follow) : landingUrl("invalid"));
        return;
      }

      if (req.method === "POST") {
        await handleFollow(req, res);
        return;
      }

      res.status(405).json({ ok: false, error: "method_not_allowed" });
    } catch (error) {
      logger.error("[email-follows] request failed", { error: (error as Error)?.message });
      res.status(500).json({ ok: false, error: "internal" });
    }
  },
);
