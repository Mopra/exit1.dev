/**
 * WAF / bot-protection block-page detection.
 *
 * A 401/403 is accepted as UP by default so that auth-walled pages count as
 * reachable. That allowance is wrong when the 403 is not the origin talking
 * but an edge firewall refusing to forward our probe: the monitor is blind and
 * the origin could be on fire (jcinsulationsa.com, 2026-09: Cloudflare WAF 403
 * to the probe for ten weeks while browsers saw an origin 526).
 *
 * This module is pure so it can be unit-tested and shared by the primary probe
 * and the peer-confirm path (both call checkRestEndpoint).
 */

export type WafBlock = {
  vendor: "Cloudflare";
  /** "block" = hard deny (WAF rule, IP/ASN/geo block). "challenge" = JS or managed challenge. */
  kind: "block" | "challenge";
};

/**
 * Status codes an edge firewall uses for a refused or challenged request.
 * 403: WAF block, IP/geo/ASN block, managed challenge. 503: Under Attack mode
 * and legacy JS challenges. Cloudflare's own origin-error pages (52x) share the
 * block page's markup, so the candidate set deliberately excludes them.
 */
export const WAF_CANDIDATE_STATUS_CODES: ReadonlySet<number> = new Set([403, 503]);

const getHeader = (headers: Headers, name: string): string | undefined => {
  const value = headers.get(name);
  return value === null ? undefined : value;
};

const hasCloudflareHeaders = (headers: Headers): boolean =>
  Boolean(getHeader(headers, "cf-mitigated")) ||
  Boolean(getHeader(headers, "cf-ray")) ||
  (getHeader(headers, "server")?.toLowerCase() ?? "").includes("cloudflare");

/**
 * Whether the response looks like it was produced by an edge that may have
 * substituted its own block page. Used to decide whether spending one extra
 * body-reading request is worth it. Cheap and header-only.
 */
export const mayBeWafResponse = (statusCode: number, headers: Headers): boolean =>
  WAF_CANDIDATE_STATUS_CODES.has(statusCode) && hasCloudflareHeaders(headers);

/**
 * Classify a response as a WAF block or challenge page, or undefined when it
 * is an ordinary response (including an ordinary origin 403 behind a CDN).
 *
 * Header-only signals are checked first so the caller can skip the body fetch
 * when they already settle it. Body signatures are matched against the first
 * few KB, where every vendor puts its <title>.
 */
export const detectWafBlock = (
  statusCode: number,
  headers: Headers,
  bodySnippet?: string
): WafBlock | undefined => {
  if (!WAF_CANDIDATE_STATUS_CODES.has(statusCode)) return undefined;

  // Cloudflare stamps every challenge (JS, managed, interactive, Under Attack
  // mode) with this header. It is never present on a passthrough origin 403.
  const mitigated = getHeader(headers, "cf-mitigated")?.toLowerCase();
  if (mitigated === "challenge") {
    return { vendor: "Cloudflare", kind: "challenge" };
  }

  if (!bodySnippet) return undefined;
  const body = bodySnippet.toLowerCase();
  const fromCloudflare =
    hasCloudflareHeaders(headers) ||
    body.includes("/cdn-cgi/styles/cf.errors.css") ||
    body.includes("/cdn-cgi/challenge-platform/");
  if (!fromCloudflare) return undefined;

  // WAF / firewall rule block page (error 1020 and friends). Only ever a 403:
  // a Cloudflare-generated 503 with the same markup is an origin problem, not
  // a refusal to forward us, and must keep its plain "HTTP 503" error.
  if (
    statusCode === 403 &&
    (body.includes("<title>attention required! | cloudflare</title>") ||
      body.includes("sorry, you have been blocked"))
  ) {
    return { vendor: "Cloudflare", kind: "block" };
  }

  // Challenge page served without the cf-mitigated header (older variants).
  // Deliberately NOT keyed on "/cdn-cgi/challenge-platform/": Bot Management's
  // JavaScript Detections injects a script from that path into ordinary origin
  // HTML, so the path alone does not mean the origin was withheld.
  if (body.includes("<title>just a moment...</title>")) {
    return { vendor: "Cloudflare", kind: "challenge" };
  }

  return undefined;
};

/**
 * Stable, user-facing error string. Lands in lastError, alert emails, webhooks
 * and the history table, so it says what happened and what to do.
 */
export const describeWafBlock = (block: WafBlock, statusCode: number, userAgent: string): string => {
  const what =
    block.kind === "challenge"
      ? `${block.vendor} challenge page`
      : `Blocked by ${block.vendor} firewall`;
  return `${what} (HTTP ${statusCode}): the monitor never reached your origin server. Allow the user agent "${userAgent}" (or the monitor's IP addresses) in your ${block.vendor} WAF rules. See https://docs.exit1.dev/monitoring/request-headers`;
};
