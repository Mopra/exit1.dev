# Domain Intelligence (DI) - Feature Design Document

## Overview

**Domain Intelligence (DI)** is a domain expiry monitoring feature that uses RDAP (Registration Data Access Protocol) to track domain registration expiration dates and alert users before their domains expire. This feature extends the existing Exit1 platform, leveraging the same checks, users, and alert infrastructure while using its own dedicated checking functions and scheduler.

**Nano Tier Only** - This feature is exclusively available to paying (Nano) users.

**Key Principles:**
- Integrated with existing platform (same checks, users, alerts)
- Own dedicated scheduler and RDAP checking logic (separate from uptime/SSL checks)
- Extremely conservative resource usage (CPU, memory, invocations)
- No external paid API services - RDAP is free and standardized
- Minimal Firestore reads/writes through intelligent caching and batching
- Dedicated UI at `/domain-intelligence` route

---

## Why RDAP?

RDAP (Registration Data Access Protocol) is the modern, ICANN-mandated replacement for WHOIS:

| Feature | RDAP | WHOIS |
|---------|------|-------|
| Format | Structured JSON | Unstructured text |
| Parsing | Reliable, standardized | Regex nightmare, varies by registrar |
| Rate Limits | Generally more lenient | Often aggressive blocking |
| Accuracy | Authoritative from registries | Often outdated |
| Cost | Free (public protocol) | Free but unreliable |

**RDAP Bootstrap Process:**
1. Query IANA bootstrap file to find authoritative RDAP server for TLD
2. Query the RDAP server for domain registration data
3. Parse standardized JSON response for expiry dates

---

## Data Model

### Extended Fields on Existing `checks` Collection

Domain expiry monitoring is added as fields on the existing check documents. This keeps domains linked to their checks and avoids data duplication.

```typescript
// Extension to existing Website interface in types.ts
interface Website {
  // ... existing fields (id, userId, url, name, status, etc.)
  
  // Domain Expiry Monitoring (new fields)
  domainExpiry?: {
    enabled: boolean;                    // User opted in to domain monitoring
    domain: string;                      // Extracted/normalized domain from URL
    
    // Registration Data (from RDAP)
    registrar?: string;                  // e.g., "Cloudflare, Inc."
    registrarUrl?: string;               // Registrar's website
    createdDate?: number;                // Domain creation timestamp
    updatedDate?: number;                // Last update timestamp  
    expiryDate?: number;                 // Expiration timestamp (critical)
    nameservers?: string[];              // NS records
    registryStatus?: string[];           // e.g., ['clientTransferProhibited']
    
    // Status Tracking
    status: 'active' | 'expiring_soon' | 'expired' | 'unknown' | 'error';
    daysUntilExpiry?: number;            // Computed, cached
    lastCheckedAt?: number;              // Last RDAP query timestamp
    nextCheckAt?: number;                // Scheduled next check timestamp
    lastError?: string;                  // Last error message if any
    consecutiveErrors: number;           // For backoff logic
    
    // Alert Configuration
    alertThresholds: number[];           // Days before expiry [30, 14, 7, 1]
    alertsSent: number[];                // Thresholds already alerted for
  };
}
```

**Benefits of this approach:**
- Domain is always linked to its check (no orphaned records)
- Single source of truth for URL/domain
- User sees domain expiry alongside uptime status
- Deleting a check automatically removes domain monitoring
- No need for separate collection queries

### Extension to Existing Collections

**`emailSettings`** - Add new event types:
```typescript
events: [..., 'domain_expiring', 'domain_expired', 'domain_renewed'];
```

**`webhooks`** - Add new event types:
```typescript
events: [..., 'domain_expiring', 'domain_expired', 'domain_renewed'];
```

**`smsSettings`** - Add new event types:
```typescript
events: [..., 'domain_expiring', 'domain_expired', 'domain_renewed'];
```

---

## Architecture

### Integration with Existing Platform

This feature integrates with the existing Exit1 infrastructure:

- **Uses existing `checks` collection**: Domain expiry data is added to existing check documents (no separate collection)
- **Uses existing alert system**: Leverages `alert.ts` for webhooks, email, and SMS dispatch
- **Uses existing user tiers**: Respects free/nano limits and feature gates
- **Uses existing API patterns**: Same `onCall` structure and error handling
- **Own dedicated scheduler**: Separate from `checkAllChecks` - does not interfere with uptime/SSL monitoring
- **Own RDAP checking logic**: Dedicated functions for domain registration queries

### Check Frequency Strategy (Cost Optimization)

The key insight: **Domain expiry dates rarely change.** Unlike uptime monitoring (minutes), domain checks can run on much longer intervals.

| Days Until Expiry | Check Frequency | Rationale |
|-------------------|-----------------|-----------|
| > 90 days | Every 30 days | Plenty of buffer, minimal checks |
| 31-90 days | Every 14 days | Early warning window |
| 8-30 days | Every 3 days | Active monitoring |
| 2-7 days | Daily | Critical period |
| 0-1 days | Every 12 hours | Last chance alerts |
| Expired | Every 7 days | Check for renewal |

**Estimated invocations per domain/month:**
- Typical domain (>90 days out): ~1 check/month
- Expiring domain: ~10-15 checks in final 30 days
- Average: **~2 checks/domain/month** (vs ~21,600 for 1-min uptime checks)

### Scheduler Design

**Single Daily Scheduler** (not per-region like uptime checks):

