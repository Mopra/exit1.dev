/**
 * OAuth 2.1 authorization server for the remote MCP endpoint.
 *
 * Why we run our own AS instead of pointing clients at Clerk: Clerk authenticates
 * the human, but the tokens MCP clients carry need to be *our* tokens, scoped to
 * our public API, revocable from our dashboard, and mintable for clients we never
 * pre-registered. So Clerk stays the identity provider (the consent page is behind
 * AuthGuard, which means an unauthenticated visitor gets Clerk's sign-up first —
 * exactly the signup path agent onboarding wants) and this module mints, stores
 * and validates the access tokens.
 *
 * Endpoints (served through Firebase Hosting rewrites on app.exit1.dev):
 *   GET  /.well-known/oauth-authorization-server   RFC 8414
 *   GET  /.well-known/oauth-protected-resource     RFC 9728
 *   POST /oauth/register                           RFC 7591 dynamic registration
 *   GET  /oauth/authorize                          → 302 to the SPA consent page
 *   POST /oauth/token                              authorization_code + refresh_token
 *   POST /oauth/revoke                             RFC 7009
 */

import { onRequest, onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createHash, randomBytes } from "crypto";
import { firestore } from "./init";
import { FixedWindowRateLimiter, getClientIp } from "./rate-limit";
import { type ApiScope } from "./api-scopes";
import {
  DEFAULT_MCP_SCOPES,
  appendQuery,
  isAllowedRedirectUri,
  parseScopes,
  verifyPkce,
} from "./mcp-oauth-policy";

// ── Constants ──

export const ISSUER = "https://app.exit1.dev";
// The endpoint is versioned rather than living at bare /mcp: that path is already
// the dashboard's MCP settings page, and a Hosting rewrite there would shadow it.
export const MCP_RESOURCE_URL = `${ISSUER}/mcp/v1`;
const CONSENT_PAGE = `${ISSUER}/authorize`;

const CLIENTS_COLLECTION = "mcp_oauth_clients";
const REQUESTS_COLLECTION = "mcp_oauth_requests";
const CODES_COLLECTION = "mcp_oauth_codes";
export const MCP_TOKENS_COLLECTION = "mcp_oauth_tokens";
const TOKENS_COLLECTION = MCP_TOKENS_COLLECTION;

// Generous because a first-time user goes signup → onboarding → consent, and
// onboarding includes picking a plan. The request is single-use, grants nothing
// on its own, and still needs the user's own authenticated session to approve.
const AUTH_REQUEST_TTL_MS = 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENTS_PER_IP_PER_HOUR = 20;

const registrationLimiter = new FixedWindowRateLimiter({ windowMs: 60 * 60 * 1000, maxKeys: 10_000 });
const tokenLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 20_000 });

// ── Types ──

interface OAuthClientDoc {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
  lastUsedAt?: number;
}

interface AuthRequestDoc {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ApiScope[];
  state: string | null;
  resource: string | null;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}

