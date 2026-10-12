// ============================================================================
// TEAM MEMBERS (Pro)
//
// A Pro owner invites teammates by email. The invitee accepts while signed in
// with that (verified) address and from then on can switch into the owner's
// account. See team-access.ts for how access is decided on every request, and
// firestore.rules for the matching read/write rules.
//
// Collections (all writes here, clients only read):
//   teamInvites/{autoId}                   pending invites, one per owner+email
//   teamMembers/{ownerUid}_{memberUid}     active memberships
//
// Removal and leaving also switch off what the member minted inside the
// account: API keys (`createdByUid`) and MCP tokens (`memberUid`). The public
// API re-checks membership on every request anyway; switching them off makes
// the state obvious on the API keys page and survives a later re-invite.
// ============================================================================

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore, getClerkClient, getUserTierLive } from "./init";
import { CONFIG } from "./config";
import {
  CLERK_SECRET_KEY_DEV,
  CLERK_SECRET_KEY_PROD,
  DAY3_API_KEY,
  DAY3_FROM,
  RESEND_API_KEY,
  RESEND_FROM,
} from "./env";
import { sendTransactionalEmail } from "./email-send";
import { normalizeEmail } from "./email-suppression-policy";
import {
  TEAM_INVITES_COLLECTION,
  TEAM_MEMBERS_COLLECTION,
  invalidateMemberAccess,
  isTeamRole,
  membershipId,
  requireAccountOwner,
  resolveAccount,
  type TeamInviteDoc,
  type TeamMemberDoc,
  type TeamRole,
} from "./team-access";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLERK_SECRETS = [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV];
const EMAIL_SECRETS = [RESEND_API_KEY, RESEND_FROM, DAY3_API_KEY, DAY3_FROM];

function appUrl(): string {
  return process.env.FRONTEND_URL || "https://app.exit1.dev";
}

function seatLimit(): number {
  return CONFIG.getTierLimits("pro").teamSeats;
}

interface ClerkUserSummary {
  /** Verified addresses only, normalised. An invite is claimed by proving one of these. */
  verifiedEmails: string[];
  primaryEmail: string | null;
  name: string | null;
}

async function getClerkUserSummary(uid: string): Promise<ClerkUserSummary | null> {
  for (const client of [getClerkClient("prod"), getClerkClient("dev")]) {
    if (!client) continue;
    try {
      const user = await client.users.getUser(uid);
      const verifiedEmails = (user.emailAddresses || [])
        .filter((e) => e.verification?.status === "verified")
        .map((e) => normalizeEmail(e.emailAddress));
      const primary = user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
        ?? user.emailAddresses?.[0];
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
      return {
        verifiedEmails,
        primaryEmail: primary?.emailAddress ? normalizeEmail(primary.emailAddress) : null,
        name,
      };
    } catch {
      // Not in this instance, try the next one.
    }
  }
  return null;
}

function readRole(value: unknown): TeamRole {
  if (!isTeamRole(value)) throw new HttpsError("invalid-argument", "Role must be editor or viewer");
  return value;
}

function readString(data: unknown, field: string): string {
  const raw = data && typeof data === "object" ? (data as Record<string, unknown>)[field] : undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpsError("invalid-argument", `${field} is required`);
  }
  return raw.trim();
}

async function requireProOwner(ownerUid: string): Promise<void> {
  const tier = await getUserTierLive(ownerUid);
  if (tier !== "pro") {
    throw new HttpsError("failed-precondition", "Team members are part of the Pro plan. Upgrade to Pro to invite your team.");
  }
}

function inviteLink(inviteId: string): string {
  return `${appUrl()}/team?invite=${encodeURIComponent(inviteId)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendInviteEmail(invite: TeamInviteDoc, inviteId: string): Promise<boolean> {
  const inviter = invite.ownerName || invite.ownerEmail || "A teammate";
  const roleLine = invite.role === "editor"
    ? "You'll be able to see and change their checks, alerts and status pages."
    : "You'll be able to see their checks, alerts and status pages.";
  const link = inviteLink(inviteId);
  const html = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;padding:16px;background:#0b1220;color:#e2e8f0">
      <div style="max-width:560px;margin:0 auto;background:rgba(2,6,23,0.6);border:1px solid rgba(148,163,184,0.15);border-radius:12px;padding:20px">
        <h2 style="margin:0 0 8px 0">You're invited to a team on exit1.dev</h2>
        <p style="margin:0 0 12px 0;color:#e2e8f0"><strong>${escapeHtml(inviter)}</strong> invited you to join their exit1.dev account as ${invite.role === "editor" ? "an editor" : "a viewer"}.</p>
        <p style="margin:0 0 12px 0;color:#94a3b8">${roleLine} Sign in or create a free account with <strong>${escapeHtml(invite.email)}</strong> to accept.</p>
        <div style="margin:16px 0 0 0;text-align:center">
          <a href="${link}" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:12px;font-weight:500">Accept invite</a>
        </div>
        <p style="margin:16px 0 0 0;color:#64748b;font-size:12px">This invite expires in 14 days. If you weren't expecting it, you can ignore this email.</p>
      </div>
    </div>`;
  try {
    await sendTransactionalEmail({
      to: invite.email,
      subject: `${inviter} invited you to their exit1.dev team`,
      html,
      text: `${inviter} invited you to their exit1.dev account. Accept here: ${link}`,
      category: "account",
      meta: { kind: "team_invite", ownerUid: invite.ownerUid },
    });
    return true;
  } catch (error) {
    logger.error("Team invite email failed", { ownerUid: invite.ownerUid, error });
    return false;
  }
}

