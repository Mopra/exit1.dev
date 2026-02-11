/**
 * WHOIS Client for Domain Intelligence
 *
 * Provides WHOIS fallback when RDAP is rate-limited (e.g., Nominet .uk 429s).
 * Uses raw TCP port 43 via Node.js `net` module (zero dependencies).
 * Returns the same RdapDomainInfo interface for seamless integration.
 */

import net from 'net';
import type { RdapDomainInfo } from './rdap-client';

// WHOIS port per RFC 3912
const WHOIS_PORT = 43;

// Timeout for WHOIS TCP connections (8s leaves headroom within 10s total budget)
const WHOIS_TIMEOUT_MS = 8000;

// Hardcoded WHOIS servers for common TLDs (avoids IANA referral roundtrip)
const WHOIS_SERVERS: Record<string, string> = {
  // gTLDs
  com: 'whois.verisign-grs.com',
  net: 'whois.verisign-grs.com',
  org: 'whois.pir.org',
  info: 'whois.afilias.net',
  biz: 'whois.biz',
  io: 'whois.nic.io',
  dev: 'whois.nic.google',
  app: 'whois.nic.google',
  xyz: 'whois.nic.xyz',
  me: 'whois.nic.me',
  co: 'whois.nic.co',
  ai: 'whois.nic.ai',
  tech: 'whois.nic.tech',
  online: 'whois.nic.online',
  site: 'whois.nic.site',
  // ccTLDs
  uk: 'whois.nic.uk',
  de: 'whois.denic.de',
  fr: 'whois.nic.fr',
  nl: 'whois.sidn.nl',
  eu: 'whois.eu',
  au: 'whois.auda.org.au',
  ca: 'whois.cira.ca',
  jp: 'whois.jprs.jp',
  in: 'whois.registry.in',
  br: 'whois.registro.br',
  it: 'whois.nic.it',
  se: 'whois.iis.se',
  ch: 'whois.nic.ch',
  nz: 'whois.srs.net.nz',
  ru: 'whois.tcinet.ru',
  pl: 'whois.dns.pl',
  be: 'whois.dns.be',
  za: 'whois.registry.net.za',
  dk: 'whois.dk-hostmaster.dk',
  no: 'whois.norid.no',
  fi: 'whois.fi',
  at: 'whois.nic.at',
  pt: 'whois.dns.pt',
  ie: 'whois.iedr.ie',
  cz: 'whois.nic.cz',
  kr: 'whois.kr',
  us: 'whois.nic.us',
  mx: 'whois.mx',
  cl: 'whois.nic.cl',
  sg: 'whois.sgnic.sg',
  hk: 'whois.hkirc.hk',
  tw: 'whois.twnic.net.tw',
};

// In-memory cache for IANA-resolved WHOIS servers (persists across warm invocations)
const whoisServerCache = new Map<string, string>();

// ── Per-server throttle + result cache ──────────────────────────────

// Minimum delay between queries to the same WHOIS server (ms).
// Nominet allows ~20 queries/min; 2s spacing keeps us well under that.
const WHOIS_PER_SERVER_DELAY_MS = 2000;

// Cache TTL for parsed WHOIS results (5 min). Covers bulk operations within
// a single scheduled function execution without re-querying the same domain.
const WHOIS_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;

// Tracks the last query timestamp per WHOIS server for throttling
const lastQueryTime = new Map<string, number>();

// Caches parsed results per domain to avoid duplicate queries
const resultCache = new Map<string, { data: RdapDomainInfo; expiresAt: number }>();

/**
 * Wait until at least WHOIS_PER_SERVER_DELAY_MS has elapsed since the last
 * query to the given server. Returns immediately if enough time has passed.
 */
async function throttleForServer(server: string): Promise<void> {
  const last = lastQueryTime.get(server);
  if (last) {
    const elapsed = Date.now() - last;
    if (elapsed < WHOIS_PER_SERVER_DELAY_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, WHOIS_PER_SERVER_DELAY_MS - elapsed)
      );
    }
  }
  lastQueryTime.set(server, Date.now());
}

