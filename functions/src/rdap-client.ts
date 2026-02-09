/**
 * RDAP Client for Domain Intelligence
 * 
 * Implements RDAP (Registration Data Access Protocol) queries for domain
 * registration data. Uses IANA bootstrap file to find authoritative RDAP
 * servers for each TLD.
 */

import { firestore } from './init';
import { queryWhois } from './whois-client';

// RDAP Bootstrap URL from IANA
const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

// Cache TTL: 24 hours in milliseconds
const BOOTSTRAP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// In-memory bootstrap cache for function execution
let bootstrapCache: RdapBootstrapCache | null = null;

// Types
interface RdapBootstrapCache {
  data: RdapBootstrapData;
  fetchedAt: number;
  expiresAt: number;
}

// Firestore-compatible version with serialized data
interface RdapBootstrapCacheFirestore {
  dataJson: string; // Serialized RdapBootstrapData
  fetchedAt: number;
  expiresAt: number;
}

interface RdapBootstrapData {
  version: string;
  publication: string;
  services: [string[], string[]][];
}

export interface RdapDomainInfo {
  expiryDate?: number;
  createdDate?: number;
  updatedDate?: number;
  registrar?: string;
  registrarUrl?: string;
  nameservers?: string[];
  registryStatus?: string[];
  daysUntilExpiry?: number;
}

interface RdapResponse {
  objectClassName: string;
  handle?: string;
  ldhName: string;
  status?: string[];
  events?: Array<{
    eventAction: string;
    eventDate: string;
  }>;
  entities?: Array<{
    roles?: string[];
    vcardArray?: [string, Array<[string, Record<string, unknown>, string, string | string[]]>];
    publicIds?: Array<{ type: string; identifier: string }>;
    links?: Array<{ rel: string; href: string }>;
  }>;
  nameservers?: Array<{ ldhName: string }>;
  links?: Array<{ rel: string; href: string }>;
}

/**
 * Get cached RDAP bootstrap data with multi-level caching:
 * 1. In-memory cache (fastest, per-function execution)
 * 2. Firestore cache (persistent across invocations)
 * 3. Fresh fetch from IANA (fallback)
 */
