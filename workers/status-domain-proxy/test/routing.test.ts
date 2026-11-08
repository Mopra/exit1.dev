import { describe, expect, it } from 'vitest';
import { isOwnHost, routeRequest } from '../src/routing';

const route = (href: string, method = 'GET') => routeRequest(new URL(href), method);

describe('routeRequest', () => {
  it('serves the SPA shell for the root and any page path', () => {
    for (const path of ['/', '/status/abc', '/anything/deep?x=1', '/index.html']) {
      expect(route(`https://status.acme.com${path}`)).toEqual({ kind: 'shell', upstream: 'https://app.exit1.dev/' });
    }
  });

  it('passes hashed assets and favicons through', () => {
    expect(route('https://status.acme.com/assets/index-AbC123.js')).toEqual({
      kind: 'asset',
      upstream: 'https://app.exit1.dev/assets/index-AbC123.js',
    });
    expect(route('https://status.acme.com/e_.svg').kind).toBe('asset');
    expect(route('https://status.acme.com/favicon.ico').kind).toBe('asset');
    expect(route('https://status.acme.com/e_%20Logo.png')).toEqual({
      kind: 'asset',
      upstream: 'https://app.exit1.dev/e_%20Logo.png',
    });
    expect(route('https://status.acme.com/e_%20Logo%20Large.png').kind).toBe('asset');
  });

  it('blocks exit1 API, OAuth, MCP, probe and discovery paths', () => {
    for (const path of [
      '/v1/public/monitors',
      '/v1',
      '/api/probe/generate',
      '/oauth/authorize',
      '/OAuth/authorize',
      '/mcp/v1',
      '/probe/x',
      '/.well-known/oauth-authorization-server',
      '/%2Ewell-known/oauth-protected-resource',
      '/%6fauth/authorize',
      '/llms.txt',
      '/sitemap.xml',
      '/sitemap-0.xml',
    ]) {
      expect(route(`https://status.acme.com${path}`), path).toEqual({ kind: 'not-found' });
    }
  });

  it('does not over-block paths that only share a prefix', () => {
    expect(route('https://status.acme.com/v1beta').kind).toBe('shell');
    expect(route('https://status.acme.com/oauthx').kind).toBe('shell');
  });

  it('rejects encoded traversal and malformed encodings', () => {
    expect(route('https://status.acme.com/assets/%2E%2E/oauth/x').kind).toBe('not-found');
    expect(route('https://status.acme.com/assets/..%2Fmcp').kind).toBe('not-found');
    expect(route('https://status.acme.com/assets/%E0%A4%A').kind).toBe('not-found');
  });

  it('synthesizes robots.txt', () => {
    expect(route('https://status.acme.com/robots.txt')).toEqual({ kind: 'robots' });
  });

  it('never fronts exit1.dev hosts', () => {
    for (const host of ['exit1.dev', 'app.exit1.dev', 'domains.exit1.dev', 'APP.Exit1.Dev']) {
      expect(route(`https://${host}/`), host).toEqual({ kind: 'not-found' });
    }
    expect(route('https://notexit1.dev/').kind).toBe('shell');
    expect(route('https://exit1.dev.evil.com/').kind).toBe('shell');
  });

  it('redirects plain HTTP to HTTPS, keeping path and query', () => {
    expect(route('http://status.acme.com/x?y=1')).toEqual({
      kind: 'redirect',
      location: 'https://status.acme.com/x?y=1',
    });
  });

  it('allows only GET and HEAD', () => {
    expect(route('https://status.acme.com/', 'HEAD').kind).toBe('shell');
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      expect(route('https://status.acme.com/', method)).toEqual({ kind: 'method-not-allowed' });
    }
  });
});

describe('isOwnHost', () => {
  it('handles a trailing dot', () => {
    expect(isOwnHost('app.exit1.dev.')).toBe(true);
    expect(isOwnHost('status.acme.com')).toBe(false);
  });
});
