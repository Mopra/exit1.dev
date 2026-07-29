import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";

import {
  DEFAULT_MCP_SCOPES,
  appendQuery,
  base64UrlSha256,
  isAllowedRedirectUri,
  parseScopes,
  verifyPkce,
} from "../mcp-oauth-policy";
import { API_SCOPES } from "../api-scopes";

// Security coverage for the MCP OAuth server. These two decisions — which
// callback we'll hand an authorization code to, and whether a PKCE verifier
// really matches — are the difference between "an agent can manage your
// monitors" and "anyone who can get you to click a link can".

// ── Redirect URI policy ──

test("loopback callbacks are allowed on any port (CLI clients bind one at runtime)", () => {
  assert.equal(isAllowedRedirectUri("http://localhost:33418/callback"), true);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1:8976/oauth/cb"), true);
  assert.equal(isAllowedRedirectUri("http://[::1]:5000/cb"), true);
});

test("https callbacks are allowed", () => {
  assert.equal(isAllowedRedirectUri("https://cursor.sh/oauth/callback"), true);
  assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
});

test("plaintext http to a non-loopback host is rejected", () => {
  // The code would travel in the clear to a host we can't verify.
  assert.equal(isAllowedRedirectUri("http://evil.example/callback"), false);
  assert.equal(isAllowedRedirectUri("http://192.168.1.10/callback"), false);
  // Near-misses that a naive substring check would wave through.
  assert.equal(isAllowedRedirectUri("http://localhost.evil.example/cb"), false);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1.evil.example/cb"), false);
});

test("non-http(s) schemes are rejected", () => {
  assert.equal(isAllowedRedirectUri("javascript:alert(1)"), false);
  assert.equal(isAllowedRedirectUri("data:text/html,<script>"), false);
  assert.equal(isAllowedRedirectUri("file:///etc/passwd"), false);
  // Custom app schemes are legal per RFC 8252 but we can't verify ownership.
  assert.equal(isAllowedRedirectUri("myagent://callback"), false);
});

test("callbacks carrying a fragment are rejected", () => {
  // The authorization response appends query params; a pre-existing fragment
  // lets a client control what lands after them.
  assert.equal(isAllowedRedirectUri("https://example.com/cb#anything"), false);
});

test("malformed, empty and oversized values are rejected", () => {
  assert.equal(isAllowedRedirectUri(""), false);
  assert.equal(isAllowedRedirectUri("not a url"), false);
  assert.equal(isAllowedRedirectUri(null), false);
  assert.equal(isAllowedRedirectUri(undefined), false);
  assert.equal(isAllowedRedirectUri(12345), false);
  assert.equal(isAllowedRedirectUri({ toString: () => "https://example.com" }), false);
  assert.equal(isAllowedRedirectUri(`https://example.com/${"a".repeat(2100)}`), false);
});

// ── PKCE ──

const VALID_VERIFIER = "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXkw123456";

test("a verifier matching its S256 challenge passes", () => {
  const challenge = base64UrlSha256(VALID_VERIFIER);
  assert.equal(verifyPkce(VALID_VERIFIER, challenge), true);
});

test("base64UrlSha256 produces unpadded base64url, matching RFC 7636", () => {
  const out = base64UrlSha256(VALID_VERIFIER);
  assert.match(out, /^[A-Za-z0-9\-_]+$/, "no +, / or = characters");
  const expected = createHash("sha256")
    .update(VALID_VERIFIER)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(out, expected);
});

test("a wrong verifier fails", () => {
  const challenge = base64UrlSha256(VALID_VERIFIER);
  assert.equal(verifyPkce(`${VALID_VERIFIER.slice(0, -1)}X`, challenge), false);
});

test("the challenge itself is not accepted as the verifier", () => {
  // Guards against an implementation that compares the two directly.
  const challenge = base64UrlSha256(VALID_VERIFIER);
  assert.equal(verifyPkce(challenge, challenge), false);
});

test("verifiers outside the RFC 7636 length bounds are rejected", () => {
  // A short verifier is brute-forceable, which defeats the point of PKCE.
  const short = "abc";
  assert.equal(verifyPkce(short, base64UrlSha256(short)), false);
  const long = "a".repeat(129);
  assert.equal(verifyPkce(long, base64UrlSha256(long)), false);
});

test("verifiers with characters outside the RFC 7636 alphabet are rejected", () => {
  const bad = `${"a".repeat(42)}/`;
  assert.equal(verifyPkce(bad, base64UrlSha256(bad)), false);
});

test("an empty or non-string challenge never verifies", () => {
  assert.equal(verifyPkce(VALID_VERIFIER, ""), false);
  assert.equal(verifyPkce(VALID_VERIFIER, null), false);
  assert.equal(verifyPkce(VALID_VERIFIER, undefined), false);
  assert.equal(verifyPkce(null, base64UrlSha256(VALID_VERIFIER)), false);
});

// ── Scopes ──

test("an absent scope parameter yields the default grant", () => {
  assert.deepEqual(parseScopes(undefined), DEFAULT_MCP_SCOPES);
  assert.deepEqual(parseScopes(""), DEFAULT_MCP_SCOPES);
  assert.deepEqual(parseScopes("   "), DEFAULT_MCP_SCOPES);
});

test("delete access is never in the default grant", () => {
  assert.equal(DEFAULT_MCP_SCOPES.includes(API_SCOPES.CHECKS_DELETE), false);
  assert.equal(parseScopes(undefined).includes(API_SCOPES.CHECKS_DELETE), false);
});

test("delete access is granted only when explicitly requested", () => {
  const scopes = parseScopes("checks:read checks:delete");
  assert.deepEqual(scopes, [API_SCOPES.CHECKS_READ, API_SCOPES.CHECKS_DELETE]);
});

test("unknown scopes are dropped, known ones survive", () => {
  assert.deepEqual(parseScopes("checks:read billing:write nonsense"), [API_SCOPES.CHECKS_READ]);
});

test("an entirely unknown scope string falls back to the default grant", () => {
  // Granting nothing would mint a token that 403s on every call.
  assert.deepEqual(parseScopes("admin:* root"), DEFAULT_MCP_SCOPES);
});

test("duplicate scopes are collapsed", () => {
  assert.deepEqual(parseScopes("checks:read checks:read checks:read"), [API_SCOPES.CHECKS_READ]);
});

test("scopes separated by + (form-encoded spaces) parse correctly", () => {
  assert.deepEqual(parseScopes("checks:read+alerts:write"), [
    API_SCOPES.CHECKS_READ,
    API_SCOPES.ALERTS_WRITE,
  ]);
});

test("mutating a returned default scope array cannot poison later calls", () => {
  const first = parseScopes(undefined);
  first.push(API_SCOPES.CHECKS_DELETE);
  assert.equal(parseScopes(undefined).includes(API_SCOPES.CHECKS_DELETE), false);
});

// ── Redirect construction ──

test("appendQuery preserves an existing query string and skips empty values", () => {
  const out = appendQuery("https://example.com/cb?keep=1", { code: "abc", state: null });
  const url = new URL(out);
  assert.equal(url.searchParams.get("keep"), "1");
  assert.equal(url.searchParams.get("code"), "abc");
  assert.equal(url.searchParams.has("state"), false);
});

test("appendQuery encodes values rather than letting them inject parameters", () => {
  const out = appendQuery("https://example.com/cb", { code: "a&admin=1", state: "x y" });
  const url = new URL(out);
  assert.equal(url.searchParams.get("code"), "a&admin=1");
  assert.equal(url.searchParams.get("state"), "x y");
  assert.equal(url.searchParams.has("admin"), false);
});
