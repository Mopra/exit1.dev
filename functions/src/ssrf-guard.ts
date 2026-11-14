import dns from "dns";
import net from "net";
import os from "os";
import type { LookupFn } from "./probe-blockers";

/**
 * SSRF guard for probes.
 *
 * A check target is customer input, and the runner sits on a box with Redis,
 * Postgres, Traefik and other apps listening locally. Without this guard a
 * customer could aim a check (or a redirect, or a DNS record they control) at
 * 127.0.0.1, the Docker bridge or the cloud metadata address and read the
 * answer back through the check result.
 *
 * The guard runs on the addresses a DNS lookup returns, inside the lookup
 * function the socket itself uses. The socket connects to exactly what that
 * lookup handed back, with no second resolve, so a DNS rebinding answer cannot
 * swap in a private address after validation. Node skips the lookup for
 * IP-literal hosts, so those are checked up front with assertPublicHost.
 */

export const BLOCKED_ADDRESS_CODE = "EBLOCKEDADDR";

const IPV4_BLOCKS: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private network"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private network"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "documentation"],
  ["192.168.0.0", 16, "private network"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function ipv4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

const IPV4_BLOCK_TABLE = IPV4_BLOCKS.map(([base, bits, label]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ipv4ToInt(base) & mask) >>> 0, mask, label };
});

function reservedIpv4Reason(ip: string): string | undefined {
  const value = ipv4ToInt(ip);
  return IPV4_BLOCK_TABLE.find((b) => ((value & b.mask) >>> 0) === b.base)?.label;
}

