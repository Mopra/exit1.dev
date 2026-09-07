/**
 * Pure HTTP-method policy for the hosted MCP endpoint.
 *
 * Split out of `mcp-server.ts` (which imports firebase-functions and the OAuth
 * store, so it can't be unit-imported) for the same reason as
 * `mcp-oauth-policy.ts`: this one decision has a bill attached, and the comment
 * that used to guard it was wrong for a month.
 */

/** Value for the `Allow` header on a 405, and for CORS `Access-Control-Allow-Methods`. */
export const MCP_ALLOWED_METHODS = "POST, OPTIONS";

/**
 * Whether a request may be handed to the Streamable HTTP transport at all.
 *
 * Only POST qualifies. GET is the one that costs money: Streamable HTTP lets a
 * client open a standalone GET to receive server-initiated messages, and the
 * SDK honours it even with `enableJsonResponse: true` (that flag only shapes
 * POST replies). On Cloud Run the resulting `text/event-stream` sits open until
 * the 120s function timeout, the client reconnects, and a single connected agent
 * pins an instance around the clock. That was the 2026-08-30 Cloud Run cost
 * spike. This server never pushes anything down that stream, so refusing it
 * loses nothing; the spec names 405 as the way to say so, and SDK clients treat
 * that as "no stream offered" rather than an error.
 *
 * DELETE terminates a session and there are none. 405 is the spec answer there
 * too. OPTIONS is answered before this check as a CORS preflight.
 */
export function isMcpTransportMethod(method: string): boolean {
  return method.toUpperCase() === "POST";
}
