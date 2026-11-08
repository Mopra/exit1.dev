// Pure request routing for the custom status domain proxy. No I/O here, so it
// is unit tested directly. See docs/plans/custom-status-domain.md sections 8 and 10.

export const ORIGIN = 'https://app.exit1.dev';

// Paths that belong to exit1 itself and must never be served on a customer
// domain: public API, OAuth consent, MCP, probes, discovery documents, and
// files that describe exit1 rather than the customer (llms.txt, sitemaps).
// Blocking OAuth and MCP here is what stops a custom domain fronting an exit1
// sign-in or consent page.
const BLOCKED = /^\/(v1|api|oauth|mcp|probe|\.well-known)(\/|$)|^\/(llms\.txt|sitemap)/i;

// Static files fetched as is from Firebase Hosting. Everything under /assets/
// has a content hash in its name, so it is cached at the edge for a year.
const PASSTHROUGH = /^\/assets\/[^?#]+$|^\/(e_\.svg|e_ Logo\.png|e_ Logo Large\.png|favicon\.ico)$/;

export const ROBOTS_TXT = 'User-agent: *\nAllow: /\n';

export type Route =
  | { kind: 'not-found' }
  | { kind: 'method-not-allowed' }
  | { kind: 'redirect'; location: string }
  | { kind: 'robots' }
  | { kind: 'asset'; upstream: string }
  | { kind: 'shell'; upstream: string };

/** True for exit1.dev and every subdomain. The proxy never fronts our own hosts. */
export function isOwnHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'exit1.dev' || host.endsWith('.exit1.dev');
}

function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

export function routeRequest(url: URL, method: string): Route {
  if (isOwnHost(url.hostname)) return { kind: 'not-found' };

  if (url.protocol === 'http:') {
    const secure = new URL(url.toString());
    secure.protocol = 'https:';
    return { kind: 'redirect', location: secure.toString() };
  }

  if (method !== 'GET' && method !== 'HEAD') return { kind: 'method-not-allowed' };

  const path = decodePath(url.pathname);
  if (path === null) return { kind: 'not-found' };
  // Dot segments are normalized by URL parsing; a decoded one is an attempt to
  // smuggle a path past the checks below.
  if (path.includes('/../') || path.endsWith('/..') || path.includes('\\')) {
    return { kind: 'not-found' };
  }

  if (path === '/robots.txt') return { kind: 'robots' };
  if (BLOCKED.test(path)) return { kind: 'not-found' };

  if (PASSTHROUGH.test(path)) {
    // Keep the encoded form so names with spaces reach Firebase intact.
    return { kind: 'asset', upstream: ORIGIN + url.pathname };
  }

  // Every other path gets the SPA shell. The SPA sees the foreign hostname and
  // renders only the status page bound to it.
  return { kind: 'shell', upstream: ORIGIN + '/' };
}