/** Parse a valid IPv6 string (net.isIP === 6, no zone) into 16 bytes. */
function ipv6ToBytes(ip: string): number[] | undefined {
  let text = ip;
  // Dotted IPv4 tail (::ffff:1.2.3.4) becomes two hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (net.isIP(tail) !== 4) return undefined;
    const v4 = ipv4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    const n = parseInt(group, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return undefined;
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes.length === 16 ? bytes : undefined;
}

function reservedIpv6Reason(ip: string): string | undefined {
  const b = ipv6ToBytes(ip);
  if (!b) return "unrecognised";

  // Only global unicast (2000::/3) is ever a public target. Name the common
  // cases outside it so the error tells the customer what they hit.
  if ((b[0] & 0xe0) !== 0x20) {
    if (b.every((x) => x === 0)) return "unspecified";
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "loopback";
    if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return "IPv4-mapped";
    if ((b[0] & 0xfe) === 0xfc) return "unique local";
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local";
    if (b[0] === 0xff) return "multicast";
    return "reserved";
  }

  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x00 && b[3] === 0x00) return "Teredo tunnel";
    if (b[2] === 0x0d && b[3] === 0xb8) return "documentation";
  }
  // 6to4 carries an IPv4 address in bytes 2 to 5. Judge it by that address.
  if (b[0] === 0x20 && b[1] === 0x02) {
    const inner = reservedIpv4Reason(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`);
    if (inner) return `6to4 ${inner}`;
  }
  return undefined;
}

/** Lowercase, and drop URL brackets and any IPv6 zone id. */
export function normalizeIpLiteral(host: string): string {
  let text = host.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  return text;
}

/**
 * Why an address is not a public internet address, or undefined when it is.
 * Pure: looks at the address ranges only. A string that is not an IP at all
 * counts as blocked, since this is only ever asked about resolved addresses.
 */
export function reservedAddressReason(ip: string): string | undefined {
  const text = normalizeIpLiteral(ip);
  const family = net.isIP(text);
  if (family === 4) return reservedIpv4Reason(text);
  if (family === 6) return reservedIpv6Reason(text);
  return "unrecognised";
}

// The box's own addresses. Its public IPs sit on eth0 on both VPSes, and a
// probe aimed at them reaches the same local services as 127.0.0.1 would.
const OWN_ADDRESS_TTL_MS = 5 * 60 * 1000;
let ownAddresses: Set<string> | undefined;
let ownAddressesAt = 0;

function canonical(ip: string): string {
  const text = normalizeIpLiteral(ip);
  if (net.isIP(text) !== 6) return text;
  const bytes = ipv6ToBytes(text);
  return bytes ? bytes.map((x) => x.toString(16).padStart(2, "0")).join("") : text;
}

function getOwnAddresses(): Set<string> {
  const now = Date.now();
  if (ownAddresses && now - ownAddressesAt < OWN_ADDRESS_TTL_MS) return ownAddresses;
  const set = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const info of list ?? []) set.add(canonical(info.address));
    }
  } catch {
    // No interface list: the range checks still apply.
  }
  // Extra addresses to refuse, comma separated (for example the peer runner).
  for (const extra of (process.env.PROBE_BLOCKED_IPS ?? "").split(",")) {
    if (extra.trim()) set.add(canonical(extra));
  }
  ownAddresses = set;
  ownAddressesAt = now;
  return set;
}

// Tests run probes against servers on 127.0.0.1. Nothing outside tests calls this.
let testExemption: ((ip: string) => boolean) | undefined;
export function setSsrfGuardExemptionForTests(exempt: ((ip: string) => boolean) | undefined): void {
  testExemption = exempt;
}

/** Why a probe must not connect to this address, or undefined when it may. */
export function blockedAddressReason(ip: string): string | undefined {
  const text = normalizeIpLiteral(ip);
  if (testExemption?.(text)) return undefined;
  const reserved = reservedAddressReason(text);
  if (reserved) return reserved;
  if (getOwnAddresses().has(canonical(text))) return "monitoring server";
  return undefined;
}

export class BlockedAddressError extends Error {
  readonly code = BLOCKED_ADDRESS_CODE;
  constructor(host: string, ip: string, reason: string) {
    const target = normalizeIpLiteral(host) === normalizeIpLiteral(ip) ? ip : `${host} resolves to ${ip}`;
    super(
      `Blocked target: ${target}, which is not a public address (${reason}). ` +
        "exit1 can only check hosts that are reachable from the public internet.",
    );
    this.name = "BlockedAddressError";
  }
}

export function isBlockedAddressError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: unknown }).code === BLOCKED_ADDRESS_CODE;
}

/**
 * Throw if the host is an IP literal a probe must not reach. Hostnames pass:
 * they are judged by what they resolve to, inside the guarded lookup.
 */
export function assertPublicHost(host: string): void {
  const text = normalizeIpLiteral(host);
  if (!net.isIP(text)) return;
  const reason = blockedAddressReason(text);
  if (reason) throw new BlockedAddressError(text, text, reason);
}

/**
 * The address a socket ended up connected to, checked once more. A dual-stack
 * socket reports an IPv4 peer as ::ffff:a.b.c.d, so that form is unwrapped.
 */
export function blockedPeerError(host: string, remoteAddress: string | undefined): BlockedAddressError | undefined {
  if (!remoteAddress) return undefined;
  let text = normalizeIpLiteral(remoteAddress);
  if (text.startsWith("::ffff:") && net.isIP(text.slice(7)) === 4) text = text.slice(7);
  const reason = blockedAddressReason(text);
  return reason ? new BlockedAddressError(host, text, reason) : undefined;
}

/**
 * Wrap a dns.lookup-compatible function so it never hands a socket a private
 * or local address. With several answers the public ones are kept. With none
 * left the lookup fails with a BlockedAddressError.
 */
export function withSsrfGuard(lookup: LookupFn): LookupFn {
  return (hostname, options, callback) => {
    lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);

      if (Array.isArray(address)) {
        if (address.length === 0) return callback(null, address);
        const allowed = address.filter((entry) => !blockedAddressReason(entry.address));
        if (allowed.length > 0) return callback(null, allowed);
        const first = address[0].address;
        return callback(
          new BlockedAddressError(hostname, first, blockedAddressReason(first) ?? "private"),
          [],
        );
      }

      const reason = blockedAddressReason(address);
      if (reason) return callback(new BlockedAddressError(hostname, address, reason), "", family);
      return callback(null, address, family);
    });
  };
}

/** The system resolver (what net, tls and dgram use by default), guarded. */
export const guardedSystemLookup: LookupFn = withSsrfGuard(dns.lookup as unknown as LookupFn);

/** For socket options, which want the dns.lookup signature. */
export const guardedSystemLookupOption = guardedSystemLookup as unknown as typeof dns.lookup;

/**
 * Resolve a host to one address a probe may reach. For probes that cannot take
 * a lookup function (UDP, ping): resolve here, then hand them the IP so they
 * cannot resolve the name a second time.
 */
export function resolvePublicAddress(
  host: string,
  family: 0 | 4 | 6 = 0,
  lookup: LookupFn = guardedSystemLookup,
): Promise<{ address: string; family: 4 | 6 }> {
  const name = normalizeIpLiteral(host);
  return new Promise((resolve, reject) => {
    lookup(name, { family, all: true }, (err, address) => {
      if (err) return reject(err);
      const first = Array.isArray(address) ? address[0] : { address, family: net.isIP(address) };
      if (!first?.address) {
        const notFound = new Error(`getaddrinfo ENOTFOUND ${name}`) as NodeJS.ErrnoException;
        notFound.code = "ENOTFOUND";
        return reject(notFound);
      }
      resolve({ address: first.address, family: (first.family || net.isIP(first.address)) === 6 ? 6 : 4 });
    });
  });
}
