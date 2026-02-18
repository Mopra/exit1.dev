/**
 * High-performance DNS cache using c-ares (non-blocking) instead of
 * libc's getaddrinfo (UV threadpool-bound).
 *
 * Problem: Node's default dns.lookup() uses the UV threadpool (4 threads).
 * When hundreds of checks run concurrently, DNS lookups queue up and can
 * take 15s+ instead of <50ms, causing false timeout alerts.
 *
 * Solution: Use dns.Resolver (c-ares based, truly async) with an in-memory
 * cache and configurable upstream DNS servers.
 *
 * EREFUSED mitigation: Under high concurrent load, c-ares can receive
 * intermittent REFUSED responses. When this happens, we retry once with
 * a fresh resolver using a different server order. Transient errors are
 * cached with a much shorter TTL to prevent amplification.
 */
import { Resolver } from "dns/promises";
import net from "net";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DNS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes (matches check interval)
const DNS_NEGATIVE_TTL_MS = 30 * 1000;   // 30 seconds for NXDOMAIN / permanent failures
const DNS_TRANSIENT_NEGATIVE_TTL_MS = 5_000; // 5 seconds for transient errors (EREFUSED, ETIMEOUT)
const DNS_RESOLVE_TIMEOUT_MS = 5_000;     // Per-query timeout
const DNS_RETRY_DELAY_MS = 150;           // Delay before retry on transient failure

// Transient DNS error codes that warrant a retry (not final answers)
const TRANSIENT_DNS_CODES = new Set(["EREFUSED", "ESERVFAIL", "ECONNREFUSED"]);

// ---------------------------------------------------------------------------
// Resolver setup
// ---------------------------------------------------------------------------

const DEFAULT_DNS_SERVERS = ["1.1.1.1", "8.8.8.8", "1.0.0.1"];
const parsedServers = process.env.DNS_SERVERS
  ? process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const dnsServers: string[] = parsedServers.length > 0 ? parsedServers : DEFAULT_DNS_SERVERS;

// Primary resolver (c-ares, non-blocking)
const resolver = new Resolver();
resolver.setServers(dnsServers);

// Retry resolver with reversed server order — if the primary server returns
// EREFUSED, the retry hits a different server first.
const retryResolver = new Resolver();
retryResolver.setServers([...dnsServers].reverse());

// Track EREFUSED occurrences for observability (logged periodically)
let erefusedCount = 0;
let erefusedRetrySuccessCount = 0;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = {
  addresses: Array<{ address: string; family: number }>;
  expiresAt: number;
};

type NegativeCacheEntry = {
  error: NodeJS.ErrnoException;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const negativeCache = new Map<string, NegativeCacheEntry>();
const inflight = new Map<string, Promise<Array<{ address: string; family: number }>>>();

// Periodic eviction to prevent unbounded growth (runs every 5 min)
const EVICT_INTERVAL_MS = 5 * 60 * 1000;
let evictTimer: ReturnType<typeof setInterval> | undefined;

function startEviction() {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    for (const [key, entry] of negativeCache) {
      if (entry.expiresAt <= now) negativeCache.delete(key);
    }
  }, EVICT_INTERVAL_MS);
  // Allow the process to exit without waiting for this timer
  if (evictTimer && typeof evictTimer === "object" && "unref" in evictTimer) {
    evictTimer.unref();
  }
}
startEviction();

// ---------------------------------------------------------------------------
// Core resolution (c-ares, non-blocking, cached)
// ---------------------------------------------------------------------------

async function resolveWithTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(Object.assign(new Error("DNS resolve timeout"), { code: "ETIMEOUT" })),
      DNS_RESOLVE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

function isTransientError(err: unknown): boolean {
  if (err instanceof Error && "code" in err) {
    return TRANSIENT_DNS_CODES.has((err as NodeJS.ErrnoException).code || "");
  }
  return false;
}

/**
 * Attempt resolve4 + resolve6 using the given resolver.
 * Returns addresses on success, or throws the primary (v4) error.
 */
async function attemptResolve(
  hostname: string,
  res: Resolver,
): Promise<Array<{ address: string; family: number }>> {
  const [v4, v6] = await Promise.allSettled([
    resolveWithTimeout(res.resolve4(hostname)),
    resolveWithTimeout(res.resolve6(hostname)),
  ]);

  const results: Array<{ address: string; family: number }> = [];
  if (v4.status === "fulfilled") {
    for (const addr of v4.value) results.push({ address: addr, family: 4 });
  }
  if (v6.status === "fulfilled") {
    for (const addr of v6.value) results.push({ address: addr, family: 6 });
  }

  if (results.length > 0) return results;

  // Both failed — propagate the v4 error (more common path)
  const baseErr =
    v4.status === "rejected" ? v4.reason :
    v6.status === "rejected" ? v6.reason :
    new Error(`DNS resolution failed for ${hostname}`);
  const err: NodeJS.ErrnoException = baseErr instanceof Error ? baseErr : new Error(String(baseErr));
  if (!err.code) err.code = "ENOTFOUND";
  throw err;
}

