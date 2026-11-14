/**
 * Heartbeat pings that land on the wrong box.
 *
 * Customers are given one ping URL, https://vps.exit1.dev/heartbeat/<token>,
 * which reaches vps-eu-1. Each runner only knows the tokens of the checks in
 * its own region, so a heartbeat check placed in the other region would get a
 * 404 there. Rather than hand out a URL per region (it would break the moment
 * a check moves region, and the URL is pasted into cron jobs we can not
 * update), a runner that does not know a token asks its peer once.
 *
 * Guards, since this path is open to the internet:
 *  - only well-formed tokens are forwarded (64 hex chars, as created);
 *  - a forwarded request is never forwarded again (FORWARDED_HEADER);
 *  - a token the peer did not know either is remembered for a minute;
 *  - at most MAX_IN_FLIGHT forwards run at once, the rest are shed.
 */

export const FORWARDED_HEADER = 'x-exit1-heartbeat-forwarded';
export const FORWARD_TIMEOUT_MS = 5_000;
export const MISS_TTL_MS = 60_000;
export const MISS_CACHE_MAX = 5_000;
export const MAX_IN_FLIGHT = 20;

const TOKEN_RE = /^[a-f0-9]{64}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export interface ForwardResult {
  status: number;
  body: string;
}

export interface ForwarderOptions {
  /** Base URL of the other runner, like https://live-us.exit1.dev. */
  peerUrl: string | undefined;
  /** This runner's region, sent along so the peer's log says who asked. */
  region: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ForwardStats {
  forwarded: number;
  peerHits: number;
  peerMisses: number;
  cachedMisses: number;
  shed: number;
  errors: number;
  inFlight: number;
}

const json = (status: number, error: string): ForwardResult => ({
  status,
  body: JSON.stringify({ error }),
});

export function createHeartbeatForwarder(opts: ForwarderOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  // token -> time until which we answer 404 without asking the peer.
  const misses = new Map<string, number>();
  let inFlight = 0;
  const stats: Omit<ForwardStats, 'inFlight'> = {
    forwarded: 0,
    peerHits: 0,
    peerMisses: 0,
    cachedMisses: 0,
    shed: 0,
    errors: 0,
  };

  function rememberMiss(token: string) {
    if (misses.size >= MISS_CACHE_MAX) {
      const t = now();
      for (const [k, until] of misses) if (until <= t) misses.delete(k);
      // Still full of live entries: drop the oldest (Map keeps insert order).
      if (misses.size >= MISS_CACHE_MAX) {
        const oldest = misses.keys().next().value;
        if (oldest !== undefined) misses.delete(oldest);
      }
    }
    misses.set(token, now() + MISS_TTL_MS);
  }

  /**
   * Should a token this runner does not know be passed to the peer?
   * `forwardedHeader` is the incoming request's FORWARDED_HEADER value.
   */
  function shouldForward(token: string, forwardedHeader: unknown): boolean {
    if (!opts.peerUrl) return false;
    if (forwardedHeader) return false;
    return isWellFormedToken(token);
  }

  async function forward(
    token: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    contentType: string | undefined,
  ): Promise<ForwardResult> {
    if (!opts.peerUrl || !isWellFormedToken(token)) return json(404, 'not_found');

    const until = misses.get(token);
    if (until !== undefined) {
      if (until > now()) {
        stats.cachedMisses++;
        return json(404, 'not_found');
      }
      misses.delete(token);
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      stats.shed++;
      return json(503, 'busy');
    }

    inFlight++;
    stats.forwarded++;
    try {
      const resp = await fetchImpl(`${opts.peerUrl}/heartbeat/${token}`, {
        method,
        headers: {
          [FORWARDED_HEADER]: opts.region,
          ...(method === 'POST' && body ? { 'Content-Type': contentType || 'application/json' } : {}),
        },
        ...(method === 'POST' && body ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      // Drain so the socket goes back to the pool.
      await resp.arrayBuffer().catch(() => undefined);

      if (resp.status === 200) {
        stats.peerHits++;
        return { status: 200, body: JSON.stringify({ ok: true }) };
      }
      if (resp.status === 404) {
        stats.peerMisses++;
        rememberMiss(token);
        return json(404, 'not_found');
      }
      // Anything else means the peer could not take the ping. Say so, so the
      // sender's job sees a failure instead of a ping that silently went nowhere.
      stats.errors++;
      return json(502, 'peer_unavailable');
    } catch {
      stats.errors++;
      return json(502, 'peer_unavailable');
    } finally {
      inFlight--;
    }
  }

  return {
    shouldForward,
    forward,
    stats: (): ForwardStats => ({ ...stats, inFlight }),
  };
}