/**
 * Switch off what a member minted inside an account and drop their membership.
 * Shared by remove and leave.
 */
async function offboardMember(ownerUid: string, memberUid: string): Promise<void> {
  await firestore.collection(TEAM_MEMBERS_COLLECTION).doc(membershipId(ownerUid, memberUid)).delete();
  invalidateMemberAccess(ownerUid, memberUid);

  const [keys, tokens] = await Promise.all([
    firestore.collection("apiKeys")
      .where("userId", "==", ownerUid)
      .where("createdByUid", "==", memberUid)
      .get(),
    firestore.collection("mcp_oauth_tokens")
      .where("userId", "==", ownerUid)
      .where("memberUid", "==", memberUid)
      .where("revoked", "==", false)
      .get(),
  ]);

  const batch = firestore.batch();
  keys.docs.forEach((d) => batch.update(d.ref, { enabled: false, disabledReason: "team_member_removed" }));
  tokens.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  if (!keys.empty || !tokens.empty) await batch.commit();

  logger.info("Team member offboarded", {
    ownerUid,
    memberUid,
    keysDisabled: keys.size,
    tokensRevoked: tokens.size,
  });
}

function serializeMember(doc: TeamMemberDoc) {
  return {
    memberUid: doc.memberUid,
    email: doc.email,
    name: doc.name ?? null,
    role: doc.role,
    joinedAt: doc.joinedAt,
  };
}

function serializeInvite(id: string, doc: TeamInviteDoc) {
  return {
    id,
    email: doc.email,
    role: doc.role,
    createdAt: doc.createdAt,
    expiresAt: doc.expiresAt,
    link: inviteLink(id),
  };
}

/**
 * Who am I, team-wise? The accounts the caller can switch into and the invites
 * waiting for them. Personal: ignores any accountId in the payload.
 */
export const getTeamContext = onCall({
  cors: true,
  maxInstances: 20,
  secrets: CLERK_SECRETS,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const membershipsSnap = await firestore.collection(TEAM_MEMBERS_COLLECTION)
    .where("memberUid", "==", uid)
    .get();

  const memberships = membershipsSnap.docs.map((d) => d.data() as TeamMemberDoc & {
    ownerName?: string | null;
    ownerEmail?: string | null;
  });

  const ownerRefs = memberships.map((m) => firestore.collection("users").doc(m.ownerUid));
  const ownerSnaps = ownerRefs.length ? await firestore.getAll(...ownerRefs) : [];
  const ownerTier = new Map(ownerSnaps.map((s) => [s.id, s.exists ? (s.data() || {}).tier : null]));

  const accounts = memberships.map((m) => ({
    accountId: m.ownerUid,
    role: m.role,
    ownerName: m.ownerName ?? null,
    ownerEmail: m.ownerEmail ?? null,
    // The owner left Pro: the membership is kept (it comes back if they
    // re-subscribe) but it grants nothing meanwhile.
    active: ownerTier.get(m.ownerUid) === "pro",
  }));

  let invites: Array<{ id: string; ownerName: string | null; ownerEmail: string | null; role: TeamRole; expiresAt: number }> = [];
  const me = await getClerkUserSummary(uid);
  const emails = (me?.verifiedEmails || []).slice(0, 30);
  if (emails.length > 0) {
    const inviteSnap = await firestore.collection(TEAM_INVITES_COLLECTION)
      .where("email", "in", emails)
      .get();
    const now = Date.now();
    invites = inviteSnap.docs
      .map((d) => ({ id: d.id, data: d.data() as TeamInviteDoc }))
      .filter(({ data }) => data.expiresAt > now && data.ownerUid !== uid)
      .filter(({ data }) => !memberships.some((m) => m.ownerUid === data.ownerUid))
      .map(({ id, data }) => ({
        id,
        ownerName: data.ownerName ?? null,
        ownerEmail: data.ownerEmail ?? null,
        role: data.role,
        expiresAt: data.expiresAt,
      }));
  }

  return { success: true, data: { accounts, invites } };
});