interface AuthCodeDoc {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ApiScope[];
  resource: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

export interface OAuthTokenDoc {
  tokenHash: string;
  type: "access" | "refresh";
  userId: string;
  clientId: string;
  clientName: string;
  scopes: ApiScope[];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  lastUsedAt?: number;
  /** Set on refresh tokens so rotating one can invalidate its predecessor's family. */
  familyId?: string;
}

// ── Helpers ──

function hashToken(token: string): string {
  const pepper = process.env.API_KEY_PEPPER || "";
  return createHash("sha256").update(pepper + token).digest("hex");
}

/**
 * Strip the function-name prefix that direct cloudfunctions.net invocations add,
 * so the same handler works behind a Hosting rewrite and when called directly.
 */
function normalizePath(req: { path?: string; url?: string }): string {
  const raw = (req.path || req.url || "/").split("?")[0];
  const stripped = raw.replace(/^\/mcpOauth/, "");
  const trimmed = stripped.replace(/\/+$/, "");
  return trimmed || "/";
}

function sendJson(res: { status: (n: number) => { json: (b: unknown) => void } }, status: number, body: unknown): void {
  res.status(status).json(body);
}

function oauthError(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  status: number,
  error: string,
  description: string
): void {
  sendJson(res, status, { error, error_description: description });
}

// ── Token issuance / validation (shared with the public API) ──

async function issueTokenPair(params: {
  userId: string;
  clientId: string;
  clientName: string;
  scopes: ApiScope[];
  familyId?: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const now = Date.now();
  const accessToken = `ek_at_${randomBytes(32).toString("hex")}`;
  const refreshToken = `ek_rt_${randomBytes(32).toString("hex")}`;
  const familyId = params.familyId || randomBytes(16).toString("hex");

  const batch = firestore.batch();
  const accessRef = firestore.collection(TOKENS_COLLECTION).doc();
  const refreshRef = firestore.collection(TOKENS_COLLECTION).doc();

  batch.set(accessRef, {
    tokenHash: hashToken(accessToken),
    type: "access",
    userId: params.userId,
    clientId: params.clientId,
    clientName: params.clientName,
    scopes: params.scopes,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
    revoked: false,
    familyId,
  } satisfies OAuthTokenDoc);

  batch.set(refreshRef, {
    tokenHash: hashToken(refreshToken),
    type: "refresh",
    userId: params.userId,
    clientId: params.clientId,
    clientName: params.clientName,
    scopes: params.scopes,
    createdAt: now,
    expiresAt: now + REFRESH_TOKEN_TTL_MS,
    revoked: false,
    familyId,
  } satisfies OAuthTokenDoc);

  await batch.commit();

  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

export interface ResolvedBearer {
  userId: string;
  scopes: ApiScope[];
  clientId: string;
  tokenDocId: string;
}

// Every MCP tool call validates the token twice — once at the MCP endpoint, once
// again when that endpoint calls the public API — so an uncached lookup doubles
// the Firestore reads for the whole flow. The TTL is short enough that a
// revocation takes effect within a minute, which is the property that matters:
// "revoke" has to actually mean revoked, not "revoked in five minutes".
const BEARER_CACHE_TTL_MS = 60 * 1000;
const BEARER_CACHE_MAX = 5000;
const bearerCache = new Map<string, { resolved: ResolvedBearer; expiresAt: number }>();

/** Drop cached entries for a user so a revoke takes effect immediately. */
function invalidateBearerCacheForUser(userId: string): void {
  for (const [key, entry] of bearerCache) {
    if (entry.resolved.userId === userId) {
      bearerCache.delete(key);
    }
  }
}

/**
 * Validate a Bearer access token. Returns null for anything not currently valid —
 * unknown, revoked, expired, or a refresh token presented as an access token.
 */
export async function resolveBearerToken(token: string): Promise<ResolvedBearer | null> {
  if (!token.startsWith("ek_at_")) return null;

  const hash = hashToken(token);

  const cached = bearerCache.get(hash);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.resolved;
    }
    bearerCache.delete(hash);
  }

  const snap = await firestore
    .collection(TOKENS_COLLECTION)
    .where("tokenHash", "==", hash)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data() as OAuthTokenDoc;

  if (data.type !== "access" || data.revoked || data.expiresAt <= Date.now()) {
    return null;
  }

  const resolved: ResolvedBearer = {
    userId: data.userId,
    scopes: (data.scopes || []) as ApiScope[],
    clientId: data.clientId,
    tokenDocId: doc.id,
  };

  // Never cache past the token's own expiry.
  const expiresAt = Math.min(Date.now() + BEARER_CACHE_TTL_MS, data.expiresAt);
  if (expiresAt > Date.now()) {
    bearerCache.set(hash, { resolved, expiresAt });
    if (bearerCache.size > BEARER_CACHE_MAX) {
      bearerCache.clear();
    }
  }

  return resolved;
}

/** Header value that tells an MCP client where to find our authorization server. */
export function buildWwwAuthenticate(errorDescription?: string): string {
  const parts = [
    `Bearer realm="exit1"`,
    `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
  ];
  if (errorDescription) {
    parts.push(`error="invalid_token"`, `error_description="${errorDescription.replace(/"/g, "")}"`);
  }
  return parts.join(", ");
}

// ── HTTP handlers ──