/**
 * Raw TCP WHOIS query to a WHOIS server
 */
function rawWhoisQuery(server: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(WHOIS_PORT, server);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WHOIS query to ${server} timed out after ${WHOIS_TIMEOUT_MS}ms`));
    }, WHOIS_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(`${query}\r\n`);
    });

    socket.on('data', (chunk) => {
      chunks.push(chunk);
    });

    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WHOIS query to ${server} failed: ${err.message}`));
    });
  });
}

/**
 * Get the WHOIS server for a TLD.
 * Checks hardcoded map first, then queries IANA referral as fallback.
 */
async function getWhoisServer(tld: string): Promise<string> {
  const lower = tld.toLowerCase();

  // 1. Hardcoded map (fast path)
  if (WHOIS_SERVERS[lower]) return WHOIS_SERVERS[lower];

  // 2. In-memory cache from previous IANA lookups
  if (whoisServerCache.has(lower)) return whoisServerCache.get(lower)!;

  // 3. IANA referral query
  const ianaResponse = await rawWhoisQuery('whois.iana.org', lower);
  const match = ianaResponse.match(/whois:\s+(\S+)/i);
  if (!match) {
    throw new Error(`No WHOIS server found for TLD: .${tld}`);
  }

  const server = match[1];
  whoisServerCache.set(lower, server);
  return server;
}

// ── Response Parsing ──────────────────────────────────────────────────

/**
 * Regex patterns for extracting fields from WHOIS responses.
 * Ordered by commonality — first match wins for single-value fields.
 */
const FIELD_PATTERNS = {
  expiryDate: [
    /Registry Expiry Date:\s*(.+)/i,
    /Expiry date:\s*\n?\s*(.+)/i,
    /Expiration Date:\s*(.+)/i,
    /Expiry Date:\s*(.+)/i,
    /Expire Date:\s*(.+)/i,
    /expires:\s*(.+)/i,
    /paid-till:\s*(.+)/i,
    /Renewal date:\s*\n?\s*(.+)/i,
  ],
  createdDate: [
    /Creation Date:\s*(.+)/i,
    /Registered on:\s*\n?\s*(.+)/i,
    /Registration Date:\s*(.+)/i,
    /created:\s*(.+)/i,
    /Registered:\s*(.+)/i,
  ],
  updatedDate: [
    /Updated Date:\s*(.+)/i,
    /Last updated:\s*\n?\s*(.+)/i,
    /Last Update:\s*(.+)/i,
    /last-modified:\s*(.+)/i,
    /Modified:\s*(.+)/i,
  ],
  registrar: [
    /Registrar:\s*\n?\s*(.+)/i,
    /Registrar Name:\s*(.+)/i,
    /Sponsoring Registrar:\s*(.+)/i,
  ],
  registrarUrl: [
    /Registrar URL:\s*(.+)/i,
    /^\s*URL:\s*(https?:\/\/\S+)/im,  // Nominet: "URL: https://..." under Registrar block
  ],
  nameserver: [
    /Name Server:\s*(\S+)/gi,
    /Name servers:\s*\n?\s*(\S+)/gi,
    /Nameserver:\s*(\S+)/gi,
    /nserver:\s*(\S+)/gi,
  ],
  status: [
    /Domain Status:\s*(\S+)/gi,
    /Registration status:\s*\n?\s*(.+)/gi,
    /Status:\s*(.+)/gi,
  ],
};

// Month name map for manual date parsing
const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parse a date string from a WHOIS response into a Unix timestamp.
 * Handles multiple formats:
 *   - ISO 8601: 2025-12-31T23:59:59Z
 *   - Nominet:  31-December-2025 or 00:00:00 31-Dec-2025
 *   - Compact:  2025-12-31
 *   - Slash:    31/12/2025
 *   - Dot:      2025.12.31
 */