/**
 * The member list of the account the caller is acting on. Owners also get the
 * pending invites and seat usage; members get the list read-only.
 */
export const getTeam = onCall({
  cors: true,
  maxInstances: 20,
}, async (request) => {
  const ctx = await resolveAccount(request, "read");
  const accountId = ctx.accountId;

  const [membersSnap, invitesSnap, ownerSnap] = await Promise.all([
    firestore.collection(TEAM_MEMBERS_COLLECTION).where("ownerUid", "==", accountId).get(),
    ctx.isMember
      ? Promise.resolve(null)
      : firestore.collection(TEAM_INVITES_COLLECTION).where("ownerUid", "==", accountId).get(),
    firestore.collection("users").doc(accountId).get(),
  ]);

  const now = Date.now();
  const members = membersSnap.docs
    .map((d) => serializeMember(d.data() as TeamMemberDoc))
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const invites = invitesSnap
    ? invitesSnap.docs
      .map((d) => ({ id: d.id, data: d.data() as TeamInviteDoc }))
      .filter(({ data }) => data.expiresAt > now)
      .map(({ id, data }) => serializeInvite(id, data))
      .sort((a, b) => b.createdAt - a.createdAt)
    : [];

  const tier = ownerSnap.exists ? (ownerSnap.data() || {}).tier : null;

  return {
    success: true,
    data: {
      canManage: !ctx.isMember,
      role: ctx.role,
      ownerTier: typeof tier === "string" ? tier : "free",
      seats: { used: members.length + invites.length, total: seatLimit() },
      members,
      invites,
    },
  };
});

/** Invite someone by email, or refresh and resend an existing invite to them. */
export const inviteTeamMember = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [...CLERK_SECRETS, ...EMAIL_SECRETS],
}, async (request) => {
  const ownerUid = await requireAccountOwner(request);
  const email = normalizeEmail(readString(request.data, "email"));
  const role = readRole((request.data as Record<string, unknown>)?.role ?? "editor");

  if (!EMAIL_RE.test(email) || email.length > 200) {
    throw new HttpsError("invalid-argument", "Enter a valid email address");
  }

  await requireProOwner(ownerUid);

  const owner = await getClerkUserSummary(ownerUid);
  if (owner?.verifiedEmails.includes(email) || owner?.primaryEmail === email) {
    throw new HttpsError("invalid-argument", "That's your own email. Invite a teammate instead.");
  }

  const [membersSnap, invitesSnap] = await Promise.all([
    firestore.collection(TEAM_MEMBERS_COLLECTION).where("ownerUid", "==", ownerUid).get(),
    firestore.collection(TEAM_INVITES_COLLECTION).where("ownerUid", "==", ownerUid).get(),
  ]);

  if (membersSnap.docs.some((d) => normalizeEmail((d.data() as TeamMemberDoc).email || "") === email)) {
    throw new HttpsError("already-exists", "That person is already on your team.");
  }

  const now = Date.now();
  const existing = invitesSnap.docs.find((d) => (d.data() as TeamInviteDoc).email === email);
  const activeInvites = invitesSnap.docs.filter((d) => (d.data() as TeamInviteDoc).expiresAt > now && d.id !== existing?.id);
  const limit = seatLimit();
  if (membersSnap.size + activeInvites.length + 1 > limit) {
    throw new HttpsError(
      "resource-exhausted",
      `Your plan includes ${limit} team seats and they're all taken. Remove a member or cancel an invite first.`,
    );
  }

  const invite: TeamInviteDoc = {
    ownerUid,
    email,
    role,
    invitedByUid: ownerUid,
    ownerName: owner?.name ?? null,
    ownerEmail: owner?.primaryEmail ?? null,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  };

  const ref = existing ? existing.ref : firestore.collection(TEAM_INVITES_COLLECTION).doc();
  await ref.set(invite);
  const emailSent = await sendInviteEmail(invite, ref.id);

  logger.info("Team invite sent", { ownerUid, inviteId: ref.id, role, resent: !!existing, emailSent });
  return { success: true, data: { ...serializeInvite(ref.id, invite), emailSent } };
});