async function handleRegister(
  req: { body?: unknown; headers?: Record<string, unknown>; ip?: unknown },
  res: { status: (n: number) => { json: (b: unknown) => void } }
): Promise<void> {
  const ip = getClientIp(req);
  const decision = registrationLimiter.consume(`reg:${ip}`, MAX_CLIENTS_PER_IP_PER_HOUR);
  if (!decision.allowed) {
    oauthError(res, 429, "temporarily_unavailable", "Too many client registrations. Try again later.");
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const rawUris = body.redirect_uris;

  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required and must be a non-empty array");
    return;
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    oauthError(res, 400, "invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`);
    return;
  }

  const redirectUris = rawUris.filter(isAllowedRedirectUri);
  if (redirectUris.length !== rawUris.length) {
    oauthError(
      res,
      400,
      "invalid_redirect_uri",
      "redirect_uris must be https:// or http://localhost (no fragments)"
    );
    return;
  }

  // Public clients only. We never issue a client_secret, so a leaked registration
  // buys an attacker nothing without also controlling a registered redirect URI.
  const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (authMethod !== "none") {
    oauthError(res, 400, "invalid_client_metadata", "Only public clients (token_endpoint_auth_method=none) are supported");
    return;
  }

  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 120)
      : "MCP client";

  const clientId = `mcpc_${randomBytes(16).toString("hex")}`;
  const now = Date.now();

  await firestore.collection(CLIENTS_COLLECTION).doc(clientId).set({
    clientId,
    clientName,
    redirectUris,
    createdAt: now,
  } satisfies OAuthClientDoc);

  logger.info("MCP OAuth client registered", { clientId, clientName, redirectUris });

  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: DEFAULT_MCP_SCOPES.join(" "),
  });
}

type OAuthRequest = Parameters<Parameters<typeof onRequest>[0]>[0];
type OAuthResponse = Parameters<Parameters<typeof onRequest>[0]>[1];

async function handleAuthorize(req: OAuthRequest, res: OAuthResponse): Promise<void> {
  const q = req.query || {};
  const clientId = typeof q.client_id === "string" ? q.client_id : "";
  const redirectUri = typeof q.redirect_uri === "string" ? q.redirect_uri : "";
  const responseType = typeof q.response_type === "string" ? q.response_type : "";
  const codeChallenge = typeof q.code_challenge === "string" ? q.code_challenge : "";
  const codeChallengeMethod = typeof q.code_challenge_method === "string" ? q.code_challenge_method : "";
  const state = typeof q.state === "string" ? q.state : null;
  const resource = typeof q.resource === "string" ? q.resource : null;

  if (!clientId) {
    oauthError(res, 400, "invalid_request", "client_id is required");
    return;
  }

  const clientSnap = await firestore.collection(CLIENTS_COLLECTION).doc(clientId).get();
  if (!clientSnap.exists) {
    oauthError(res, 400, "invalid_client", "Unknown client_id");
    return;
  }
  const client = clientSnap.data() as OAuthClientDoc;

  // Redirect URI must match exactly. Everything below this point may redirect
  // errors back to the client; above it we must render them, since an unvalidated
  // redirect_uri is attacker-controlled.
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    oauthError(res, 400, "invalid_request", "redirect_uri does not match a registered URI for this client");
    return;
  }

  if (responseType !== "code") {
    res.redirect(appendQuery(redirectUri, { error: "unsupported_response_type", state }));
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    res.redirect(
      appendQuery(redirectUri, {
        error: "invalid_request",
        error_description: "PKCE with code_challenge_method=S256 is required",
        state,
      })
    );
    return;
  }

  const scopes = parseScopes(q.scope);
  const now = Date.now();

  const requestRef = await firestore.collection(REQUESTS_COLLECTION).add({
    clientId,
    clientName: client.clientName,
    redirectUri,
    codeChallenge,
    scopes,
    state,
    resource,
    createdAt: now,
    expiresAt: now + AUTH_REQUEST_TTL_MS,
  } satisfies AuthRequestDoc);

  // Hand off to the SPA. Passing an opaque request id (rather than the raw
  // params) means the consent page can't be used to smuggle altered scopes or a
  // swapped redirect_uri past the validation we just did.
  //
  // The id goes in the PATH, not a query string: when the visitor isn't signed
  // in yet, AuthGuard stashes `location` and the login flow replays only
  // `pathname`. A query param would be dropped and the consent page would load
  // with nothing to approve.
  res.redirect(`${CONSENT_PAGE}/${requestRef.id}`);
}

