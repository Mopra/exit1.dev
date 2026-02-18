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
 */
import { Resolver } from "dns/promises";
import net from "net";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DNS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes (matches check interval)
const DNS_NEGATIVE_TTL_MS = 30 * 1000;   // 30 seconds for NXDOMAIN / failures
const DNS_RESOLVE_TIMEOUT_MS = 5_000;     // Per-query timeout

// ---------------------------------------------------------------------------
// Resolver setup
// ---------------------------------------------------------------------------

const DEFAULT_DNS_SERVERS = ["1.1.1.1", "8.8.8.8", "1.0.0.1"];
const parsedServers = process.env.DNS_SERVERS
  ? process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const dnsServers: string[] = parsedServers.length > 0 ? parsedServers : DEFAULT_DNS_SERVERS;

// Promise-based resolver (c-ares, non-blocking)
const resolver = new Resolver();
resolver.setServers(dnsServers);

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
    // Use c-ares resolve4/resolve6 (non-blocking, NOT UV threadpool)
    const [v4, v6] = await Promise.allSettled([
      resolveWithTimeout(resolver.resolve4(hostname)),
      resolveWithTimeout(resolver.resolve6(hostname)),
    ]);

    const results: Array<{ address: string; family: number }> = [];
    if (v4.status === "fulfilled") {
      for (const addr of v4.value) results.push({ address: addr, family: 4 });
    }
    if (v6.status === "fulfilled") {
      for (const addr of v6.value) results.push({ address: addr, family: 6 });
    }

    if (results.length === 0) {
      // Propagate the actual error from the v4 attempt (more common)
      const baseErr =
        v4.status === "rejected" ? v4.reason :
        v6.status === "rejected" ? v6.reason :
        new Error(`DNS resolution failed for ${hostname}`);
      const err: NodeJS.ErrnoException = baseErr instanceof Error ? baseErr : new Error(String(baseErr));
      if (!err.code) err.code = "ENOTFOUND";
      negativeCache.set(hostname, { error: err, expiresAt: Date.now() + DNS_NEGATIVE_TTL_MS });
      throw err;
    }

    cache.set(hostname, { addresses: results, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    return results;
  })();

  inflight.set(hostname, p);
  try {
    return await p;
  } finally {
    inflight.delete(hostname);
  }
}

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
