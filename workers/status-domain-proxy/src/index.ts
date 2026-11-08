// Origin Worker for Cloudflare for SaaS custom hostnames (status.acme.com).
// Serves the exit1 SPA shell and its assets from Firebase Hosting; the SPA
// detects the foreign hostname and renders only that host's status page.
// The Worker never reads Firestore: only hostnames we registered through the
// Cloudflare API can reach it at all.

import { ROBOTS_TXT, routeRequest } from './routing';

const YEAR = 31536000;
const SHELL_EDGE_TTL = 60;

// Response headers that must never reach a customer's domain.
const STRIPPED = [
  'strict-transport-security', // never pin HSTS (or includeSubDomains) on their domain
  'set-cookie',
  'pragma',
  'expires',
];

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function handle(req: Request, fetcher: Fetcher = fetch): Promise<Response> {
  const url = new URL(req.url);
  const route = routeRequest(url, req.method);

  switch (route.kind) {
    case 'not-found':
      return notFound();
    case 'method-not-allowed':
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    case 'redirect':
      return Response.redirect(route.location, 301);
    case 'robots':
      return new Response(req.method === 'HEAD' ? null : ROBOTS_TXT, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
    case 'asset':
    case 'shell':
      break;
  }

  const isAsset = route.kind === 'asset';
  const res = await fetcher(route.upstream, {
    method: req.method,
    cf: isAsset
      ? { cacheEverything: true, cacheTtlByStatus: { '200-299': YEAR, '300-599': 0 } }
      : { cacheEverything: true, cacheTtlByStatus: { '200-299': SHELL_EDGE_TTL, '300-599': 0 } },
  });

  // Firebase answers a missing file with the SPA shell (200, text/html), even
  // under /assets/. Never hand that out as a script or image.
  if (isAsset && (res.headers.get('content-type') ?? '').startsWith('text/html')) {
    return notFound();
  }

  const out = new Response(res.body, res);
  for (const name of STRIPPED) out.headers.delete(name);
  out.headers.set('x-content-type-options', 'nosniff');

  if (isAsset) {
    if (res.ok) out.headers.set('cache-control', `public, max-age=${YEAR}, immutable`);
  } else {
    out.headers.set('cache-control', 'no-cache');
    out.headers.set('link', `<https://${url.hostname}/>; rel="canonical"`);
    out.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  }
  return out;
}

export default {
  async fetch(req: Request): Promise<Response> {
    try {
      return await handle(req);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'status-domain-proxy upstream error', url: req.url, error: String(err) }));
      return new Response('Status page temporarily unavailable', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  },
} satisfies ExportedHandler;
