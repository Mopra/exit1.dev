import * as logger from "firebase-functions/logger";
import * as tls from 'tls';
import { URL } from 'url';
import { parse as parseTld } from "tldts";
import * as punycode from "punycode";
import * as net from "net";
import * as dns from "node:dns/promises";
import * as https from 'https';
import { firestore } from "./init";
import { CONFIG } from "./config";

export async function checkSSLCertificate(url: string): Promise<{
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  error?: string;
}> {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const port = urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80);
    
    // Only check SSL for HTTPS URLs
    if (urlObj.protocol !== 'https:') {
      return {
        valid: true // HTTP URLs don't need SSL
      };
    }

    return new Promise((resolve) => {
      const socket = tls.connect({
        host: hostname,
        port: parseInt(port.toString()),
        servername: hostname, // SNI support
        rejectUnauthorized: false, // Don't reject on certificate errors, we'll check manually
        timeout: 10000 // 10 second timeout
      });

      socket.on('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        
        if (!cert || Object.keys(cert).length === 0) {
          socket.destroy();
          resolve({
            valid: false,
            error: 'No certificate received'
          });
          return;
        }

        const now = Date.now();
        const validFrom = new Date(cert.valid_from).getTime();
        const validTo = new Date(cert.valid_to).getTime();
        const daysUntilExpiry = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));
        
        const isValid = now >= validFrom && now <= validTo;
        
        socket.destroy();
        
        const sslData: {
          valid: boolean;
          issuer: string;
          subject: string;
          validFrom: number;
          validTo: number;
          daysUntilExpiry: number;
          error?: string;
        } = {
          valid: isValid,
          issuer: cert.issuer?.CN || cert.issuer?.O || 'Unknown',
          subject: cert.subject?.CN || cert.subject?.O || hostname,
          validFrom,
          validTo,
          daysUntilExpiry
        };
        
        // Only add error field if there's an actual error
        if (!isValid) {
          sslData.error = `Certificate expired ${Math.abs(daysUntilExpiry)} days ago`;
        }
        
        resolve(sslData);
      });

      socket.on('error', (error) => {
        socket.destroy();
        resolve({
          valid: false,
          error: `SSL connection failed: ${error.message}`
        });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({
          valid: false,
          error: 'SSL connection timeout'
        });
      });
    });
  } catch (error) {
    return {
      valid: false,
      error: `SSL check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

// Function to check domain expiry using DNS and basic validation
// Enhanced RDAP domain type
type RdapDomain = {
  events?: Array<{ 
    eventAction?: string; 
    eventDate?: string;
    eventActor?: string;
  }>;
  registrar?: { 
    name?: string;
    ianaId?: string;
    url?: string;
  };
  name?: string;
  status?: string[];
  entities?: Array<{
    vcardArray?: unknown[];
    roles?: string[];
    handle?: string;
  }>;
  nameservers?: Array<{
    ldhName?: string;
    ipAddresses?: {
      v4?: string[];
      v6?: string[];
    };
  }>;
  secureDNS?: {
    delegationSigned?: boolean;
    dsData?: Array<{
      algorithm?: number;
      digest?: string;
      digestType?: number;
      keyTag?: number;
    }>;
  };
  links?: Array<{
    href?: string;
    rel?: string;
    type?: string;
  }>;
  remarks?: Array<{
    title?: string;
    description?: string[];
  }>;
};

type RdapCacheData = {
  expiryDate?: number; 
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  status?: string[];
  nameservers?: string[];
  hasDNSSEC?: boolean;
  events?: Array<{ action: string; date: string; actor?: string }>;
  remarks?: string[];
  cachedAt: number;
  error?: string;
  rawData?: unknown; // Store raw RDAP response for debugging
  lastAttempt?: number; // Track last attempt to prevent spam
  attemptCount?: number; // Track failed attempts
};

// Enhanced RDAP cache with comprehensive data
const rdapCache = new Map<string, RdapCacheData>();
const rdapFirestoreReadCache = new Map<string, Promise<RdapCacheData | null>>();

// Rate limiting for RDAP requests
const RDAP_RATE_LIMIT = {
  MIN_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours minimum between attempts
  MAX_ATTEMPTS: 3, // Max failed attempts before backing off
  BACKOFF_MULTIPLIER: 2, // Exponential backoff multiplier
  MAX_BACKOFF: 7 * 24 * 60 * 60 * 1000, // Max 7 days backoff
};

// Firestore cache for persistent storage
async function getRdapFromFirestore(domain: string): Promise<RdapCacheData | null> {
  try {
    const doc = await firestore.collection('rdap_cache').doc(domain).get();
    if (doc.exists) {
      const data = doc.data();
      return {
        expiryDate: data?.expiryDate,
        registrar: data?.registrar,
        registrarId: data?.registrarId,
        registrarUrl: data?.registrarUrl,
        domainName: data?.domainName,
        status: data?.status,
        nameservers: data?.nameservers,
        hasDNSSEC: data?.hasDNSSEC,
        events: data?.events,
        remarks: data?.remarks,
        cachedAt: data?.cachedAt || 0,
        error: data?.error,
        lastAttempt: data?.lastAttempt,
        attemptCount: data?.attemptCount || 0,
      };
    }
    return null;
  } catch (error) {
    logger.warn(`Failed to get RDAP cache from Firestore for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function saveRdapToFirestore(domain: string, data: RdapCacheData): Promise<void> {
  try {
    await firestore.collection('rdap_cache').doc(domain).set(data, { merge: true });
  } catch (error) {
    logger.warn(`Failed to save RDAP cache to Firestore for ${domain}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getRdapFromFirestoreMemo(domain: string): Promise<RdapCacheData | null> {
  if (!rdapFirestoreReadCache.has(domain)) {
    rdapFirestoreReadCache.set(domain, getRdapFromFirestore(domain));
  }
  return rdapFirestoreReadCache.get(domain)!;
}

// Extract registrable domain from URL
function getRegistrableDomainFromUrl(url: string): {
  registrableDomain?: string;
  hostname?: string;
  error?: string;
} {
  try {
    const u = new URL(url);
    let hostname = u.hostname.replace(/\.$/, ''); // strip trailing dot
    
    if (net.isIP(hostname)) {
      return { hostname, error: 'IP addresses have no expiry' };
    }
    
    // Convert IDNs to ASCII
    hostname = punycode.toASCII(hostname);
    
    const parsed = parseTld(hostname, { validateHostname: true });
    if (!parsed.domain || !parsed.publicSuffix) {
      return { hostname, error: 'Unable to determine registrable domain (PSL)' };
    }
    
    return { hostname, registrableDomain: parsed.domain };
  } catch (e) {
    return { error: `Invalid URL: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Check if we should attempt RDAP request based on rate limiting
function shouldAttemptRdap(domain: string, cached: {
  expiryDate?: number;
  cachedAt?: number;
  lastAttempt?: number;
  attemptCount?: number;
  error?: string;
} | null | undefined): boolean {
  const now = Date.now();
  
  // If we have recent successful data, don't attempt
  if (cached && cached.cachedAt && !cached.error) {
    const daysUntilExpiry = cached.expiryDate ? Math.floor((cached.expiryDate - now) / 86400000) : undefined;
    const freshnessMs = daysUntilExpiry !== undefined && daysUntilExpiry <= 30
      ? 24 * 60 * 60 * 1000  // ≤30d left → refresh daily
      : 7 * 24 * 60 * 60 * 1000; // otherwise weekly
    
    if (now - cached.cachedAt < freshnessMs) {
      return false; // Cache is still fresh
    }
  }
  
  // Check rate limiting
  const lastAttempt = cached?.lastAttempt || 0;
  const attemptCount = cached?.attemptCount || 0;
  
  // If we've exceeded max attempts, use exponential backoff
  if (attemptCount >= RDAP_RATE_LIMIT.MAX_ATTEMPTS) {
    const backoffMs = Math.min(
      RDAP_RATE_LIMIT.MIN_INTERVAL * Math.pow(RDAP_RATE_LIMIT.BACKOFF_MULTIPLIER, attemptCount - RDAP_RATE_LIMIT.MAX_ATTEMPTS + 1),
      RDAP_RATE_LIMIT.MAX_BACKOFF
    );
    
    if (now - lastAttempt < backoffMs) {
      return false; // Still in backoff period
    }
  } else {
    // Normal rate limiting
    if (now - lastAttempt < RDAP_RATE_LIMIT.MIN_INTERVAL) {
      return false; // Too soon since last attempt
    }
  }
  
  return true;
}

// Enhanced RDAP data fetching with better error handling and fallbacks
async function fetchRdap(domain: string, signal?: AbortSignal): Promise<{
  expiryDate?: number;
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  status?: string[];
  nameservers?: string[];
  hasDNSSEC?: boolean;
  events?: Array<{ action: string; date: string; actor?: string }>;
  remarks?: string[];
  raw?: RdapDomain;
}> {
  try {
    // Try multiple RDAP servers with better error handling
    const rdapServers = [
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      `https://rdap.iana.org/domain/${encodeURIComponent(domain)}`,
      `https://rdap.verisign.com/rdap/domain/${encodeURIComponent(domain)}`
    ];
    
    let lastError: Error | null = null;
    
    for (const serverUrl of rdapServers) {
      try {
        logger.info(`Trying RDAP server: ${serverUrl}`);
        
        const body = await new Promise<RdapDomain>((resolve, reject) => {
          const req = https.get(serverUrl, {
            headers: { 
              'User-Agent': 'Mozilla/5.0 (compatible; exit1.dev/rdap; +https://exit1.dev)',
              'Accept': 'application/rdap+json, application/json',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 10000, // Increased timeout
          }, (res) => {
            if (res.statusCode !== 200) {
              reject(new Error(`RDAP HTTP ${res.statusCode} from ${serverUrl}`));
              return;
            }
            
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data) as RdapDomain;
                resolve(parsed);
              } catch (e) {
                reject(new Error(`Failed to parse RDAP JSON from ${serverUrl}: ${e instanceof Error ? e.message : String(e)}`));
              }
            });
          });
          
          req.on('error', (err) => {
            reject(new Error(`RDAP request failed for ${serverUrl}: ${err.message}`));
          });
          
          req.on('timeout', () => {
            req.destroy();
            reject(new Error(`RDAP request timeout for ${serverUrl}`));
          });
          
          // Handle abort signal
          if (signal) {
            signal.addEventListener('abort', () => {
              req.destroy();
              reject(new Error('RDAP request aborted'));
            });
          }
        });
        
        // If we get here, the request succeeded
        logger.info(`RDAP request succeeded for ${serverUrl}`);
        
        // Enhanced expiration detection - try multiple patterns
        let expiryDate: number | undefined;
        const events = body.events || [];
        
        // Look for expiration events with various naming patterns
        const expEvent = events.find(e => {
          const action = (e.eventAction || '').toLowerCase();
          return action.includes('expiration') || 
                 action.includes('expiry') || 
                 action.includes('expires') ||
                 action.includes('renewal') ||
                 action.includes('registration');
        });
        
        if (expEvent?.eventDate) {
          expiryDate = Date.parse(expEvent.eventDate);
        }
        
        // Extract nameservers
        const nameservers = body.nameservers?.map(ns => ns.ldhName).filter((ns): ns is string => Boolean(ns)) || [];
        
        // Check DNSSEC status
        const hasDNSSEC = body.secureDNS?.delegationSigned || false;
        
        // Extract remarks
        const remarks = body.remarks?.map(r => r.description?.join(' ')).filter((r): r is string => Boolean(r)) || [];
        
        // Process all events for debugging
        const processedEvents = events.map(e => ({
          action: e.eventAction || 'unknown',
          date: e.eventDate || '',
          actor: e.eventActor
        }));

        return {
          expiryDate,
          registrar: body.registrar?.name,
          registrarId: body.registrar?.ianaId,
          registrarUrl: body.registrar?.url,
          domainName: body.name ?? domain,
          status: body.status || [],
          nameservers,
          hasDNSSEC,
          events: processedEvents,
          remarks,
          raw: body,
        };
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`RDAP request failed for ${serverUrl}: ${lastError.message}`);
        continue; // Try next server
      }
    }
    
    // If we get here, all servers failed
    throw lastError || new Error('All RDAP servers failed');
  } catch (error) {
    throw new Error(`RDAP fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Enhanced DNS validation
async function performDNSValidation(hostname: string): Promise<{
  valid: boolean;
  ipAddresses?: string[];
  ns?: string[];
  error?: string;
}> {
  try {
    const [a, aaaa] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const ipAddresses: string[] = [];
    if (a.status === 'fulfilled') ipAddresses.push(...a.value);
    if (aaaa.status === 'fulfilled') ipAddresses.push(...aaaa.value);

    // NS records are helpful for diagnostics (optional)
    const ns = await Promise.allSettled([
      dns.resolveNs(hostname),
    ]);

    if (!ipAddresses.length) {
      return { valid: false, error: `No A/AAAA for ${hostname}` };
    }

    return {
      valid: true,
      ipAddresses,
      ns: ns[0].status === 'fulfilled' ? ns[0].value : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, error: `DNS validation failed: ${msg}` };
  }
}

// Main domain expiry check function
export async function checkDomainExpiry(url: string): Promise<{
  valid: boolean;
  registrar?: string;
  registrarId?: string;
  registrarUrl?: string;
  domainName?: string;
  expiryDate?: number;
  daysUntilExpiry?: number;
  nameservers?: string[];
  hasDNSSEC?: boolean;
  status?: string[];
  events?: Array<{ action: string; date: string; actor?: string }>;
  error?: string;
}> {
  try {
    const parsed = getRegistrableDomainFromUrl(url);
    if (parsed.error) {
      return { valid: false, error: parsed.error };
    }
    
    const { registrableDomain, hostname } = parsed;
    if (!registrableDomain) {
      return { valid: false, error: 'No registrable domain found' };
    }

    logger.info(`Checking domain expiry for: ${url} (registrable domain: ${registrableDomain})`);

    // Skip localhost-like/private use
    if (/^(localhost|127\.|::1)/.test(hostname!)) {
      return { valid: true, domainName: hostname, registrar: 'n/a' };
    }

    // DNS sanity check (optional but helpful)
    const dnsResult = await performDNSValidation(hostname!);
    if (!dnsResult.valid) {
      // Domain might be parked or non-resolving; still try RDAP
      // but note DNS error as context
      logger.info(`DNS validation failed for ${hostname}: ${dnsResult.error}`);
    }

    // RDAP with intelligent caching and rate limiting
    const now = Date.now();
    
    // Try to get from in-memory cache first
    let cached = rdapCache.get(registrableDomain);
    
    // If not in memory, try Firestore
  if (!cached) {
      const firestoreData = await getRdapFromFirestoreMemo(registrableDomain);
      if (firestoreData) {
        cached = firestoreData;
        rdapCache.set(registrableDomain, cached);
      }
    }
    
    // Check if we should attempt RDAP request
    const shouldAttempt = shouldAttemptRdap(registrableDomain, cached);
    
    if (shouldAttempt) {
      logger.info(`Fetching fresh RDAP data for ${registrableDomain} (cached=${!!cached}, attemptCount=${cached?.attemptCount || 0})`);
      
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000); // 10 second timeout
        
        const rdap = await fetchRdap(registrableDomain, ctrl.signal);
        clearTimeout(t);
        
        // Success - update cache
        const cacheData = {
          expiryDate: rdap.expiryDate, 
          registrar: rdap.registrar,
          registrarId: rdap.registrarId,
          registrarUrl: rdap.registrarUrl,
          domainName: rdap.domainName,
          status: rdap.status,
          nameservers: rdap.nameservers,
          hasDNSSEC: rdap.hasDNSSEC,
          events: rdap.events,
          remarks: rdap.remarks,
          cachedAt: now,
          lastAttempt: now,
          attemptCount: 0, // Reset attempt count on success
          error: undefined
        };
        
        rdapCache.set(registrableDomain, cacheData);
        await saveRdapToFirestore(registrableDomain, cacheData);
        
        logger.info(`RDAP data cached for ${registrableDomain}: expiry=${rdap.expiryDate}, registrar=${rdap.registrar}, events=${rdap.events?.length || 0}, nameservers=${rdap.nameservers?.length || 0}, hasDNSSEC=${rdap.hasDNSSEC}, status=${rdap.status?.length || 0}`);
        
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn(`RDAP fetch failed for ${registrableDomain}: ${errorMsg}`);
        
        // Update attempt count and last attempt
        const attemptCount = (cached?.attemptCount || 0) + 1;
        const cacheData = {
          ...cached,
          cachedAt: cached?.cachedAt || now,
          lastAttempt: now,
          attemptCount,
          error: errorMsg
        };
        
        rdapCache.set(registrableDomain, cacheData);
        await saveRdapToFirestore(registrableDomain, cacheData);
        
        // Keep old cache if present, otherwise continue with limited data
        if (!cached) {
          cached = cacheData;
        }
      }
    } else {
      logger.info(`Using cached RDAP data for ${registrableDomain} (lastAttempt=${cached?.lastAttempt}, attemptCount=${cached?.attemptCount || 0})`);
    }

    const fresh = rdapCache.get(registrableDomain);
    const daysUntilExpiry = fresh?.expiryDate ? Math.floor((fresh.expiryDate - now) / 86400000) : undefined;

    // Debug: Log what's in the cache
    logger.info(`Cache data for ${registrableDomain}: fresh=${!!fresh}, registrar=${fresh?.registrar}, events=${fresh?.events?.length}, nameservers=${fresh?.nameservers?.length}, hasDNSSEC=${fresh?.hasDNSSEC}, status=${fresh?.status?.length}, error=${fresh?.error}`);

    // Check if we have any RDAP data at all
    const hasRdapData = fresh && (
      fresh.registrar || 
      fresh.events?.length || 
      fresh.nameservers?.length || 
      fresh.hasDNSSEC !== undefined ||
      fresh.status?.length
    );

    // Build comprehensive status message
    let statusMessage = '';
    if (hasRdapData) {
      if (fresh?.events && fresh.events.length > 0) {
        statusMessage = `RDAP data available (${fresh.events.length} events)`;
        if (!fresh.expiryDate) {
          statusMessage += ' - No expiry date found in events';
        }
      } else if (fresh?.registrar) {
        statusMessage = `RDAP data available (registrar: ${fresh.registrar})`;
        if (!fresh.expiryDate) {
          statusMessage += ' - No expiry date found';
        }
      } else {
        statusMessage = 'RDAP data available (limited information)';
      }
    } else {
      // Check if we have DNS validation as fallback
      const dnsResult = await performDNSValidation(hostname!);
      if (dnsResult.valid) {
        statusMessage = 'RDAP data unavailable (using DNS validation only)';
      } else {
        statusMessage = `RDAP data unavailable - ${fresh?.error || 'No RDAP data available'}`;
      }
    }

    return {
      valid: true,
      domainName: fresh?.domainName ?? registrableDomain,
      registrar: fresh?.registrar,
      registrarId: fresh?.registrarId,
      registrarUrl: fresh?.registrarUrl,
      expiryDate: fresh?.expiryDate,
      daysUntilExpiry,
      nameservers: fresh?.nameservers,
      hasDNSSEC: fresh?.hasDNSSEC,
      status: fresh?.status,
      events: fresh?.events,
      error: hasRdapData ? undefined : statusMessage,
    };

    // Debug logging
    logger.info(`Domain expiry result for ${registrableDomain}: hasRdapData=${hasRdapData}, registrar=${fresh?.registrar}, events=${fresh?.events?.length}, nameservers=${fresh?.nameservers?.length}, hasDNSSEC=${fresh?.hasDNSSEC}, error=${hasRdapData ? undefined : statusMessage}`);
    
  } catch (error) {
    return {
      valid: false,
      error: `Domain check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

// Enhanced function to check both SSL and domain expiry
export async function checkSecurityAndExpiry(url: string): Promise<{
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    registrarId?: string;
    registrarUrl?: string;
    domainName?: string;
    expiryDate?: number;
    daysUntilExpiry?: number;
    nameservers?: string[];
    hasDNSSEC?: boolean;
    status?: string[];
    events?: Array<{ action: string; date: string; actor?: string }>;
    error?: string;
  };
}> {
  if (!CONFIG.ENABLE_SECURITY_LOOKUPS) {
    logger.info("Security lookups disabled via ENABLE_SECURITY_LOOKUPS flag");
    return {};
  }
  const [sslCertificate, domainExpiry] = await Promise.allSettled([
    checkSSLCertificate(url),
    checkDomainExpiry(url)
  ]);

  return {
    sslCertificate: sslCertificate.status === 'fulfilled' ? sslCertificate.value : undefined,
    domainExpiry: domainExpiry.status === 'fulfilled' ? domainExpiry.value : undefined
  };
}