```typescript
export const checkDomainExpiry = onSchedule({
  schedule: "every 6 hours",  // 4x daily is plenty
  region: "us-central1",      // Single region sufficient
  timeoutSeconds: 540,        // 9 minutes max
  memory: "256MiB",           // Minimal memory needed
  maxInstances: 1,            // Prevent concurrent runs
}, async () => {
  // Process domains where nextCheckAt <= now
});
```

**Why 6-hour intervals?**
- Most domains don't need frequent checks
- Catches domains entering critical windows within same day
- Only processes domains actually due (via `nextCheckAt` index)
- 4 invocations/day regardless of domain count

### RDAP Implementation

**Recommended Library: `rdap-client`**
- npm: [rdap-client](https://www.npmjs.com/package/rdap-client)
- Handles IANA bootstrap automatically
- Clean TypeScript types
- Active maintenance

**Alternative: Build minimal client** (recommended for full control)

```typescript
interface RdapResponse {
  handle: string;
  ldhName: string;  // Domain name
  events: Array<{
    eventAction: 'registration' | 'expiration' | 'last update of RDAP database' | string;
    eventDate: string;  // ISO 8601
  }>;
  entities?: Array<{
    roles: string[];  // ['registrar', 'registrant', etc.]
    vcardArray?: any;
  }>;
  status?: string[];  // ['active', 'client transfer prohibited', etc.]
  nameservers?: Array<{ ldhName: string }>;
}
```

**Implementation approach:**

```typescript
// 1. Cache IANA bootstrap data (changes rarely)
const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

// Cache bootstrap for 24 hours in memory/Firestore
async function getRdapServerForTld(tld: string): Promise<string> {
  const bootstrap = await getCachedBootstrap();
  // Find matching service for TLD
  for (const service of bootstrap.services) {
    if (service[0].includes(tld)) {
      return service[1][0];  // Return first RDAP server URL
    }
  }
  throw new Error(`No RDAP server found for TLD: ${tld}`);
}

// 2. Query RDAP for domain
async function queryRdap(domain: string): Promise<DomainInfo> {
  const tld = domain.split('.').pop()!;
  const rdapServer = await getRdapServerForTld(tld);
  
  const response = await fetch(`${rdapServer}domain/${domain}`, {
    headers: { 'Accept': 'application/rdap+json' },
    timeout: 10000,
  });
  
  if (!response.ok) {
    throw new Error(`RDAP query failed: ${response.status}`);
  }
  
  return parseRdapResponse(await response.json());
}
```

### Bootstrap Caching Strategy

The IANA bootstrap file rarely changes. Cache aggressively:

```typescript
// Firestore document: system/rdapBootstrap
interface RdapBootstrapCache {
  data: any;              // Full bootstrap JSON
  fetchedAt: number;      // Timestamp
  expiresAt: number;      // fetchedAt + 24 hours
}

// In-memory cache during function execution
let bootstrapCache: RdapBootstrapCache | null = null;

async function getCachedBootstrap(): Promise<any> {
  const now = Date.now();
  
  // 1. Check in-memory cache
  if (bootstrapCache && bootstrapCache.expiresAt > now) {
    return bootstrapCache.data;
  }
  
  // 2. Check Firestore cache
  const doc = await db.doc('system/rdapBootstrap').get();
  if (doc.exists && doc.data()!.expiresAt > now) {
    bootstrapCache = doc.data() as RdapBootstrapCache;
    return bootstrapCache.data;
  }
  
  // 3. Fetch fresh from IANA
  const response = await fetch(RDAP_BOOTSTRAP_URL);
  const data = await response.json();
  
  bootstrapCache = {
    data,
    fetchedAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000,  // 24 hours
  };
  
  // Save to Firestore (fire and forget)
  db.doc('system/rdapBootstrap').set(bootstrapCache).catch(console.error);
  
  return data;
}
```

---

## Processing Logic

### Main Scheduler Function

```typescript
export const checkDomainExpiry = onSchedule({
  schedule: "every 6 hours",
  region: "us-central1",
  timeoutSeconds: 540,
  memory: "256MiB",
  maxInstances: 1,
}, async () => {
  const now = Date.now();
  const startTime = now;
  const TIME_BUDGET_MS = 500 * 1000;  // 8.3 min safety margin
  
  // Query checks with domain expiry enabled and due for checking
  // Note: We filter by userTier in the query to avoid processing free tier users
  const checksQuery = db.collection('checks')
    .where('domainExpiry.enabled', '==', true)
    .where('userTier', '==', 'nano')  // Only Nano users
    .where('domainExpiry.nextCheckAt', '<=', now)
    .orderBy('domainExpiry.nextCheckAt')
    .limit(500);  // Process in batches
  
  const snapshot = await checksQuery.get();
  
  if (snapshot.empty) {
    console.log('No domains due for checking');
    return;
  }
  
  // Cache user tiers to minimize Clerk API calls
  const userTierCache = new Map<string, 'free' | 'nano'>();
  
  async function verifyNanoTier(userId: string): Promise<boolean> {
    if (userTierCache.has(userId)) {
      return userTierCache.get(userId) === 'nano';
    }
    const tier = await getUserTier(userId);
    userTierCache.set(userId, tier);
    return tier === 'nano';
  }
  
  // Batch writes for efficiency
  let batch = db.batch();
  let batchCount = 0;
  const MAX_BATCH_SIZE = 400;  // Firestore limit is 500
  
  for (const doc of snapshot.docs) {
    // Check time budget
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      console.log('Time budget exceeded, stopping');
      break;
    }
    
    const check = doc.data() as Website;
    
    // Double-check tier from Clerk (in case userTier field is stale)
    const isNano = await verifyNanoTier(check.userId);
    if (!isNano) {
      // User downgraded - disable domain expiry
      batch.update(doc.ref, { 'domainExpiry.enabled': false });
      batchCount++;
      continue;
    }
    
    const domainExpiry = check.domainExpiry!;
    
    try {
      const rdapData = await queryRdap(domainExpiry.domain);
      const updateData = processRdapResult(domainExpiry, rdapData, now);
      
      // Update nested domainExpiry field
      batch.update(doc.ref, prefixKeys('domainExpiry', updateData));
      batchCount++;
      
      // Check for alerts (using existing check for context)
      await checkAndSendAlerts(check, domainExpiry, updateData);
      
    } catch (error) {
      // Handle errors with exponential backoff
      const errorUpdate = handleCheckError(domainExpiry, error, now);
      batch.update(doc.ref, prefixKeys('domainExpiry', errorUpdate));
      batchCount++;
    }
    
    // Commit batch if approaching limit
    if (batchCount >= MAX_BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  
  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }
});

// Helper to update nested fields
function prefixKeys(prefix: string, obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[`${prefix}.${key}`] = value;
  }
  return result;
}
```

### Calculating Next Check Time

```typescript
function calculateNextCheckTime(daysUntilExpiry: number, now: number): number {
  let intervalDays: number;
  
  if (daysUntilExpiry > 90) {
    intervalDays = 30;
  } else if (daysUntilExpiry > 30) {
    intervalDays = 14;
  } else if (daysUntilExpiry > 7) {
    intervalDays = 3;
  } else if (daysUntilExpiry > 1) {
    intervalDays = 1;
  } else if (daysUntilExpiry > 0) {
    intervalDays = 0.5;  // 12 hours
  } else {
    intervalDays = 7;  // Expired, check weekly for renewal
  }
  
  return now + intervalDays * 24 * 60 * 60 * 1000;
}
```

### Error Handling with Backoff

```typescript
function handleCheckError(domain: DomainCheck, error: Error, now: number): Partial<DomainCheck> {
  const consecutiveErrors = (domain.consecutiveErrors || 0) + 1;
  
  // Exponential backoff: 1h, 4h, 12h, 24h, 48h max
  const backoffHours = Math.min(Math.pow(2, consecutiveErrors - 1), 48);
  const nextCheckAt = now + backoffHours * 60 * 60 * 1000;
  
  return {
    lastCheckedAt: now,
    nextCheckAt,
    consecutiveErrors,
    lastError: error.message.slice(0, 500),  // Truncate for storage
    status: consecutiveErrors >= 5 ? 'error' : domain.status,
    updatedAt: now,
  };
}
```

---

## Alert System

### Alert Thresholds

Default thresholds: `[30, 14, 7, 1]` days before expiry.

Users can customize per-domain (Nano tier only):
- Add/remove thresholds
- Disable specific thresholds
- Range: 1-365 days

### Alert Logic

```typescript
async function checkAndSendAlerts(
  domain: DomainCheck, 
  updateData: Partial<DomainCheck>
): Promise<void> {
  const daysUntilExpiry = updateData.daysUntilExpiry;
  if (daysUntilExpiry === undefined) return;
  
  const alertsSent = domain.alertsSent || [];
  const thresholds = domain.alertThresholds || [30, 14, 7, 1];
  
  // Check each threshold
  for (const threshold of thresholds) {
    // Skip if already sent
    if (alertsSent.includes(threshold)) continue;
    
    // Trigger if we've crossed this threshold
    if (daysUntilExpiry <= threshold) {
      await triggerDomainAlert(domain, threshold, daysUntilExpiry);
      
      // Mark as sent (will be included in batch update)
      updateData.alertsSent = [...alertsSent, threshold];
      break;  // Only one alert per check
    }
  }
  
  // Check for domain renewed (expiry moved forward)
  if (domain.expiryDate && updateData.expiryDate) {
    const oldExpiry = domain.expiryDate;
    const newExpiry = updateData.expiryDate;
    
    // If expiry extended by more than 30 days, it's a renewal
    if (newExpiry > oldExpiry + 30 * 24 * 60 * 60 * 1000) {
      await triggerDomainRenewalAlert(domain, newExpiry);
      updateData.alertsSent = [];  // Reset alerts for new cycle
    }
  }
}
```

### Alert Event Types

| Event | Trigger | Description |
|-------|---------|-------------|
| `domain_expiring` | Threshold crossed | "Domain expires in X days" |
| `domain_expired` | `daysUntilExpiry <= 0` | "Domain has expired" |
| `domain_renewed` | Expiry date extended significantly | "Domain renewed until [date]" |

### Integration with Existing Alert System

Leverage the existing alert infrastructure in `alert.ts`:

```typescript
// New function in alert.ts
export async function triggerDomainAlert(
  check: Website,  // Full check for context (name, URL, userId)
  threshold: number,
  daysUntilExpiry: number,
): Promise<void> {
  const domainExpiry = check.domainExpiry!;
  const event: WebhookEvent = daysUntilExpiry <= 0 ? 'domain_expired' : 'domain_expiring';
  
  const payload = {
    event,
    checkId: check.id,
    checkName: check.name,
    checkUrl: check.url,
    domain: domainExpiry.domain,
    daysUntilExpiry,
    expiryDate: domainExpiry.expiryDate,
    registrar: domainExpiry.registrar,
    threshold,
    timestamp: Date.now(),
  };
  
  // Use existing webhook dispatch (filtered by event type)
  await dispatchWebhooksForUser(check.userId, event, payload, check.id);
  
  // Use existing email dispatch (respects per-check settings)
  await sendDomainAlertEmail(check.userId, check, payload);
  
  // Use existing SMS dispatch (Nano only, respects per-check settings)
  await sendDomainAlertSms(check.userId, check, payload);
}

// Renewal detection
export async function triggerDomainRenewalAlert(
  check: Website,
  newExpiryDate: number,
): Promise<void> {
  const domainExpiry = check.domainExpiry!;
  const event: WebhookEvent = 'domain_renewed';
  
  const payload = {
    event,
    checkId: check.id,
    checkName: check.name,
    domain: domainExpiry.domain,
    oldExpiryDate: domainExpiry.expiryDate,
    newExpiryDate,
    registrar: domainExpiry.registrar,
    timestamp: Date.now(),
  };
  
  await dispatchWebhooksForUser(check.userId, event, payload, check.id);
  await sendDomainRenewalEmail(check.userId, check, payload);
  // SMS not needed for renewals (positive event)
}
```

---

## API Endpoints

### New Callable Functions

```typescript
// Enable domain expiry monitoring for a check (Nano only)
export const enableDomainExpiry = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  // Verify Nano tier
  const tier = await getUserTier(uid);
  assertNanoTier(tier);
  
  const { checkId, alertThresholds } = request.data;
  
  // Get the existing check
  const checkRef = db.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  const check = checkDoc.data() as Website;
  
  // Extract domain from check URL
  const domain = extractDomain(check.url);
  if (!domain) {
    throw new HttpsError('invalid-argument', 'Could not extract domain from URL');
  }
  
  // Check tier limits for domain monitoring
  await enforceUserLimits(uid, 'domainExpiry');
  
  // Initial RDAP query to validate and populate
  const rdapData = await queryRdap(domain);
  
  const now = Date.now();
  const domainExpiry: Website['domainExpiry'] = {
    enabled: true,
    domain,
    ...rdapData,
    status: calculateStatus(rdapData.daysUntilExpiry),
    lastCheckedAt: now,
    nextCheckAt: calculateNextCheckTime(rdapData.daysUntilExpiry, now),
    consecutiveErrors: 0,
    alertThresholds: alertThresholds || [30, 14, 7, 1],
    alertsSent: [],
  };
  
  await checkRef.update({ domainExpiry });
  
  return { success: true, data: { checkId, domainExpiry } };
});

// Disable domain expiry monitoring for a check
export const disableDomainExpiry = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  const { checkId } = request.data;
  
  const checkRef = db.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  await checkRef.update({ 'domainExpiry.enabled': false });
  
  return { success: true };
});

// Update domain expiry settings for a check
export const updateDomainExpiry = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  const { checkId, alertThresholds } = request.data;
  
  const checkRef = db.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  const updates: Record<string, any> = {};
  if (alertThresholds) {
    updates['domainExpiry.alertThresholds'] = alertThresholds;
  }
  
  await checkRef.update(updates);
  
  return { success: true };
});

// Manual refresh of domain expiry data
export const refreshDomainExpiry = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  const { checkId } = request.data;
  
  const checkRef = db.collection('checks').doc(checkId);
  const checkDoc = await checkRef.get();
  
  if (!checkDoc.exists || checkDoc.data()!.userId !== uid) {
    throw new HttpsError('not-found', 'Check not found');
  }
  
  const check = checkDoc.data() as Website;
  if (!check.domainExpiry?.enabled) {
    throw new HttpsError('failed-precondition', 'Domain expiry monitoring not enabled');
  }
  
  // Rate limit manual refreshes
  await enforceRefreshRateLimit(uid, checkId);
  
  const rdapData = await queryRdap(check.domainExpiry.domain);
  
  const now = Date.now();
  const updates = {
    'domainExpiry.registrar': rdapData.registrar,
    'domainExpiry.registrarUrl': rdapData.registrarUrl,
    'domainExpiry.createdDate': rdapData.createdDate,
    'domainExpiry.updatedDate': rdapData.updatedDate,
    'domainExpiry.expiryDate': rdapData.expiryDate,
    'domainExpiry.nameservers': rdapData.nameservers,
    'domainExpiry.registryStatus': rdapData.registryStatus,
    'domainExpiry.status': calculateStatus(rdapData.daysUntilExpiry),
    'domainExpiry.daysUntilExpiry': rdapData.daysUntilExpiry,
    'domainExpiry.lastCheckedAt': now,
    'domainExpiry.nextCheckAt': calculateNextCheckTime(rdapData.daysUntilExpiry, now),
    'domainExpiry.consecutiveErrors': 0,
    'domainExpiry.lastError': FieldValue.delete(),
  };
  
  await checkRef.update(updates);
  
  return { success: true, data: { checkId, ...rdapData } };
});

// Bulk enable domain expiry for multiple checks (Nano only)
export const bulkEnableDomainExpiry = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
  
  // Verify Nano tier
  const tier = await getUserTier(uid);
  assertNanoTier(tier);
  
  const { checkIds } = request.data;
  
  const results: Array<{ checkId: string; success: boolean; error?: string }> = [];
  
  for (const checkId of checkIds) {
    try {
      // Reuse enableDomainExpiry logic
      await enableDomainExpiryForCheck(uid, checkId);
      results.push({ checkId, success: true });
    } catch (error) {
      results.push({ checkId, success: false, error: error.message });
    }
  }
  
  return { success: true, data: { results } };
});
```

---

## Tier Limits

**Domain Intelligence is a Nano-only feature.** Free tier users cannot access this feature.

| Feature | Free | Nano |
|---------|------|------|
| Access to Domain Intelligence | No | Yes |
| Domain monitoring | Not available | All checks |
| Alert thresholds | - | Custom thresholds |
| Alert channels | - | Email, SMS, Webhooks |
| Manual refresh | - | 10/day per domain |

### Tier Enforcement

User tier is retrieved from Clerk metadata. The scheduler and API endpoints must verify tier before processing:

```typescript
import { clerkClient } from './init';

async function getUserTier(userId: string): Promise<'free' | 'nano'> {
  const user = await clerkClient.users.getUser(userId);
  return (user.publicMetadata?.tier as 'free' | 'nano') || 'free';
}

// In scheduler - skip free tier users entirely
async function shouldProcessDomain(check: Website): Promise<boolean> {
  const tier = await getUserTier(check.userId);
  return tier === 'nano';
}

// In API - reject free tier users
function assertNanoTier(tier: string): void {
  if (tier !== 'nano') {
    throw new HttpsError(
      'permission-denied', 
      'Domain Intelligence is only available for Nano subscribers'
    );
  }
}
```

---

## Cost Analysis

### Firebase Costs

**Cloud Functions Invocations:**
- Scheduler: 4 invocations/day = 120/month = ~$0
- API calls: Minimal (user actions)

**Firestore:**
- Reads: ~2 per domain per check (domain + bootstrap cache)
- Writes: 1 per domain per check (batched)
- Estimated: 1000 domains = ~4000 reads/month, ~2000 writes/month = ~$0.01

**Total estimated cost per 1000 domains: ~$0.01-0.05/month**

### Comparison with Uptime Checks

| Metric | Domain Expiry | Uptime (1-min) |
|--------|---------------|----------------|
| Checks/domain/month | ~2 | ~43,200 |
| Function invocations | 120/month | ~129,600/month |
| Firestore writes | ~2/domain/month | ~43,200/domain/month |
| Relative cost | 1x | ~20,000x |

---

## RDAP Limitations & Handling

### TLDs Without RDAP Support

Some TLDs don't have RDAP servers yet. Handle gracefully:

```typescript
const UNSUPPORTED_TLDS = new Set([
  // Add known unsupported TLDs
]);

function validateDomain(domain: string): { valid: boolean; error?: string } {
  const tld = domain.split('.').pop()!.toLowerCase();
  
  if (UNSUPPORTED_TLDS.has(tld)) {
    return { 
      valid: false, 
      error: `The .${tld} TLD does not support RDAP. Manual monitoring recommended.` 
    };
  }
  
  return { valid: true };
}
```

### Rate Limiting from RDAP Servers

Different registries have different rate limits. Implement defensive measures:

1. **In-memory request counting** per RDAP server
2. **Automatic backoff** on 429 responses
3. **Spread requests** over scheduler window (don't burst)

```typescript
const rdapRequestCounts = new Map<string, { count: number; resetAt: number }>();

async function rateLimitedRdapQuery(domain: string): Promise<DomainInfo> {
  const rdapServer = await getRdapServerForTld(getTld(domain));
  
  const now = Date.now();
  const serverLimit = rdapRequestCounts.get(rdapServer);
  
  if (serverLimit && serverLimit.resetAt > now && serverLimit.count >= 30) {
    // Skip this domain, will be picked up next run
    throw new Error('RDAP rate limit, will retry later');
  }
  
  const result = await queryRdap(domain);
  
  // Track request
  const current = rdapRequestCounts.get(rdapServer) || { count: 0, resetAt: now + 60000 };
  current.count++;
  rdapRequestCounts.set(rdapServer, current);
  
  return result;
}
```

### Handling RDAP Response Variations

Different registries return slightly different JSON structures. Normalize:

```typescript
function parseRdapResponse(response: any): DomainInfo {
  const events = response.events || [];
  
  let expiryDate: number | undefined;
  let createdDate: number | undefined;
  let updatedDate: number | undefined;
  
  for (const event of events) {
    const date = new Date(event.eventDate).getTime();
    
    switch (event.eventAction) {
      case 'expiration':
        expiryDate = date;
        break;
      case 'registration':
        createdDate = date;
        break;
      case 'last changed':
      case 'last update of RDAP database':
        updatedDate = date;
        break;
    }
  }
  
  // Find registrar from entities
  const registrar = response.entities?.find(
    (e: any) => e.roles?.includes('registrar')
  );
  
  return {
    expiryDate,
    createdDate,
    updatedDate,
    registrar: registrar?.vcardArray?.[1]?.find(
      (v: any) => v[0] === 'fn'
    )?.[3],
    nameservers: response.nameservers?.map((ns: any) => ns.ldhName),
    status: response.status,
  };
}
```

---

## Implementation Plan

### Phase 1: Core Infrastructure (Backend)
1. Extend `Website` interface with `domainExpiry` field in `types.ts`
2. Implement RDAP client with bootstrap caching (`rdap-client.ts`)
3. Create dedicated scheduler function (`domain-intelligence.ts`)
4. Add domain extraction and normalization utilities
5. Add Nano tier check using Clerk metadata

### Phase 2: API Endpoints
1. `enableDomainExpiry` - Enable monitoring for a check (Nano only)
2. `disableDomainExpiry` - Disable monitoring
3. `updateDomainExpiry` - Update alert thresholds
4. `refreshDomainExpiry` - Manual refresh
5. `bulkEnableDomainExpiry` - Enable for multiple checks
6. `getDomainIntelligence` - Get all DI data for user's checks

### Phase 3: Alert Integration
1. Add new event types (`domain_expiring`, `domain_expired`, `domain_renewed`)
2. Implement `triggerDomainAlert` in `alert.ts`
3. Create email templates for domain alerts
4. Add webhook payload formatting for domain events

### Phase 4: Frontend - Domain Intelligence Page
1. Create `/domain-intelligence` route (Nano-gated)
2. Create `useDomainIntelligence.ts` hook following `useChecks` patterns:
   - Real-time Firestore subscription for checks with `domainExpiry.enabled`
   - Optimistic updates with rollback
   - Folder/grouping support (reuse folder utilities)
   - Bulk operations (enable, disable, refresh)
3. Create `DomainTable.tsx` based on `CheckTable`:
   - Same table structure with domain-specific columns
   - Column visibility toggle
   - Sorting by expiry date, domain, status
   - Grouping by folder
   - Drag-and-drop reordering
   - Multi-select with bulk actions
4. Create `DomainTableShell.tsx` for responsive table/card switching
5. Create `DomainCard.tsx` for mobile view
6. Create `DomainFolderView.tsx` based on `CheckFolderView`
7. Create `DomainSettingsPanel.tsx` slide-out panel
8. Create `EnableDomainModal.tsx` for enabling DI on checks
9. Add navigation link (visible to Nano users only)

### Phase 5: Polish
1. Enforce Nano tier in scheduler (skip free tier checks)
2. Add rate limiting for manual refreshes
3. Handle RDAP errors gracefully with user feedback
4. Add Firestore indexes for scheduler queries
5. Add upgrade prompt for free tier users visiting `/domain-intelligence`

---

## Files to Create/Modify

### New Files (Backend)
- `functions/src/domain-intelligence.ts` - Scheduler and RDAP checking logic (dedicated, separate from uptime checks)
- `functions/src/rdap-client.ts` - RDAP implementation with bootstrap caching

### New Files (Frontend)
- `src/pages/DomainIntelligence.tsx` - Main UI page at `/domain-intelligence`
- `src/hooks/useDomainIntelligence.ts` - Hook for DI data and actions (follows `useChecks` patterns)
- `src/components/domain-intelligence/DomainTable.tsx` - Table view (based on `CheckTable`)
- `src/components/domain-intelligence/DomainTableShell.tsx` - Responsive wrapper (based on `ChecksTableShell`)
- `src/components/domain-intelligence/DomainCard.tsx` - Mobile card view (based on `CheckCard`)
- `src/components/domain-intelligence/DomainFolderView.tsx` - Folder view (based on `CheckFolderView`)
- `src/components/domain-intelligence/DomainSettingsPanel.tsx` - Slide-out settings (based on `CheckForm`)
- `src/components/domain-intelligence/EnableDomainModal.tsx` - Modal to enable DI for checks

### Reused Components (no changes needed)
- `src/components/ui/table.tsx` - Table primitives
- `src/components/ui/glow-card.tsx` - Card container
- `src/components/ui/EmptyState.tsx` - Empty/loading states
- `src/components/ui/BulkActionsBar.tsx` - Bulk actions bar
- `src/components/layout/PageHeader.tsx` - Page header
- `src/components/layout/PageContainer.tsx` - Page wrapper
- `src/components/ui/tabs.tsx` - View tabs
- `src/components/check/FolderGroupHeaderRow.tsx` - Folder group headers (generic)
- `src/lib/folder-utils.ts` - Folder utilities

### Modified Files (Backend)
- `functions/src/index.ts` - Export new domain intelligence functions
- `functions/src/types.ts` - Extend Website interface with `domainExpiry` field
- `functions/src/alert.ts` - Add domain alert handlers (integrate with existing dispatch)
- `functions/src/config.ts` - Add domain intelligence config constants
- `functions/src/webhook-events.ts` - Add `domain_expiring`, `domain_expired`, `domain_renewed` events

### Modified Files (Frontend)
- `src/api/client.ts` - Add domain intelligence API methods
- `src/api/types.ts` - Add domain intelligence API types
- `src/types.ts` - Add DomainExpiry interface to frontend types
- `src/App.tsx` - Add `/domain-intelligence` route (Nano-gated)

---

## Testing Strategy

### Unit Tests
- RDAP response parsing (various registry formats)
- Next check time calculation
- Alert threshold logic
- Domain normalization

### Integration Tests
- Full RDAP query flow
- Scheduler batch processing
- Alert dispatch

### Manual Testing
- Test with various TLDs (.com, .io, .dev, .co.uk, etc.)
- Test error scenarios (invalid domain, RDAP down)
- Verify alert delivery

---

## UI Design - Domain Intelligence Page

### Route: `/domain-intelligence`

**Access Control:**
- Nano users: Full access to the page
- Free users: Redirect to upgrade page or show upgrade prompt

### Design Principle

The Domain Intelligence page follows the **same patterns as `/checks`**:
- Same table component structure with `ChecksTableShell` pattern
- Same folder/grouping system
- Same responsive design (table on desktop, cards on mobile)
- Same drag-and-drop reordering
- Same multi-select with bulk actions
- Same optimistic updates pattern

### Component Hierarchy

```
DomainIntelligence.tsx (Page)
├── PageContainer (reuse)
├── PageHeader (reuse)
├── SearchInput (reuse)
├── Tabs (reuse)
│   ├── TabsContent: "table"
│   │   └── DomainTable
│   │       ├── DomainTableShell (based on ChecksTableShell)
│   │       │   ├── GlowCard (reuse)
│   │       │   │   ├── Toolbar (groupBy dropdown, columns dropdown)
│   │       │   │   └── Table components (reuse)
│   │       │   │       └── FolderGroupHeaderRow (reuse)
│   │       │   └── Mobile: DomainCard components
│   │       └── ConfirmationModal (reuse)
│   └── TabsContent: "folders"
│       └── DomainFolderView (based on CheckFolderView)
├── DomainSettingsPanel (slide-out, based on CheckForm pattern)
├── EnableDomainModal
└── BulkActionsBar (reuse)
```

### Table Layout

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Domain Intelligence                                    [Enable Domain] [↻ All] │
├────────────────────────────────────────────────────────────────────────────────┤
│ [Search domains...]                              [Table ▼] [Folders] [Timeline]│
├────────────────────────────────────────────────────────────────────────────────┤
│ Group by: [None ▼]    Columns: [✓Status ✓Domain ✓Check ✓Registrar ✓Expiry...] │
├────┬────┬──────────┬────────────────┬─────────────┬──────────────┬─────────────┤
│ ☐  │ ≡  │ Status   │ Domain         │ Check       │ Registrar    │ Expiry      │
├────┼────┼──────────┼────────────────┼─────────────┼──────────────┼─────────────┤
│    │    │          │ ▼ Production (3)                                          │
├────┼────┼──────────┼────────────────┼─────────────┼──────────────┼─────────────┤
│ ☐  │ ≡  │ ⚠ 7d    │ example.com    │ My Website  │ Cloudflare   │ Feb 1, 2026 │
│ ☐  │ ≡  │ ✓ 340d  │ exit1.dev      │ Exit1 Home  │ Google       │ Dec 1, 2026 │
│ ☐  │ ≡  │ ✗ Error │ broken.io      │ Broken Site │ —            │ Unknown     │
├────┼────┼──────────┼────────────────┼─────────────┼──────────────┼─────────────┤
│    │    │          │ ▼ Staging (2)                                             │
├────┼────┼──────────┼────────────────┼─────────────┼──────────────┼─────────────┤
│ ☐  │ ≡  │ ✓ 180d  │ staging.app    │ Staging API │ Namecheap    │ Jul 25, 2026│
└────┴────┴──────────┴────────────────┴─────────────┴──────────────┴─────────────┘
                                              Selected: 2  [Disable DI] [Refresh]
```

### Table Columns

| Column | Description | Sortable |
|--------|-------------|----------|
| Checkbox | Multi-select | No |
| Drag handle | Reorder domains | No |
| Status | Expiry status badge (days until expiry) | Yes |
| Domain | Domain name (extracted from check URL) | Yes |
| Check | Linked check name (click to go to check) | Yes |
| Registrar | Domain registrar from RDAP | Yes |
| Expiry Date | Expiration date | Yes (default) |
| Created | Domain registration date | Yes |
| Nameservers | NS records (collapsible) | No |
| Last Checked | Last RDAP query time | Yes |
| Actions | Settings, Refresh, Disable | No |

### Status Badge Logic

| Days Until Expiry | Status | Badge Color |
|-------------------|--------|-------------|
| > 90 days | Healthy | Green |
| 31-90 days | Attention | Blue |
| 8-30 days | Warning | Yellow |
| 1-7 days | Critical | Orange |
| 0 or expired | Expired | Red |
| RDAP error | Error | Gray |

### Folder System

Uses the **same folder system as checks** with the same utilities:
- Hierarchical folders with `/` separator
- Max depth of 2 levels
- Folder colors from `FOLDER_COLORS` palette
- Collapsible folder groups in table view
- Folder view with cards

**Folder Storage:** Reuses the check's folder field - domains inherit their check's folder automatically.

### Mobile View (DomainCard)

```
┌─────────────────────────────────────────┐
│ ⚠ example.com                     [···] │
│ Expires in 7 days (Feb 1, 2026)         │
│                                         │
│ Check: My Website                       │
│ Registrar: Cloudflare, Inc.             │
│ Alerts: 30d ✓  14d ✓  7d ●  1d ○       │
│                                         │
│ Last checked: 2 hours ago               │
└─────────────────────────────────────────┘
```

### Slide-out Settings Panel

Based on `CheckForm` pattern - slides in from right:

```
┌─────────────────────────────────────┐
│ Domain Settings              [Close]│
├─────────────────────────────────────┤
│ example.com                         │
│ Linked to: My Website               │
├─────────────────────────────────────┤
│ Alert Thresholds                    │
│ ┌─────────────────────────────────┐ │
│ │ [30] days before  [×]           │ │
│ │ [14] days before  [×]           │ │
│ │ [7]  days before  [×]           │ │
│ │ [1]  day before   [×]           │ │
│ │ [+ Add threshold]               │ │
│ └─────────────────────────────────┘ │
├─────────────────────────────────────┤
│ RDAP Information                    │
│ Registrar: Cloudflare, Inc.         │
│ Created: Sep 15, 1997               │
│ Updated: Aug 15, 2024               │
│ Expires: Feb 1, 2026                │
│ Status: clientTransferProhibited    │
│ Nameservers:                        │
│   ns1.cloudflare.com                │
│   ns2.cloudflare.com                │
├─────────────────────────────────────┤
│ [Refresh Now]    [Disable DI]       │
└─────────────────────────────────────┘
```

### Enable Domain Modal

```
┌─────────────────────────────────────────┐
│ Enable Domain Intelligence       [Close]│
├─────────────────────────────────────────┤
│ Select checks to enable DI:             │
│                                         │
│ ☐ My Website (example.com)              │
│ ☐ API Server (api.example.com)          │
│ ☐ Blog (blog.example.com)               │
│ ☑ Exit1 Homepage (exit1.dev)            │
│ ☑ Documentation (docs.exit1.dev)        │
│                                         │
│ ─────────────────────────────────────── │
│ ✓ Already enabled: 12 domains           │
├─────────────────────────────────────────┤
│                    [Cancel] [Enable (2)]│
└─────────────────────────────────────────┘
```

### Bulk Actions Bar

When domains are selected, show fixed bottom bar (reuse `BulkActionsBar`):

```
┌─────────────────────────────────────────────────────────────┐
│  3 domains selected    [Refresh All] [Disable DI] [Cancel] │
└─────────────────────────────────────────────────────────────┘
```

### Empty States

**No domains monitored:**
```
┌─────────────────────────────────────────┐
│                  📋                     │
│     No domains monitored yet            │
│                                         │
│  Enable Domain Intelligence for your    │
│  checks to monitor domain expiration    │
│  dates and receive alerts.              │
│                                         │
│         [Enable for checks]             │
└─────────────────────────────────────────┘
```

**Free tier user visiting page:**
```
┌─────────────────────────────────────────┐
│                  🔒                     │
│  Domain Intelligence is a Nano feature  │
│                                         │
│  Upgrade to Nano to monitor domain      │
│  expiration dates and never lose a      │
│  domain again.                          │
│                                         │
│          [Upgrade to Nano]              │
└─────────────────────────────────────────┘
```

### LocalStorage Keys (following checks pattern)

```typescript
'di-group-by-v1': 'none' | 'folder'
'di-folder-collapsed-v1': string[]
'di-columns-v1': string[]
'di-sort-v1': { field: string; direction: 'asc' | 'desc' }
'di-view-v1': 'table' | 'folders' | 'timeline'
```
┌─────────────────────────────────────────────────────────────┐
│  Domain Intelligence                            [Refresh All]│
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Total    │ │ Expiring │ │ Healthy  │ │ Errors   │       │
│  │ 24       │ │ 3        │ │ 20       │ │ 1        │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
├─────────────────────────────────────────────────────────────┤
│  [Enable for checks ▼]                    [Search domains] │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ⚠ example.com              Expires in 7 days        │   │
│  │   Registrar: Cloudflare    Check: My Website        │   │
│  │   Alerts: 30d ✓ 14d ✓ 7d ● 1d ○    [Settings] [↻]  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ✓ exit1.dev                Expires in 340 days      │   │
│  │   Registrar: Google        Check: Exit1 Homepage    │   │
│  │   Alerts: 30d ○ 14d ○ 7d ○ 1d ○    [Settings] [↻]  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

### Components

**Summary Cards:**
- Total monitored domains
- Domains expiring within 30 days (warning state)
- Healthy domains (>30 days)
- Domains with RDAP errors

**Domain List:**
- Sorted by expiry date (soonest first)
- Status indicator (healthy/warning/critical/error)
- Domain name and linked check name
- Registrar information
- Days until expiry
- Alert threshold progress (which alerts have been sent)
- Quick actions: Settings, Manual Refresh

**Enable Modal:**
- Dropdown to select from user's checks that don't have DI enabled
- Shows extracted domain from check URL
- Validates domain supports RDAP before enabling

**Settings Modal:**
- Custom alert thresholds (add/remove days)
- Disable DI for this domain
- View full RDAP data (registrar, nameservers, registry status)

### Empty States

**No domains monitored:**
```
No domains monitored yet

Enable Domain Intelligence for your checks to monitor
domain expiration dates and receive alerts.

[Enable for a check]
```

**Free tier user visiting page:**
```
Domain Intelligence is a Nano feature

Upgrade to Nano to monitor domain expiration dates
and never lose a domain again.

[Upgrade to Nano]
```

## Security Considerations

1. **Input Validation**: Strict domain format validation
2. **User Isolation**: All queries scoped to userId
3. **No Secrets Stored**: RDAP is public, no API keys needed
4. **Rate Limiting**: Prevent abuse of manual refresh

---

## Open Questions

1. **Should we track nameserver changes?** Could alert on unexpected NS changes (security feature)
2. **Historical data in BigQuery?** Worth storing domain status history?
3. **Bulk import?** Allow importing multiple domains at once?
4. **Domain groups/folders?** Organize domains like checks?

---

## Appendix: RDAP Bootstrap Example

```json
{
  "version": "1.0",
  "publication": "2024-01-15T00:00:00Z",
  "services": [
    [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
    [["io"], ["https://rdap.nic.io/"]],
    [["dev"], ["https://rdap.nic.google/"]],
    [["uk", "co.uk"], ["https://rdap.nominet.uk/"]],
    // ... more TLDs
  ]
}
```

## Appendix: Example RDAP Response

```json
{
  "objectClassName": "domain",
  "handle": "123456789_DOMAIN_COM-VRSN",
  "ldhName": "example.com",
  "status": ["client transfer prohibited", "server delete prohibited"],
  "events": [
    { "eventAction": "registration", "eventDate": "1997-09-15T04:00:00Z" },
    { "eventAction": "expiration", "eventDate": "2025-09-14T04:00:00Z" },
    { "eventAction": "last changed", "eventDate": "2024-08-15T09:00:00Z" }
  ],
  "entities": [
    {
      "roles": ["registrar"],
      "vcardArray": ["vcard", [["fn", {}, "text", "Example Registrar, Inc."]]]
    }
  ],
  "nameservers": [
    { "ldhName": "ns1.example.com" },
    { "ldhName": "ns2.example.com" }
  ]
}
```
