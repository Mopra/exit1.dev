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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Does a presented redirect_uri match one of the client's registered ones?
 *
 * Exact string match, with one exception from RFC 8252 §7.3: for an http
 * loopback callback the port is ignored, because a CLI binds an ephemeral port
 * at runtime and can't know it when it publishes its metadata. Claude Code's
 * own Client ID Metadata Document lists `http://localhost/callback` with no
 * port at all, so without this every CIMD connection from it would fail.
 * Scheme, host, path and query must still match exactly, so the exception
 * only ever lets a code land on the user's own machine.
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;

  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  if (p.protocol !== "http:" || !LOOPBACK_HOSTS.has(p.hostname) || p.hash) return false;

  return registered.some((candidate) => {
    let r: URL;
    try {
      r = new URL(candidate);
    } catch {
      return false;
    }
    return (
      r.protocol === "http:" &&
      r.hostname === p.hostname &&
      r.pathname === p.pathname &&
      r.search === p.search
    );
  });
}

// ── Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document) ──

export const MAX_CIMD_CLIENT_ID_LENGTH = 2000;
export const MAX_CIMD_REDIRECT_URIS = 10;

/**
 * Is this client_id a Client ID Metadata Document URL?
 *
 * The draft's rules: https, a path component, no userinfo, no fragment, and no
 * `.` or `..` segments. The dot-segment check runs on the raw string because
 * `new URL()` silently resolves them away, and the whole point of the rule is
 * that the identifier the user sees is the document we fetch.
 */
export function isCimdClientId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  if (value.length > MAX_CIMD_CLIENT_ID_LENGTH) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:" || !parsed.hostname) return false;
  if (parsed.username || parsed.password || parsed.hash || value.includes("#")) return false;
  if (parsed.pathname === "/" || !parsed.pathname) return false;

  const rawPath = value.slice("https://".length).replace(/^[^/]*/, "").split(/[?]/)[0];
  if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) return false;

  return true;
}

export interface CimdClient {
  clientName: string;
  redirectUris: string[];
}

/**
 * Validate a fetched metadata document against the URL it came from.
 *
 * Returns the client on success or a reason string the authorize endpoint can
 * show. We only support public clients, so `private_key_jwt` is refused along
 * with the secret-based methods the draft forbids outright.
 */
export function validateCimdDocument(doc: unknown, clientIdUrl: string): CimdClient | string {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return "Client metadata document is not a JSON object";
  }
  const d = doc as Record<string, unknown>;

  if (d.client_id !== clientIdUrl) {
    return "Client metadata document's client_id does not match its URL";
  }
  if ("client_secret" in d || "client_secret_expires_at" in d) {
    return "Client metadata document must not contain a client_secret";
  }
  const authMethod = d.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none") {
    return "Only public clients (token_endpoint_auth_method=none) are supported";
  }

  const rawUris = d.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return "Client metadata document must list redirect_uris";
  }
  if (rawUris.length > MAX_CIMD_REDIRECT_URIS) {
    return `Client metadata document lists more than ${MAX_CIMD_REDIRECT_URIS} redirect_uris`;
  }
  if (!rawUris.every(isAllowedRedirectUri)) {
    return "redirect_uris must be https:// or http://localhost (no fragments)";
  }

  // The draft requires client_name for MCP, but a missing one shouldn't block
  // the user: fall back to the host, which is the part we can actually vouch for.
  const clientName =
    typeof d.client_name === "string" && d.client_name.trim()
      ? d.client_name.trim().slice(0, 120)
      : new URL(clientIdUrl).hostname;

  return { clientName, redirectUris: rawUris as string[] };
}

/**
 * Is this IP address one we must never fetch from (RFC 6890 special-use)?
 *
 * The metadata URL is attacker-chosen, so without this an authorize link
 * could make our function read from the metadata server, the VPC, or itself.
 * IPv4-mapped IPv6 is unwrapped first so `::ffff:10.0.0.1` can't slip past.
 */
export function isSpecialUseAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  const address = mapped ? mapped[1] : ip;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const v6 = address.toLowerCase();
  if (!v6.includes(":")) return true; // not an address we understand: refuse
  if (v6 === "::" || v6 === "::1") return true;
  const first = parseInt(v6.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    v6.startsWith("64:ff9b:") || // NAT64, would reach an embedded IPv4
    v6.startsWith("2001:db8:") || // documentation
    v6.startsWith("2001:0:") || // Teredo
    v6.startsWith("2002:") || // 6to4, embeds an IPv4
    v6.startsWith("::ffff:") // mapped forms the regex above didn't unwrap
  );
}

/**
 * How long to cache a metadata document, from its Cache-Control header.
 *
 * The draft says to honour HTTP caching. We clamp it: a floor so a client
 * sending `no-cache` doesn't cost a fetch on every authorize, a ceiling so a
 * client that changes its redirect URIs isn't locked out for days.
 */
export function cimdCacheTtlMs(cacheControl: string | undefined | null): number {
  const MIN = 5 * 60 * 1000;
  const MAX = 24 * 60 * 60 * 1000;
  const DEFAULT = 60 * 60 * 1000;
  if (!cacheControl) return DEFAULT;
  if (/\bno-store\b/i.test(cacheControl)) return 0;
  const match = /\bmax-age=(\d+)/i.exec(cacheControl);
  if (!match) return /\bno-cache\b/i.test(cacheControl) ? MIN : DEFAULT;
  return Math.min(MAX, Math.max(MIN, Number(match[1]) * 1000));
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