async function handleToken(
  req: { body?: unknown; headers?: Record<string, unknown>; ip?: unknown },
  res: { status: (n: number) => { json: (b: unknown) => void } }
): Promise<void> {
  const ip = getClientIp(req);
  if (!tokenLimiter.consume(`token:${ip}`, 30).allowed) {
    oauthError(res, 429, "temporarily_unavailable", "Too many token requests. Try again shortly.");
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const grantType = typeof body.grant_type === "string" ? body.grant_type : "";

  if (grantType === "authorization_code") {
    await handleAuthorizationCodeGrant(body, res);
    return;
  }
  if (grantType === "refresh_token") {
    await handleRefreshTokenGrant(body, res);
    return;
  }
  oauthError(res, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

async function handleAuthorizationCodeGrant(
  body: Record<string, unknown>,
  res: { status: (n: number) => { json: (b: unknown) => void } }
): Promise<void> {
  const code = typeof body.code === "string" ? body.code : "";
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
  const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    oauthError(res, 400, "invalid_request", "code, client_id, redirect_uri and code_verifier are required");
    return;
  }

  const snap = await firestore
    .collection(CODES_COLLECTION)
    .where("codeHash", "==", hashToken(code))
    .limit(1)
    .get();

  if (snap.empty) {
    oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
    return;
  }

  const codeDoc = snap.docs[0];
  const codeData = codeDoc.data() as AuthCodeDoc;

  if (codeData.usedAt) {
    // Replay. The code already bought a token pair, so burn the whole family —
    // we can't tell whether the legitimate client or an attacker got there first.
    await revokeTokensForClientAndUser(codeData.clientId, codeData.userId);
    await codeDoc.ref.delete().catch(() => {});
    logger.warn("MCP OAuth code replay detected — revoked tokens", {
      clientId: codeData.clientId,
      userId: codeData.userId,
    });
    oauthError(res, 400, "invalid_grant", "Authorization code has already been used");
    return;
  }

  if (codeData.expiresAt <= Date.now()) {
    await codeDoc.ref.delete().catch(() => {});
    oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
    return;
  }
  if (codeData.clientId !== clientId || codeData.redirectUri !== redirectUri) {
    oauthError(res, 400, "invalid_grant", "Authorization code was issued to a different client or redirect_uri");
    return;
  }
  if (!verifyPkce(codeVerifier, codeData.codeChallenge)) {
    oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    return;
  }

  await codeDoc.ref.update({ usedAt: Date.now() });

  const clientSnap = await firestore.collection(CLIENTS_COLLECTION).doc(clientId).get();
  const clientName = clientSnap.exists ? (clientSnap.data() as OAuthClientDoc).clientName : "MCP client";

  const tokens = await issueTokenPair({
    userId: codeData.userId,
    clientId,
    clientName,
    scopes: codeData.scopes,
  });

  await firestore.collection(CLIENTS_COLLECTION).doc(clientId).update({ lastUsedAt: Date.now() }).catch(() => {});

  sendJson(res, 200, {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: codeData.scopes.join(" "),
  });
}

async function handleRefreshTokenGrant(
  body: Record<string, unknown>,
  res: { status: (n: number) => { json: (b: unknown) => void } }
): Promise<void> {
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const clientId = typeof body.client_id === "string" ? body.client_id : "";

  if (!refreshToken) {
    oauthError(res, 400, "invalid_request", "refresh_token is required");
    return;
  }

  const snap = await firestore
    .collection(TOKENS_COLLECTION)
    .where("tokenHash", "==", hashToken(refreshToken))
    .limit(1)
    .get();

  if (snap.empty) {
    oauthError(res, 400, "invalid_grant", "Refresh token is invalid");
    return;
  }

  const doc = snap.docs[0];
  const data = doc.data() as OAuthTokenDoc;

  if (data.type !== "refresh" || data.expiresAt <= Date.now()) {
    oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired");
    return;
  }
  if (data.revoked) {
    // A revoked refresh token being presented means either a stale client or a
    // stolen one. Kill the family rather than guess.
    await revokeTokensForFamily(data.familyId, data.userId);
    oauthError(res, 400, "invalid_grant", "Refresh token has been revoked");
    return;
  }
  if (clientId && data.clientId !== clientId) {
    oauthError(res, 400, "invalid_grant", "Refresh token was issued to a different client");
    return;
  }

  // Rotate: the presented token is spent the moment it is accepted.
  await doc.ref.update({ revoked: true, lastUsedAt: Date.now() });

  const tokens = await issueTokenPair({
    userId: data.userId,
    clientId: data.clientId,
    clientName: data.clientName,
    scopes: data.scopes,
    familyId: data.familyId,
  });

  sendJson(res, 200, {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: data.scopes.join(" "),
  });
}

async function handleRevoke(
  req: { body?: unknown },
  res: { status: (n: number) => { json: (b: unknown) => void; send: (b: string) => void } }
): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token : "";

  // RFC 7009: always 200, even for unknown tokens.
  if (token) {
    const snap = await firestore
      .collection(TOKENS_COLLECTION)
      .where("tokenHash", "==", hashToken(token))
      .limit(1)
      .get();
    if (!snap.empty) {
      const data = snap.docs[0].data() as OAuthTokenDoc;
      await revokeTokensForFamily(data.familyId, data.userId);
    }
  }

  res.status(200).json({});
}

async function revokeTokensForFamily(familyId: string | undefined, userId: string): Promise<void> {
  if (!familyId) return;
  const snap = await firestore
    .collection(TOKENS_COLLECTION)
    .where("userId", "==", userId)
    .where("familyId", "==", familyId)
    .get();
  if (snap.empty) return;
  const batch = firestore.batch();
  snap.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  await batch.commit();
  invalidateBearerCacheForUser(userId);
}

async function revokeTokensForClientAndUser(clientId: string, userId: string): Promise<void> {
  const snap = await firestore
    .collection(TOKENS_COLLECTION)
    .where("userId", "==", userId)
    .where("clientId", "==", clientId)
    .get();
  if (snap.empty) return;
  const batch = firestore.batch();
  snap.docs.forEach((d) => batch.update(d.ref, { revoked: true }));
  await batch.commit();
  invalidateBearerCacheForUser(userId);
}

// ── Metadata documents ──

/**
 * Scopes we advertise in discovery metadata.
 *
 * Deliberately NOT `ALL_SCOPES`. Clients read `scopes_supported` and request the
 * whole list — Claude Code does exactly that — so advertising `checks:delete`
 * meant every first-time user was shown a red "this can permanently delete your
 * monitors" warning on the consent screen for access their agent never asked
 * for. Withholding it from the advertisement is what actually keeps it out of
 * the default grant; the constant below is still honoured if a client names it
 * explicitly.
 */
const ADVERTISED_SCOPES = DEFAULT_MCP_SCOPES;

function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
    scopes_supported: ADVERTISED_SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: "https://docs.exit1.dev/api-reference",
  };
}