function parseWhoisDate(dateStr: string): number | undefined {
  const trimmed = dateStr.trim();
  if (!trimmed) return undefined;

  // 1. Try native Date parsing (ISO 8601, standard formats)
  const native = new Date(trimmed);
  if (!isNaN(native.getTime()) && native.getFullYear() > 1990) {
    return native.getTime();
  }

  // 2. Nominet format: "HH:MM:SS DD-Mon-YYYY" or "DD-Month-YYYY"
  //    e.g., "00:00:00 31-Dec-2025" or "31-December-2025"
  const nominetMatch = trimmed.match(
    /(?:\d{1,2}:\d{2}:\d{2}\s+)?(\d{1,2})-(\w+)-(\d{4})/
  );
  if (nominetMatch) {
    const day = parseInt(nominetMatch[1]);
    const monthName = nominetMatch[2].toLowerCase();
    const year = parseInt(nominetMatch[3]);
    const month = MONTHS[monthName];
    if (month !== undefined) {
      return new Date(year, month, day).getTime();
    }
  }

  // 3. DD/MM/YYYY
  const slashDmy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashDmy) {
    return new Date(
      parseInt(slashDmy[3]),
      parseInt(slashDmy[2]) - 1,
      parseInt(slashDmy[1])
    ).getTime();
  }

  // 4. YYYY.MM.DD
  const dotYmd = trimmed.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (dotYmd) {
    return new Date(
      parseInt(dotYmd[1]),
      parseInt(dotYmd[2]) - 1,
      parseInt(dotYmd[3])
    ).getTime();
  }

  return undefined;
}

/**
 * Extract the first matching value for a set of regex patterns (single-value field).
 */
function extractFirst(raw: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return match[1].trim();
  }
  return undefined;
}

/**
 * Extract all matches for a set of regex patterns (multi-value field like nameservers).
 */
function extractAll(raw: string, patterns: RegExp[]): string[] {
  for (const pattern of patterns) {
    const results: string[] = [];
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(raw)) !== null) {
      results.push(match[1].trim());
    }
    if (results.length > 0) return results;
  }
  return [];
}

/**
 * TLD-specific post-processors to fix registry-specific quirks.
 * Runs after generic parsing, can override fields using the raw response.
 */
const TLD_POST_PROCESSORS: Record<string, (result: RdapDomainInfo, raw: string) => void> = {
  it: (result, raw) => {
    // NIC.it uses a block format for registrar:
    //   Registrar
    //     Organization:     Example Registrar s.r.l.
    //     Name:             EXAMPLE-REG
    //     Web:              https://www.example.it
    if (!result.registrar) {
      const registrarBlock = raw.match(/^Registrar\n((?:\s+\S.*\n?)+)/im);
      if (registrarBlock) {
        const orgMatch = registrarBlock[1].match(/Organization:\s*(.+)/i);
        if (orgMatch) {
          result.registrar = orgMatch[1].trim();
        }
        if (!result.registrarUrl) {
          const webMatch = registrarBlock[1].match(/Web:\s*(https?:\/\/\S+)/i);
          if (webMatch) {
            result.registrarUrl = webMatch[1].trim();
          }
        }
      }
    }

    // NIC.it lists nameservers as indented lines under "Nameservers":
    //   Nameservers
    //     dns1.example.com
    //     dns2.example.com
    if (!result.nameservers?.length) {
      const nsBlockMatch = raw.match(/^Nameservers\n((?:\s+\S.*\n?)+)/im);
      if (nsBlockMatch) {
        const nameservers: string[] = [];
        for (const line of nsBlockMatch[1].split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const hostname = trimmed.split(/\s+/)[0];
          if (hostname && hostname.includes('.')) {
            nameservers.push(hostname.toLowerCase());
          }
        }
        if (nameservers.length > 0) {
          result.nameservers = nameservers;
        }
      }
    }
  },

  uk: (result, raw) => {
    // Strip Nominet "[Tag = ...]" from registrar names
    // e.g., "Markmonitor Inc. [Tag = MARKMONITOR]" → "Markmonitor Inc."
    if (result.registrar) {
      result.registrar = result.registrar
        .replace(/\s*\[Tag\s*=\s*[^\]]+\]\s*$/, '')
        .trim();
    }

    // Nominet lists nameservers as an indented block under "Name servers:"
    // Each line has: hostname [optional IPs]. Generic pattern only captures the first.
    const nsBlockMatch = raw.match(/Name servers:\n((?:\s+\S.*\n?)+)/i);
    if (nsBlockMatch) {
      const nameservers: string[] = [];
      for (const line of nsBlockMatch[1].split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // First token is the hostname; rest are IPs
        const hostname = trimmed.split(/\s+/)[0];
        if (hostname && hostname.includes('.')) {
          nameservers.push(hostname.toLowerCase());
        }
      }
      if (nameservers.length > 0) {
        result.nameservers = nameservers;
      }
    }
  },
};