async function resolveHostname(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const now = Date.now();

  // Positive cache hit
  const cached = cache.get(hostname);
  if (cached && cached.expiresAt > now) return cached.addresses;

  // Negative cache hit — clone the error so callers don't mutate the cached copy
  const neg = negativeCache.get(hostname);
  if (neg && neg.expiresAt > now) {
    const clone: NodeJS.ErrnoException = new Error(neg.error.message);
    clone.code = neg.error.code;
    throw clone;
  }

  // Coalesce concurrent requests for the same hostname
  const existing = inflight.get(hostname);
  if (existing) return existing;

  const p = (async () => {
    try {
      // Primary attempt with main resolver
      const results = await attemptResolve(hostname, resolver);
      cache.set(hostname, { addresses: results, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
      return results;
    } catch (primaryErr) {
      // For transient errors (EREFUSED, ESERVFAIL, ECONNREFUSED), retry once
      // with the retry resolver (different server order) after a short delay.
      if (!isTransientError(primaryErr)) {
        // Permanent error (ENOTFOUND, ENODATA, etc.) — cache and propagate
        const err = primaryErr as NodeJS.ErrnoException;
        negativeCache.set(hostname, { error: err, expiresAt: Date.now() + DNS_NEGATIVE_TTL_MS });
        throw err;
      }

      erefusedCount++;

      // Short delay to let any transient condition clear
      await new Promise((r) => setTimeout(r, DNS_RETRY_DELAY_MS));

      try {
        const results = await attemptResolve(hostname, retryResolver);
        // Retry succeeded — cache normally
        cache.set(hostname, { addresses: results, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
        erefusedRetrySuccessCount++;
        return results;
      } catch (retryErr) {
        // Both attempts failed — use short TTL for transient errors so we
        // don't poison the cache for 30s on what's likely a temporary issue.
        const err = retryErr as NodeJS.ErrnoException;
        const ttl = isTransientError(retryErr) ? DNS_TRANSIENT_NEGATIVE_TTL_MS : DNS_NEGATIVE_TTL_MS;
        negativeCache.set(hostname, { error: err, expiresAt: Date.now() + ttl });
        throw err;
      }
    }
  })();

  inflight.set(hostname, p);
  try {
    return await p;
  } finally {
    inflight.delete(hostname);
  }
}

// ---------------------------------------------------------------------------
// Observability — log EREFUSED stats periodically
// ---------------------------------------------------------------------------
const STATS_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
let statsTimer: ReturnType<typeof setInterval> | undefined;

function startStatsLogging() {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    if (erefusedCount > 0) {
      console.log(
        `[dns-cache] EREFUSED stats: ${erefusedCount} occurrences, ${erefusedRetrySuccessCount} recovered by retry (${Math.round((erefusedRetrySuccessCount / erefusedCount) * 100)}% recovery)`,
      );
      erefusedCount = 0;
      erefusedRetrySuccessCount = 0;
    }
  }, STATS_INTERVAL_MS);
  if (statsTimer && typeof statsTimer === "object" && "unref" in statsTimer) {
    statsTimer.unref();
  }
}
startStatsLogging();

// ---------------------------------------------------------------------------
// cachedLookup — drop-in replacement for dns.lookup in http.request()
// ---------------------------------------------------------------------------

/**
 * Custom lookup function compatible with Node's http.request `lookup` option.
 * Uses c-ares (non-blocking) + cache instead of libc getaddrinfo (UV threadpool).
 */
export function cachedLookup(
  hostname: string,
  options: { family?: number; all?: boolean } | number,
  callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
): void {
  const opts = typeof options === "number" ? { family: options } : options || {};

  // Already an IP — return immediately
  const ipVer = net.isIP(hostname);
  if (ipVer) {
    if (opts.all) {
      callback(null, [{ address: hostname, family: ipVer }]);
    } else {
      callback(null, hostname, ipVer);
    }
    return;
  }

  resolveHostname(hostname)
    .then((addresses) => {
      if (opts.all) {
        callback(null, addresses);
        return;
      }

      const family = opts.family || 0;
      let selected = addresses[0];
      if (family === 4) {
        selected = addresses.find((a) => a.family === 4) || selected;
      } else if (family === 6) {
        selected = addresses.find((a) => a.family === 6) || selected;
      } else {
        // Default: prefer IPv4 (matches dns.lookup verbatim: false behavior)
        selected = addresses.find((a) => a.family === 4) || addresses[0];
      }

      callback(null, selected.address, selected.family);
    })
    .catch((err) => {
      callback(err, "", 0);
    });
}

// ---------------------------------------------------------------------------
// resolveAllCached — for use in target-metadata.ts
// ---------------------------------------------------------------------------

/**
 * Resolve all addresses for a hostname using the cached c-ares resolver.
 * Returns the same shape as dns.lookup({ all: true, verbatim: true }).
 */
export async function resolveAllCached(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const ipVer = net.isIP(hostname);
  if (ipVer) return [{ address: hostname, family: ipVer }];
  return resolveHostname(hostname);
}
