# Firestore Optimization - Cost Reduction Analysis

## Executive Summary

This document identifies opportunities to reduce Firestore read and write operations in the `/functions` directory. The codebase already implements many best practices (caching, batching, deferred writes), but several patterns can still be optimized for significant cost savings.

**Estimated total savings potential: 60-80% reduction in Firestore operations**

---

## Current State Overview

### Files with Firestore Operations

| File | Reads | Writes | Transactions | Batches |
|------|-------|--------|--------------|---------|
| `checks.ts` | High | High | 3 | 4 |
| `alert.ts` | Medium | Medium | 1 | 1 |
| `users.ts` | High | Medium | 0 | 6 |
| `history.ts` | Medium | 0 | 0 | 0 |
| `admin.ts` | High | Low | 0 | 0 |
| `webhooks.ts` | Medium | Medium | 0 | 2 |
| `status-pages.ts` | Medium | 0 | 0 | 0 |
| `email.ts` | Low | Low | 0 | 0 |
| `public-api.ts` | Medium | Low | 0 | 0 |
| `status-buffer.ts` | Low | High | 0 | 1 |
| `security-refresh.ts` | Medium | Medium | 0 | 1 |
| `notifications.ts` | Medium | Medium | 0 | 1 |
| `api-keys.ts` | Low | Low | 0 | 0 |

---

## Medium Severity Issues

### Issue 8: Alert Settings Fetched Per User Per Alert Cycle (alert.ts)

**Location:** `functions/src/alert.ts:648-654`

**Current Code:**
```typescript
const [emailDoc, smsDoc, webhooksSnapshot] = await Promise.all([
  firestore.collection('emailSettings').doc(userId).get(),
  firestore.collection('smsSettings').doc(userId).get(),
  firestore.collection('webhooks').where('userId', '==', userId).where('enabled', '==', true).get(),
]);
```

**Status:** Already optimized with 30-minute cache (`ALERT_SETTINGS_CACHE_TTL_MS`).

**Current Tradeoffs (already accepted):**
- Settings changes take up to 30 minutes to take effect
- Memory usage for cache (acceptable)

**No further action needed** - this is a good implementation.

---

### Issue 9: History Functions Read Check Document for Ownership (history.ts)

**Location:** `functions/src/history.ts:150, 288, 439, 575, 645`

**Current Code:**
```typescript
const websiteDoc = await firestore.collection("checks").doc(websiteId).get();
// Verify ownership: websiteDoc.data().userId === uid
```

**Problem:** Each history function reads the check doc to verify ownership.

**Potential Fix:**
```typescript
// Short-lived request-scoped cache
const ownershipCache = new Map<string, string>(); // checkId -> userId

async function verifyOwnership(checkId: string, uid: string): Promise<boolean> {
  if (ownershipCache.has(checkId)) {
    return ownershipCache.get(checkId) === uid;
  }
  
  const doc = await firestore.collection("checks").doc(checkId).get();
  if (!doc.exists) return false;
  
  const ownerId = doc.data()!.userId;
  ownershipCache.set(checkId, ownerId);
  return ownerId === uid;
}
```

**Impact:** Minimal - these are user-initiated actions with low frequency.

**Tradeoffs:**
- **Security consideration:** Must clear cache on each request; cannot persist across requests
- **Complexity vs benefit:** Low ROI for this optimization
- **Recommendation:** Leave as-is unless history endpoints see very high traffic

---

## Low Severity Issues

### Issue 10: Security Refresh Fetches All Non-Disabled Checks (security-refresh.ts)

**Location:** `functions/src/security-refresh.ts:216-219`

**Current Code:**
```typescript
const snapshot = await firestore.collection("checks")
  .where("disabled", "!=", true)
  .limit(MAX_WEBSITES) // 10,000
  .get();
```

**Status:** Already has limit of 10,000 documents. Runs every 168 hours (weekly).

**Impact:** ~10,000 reads per week = ~40,000 reads/month

**Potential optimization:** If only specific fields needed, add `.select()`:
```typescript
.select('url', 'userId', 'securityHeaders')
```

**Tradeoffs:** Minimal - weekly function, already limited.

---

### Issue 11: getChecks Fetches All Fields (checks.ts)

**Location:** `functions/src/checks.ts:1772-1776`

**Current Code:**
```typescript
const checksSnapshot = await firestore
  .collection("checks")
  .where("userId", "==", uid)
  .orderBy("orderIndex", "asc")
  .get(); // Fetches ALL fields
```

**Potential Fix:**
```typescript
.select('id', 'name', 'url', 'status', 'orderIndex', 'disabled', 'lastCheckedAt')
```

**Tradeoffs:**
- UI likely needs most fields anyway
- Bandwidth savings only, not read count savings
- Requires maintaining field list as schema evolves
- **Recommendation:** Leave as-is unless bandwidth is a concern

---

## Well-Optimized Patterns (Reference)

The codebase already implements these best practices:

### 1. Deferred Budget Writes (alert.ts:63-145)
```typescript
// Batches budget updates, flushes at end of run
// Reduces writes from O(alerts) to O(unique users)
```
**Impact:** Prevents N writes for N alerts, instead doing 1 write per user.

### 2. Status Update Buffer (status-buffer.ts)
```typescript
// Batches status updates with 400-doc batch size
// Hash comparison to skip no-op writes
// Graceful shutdown handlers
```
**Impact:** Reduces write frequency and eliminates redundant updates.

### 3. Per-Run Caching (checks.ts:462-497)
```typescript
// userSettingsCache - caches alert settings per user per run
// tierByUserId - memoizes tier lookups
```
**Impact:** Prevents duplicate reads within a single scheduler run.

### 4. Aggregate Queries (admin.ts:281-289)
```typescript
// Uses .count().get() for total counts
```
**Impact:** Efficient counting without reading all documents.

### 5. Parallel Queries with IN Operator (users.ts:208-223)
```typescript
// Batches user IDs with .where('userId', 'in', chunk) queries
```
**Impact:** Reduces query count by factor of 30.

### 6. Select Projections (multiple files)
```typescript
.select('field1', 'field2')
```
**Impact:** Reduces bandwidth (reads are still charged, but data transfer is lower).

---

## Implementation Priority

*All identified optimizations have been implemented.*

---

## Cost Impact Estimates

Based on Firestore pricing ($0.06/100k reads, $0.18/100k writes):

*All high-impact optimizations have been implemented.*

**Total estimated savings: $3-5/month per 10,000 operations baseline**

*Note: Actual savings depend heavily on usage patterns. High-traffic deployments will see proportionally larger savings.*

---

## Decision Matrix

Use this matrix to evaluate each optimization:

| Question | If Yes | If No |
|----------|--------|-------|
| Is the function called frequently? | Higher priority | Lower priority |
| Does it affect user-facing latency? | Higher priority | Lower priority |
| Is the change reversible? | Lower risk | Consider phased rollout |
| Does it change data semantics? | Needs thorough testing | Simpler implementation |
| Does it affect data freshness? | Document SLA changes | No action needed |

---

## Monitoring Recommendations

After implementing optimizations, monitor:

1. **Firestore usage dashboard** - Track read/write counts
2. **Function execution times** - Ensure latency doesn't regress
3. **Error rates** - Watch for new error patterns
4. **Cache hit rates** - Verify caching is effective (add logging)

```typescript
// Example: Add cache hit/miss logging
const cacheHit = apiKeyCache.has(hash);
console.log(`API key cache ${cacheHit ? 'hit' : 'miss'} for hash ${hash.slice(0, 8)}...`);
```

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-25 | - | Initial analysis |