/**
 * Parse a raw WHOIS response into the RdapDomainInfo interface.
 */
function parseWhoisResponse(rawInput: string, tld: string): RdapDomainInfo {
  // Normalize line endings — WHOIS uses \r\n but our regexes expect \n
  const raw = rawInput.replace(/\r\n/g, '\n');
  const result: RdapDomainInfo = {};

  // Single-value fields
  const expiryStr = extractFirst(raw, FIELD_PATTERNS.expiryDate);
  if (expiryStr) result.expiryDate = parseWhoisDate(expiryStr);

  const createdStr = extractFirst(raw, FIELD_PATTERNS.createdDate);
  if (createdStr) result.createdDate = parseWhoisDate(createdStr);

  const updatedStr = extractFirst(raw, FIELD_PATTERNS.updatedDate);
  if (updatedStr) result.updatedDate = parseWhoisDate(updatedStr);

  result.registrar = extractFirst(raw, FIELD_PATTERNS.registrar);
  result.registrarUrl = extractFirst(raw, FIELD_PATTERNS.registrarUrl);

  // Multi-value fields
  const nameservers = extractAll(raw, FIELD_PATTERNS.nameserver);
  if (nameservers.length > 0) {
    result.nameservers = nameservers.map((ns) => ns.toLowerCase());
  }

  const statuses = extractAll(raw, FIELD_PATTERNS.status);
  if (statuses.length > 0) {
    result.registryStatus = statuses;
  }

  // TLD-specific cleanup
  const postProcessor = TLD_POST_PROCESSORS[tld.toLowerCase()];
  if (postProcessor) postProcessor(result, raw);

  // Calculate daysUntilExpiry (same logic as RDAP parser)
  if (result.expiryDate) {
    result.daysUntilExpiry = Math.floor(
      (result.expiryDate - Date.now()) / (24 * 60 * 60 * 1000)
    );
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Query WHOIS for domain registration data.
 * Returns the same RdapDomainInfo interface as the RDAP client.
 */
export async function queryWhois(domain: string): Promise<RdapDomainInfo> {
  // Check result cache first (avoids re-querying during bulk operations)
  const cached = resultCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const tld = domain.split('.').pop()!.toLowerCase();
  const server = await getWhoisServer(tld);

  // Throttle: wait if we queried this server too recently
  await throttleForServer(server);

  const raw = await rawWhoisQuery(server, domain);

  // Check for rate-limit / block responses (Nominet returns error with seconds until replenishment)
  if (/quota exceeded|rate limit|query limit|blocked/i.test(raw.slice(0, 500))) {
    throw new Error(`WHOIS rate limited by ${server}`);
  }

  // Check for "not found" responses
  if (
    raw.length < 50 ||
    /no match|not found|no data|no entries found|this domain cannot be registered/i.test(raw.slice(0, 300))
  ) {
    throw new Error(`Domain not found in WHOIS: ${domain}`);
  }

  const result = parseWhoisResponse(raw, tld);

  // If we got nothing useful, report it
  if (!result.expiryDate && !result.registrar && !result.nameservers?.length) {
    throw new Error(`WHOIS response for ${domain} could not be parsed`);
  }

  // Cache the result for subsequent lookups within this execution
  resultCache.set(domain, {
    data: result,
    expiresAt: Date.now() + WHOIS_RESULT_CACHE_TTL_MS,
  });

  return result;
}
