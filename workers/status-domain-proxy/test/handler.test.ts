import { describe, expect, it } from 'vitest';
import { handle, type Fetcher } from '../src/index';

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeOrigin(body: string, headers: Record<string, string>, status = 200) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers });
  };
  return { calls, fetcher };
}

const FIREBASE_SHELL_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache, no-store, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
  'strict-transport-security': 'max-age=31556926',
  'set-cookie': 'a=b',
};

describe('handle', () => {
  it('serves the shell with HSTS and cookies stripped and a canonical link', async () => {
    const { calls, fetcher } = fakeOrigin('<div id="root"></div>', FIREBASE_SHELL_HEADERS);
    const res = await handle(new Request('https://status.acme.com/some/page'), fetcher);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://app.exit1.dev/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<div id="root"></div>');
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('pragma')).toBeNull();
    expect(res.headers.get('expires')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('link')).toBe('<https://status.acme.com/>; rel="canonical"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('edge caches the shell for 60 s and assets for a year, and does not cache errors', async () => {
    const shell = fakeOrigin('x', { 'content-type': 'text/html' });
    await handle(new Request('https://status.acme.com/'), shell.fetcher);
    expect(shell.calls[0]!.init?.cf).toEqual({
      cacheEverything: true,
      cacheTtlByStatus: { '200-299': 60, '300-599': 0 },
    });

    const asset = fakeOrigin('js', { 'content-type': 'text/javascript' });
    await handle(new Request('https://status.acme.com/assets/a-1.js'), asset.fetcher);
    expect(asset.calls[0]!.init?.cf).toEqual({
      cacheEverything: true,
      cacheTtlByStatus: { '200-299': 31536000, '300-599': 0 },
    });
  });

  it('proxies assets as immutable without HSTS', async () => {
    const { calls, fetcher } = fakeOrigin('console.log(1)', {
      'content-type': 'text/javascript',
      'cache-control': 'public, max-age=31536000, immutable',
      'strict-transport-security': 'max-age=31556926',
    });
    const res = await handle(new Request('https://status.acme.com/assets/index-x1.js'), fetcher);

    expect(calls[0]!.url).toBe('https://app.exit1.dev/assets/index-x1.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect(res.headers.get('link')).toBeNull();
  });

  it('turns the Firebase SPA fallback for a missing asset into a 404', async () => {
    const { fetcher } = fakeOrigin('<html>', FIREBASE_SHELL_HEADERS);
    const res = await handle(new Request('https://status.acme.com/assets/gone-123.js'), fetcher);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers blocked paths, own hosts and bad methods without calling the origin', async () => {
    const { calls, fetcher } = fakeOrigin('x', {});
    const cases: Array<[Request, number]> = [
      [new Request('https://status.acme.com/oauth/authorize'), 404],
      [new Request('https://status.acme.com/mcp/v1'), 404],
      [new Request('https://status.acme.com/v1/public/monitors'), 404],
      [new Request('https://status.acme.com/.well-known/oauth-authorization-server'), 404],
      [new Request('https://domains.exit1.dev/'), 404],
      [new Request('https://status.acme.com/', { method: 'POST', body: 'x' }), 405],
    ];
    for (const [req, status] of cases) {
      const res = await handle(req, fetcher);
      expect(res.status, req.url).toBe(status);
      expect(res.headers.get('strict-transport-security')).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('redirects HTTP to HTTPS', async () => {
    const { calls, fetcher } = fakeOrigin('x', {});
    const res = await handle(new Request('http://status.acme.com/a?b=1'), fetcher);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://status.acme.com/a?b=1');
    expect(calls).toHaveLength(0);
  });

  it('synthesizes robots.txt allowing everything', async () => {
    const { calls, fetcher } = fakeOrigin('x', {});
    const res = await handle(new Request('https://status.acme.com/robots.txt'), fetcher);
    expect(await res.text()).toBe('User-agent: *\nAllow: /\n');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(calls).toHaveLength(0);
  });
});
