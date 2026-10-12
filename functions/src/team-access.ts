// ============================================================================
// TEAM ACCOUNT ACCESS
//
// An account is identified by its owner's uid: every check, webhook, status
// page and API key carries `userId = ownerUid`, and BigQuery, the VPS index and
// the public API all key on it. A Pro owner can add teammates, who then act
// INSIDE the owner's account. Nothing about the data model changes for that;
// the only question each entry point has to answer is "which account is this
// caller acting on, and may they?". This module is the single answer.
//
// Callables: the app sends `accountId` in every callable payload (src/lib/
// callable.ts). `resolveAccount(request, need)` returns the owner's uid when the
// caller may act there, and throws otherwise. Callables then use that uid
// everywhere they used `request.auth.uid` before.
//
// Firestore rules mirror the same decision (firestore.rules, canReadAccount /
// canWriteAccount): membership doc exists AND owner's cached tier is 'pro'.
// Keep the two in step.
//
// Public API / MCP: a key or OAuth token minted by a member is stored with
// `userId = ownerUid` and `createdByUid = memberUid`. Removing the member or the
// owner leaving Pro must cut those off too, and keys outlive any session, so
// the public API re-checks membership on every request via
// `isMemberAccessActive` (short in-memory cache).
// ============================================================================

import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { firestore } from "./init";

export const TEAM_MEMBERS_COLLECTION = "teamMembers";
export const TEAM_INVITES_COLLECTION = "teamInvites";

export type TeamRole = "editor" | "viewer";
export type AccountRole = "owner" | TeamRole;
export type AccountNeed = "read" | "write";

export const TEAM_ROLES: readonly TeamRole[] = ["editor", "viewer"];

export interface TeamMemberDoc {
  ownerUid: string;
  memberUid: string;
  role: TeamRole;
  email: string;
  name?: string | null;
  invitedByUid: string;
  joinedAt: number;
  updatedAt: number;
}

export interface TeamInviteDoc {
  ownerUid: string;
  email: string;
  role: TeamRole;
  invitedByUid: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface AccountContext {
  /** The account being acted on. Use this wherever `request.auth.uid` was used for data. */
  accountId: string;
  /** The signed-in person. Use this for personal things (preferences, audit, notifications). */
  actorUid: string;
  role: AccountRole;
  /** True when the actor is a teammate in someone else's account. */
  isMember: boolean;
}

export function membershipId(ownerUid: string, memberUid: string): string {
  return `${ownerUid}_${memberUid}`;
}

export function isTeamRole(value: unknown): value is TeamRole {
  return value === "editor" || value === "viewer";
}

export type AccessDecision =
  | { ok: true; context: AccountContext }
  | { ok: false; code: "permission-denied" | "not-found"; message: string };

/**
 * Pure access policy, shared by the callable resolver and the public API.
 *
 * `membership` is the teamMembers doc for (requested account, actor), or null.
 * `ownerTier` is the owner's cached tier from users/{ownerUid}, which is the
 * same value the Firestore rules read.
 */
export function decideAccountAccess(input: {
  actorUid: string;
  requestedAccountId: string | null | undefined;
  membership: Pick<TeamMemberDoc, "role"> | null;
  ownerTier: string | null | undefined;
  need: AccountNeed;
}): AccessDecision {
  const { actorUid, requestedAccountId, membership, ownerTier, need } = input;

  if (!requestedAccountId || requestedAccountId === actorUid) {
    return {
      ok: true,
      context: { accountId: actorUid, actorUid, role: "owner", isMember: false },
    };
  }

  // Same message for "not a member" and "owner no longer on Pro" on purpose:
  // the caller learns nothing about accounts they don't belong to.
  if (!membership || ownerTier !== "pro") {
    return { ok: false, code: "permission-denied", message: "You no longer have access to this team." };
  }

  const role: TeamRole = isTeamRole(membership.role) ? membership.role : "viewer";
  if (need === "write" && role !== "editor") {
    return { ok: false, code: "permission-denied", message: "Viewers can't make changes. Ask the account owner for editor access." };
  }

  return {
    ok: true,
    context: { accountId: requestedAccountId, actorUid, role, isMember: true },
  };
}

/** Read the `accountId` the app attached to a callable payload, if any. */
export function requestedAccountIdOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>).accountId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