export const revokeTeamInvite = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const ownerUid = await requireAccountOwner(request);
  const inviteId = readString(request.data, "inviteId");
  const ref = firestore.collection(TEAM_INVITES_COLLECTION).doc(inviteId);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as TeamInviteDoc).ownerUid !== ownerUid) {
    throw new HttpsError("not-found", "Invite not found");
  }
  await ref.delete();
  return { success: true };
});

/** Load an invite for the signed-in invitee, proving they own the invited address. */
async function loadInviteForInvitee(inviteId: string, uid: string) {
  const ref = firestore.collection(TEAM_INVITES_COLLECTION).doc(inviteId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "This invite was cancelled or already used.");
  }
  const invite = snap.data() as TeamInviteDoc;
  if (invite.expiresAt <= Date.now()) {
    throw new HttpsError("failed-precondition", "This invite has expired. Ask the account owner to send a new one.");
  }
  if (invite.ownerUid === uid) {
    throw new HttpsError("invalid-argument", "You can't join your own account.");
  }
  const me = await getClerkUserSummary(uid);
  if (!me || !me.verifiedEmails.includes(invite.email)) {
    throw new HttpsError(
      "permission-denied",
      `This invite was sent to ${invite.email}. Sign in with that address, or add and verify it on your profile, to accept.`,
    );
  }
  return { ref, invite, me };
}

export const acceptTeamInvite = onCall({
  cors: true,
  maxInstances: 10,
  secrets: CLERK_SECRETS,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
  const inviteId = readString(request.data, "inviteId");

  const { ref, invite, me } = await loadInviteForInvitee(inviteId, uid);
  await requireProOwner(invite.ownerUid);

  const memberRef = firestore.collection(TEAM_MEMBERS_COLLECTION).doc(membershipId(invite.ownerUid, uid));
  const limit = seatLimit();

  await firestore.runTransaction(async (tx) => {
    const members = await tx.get(
      firestore.collection(TEAM_MEMBERS_COLLECTION).where("ownerUid", "==", invite.ownerUid),
    );
    const already = members.docs.some((d) => d.id === memberRef.id);
    if (!already && members.size >= limit) {
      throw new HttpsError("resource-exhausted", "This team has no free seats left. Ask the account owner to make room.");
    }
    const now = Date.now();
    tx.set(memberRef, {
      ownerUid: invite.ownerUid,
      memberUid: uid,
      role: invite.role,
      email: invite.email,
      name: me.name,
      ownerName: invite.ownerName ?? null,
      ownerEmail: invite.ownerEmail ?? null,
      invitedByUid: invite.invitedByUid,
      joinedAt: now,
      updatedAt: now,
    });
    tx.delete(ref);
  });

  invalidateMemberAccess(invite.ownerUid, uid);
  logger.info("Team invite accepted", { ownerUid: invite.ownerUid, memberUid: uid, role: invite.role });
  return { success: true, data: { accountId: invite.ownerUid, role: invite.role } };
});

export const declineTeamInvite = onCall({
  cors: true,
  maxInstances: 10,
  secrets: CLERK_SECRETS,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
  const inviteId = readString(request.data, "inviteId");
  const { ref } = await loadInviteForInvitee(inviteId, uid);
  await ref.delete();
  return { success: true };
});

export const updateTeamMemberRole = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const ownerUid = await requireAccountOwner(request);
  const memberUid = readString(request.data, "memberUid");
  const role = readRole((request.data as Record<string, unknown>)?.role);

  const ref = firestore.collection(TEAM_MEMBERS_COLLECTION).doc(membershipId(ownerUid, memberUid));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Member not found");
  await ref.update({ role, updatedAt: Date.now() });
  invalidateMemberAccess(ownerUid, memberUid);
  return { success: true };
});

export const removeTeamMember = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const ownerUid = await requireAccountOwner(request);
  const memberUid = readString(request.data, "memberUid");
  const snap = await firestore.collection(TEAM_MEMBERS_COLLECTION).doc(membershipId(ownerUid, memberUid)).get();
  if (!snap.exists) throw new HttpsError("not-found", "Member not found");
  await offboardMember(ownerUid, memberUid);
  return { success: true };
});

/** A member leaves someone else's account. Personal: ignores accountId. */
export const leaveTeam = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
  const ownerUid = readString(request.data, "ownerUid");
  const snap = await firestore.collection(TEAM_MEMBERS_COLLECTION).doc(membershipId(ownerUid, uid)).get();
  if (!snap.exists) throw new HttpsError("not-found", "You're not on that team.");
  await offboardMember(ownerUid, uid);
  return { success: true };
});