function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE_URL,
    authorization_servers: [ISSUER],
    scopes_supported: ADVERTISED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: "https://docs.exit1.dev/integrations/mcp",
  };
}

// ── Function export ──

export const mcpOauth = onRequest({ maxInstances: 10 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  const path = normalizePath(req);

  try {
    // RFC 8414 permits the issuer path to be appended to the well-known name, so
    // match on prefix rather than exact equality.
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-authorization-server")) {
      res.set("Cache-Control", "public, max-age=3600");
      res.status(200).json(authorizationServerMetadata());
      return;
    }
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      res.set("Cache-Control", "public, max-age=3600");
      res.status(200).json(protectedResourceMetadata());
      return;
    }
    if (req.method === "POST" && path === "/oauth/register") {
      await handleRegister(req, res);
      return;
    }
    if (req.method === "GET" && path === "/oauth/authorize") {
      await handleAuthorize(req, res);
      return;
    }
    if (req.method === "POST" && path === "/oauth/token") {
      await handleToken(req, res);
      return;
    }
    if (req.method === "POST" && path === "/oauth/revoke") {
      await handleRevoke(req, res);
      return;
    }

    oauthError(res, 404, "not_found", `No OAuth endpoint at ${path}`);
  } catch (error) {
    logger.error("mcpOauth handler failed", { path, error });
    oauthError(res, 500, "server_error", "Unexpected error");
  }
});

// ── Callables used by the SPA consent page ──

/**
 * Load an authorization request for display. Returns only what the consent
 * screen needs to render — never the code challenge or the request's internals.
 */
