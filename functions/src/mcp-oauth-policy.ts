/**
 * Pure policy helpers for the MCP OAuth server.
 *
 * Split out of `mcp-oauth.ts` because these are the security-critical decisions —
 * which callbacks we'll redirect an authorization code to, and whether a PKCE
 * verifier actually matches its challenge — and they deserve tests that don't
 * need Firebase, Firestore, or a running function.
 */

import { createHash, timingSafeEqual } from "crypto";
import { ALL_SCOPES, API_SCOPES, type ApiScope } from "./api-scopes";

/**
 * Scopes an MCP client gets when it doesn't ask for anything specific.
 *
 * `checks:delete` is deliberately absent: an agent should have to ask for
 * destruction explicitly, and the user should see it called out on the consent
 * screen when it does.
 */
export const DEFAULT_MCP_SCOPES: ApiScope[] = [
  API_SCOPES.CHECKS_READ,
  API_SCOPES.CHECKS_WRITE,
  API_SCOPES.ALERTS_READ,
  API_SCOPES.ALERTS_WRITE,
];

export const MAX_REDIRECT_URI_LENGTH = 2000;

/**
 * Redirect URI policy: https anywhere, or http on loopback only.
 *
 * This is the control that stops a hostile client from registering
 * `https://evil.example`-style callbacks it doesn't own and racing a legitimate
 * client's authorization code onto its own endpoint. Loopback is permitted with
 * any port because CLI clients bind an ephemeral one at runtime — that's the
 * native-app flow from RFC 8252 §7.3.
 *
 * Fragments are rejected outright: the authorization response appends query
 * parameters, and a pre-existing fragment would let a client smuggle content
 * past the code/state parameters we control.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_REDIRECT_URI_LENGTH) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.hash) return false;

  if (parsed.protocol === "https:") {
    // A bare "https:" with no host isn't a usable callback.
    return parsed.hostname.length > 0;
  }

  if (parsed.protocol === "http:") {
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  }

  // Custom schemes (myapp://) are rejected. They're legal in RFC 8252 but we
  // can't verify ownership of one, and no MCP client we support needs it.
  return false;
}

/** base64url(SHA-256(input)) — the S256 code challenge transform. */
export function base64UrlSha256(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a PKCE code_verifier against the stored challenge.
 *
 * Length bounds come from RFC 7636 §4.1. Enforcing the minimum matters: without
 * it a client could register a trivially guessable verifier and lose the
 * interception protection PKCE exists to provide.
 */
export function verifyPkce(codeVerifier: unknown, storedChallenge: unknown): boolean {
  if (typeof codeVerifier !== "string" || typeof storedChallenge !== "string") return false;
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) return false;
  if (!storedChallenge) return false;
  return constantTimeEquals(base64UrlSha256(codeVerifier), storedChallenge);
}

/**
 * Parse a requested `scope` string down to scopes we actually recognise.
 *
 * Unknown entries are dropped rather than rejected — a client asking for
 * something we don't implement shouldn't fail the whole authorization — but a
 * request consisting entirely of unknown scopes falls back to the default set
 * rather than granting nothing, which would produce a token that 403s on
 * every call.
 */
export function parseScopes(raw: unknown): ApiScope[] {
  if (typeof raw !== "string" || !raw.trim()) return [...DEFAULT_MCP_SCOPES];
  const requested = raw.split(/[\s+]+/).filter(Boolean);
  const allowed = requested.filter((s): s is ApiScope => (ALL_SCOPES as string[]).includes(s));
  return allowed.length > 0 ? Array.from(new Set(allowed)) : [...DEFAULT_MCP_SCOPES];
}

/** Append query parameters to a URL, skipping empty values. */
export function appendQuery(base: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