async function loadMembership(ownerUid: string, memberUid: string): Promise<TeamMemberDoc | null> {
  const snap = await firestore.collection(TEAM_MEMBERS_COLLECTION).doc(membershipId(ownerUid, memberUid)).get();
  return snap.exists ? (snap.data() as TeamMemberDoc) : null;
}

async function loadOwnerTier(ownerUid: string): Promise<string | null> {
  const snap = await firestore.collection("users").doc(ownerUid).get();
  const tier = snap.exists ? (snap.data() || {}).tier : null;
  return typeof tier === "string" ? tier : null;
}

/**
 * Resolve the account a callable acts on. Throws `unauthenticated` when signed
 * out and `permission-denied` when the caller may not act on the requested
 * account (or may only read and `need` is 'write').
 *
 * Without an `accountId` in the payload this is the caller's own account, so
 * callers that never send one (old app builds, admin tools) behave as before.
 */
export async function resolveAccount(
  request: Pick<CallableRequest, "auth" | "data">,
  need: AccountNeed = "read",
): Promise<AccountContext> {
  const actorUid = request.auth?.uid;
  if (!actorUid) throw new HttpsError("unauthenticated", "Authentication required");

  const requestedAccountId = requestedAccountIdOf(request.data);
  if (!requestedAccountId || requestedAccountId === actorUid) {
    return { accountId: actorUid, actorUid, role: "owner", isMember: false };
  }

  const [membership, ownerTier] = await Promise.all([
    loadMembership(requestedAccountId, actorUid),
    loadOwnerTier(requestedAccountId),
  ]);

  const decision = decideAccountAccess({ actorUid, requestedAccountId, membership, ownerTier, need });
  if (!decision.ok) throw new HttpsError(decision.code, decision.message);
  return decision.context;
}

/** Shorthand for callables that only need the account id. */
export async function resolveAccountId(
  request: Pick<CallableRequest, "auth" | "data">,
  need: AccountNeed = "read",
): Promise<string> {
  return (await resolveAccount(request, need)).accountId;
}

/**
 * For actions only the account owner may take (team management, billing,
 * deleting the account). Throws when the caller is acting as a member.
 */
export async function requireAccountOwner(request: Pick<CallableRequest, "auth" | "data">): Promise<string> {
  const ctx = await resolveAccount(request, "read");
  if (ctx.isMember) {
    throw new HttpsError("permission-denied", "Only the account owner can do this.");
  }
  return ctx.actorUid;
}

// ── Public API / MCP ──

const MEMBER_ACCESS_CACHE_TTL_MS = 60 * 1000;
const MEMBER_ACCESS_CACHE_MAX = 5000;
const memberAccessCache = new Map<string, { active: boolean; role: TeamRole | null; expiresAt: number }>();

/**
 * Is a key/token minted by `memberUid` inside `ownerUid`'s account still good?
 * True only while the membership exists and the owner is on Pro. Cached for a
 * minute, the same window the API key and bearer caches already allow, so a
 * removal is enforced within a minute on warm instances and at once on cold.
 */
export async function getMemberAccess(
  ownerUid: string,
  memberUid: string,
): Promise<{ active: boolean; role: TeamRole | null }> {
  if (ownerUid === memberUid) return { active: true, role: null };

  const key = membershipId(ownerUid, memberUid);
  const cached = memberAccessCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { active: cached.active, role: cached.role };
  }

  const [membership, ownerTier] = await Promise.all([
    loadMembership(ownerUid, memberUid),
    loadOwnerTier(ownerUid),
  ]);
  const decision = decideAccountAccess({
    actorUid: memberUid,
    requestedAccountId: ownerUid,
    membership,
    ownerTier,
    need: "read",
  });
  const result = decision.ok
    ? { active: true, role: decision.context.role === "owner" ? null : decision.context.role as TeamRole }
    : { active: false, role: null };

  memberAccessCache.set(key, { ...result, expiresAt: Date.now() + MEMBER_ACCESS_CACHE_TTL_MS });
  if (memberAccessCache.size > MEMBER_ACCESS_CACHE_MAX) memberAccessCache.clear();
  return result;
}

/** Drop a cached decision so a removal takes effect at once on this instance. */
export function invalidateMemberAccess(ownerUid: string, memberUid: string): void {
  memberAccessCache.delete(membershipId(ownerUid, memberUid));
}