export const getMcpAuthorizationRequest = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const requestId = typeof request.data?.requestId === "string" ? request.data.requestId : "";
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required");

  const snap = await firestore.collection(REQUESTS_COLLECTION).doc(requestId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Authorization request not found");

  const data = snap.data() as AuthRequestDoc;
  if (data.expiresAt <= Date.now() || data.consumedAt) {
    throw new HttpsError("failed-precondition", "This authorization request has expired. Start over from your AI tool.");
  }

  let redirectHost = data.redirectUri;
  try {
    redirectHost = new URL(data.redirectUri).host;
  } catch {
    /* fall back to the raw string */
  }

  return {
    success: true,
    data: {
      clientName: data.clientName,
      scopes: data.scopes,
      redirectHost,
      expiresAt: data.expiresAt,
    },
  };
});

/**
 * Approve or deny an authorization request. On approval this mints the one-time
 * code and returns the URL the browser should be sent to.
 */
export const approveMcpAuthorization = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const requestId = typeof request.data?.requestId === "string" ? request.data.requestId : "";
  const approved = request.data?.approved !== false;
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required");

  const requestRef = firestore.collection(REQUESTS_COLLECTION).doc(requestId);
  const snap = await requestRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Authorization request not found");

  const data = snap.data() as AuthRequestDoc;
  if (data.expiresAt <= Date.now() || data.consumedAt) {
    throw new HttpsError("failed-precondition", "This authorization request has expired. Start over from your AI tool.");
  }

  // Single-use: consume before doing anything else so a double-click can't mint
  // two codes for one consent.
  await requestRef.update({ consumedAt: Date.now() });

  if (!approved) {
    return {
      success: true,
      redirectTo: appendQuery(data.redirectUri, { error: "access_denied", state: data.state }),
    };
  }

  const code = `ek_ac_${randomBytes(32).toString("hex")}`;
  const now = Date.now();

  await firestore.collection(CODES_COLLECTION).add({
    codeHash: hashToken(code),
    clientId: data.clientId,
    userId: uid,
    redirectUri: data.redirectUri,
    codeChallenge: data.codeChallenge,
    scopes: data.scopes,
    resource: data.resource,
    createdAt: now,
    expiresAt: now + AUTH_CODE_TTL_MS,
  } satisfies AuthCodeDoc);

  // Attribution: first MCP grant marks where this user came from. Never
  // overwritten — a Pro user connecting an agent later is not an MCP signup.
  const userRef = firestore.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const existingOrigin = userSnap.exists ? (userSnap.data() || {}).acquisitionOrigin : undefined;
  await userRef.set(
    {
      ...(existingOrigin ? {} : { acquisitionOrigin: "mcp" }),
      mcpConnectedAt: now,
      mcpLastClientName: data.clientName,
    },
    { merge: true }
  );

  logger.info("MCP authorization approved", { uid, clientId: data.clientId, scopes: data.scopes });

  return {
    success: true,
    redirectTo: appendQuery(data.redirectUri, { code, state: data.state }),
  };
});

/** List the agent connections a user has authorized, for the dashboard. */
export const listMcpConnections = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const snap = await firestore
    .collection(TOKENS_COLLECTION)
    .where("userId", "==", uid)
    .where("type", "==", "access")
    .where("revoked", "==", false)
    .get();

  const now = Date.now();
  const byClient = new Map<string, { clientId: string; clientName: string; scopes: string[]; createdAt: number; lastUsedAt: number | null }>();

  for (const doc of snap.docs) {
    const data = doc.data() as OAuthTokenDoc;
    if (data.expiresAt <= now) continue;
    const existing = byClient.get(data.clientId);
    if (!existing || data.createdAt > existing.createdAt) {
      byClient.set(data.clientId, {
        clientId: data.clientId,
        clientName: data.clientName,
        scopes: data.scopes || [],
        createdAt: data.createdAt,
        lastUsedAt: data.lastUsedAt ?? null,
      });
    }
  }

  return {
    success: true,
    data: Array.from(byClient.values()).sort((a, b) => b.createdAt - a.createdAt),
  };
});

/** Revoke every token issued to one client for the calling user. */
export const revokeMcpConnection = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");

  const clientId = typeof request.data?.clientId === "string" ? request.data.clientId : "";
  if (!clientId) throw new HttpsError("invalid-argument", "clientId is required");

  await revokeTokensForClientAndUser(clientId, uid);
  logger.info("MCP connection revoked", { uid, clientId });
  return { success: true };
});
