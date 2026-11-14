import os from "os";

/**
 * Hosts that silently drop TCP connections from our probe VPSes.
 *
 * Webflow's shared IPv4 (198.202.211.1) has dropped every packet from both
 * VPS IPs since 2026-11-11, while its IPv6 anycast address still answers for
 * the same sites. A blocked probe times out at CONNECT, which looks exactly
 * like a dead server, so every Webflow apex domain went falsely DOWN.
 *
 * Two defences, both keyed on the IP the hostname actually resolves to:
 *  1. Reroute: swap the blocked address for the host's working one at lookup
 *     time. Hostname, Host header and SNI are untouched, so the probe is real.
 *  2. Classify: if a connect still fails on a listed route, the result is
 *     "probe blocked", which the scheduler treats as no observation at all
 *     (no status flip, no alert) instead of DOWN.
 *
 * Add an entry only after confirming from both VPSes that the address drops us
 * while the site is reachable from elsewhere.
 */
export interface ProbeBlocker {
  name: string;
  /** An address of the same service that still accepts our probes. */
  fallback?: { address: string; family: 4 | 6 };
}

export const KNOWN_PROBE_BLOCKERS: Readonly<Record<string, ProbeBlocker>> = {
  "198.202.211.1": {
    name: "Webflow",
    fallback: { address: "2620:cb:2000::1", family: 6 },
  },
};

export const PROBE_BLOCKED_ERROR_PREFIX = "Probe blocked";

/** The blocker entry for an IP, matching either the blocked or the fallback address. */
export function probeBlockerFor(ip: string | undefined | null): ProbeBlocker | undefined {
  if (!ip) return undefined;
  const direct = KNOWN_PROBE_BLOCKERS[ip];
  if (direct) return direct;
  const lower = ip.toLowerCase();
  return Object.values(KNOWN_PROBE_BLOCKERS).find((b) => b.fallback?.address === lower);
}

const CONNECT_FAILURE_CODES = new Set(["ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

/**
 * True when the request never got a TCP connection. Anything later (a TLS
 * error, an HTTP status, a slow first byte, a refused connection) means the
 * host answered us, so it is a real observation and not a block.
 */
export function isConnectStageFailure(stage: string | undefined, code: string | undefined): boolean {
  if (stage === "CONNECT") return true;
  return !stage && Boolean(code) && CONNECT_FAILURE_CODES.has(code as string);
}

export function describeProbeBlock(blocker: ProbeBlocker, cause: string): string {
  return `${PROBE_BLOCKED_ERROR_PREFIX}: ${blocker.name} is dropping connections from our monitoring servers (${cause})`;
}

/** Whether this machine can reach the public IPv6 internet (the VPSes can, Cloud Run cannot). */
export function hasGlobalIpv6(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): boolean {
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      // 2000::/3 is global unicast. Skips loopback, link-local (fe80) and ULA (fc00::/7).
      if (info.family === "IPv6" && !info.internal && /^[23]/.test(info.address)) return true;
    }
  }
  return false;
}

let cachedGlobalIpv6: boolean | undefined;
function hostHasGlobalIpv6(): boolean {
  if (cachedGlobalIpv6 === undefined) cachedGlobalIpv6 = hasGlobalIpv6();
  return cachedGlobalIpv6;
}

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
export type LookupFn = (
  hostname: string,
  options: { family?: number; all?: boolean } | number,
  callback: LookupCallback,
) => void;

function rerouteFor(address: string, canUseFamily: (family: 4 | 6) => boolean): LookupAddress | undefined {
  const fallback = KNOWN_PROBE_BLOCKERS[address]?.fallback;
  return fallback && canUseFamily(fallback.family) ? fallback : undefined;
}

/**
 * Wrap a dns.lookup-compatible function so a blocked address is replaced by
 * its fallback. Other addresses pass through untouched, and a host that moves
 * away from the blocker stops being rerouted on its next DNS answer.
 */
export function withBlockerReroute(
  lookup: LookupFn,
  canUseFamily: (family: 4 | 6) => boolean = (family) => family === 4 || hostHasGlobalIpv6(),
): LookupFn {
  return (hostname, options, callback) => {
    lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);

      if (Array.isArray(address)) {
        const seen = new Set<string>();
        const out: LookupAddress[] = [];
        for (const entry of address) {
          const next = rerouteFor(entry.address, canUseFamily) ?? entry;
          if (seen.has(next.address)) continue;
          seen.add(next.address);
          out.push(next);
        }
        return callback(null, out);
      }

      const rerouted = rerouteFor(address, canUseFamily);
      if (rerouted) return callback(null, rerouted.address, rerouted.family);
      return callback(null, address, family);
    });
  };
}
