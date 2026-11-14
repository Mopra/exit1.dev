/**
 * A heartbeat ping for a check in the other region is passed to the peer once,
 * and the open endpoint can not be used to hammer the peer.
 *
 * Run: npm test (in vps/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORWARDED_HEADER,
  MAX_IN_FLIGHT,
  MISS_CACHE_MAX,
  MISS_TTL_MS,
  createHeartbeatForwarder,
  isWellFormedToken,
} from '../heartbeat-forward.js';

const TOKEN = 'a'.repeat(64);
const PEER = 'https://live-us.exit1.dev';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, impl };
}

test('token shape: only 64 lowercase hex chars', () => {
  assert.equal(isWellFormedToken(TOKEN), true);
  assert.equal(isWellFormedToken('A'.repeat(64)), false);
  assert.equal(isWellFormedToken('a'.repeat(63)), false);
  assert.equal(isWellFormedToken(`${'a'.repeat(60)}/../x`), false);
  assert.equal(isWellFormedToken(`${TOKEN}?x=1`), false);
});

test('shouldForward: not without a peer, not twice, not for junk', () => {
  const f = createHeartbeatForwarder({ peerUrl: PEER, region: 'vps-eu-1' });
  assert.equal(f.shouldForward(TOKEN, undefined), true);
  assert.equal(f.shouldForward(TOKEN, 'vps-us-1'), false);
  assert.equal(f.shouldForward('nope', undefined), false);
  const none = createHeartbeatForwarder({ peerUrl: undefined, region: 'vps-eu-1' });
  assert.equal(none.shouldForward(TOKEN, undefined), false);
});

test('peer knows the token: 200, marked as forwarded, POST body passed on', async () => {
  const { calls, impl } = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
  const f = createHeartbeatForwarder({ peerUrl: PEER, region: 'vps-eu-1', fetchImpl: impl });

  const res = await f.forward(TOKEN, 'POST', '{"status":"ok"}', 'application/json');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${PEER}/heartbeat/${TOKEN}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"status":"ok"}');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers[FORWARDED_HEADER], 'vps-eu-1');

  const get = await f.forward(TOKEN, 'GET', undefined, undefined);
  assert.equal(get.status, 200);
  assert.equal(calls[1].init.body, undefined);
  assert.equal(f.stats().peerHits, 2);
});

test('peer does not know it either: 404, and no second ask for a minute', async () => {
  let t = 1_000_000;
  const { calls, impl } = fakeFetch(() => new Response('{}', { status: 404 }));
  const f = createHeartbeatForwarder({ peerUrl: PEER, region: 'vps-eu-1', fetchImpl: impl, now: () => t });

  assert.equal((await f.forward(TOKEN, 'GET', undefined, undefined)).status, 404);
  assert.equal((await f.forward(TOKEN, 'GET', undefined, undefined)).status, 404);
  assert.equal(calls.length, 1);
  assert.equal(f.stats().cachedMisses, 1);

  t += MISS_TTL_MS + 1;
  await f.forward(TOKEN, 'GET', undefined, undefined);
  assert.equal(calls.length, 2);
});

test('peer down or erroring: 502, and not remembered as a miss', async () => {
  let mode: 'throw' | '500' = 'throw';
  const { calls, impl } = fakeFetch(() => {
    if (mode === 'throw') throw new Error('ECONNREFUSED');
    return new Response('boom', { status: 500 });
  });
  const f = createHeartbeatForwarder({ peerUrl: PEER, region: 'vps-us-1', fetchImpl: impl });

  assert.equal((await f.forward(TOKEN, 'GET', undefined, undefined)).status, 502);
  mode = '500';
  assert.equal((await f.forward(TOKEN, 'GET', undefined, undefined)).status, 502);
  assert.equal(calls.length, 2);
  assert.equal(f.stats().errors, 2);
});

test('junk tokens never reach the peer', async () => {
  const { calls, impl } = fakeFetch(() => new Response('{}', { status: 200 }));
  const f = createHeartbeatForwarder({ peerUrl: PEER, region: 'vps-eu-1', fetchImpl: impl });
  assert.equal((await f.forward('../api/manual-check', 'GET', undefined, undefined)).status, 404);
  assert.equal(calls.length, 0);
});

test('sheds past the in-flight cap', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { calls, impl } = fakeFetch(async () => {
    await gate;
    return new Response('{}', { status: 200 });
  });
  const f = createHeartbeatForwarder({ peerUrl: PEER, region: 'vps-eu-1', fetchImpl: impl });

  const tok = (i: number) => i.toString(16).padStart(64, '0');
  const pending = Array.from({ length: MAX_IN_FLIGHT }, (_, i) => f.forward(tok(i), 'GET', undefined, undefined));
  const shed = await f.forward(tok(999), 'GET', undefined, undefined);
  assert.equal(shed.status, 503);
  assert.equal(calls.length, MAX_IN_FLIGHT);

  release();
  const done = await Promise.all(pending);
  assert.ok(done.every((r) => r.status === 200));
  assert.equal(f.stats().inFlight, 0);
});

test('miss cache stays bounded', async () => {
  const { impl } = fakeFetch(() => new Response('{}', { status: 404 }));
  const f = createHeartbeatForwarder({ peerUrl: PEER, region: 'vps-eu-1', fetchImpl: impl, now: () => 5 });
  const tok = (i: number) => i.toString(16).padStart(64, '0');
  for (let i = 0; i < MISS_CACHE_MAX + 50; i++) await f.forward(tok(i), 'GET', undefined, undefined);
  // The first ones were evicted, so asking again goes to the peer, not the cache.
  const before = f.stats().cachedMisses;
  await f.forward(tok(0), 'GET', undefined, undefined);
  assert.equal(f.stats().cachedMisses, before);
});