async function getCachedBootstrap(): Promise<RdapBootstrapData> {
  const now = Date.now();
  
  // 1. Check in-memory cache
  if (bootstrapCache && bootstrapCache.expiresAt > now) {
    return bootstrapCache.data;
  }
  
  // 2. Check Firestore cache
  try {
    const doc = await firestore.doc('system/rdapBootstrap').get();
    if (doc.exists) {
      const firestoreCached = doc.data() as RdapBootstrapCacheFirestore;
      if (firestoreCached.expiresAt > now) {
        // Deserialize and update in-memory cache
        const data = JSON.parse(firestoreCached.dataJson) as RdapBootstrapData;
        bootstrapCache = {
          data,
          fetchedAt: firestoreCached.fetchedAt,
          expiresAt: firestoreCached.expiresAt,
        };
        return data;
      }
    }
  } catch (error) {
    console.warn('Failed to read RDAP bootstrap from Firestore:', error);
  }
  
  // 3. Fetch fresh from IANA
  console.log('Fetching fresh RDAP bootstrap from IANA...');
  const response = await fetch(RDAP_BOOTSTRAP_URL, {
    headers: { 'Accept': 'application/json' },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch RDAP bootstrap: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json() as RdapBootstrapData;
  
  // Update caches
  bootstrapCache = {
    data,
    fetchedAt: now,
    expiresAt: now + BOOTSTRAP_CACHE_TTL_MS,
  };

  // Save to Firestore (fire and forget) - serialize data to avoid nested entity error
  const firestoreCache: RdapBootstrapCacheFirestore = {
    dataJson: JSON.stringify(data),
    fetchedAt: now,
    expiresAt: now + BOOTSTRAP_CACHE_TTL_MS,
  };
  firestore.doc('system/rdapBootstrap').set(firestoreCache).catch((err: unknown) => {
    console.warn('Failed to cache RDAP bootstrap to Firestore:', err);
  });

  return data;
}

/**
 * Find the RDAP server URL for a given TLD
 */
async function getRdapServerForTld(tld: string): Promise<string> {
  const bootstrap = await getCachedBootstrap();
  const lowerTld = tld.toLowerCase();
  
  for (const service of bootstrap.services) {
    const tlds = service[0];
    const servers = service[1];
    
    if (tlds.includes(lowerTld)) {
      // Return first server URL, ensure it ends with /
      let serverUrl = servers[0];
      if (!serverUrl.endsWith('/')) {
        serverUrl += '/';
      }
      return serverUrl;
    }
  }
  
  throw new Error(`No RDAP server found for TLD: .${tld}`);
}

/**
 * Parse RDAP response into normalized DomainInfo
 */
function parseRdapResponse(response: RdapResponse): RdapDomainInfo {
  const events = response.events || [];
  
  let expiryDate: number | undefined;
  let createdDate: number | undefined;
  let updatedDate: number | undefined;
  
  for (const event of events) {
    const date = new Date(event.eventDate).getTime();
    if (isNaN(date)) continue;
    
    switch (event.eventAction.toLowerCase()) {
      case 'expiration':
        expiryDate = date;
        break;
      case 'registration':
        createdDate = date;
        break;
      case 'last changed':
      case 'last update of rdap database':
        // Prefer 'last changed' over 'last update of rdap database'
        if (!updatedDate || event.eventAction.toLowerCase() === 'last changed') {
          updatedDate = date;
        }
        break;
    }
  }
  
  // Find registrar from entities
  let registrar: string | undefined;
  let registrarUrl: string | undefined;
  
  const entities = response.entities || [];
  for (const entity of entities) {
    if (entity.roles?.includes('registrar')) {
      // Extract registrar name from vCard
      if (entity.vcardArray && entity.vcardArray[1]) {
        for (const prop of entity.vcardArray[1]) {
          if (prop[0] === 'fn') {
            registrar = Array.isArray(prop[3]) ? prop[3].join(' ') : String(prop[3]);
            break;
          }
        }
      }
      
      // Extract registrar URL from links
      if (entity.links) {
        for (const link of entity.links) {
          if (link.rel === 'self' || link.rel === 'related') {
            registrarUrl = link.href;
            break;
          }
        }
      }
      
      break;
    }
  }
  
  // Extract nameservers
  const nameservers = response.nameservers?.map(ns => ns.ldhName.toLowerCase()) || [];
  
  // Calculate days until expiry
  let daysUntilExpiry: number | undefined;
  if (expiryDate) {
    const now = Date.now();
    daysUntilExpiry = Math.floor((expiryDate - now) / (24 * 60 * 60 * 1000));
  }
  
  return {
    expiryDate,
    createdDate,
    updatedDate,
    registrar,
    registrarUrl,
    nameservers,
    registryStatus: response.status,
    daysUntilExpiry,
  };
}

/**
 * Extract the registrable domain from a URL or domain string
 * Examples:
 *   https://www.example.com/path -> example.com
 *   subdomain.example.co.uk -> example.co.uk
 *   api.staging.exit1.dev -> exit1.dev
 */
export function extractDomain(input: string): string | null {
  try {
    // Handle URL or bare domain
    let hostname: string;
    if (input.includes('://')) {
      hostname = new URL(input).hostname;
    } else {
      hostname = input.split('/')[0];
    }
    
    hostname = hostname.toLowerCase();
    
    // Simple extraction: for most TLDs, take last two parts
    // For special TLDs like .co.uk, .com.au, take last three parts
    const parts = hostname.split('.');
    
    // Common two-level TLDs
    const twoLevelTlds = new Set([
      'co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.za', 
      'co.kr', 'co.in', 'com.mx', 'com.cn', 'net.au', 'org.uk',
      'ac.uk', 'gov.uk', 'org.au', 'edu.au', 'com.sg', 'com.hk',
    ]);
    
    if (parts.length >= 3) {
      const lastTwo = parts.slice(-2).join('.');
      if (twoLevelTlds.has(lastTwo)) {
        return parts.slice(-3).join('.');
      }
    }
    
    // Default: take last two parts
    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }
    
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Get the TLD from a domain
 */
function getTld(domain: string): string {
  const parts = domain.split('.');
  return parts[parts.length - 1].toLowerCase();
}

/**
 * Sleep helper for rate limiting
 */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Query RDAP for domain registration data with retry logic for rate limiting
 */
export async function queryRdap(domain: string, retries = 3): Promise<RdapDomainInfo> {
  const tld = getTld(domain);
  const rdapServer = await getRdapServerForTld(tld);

  const url = `${rdapServer}domain/${domain}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/rdap+json, application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Domain not found in RDAP: ${domain}`);
        }

        // Handle rate limiting with capped backoff
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const MAX_BACKOFF_MS = 5000; // Cap at 5 seconds to avoid function timeout
          const requestedMs = retryAfter
            ? parseInt(retryAfter) * 1000
            : Math.pow(2, attempt) * 1000; // Exponential: 1s, 2s, 4s

          // If the server asks us to wait longer than our cap, fall back to WHOIS
          if (requestedMs > MAX_BACKOFF_MS) {
            console.warn(
              `RDAP rate limited for ${domain} (Retry-After: ${retryAfter}s), falling back to WHOIS`
            );
            try {
              return await queryWhois(domain);
            } catch (whoisError) {
              throw new Error(
                `RDAP rate limited (Retry-After: ${retryAfter}s). WHOIS fallback failed: ${(whoisError as Error).message}`
              );
            }
          }

          console.warn(`Rate limited for ${domain}, retrying after ${requestedMs}ms (attempt ${attempt + 1}/${retries})`);

          if (attempt < retries - 1) {
            await sleep(requestedMs);
            continue; // Retry
          }

          throw new Error(`RDAP query failed: 429 Too Many Requests`);
        }

        throw new Error(`RDAP query failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as RdapResponse;
      return parseRdapResponse(data);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error as Error;

      if (lastError.name === 'AbortError') {
        throw new Error('RDAP query timed out');
      }

      // If it's a 429 error and we have retries left, continue to next attempt
      if (lastError.message.includes('429') && attempt < retries - 1) {
        continue;
      }

      // For other errors, throw immediately
      if (!lastError.message.includes('429')) {
        throw lastError;
      }
    }
  }

  // If we exhausted all retries, throw the last error
  throw lastError || new Error('RDAP query failed after all retries');
}

/**
 * List of TLDs known to not support RDAP
 * This can be expanded as we discover more
 */
const UNSUPPORTED_TLDS: Set<string> = new Set([
  // Add TLDs that don't have RDAP servers
]);

/**
 * Validate that a domain can be monitored via RDAP
 */
export function validateDomainForRdap(domain: string): { valid: boolean; error?: string } {
  if (!domain || domain.length === 0) {
    return { valid: false, error: 'Domain is required' };
  }
  
  const parts = domain.split('.');
  if (parts.length < 2) {
    return { valid: false, error: 'Invalid domain format' };
  }
  
  const tld = getTld(domain);
  if (UNSUPPORTED_TLDS.has(tld)) {
    return { 
      valid: false, 
      error: `The .${tld} TLD does not support RDAP. Manual monitoring recommended.` 
    };
  }
  
  return { valid: true };
}

/**
 * Calculate the next check time based on days until expiry
 */
export function calculateNextCheckTime(daysUntilExpiry: number | undefined, now: number): number {
  let intervalDays: number;
  
  if (daysUntilExpiry === undefined) {
    // Unknown expiry, check in 1 day
    intervalDays = 1;
  } else if (daysUntilExpiry > 90) {
    intervalDays = 30;
  } else if (daysUntilExpiry > 30) {
    intervalDays = 14;
  } else if (daysUntilExpiry > 7) {
    intervalDays = 3;
  } else if (daysUntilExpiry > 1) {
    intervalDays = 1;
  } else if (daysUntilExpiry > 0) {
    intervalDays = 0.5; // 12 hours
  } else {
    // Expired, check weekly for renewal
    intervalDays = 7;
  }
  
  return now + intervalDays * 24 * 60 * 60 * 1000;
}

/**
 * Calculate domain status based on days until expiry
 */
export function calculateDomainStatus(daysUntilExpiry: number | undefined): 'active' | 'expiring_soon' | 'expired' | 'unknown' {
  if (daysUntilExpiry === undefined) {
    return 'unknown';
  }
  
  if (daysUntilExpiry <= 0) {
    return 'expired';
  }
  
  if (daysUntilExpiry <= 30) {
    return 'expiring_soon';
  }
  
  return 'active';
}
