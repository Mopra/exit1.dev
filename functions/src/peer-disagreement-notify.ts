// Phase 2 Step 7b: permanent-disagreement notification.
//
// When a check's primary region reports DOWN while its peer reports UP for
// >2 hours continuously, we email the check owner once per streak. Without
// this, a misconfigured check (e.g., geo-routed endpoint where the customer
// forgot to flip peerConfirmDisabled) would never alert and the customer
// would have no signal to act on.
//
// This is informational — the site is reachable from at least one region,
// so it is NOT framed as an incident. Exactly one email per disagreement
// instance: once the streak ends (peer agrees, peer unreachable, or check
// returns to UP) a new streak is eligible to notify again. Fire-and-forget
// — failures only log; they never block the probe.

import * as logger from 'firebase-functions/logger';
import { Resend } from 'resend';
import { firestore } from './init.js';
import { getResendCredentials } from './env.js';
import type { EmailSettings, Website } from './types.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.exit1.dev';

async function resolveRecipient(website: Website): Promise<string | null> {
  try {
    const snap = await firestore.collection('emailSettings').doc(website.userId).get();
    if (!snap.exists) return null;
    const settings = snap.data() as EmailSettings;
    if (settings.enabled === false) return null;
    const recipient = typeof settings.recipient === 'string' ? settings.recipient.trim() : '';
    if (!recipient) return null;
    const perCheck = settings.perCheck?.[website.id];
    if (perCheck?.enabled === false) return null;
    return recipient;
  } catch (err) {
    logger.debug(`[peer-disagree-notify] recipient lookup failed: ${String(err)}`);
    return null;
  }
}

function buildEmail(
  website: Website,
  primaryRegion: string,
  peerRegion: string,
  streakStartedAt: number,
) {
  const subject = `Heads-up: ${website.name} is up, but unreachable from ${primaryRegion}`;
  const since = new Date(streakStartedAt).toISOString();
  const settingsLink = `${FRONTEND_URL}/checks/${website.id}/edit`;

  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">Your site is up — just a heads-up</h2>
        <p style="margin:0 0 12px 0;color:#cbd5e1">
          <strong>No action is required.</strong> Our <strong>${peerRegion}</strong> probe is reaching ${website.name} successfully, so your site is up.
          We just wanted to let you know that our <strong>${primaryRegion}</strong> probe hasn't been able to reach it for the past couple of hours.
        </p>
        <div style="margin:12px 0;padding:12px;border-radius:8px;background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.2)">
          <div><strong>Check:</strong> ${website.name}</div>
          <div><strong>URL:</strong> <a href="${website.url}" style="color:#38bdf8">${website.url}</a></div>
          <div><strong>${peerRegion}:</strong> reachable — site is up.</div>
          <div><strong>${primaryRegion}:</strong> not reachable since ${since}.</div>
        </div>
        <p style="margin:16px 0 0 0;color:#94a3b8;font-size:14px">
          We're holding alerts on this check until both regions agree, since at least one region is reaching your site fine. This is almost always one of two things:
        </p>
        <ol style="color:#94a3b8;font-size:14px">
          <li><strong>A regional network issue</strong> between ${primaryRegion} and your service. These usually resolve on their own — nothing for you to do.</li>
          <li><strong>Your endpoint is intentionally geo-restricted</strong> (e.g. blocked outside certain regions). If that's the case, <a href="${settingsLink}" style="color:#38bdf8">disable peer confirmation</a> for this check so we monitor it from ${peerRegion} only.</li>
        </ol>
        <p style="margin:16px 0 0 0;color:#64748b;font-size:12px">
          You'll only get this email once per disagreement — we won't keep nagging while it continues. If the regions agree again and later diverge, you'll get a new one.
        </p>
      </div>
    </div>
  `;

  return { subject, html };
}

export async function sendPeerDisagreementEmail(
  website: Website,
  primaryRegion: string,
  peerRegion: string,
  streakStartedAt: number,
): Promise<void> {
  const recipient = await resolveRecipient(website);
  if (!recipient) {
    logger.debug(`[peer-disagree-notify] no recipient for ${website.id} — skipping`);
    return;
  }

  const { apiKey, fromAddress } = getResendCredentials();
  if (!apiKey) {
    logger.debug('[peer-disagree-notify] RESEND_API_KEY not configured — skipping');
    return;
  }

  const { subject, html } = buildEmail(website, primaryRegion, peerRegion, streakStartedAt);

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({ from: fromAddress, to: recipient, subject, html });
    logger.info(`[peer-disagree-notify] sent to ${recipient} for ${website.id}`);
  } catch (err) {
    logger.warn(`[peer-disagree-notify] send failed for ${website.id}: ${String(err)}`);
  }
}
