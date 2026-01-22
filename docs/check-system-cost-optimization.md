# Check System Architecture & Cost Optimization

## Overview

This document provides a deep dive into the `checkAllChecks` system architecture and identifies opportunities for reducing Cloud Run Functions costs.

---

## Architecture Summary

### Regional Schedulers

The system runs **3 regional schedulers** every 2 minutes:

| Function | Region | Schedule |
|----------|--------|----------|
| `checkAllChecks` | us-central1 | Every 2 minutes |
| `checkAllChecksEU` | europe-west1 | Every 2 minutes |
| `checkAllChecksAPAC` | asia-southeast1 | Every 2 minutes |

### Execution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        runCheckScheduler()                          │
├─────────────────────────────────────────────────────────────────────┤
│  1. Acquire distributed lock (Firestore)                            │
│  2. Query due checks (nextCheckAt <= now, disabled !== true)        │
│  3. Paginate through checks (max 2000/run, 5 pages max)             │
│  4. Process in batches with dynamic concurrency (25-100)            │
│  5. Buffer status updates to Firestore                              │
│  6. Buffer history inserts to BigQuery                              │
│  7. Release lock                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Configuration (from `config.ts`)

| Setting | Value | Purpose |
|---------|-------|---------|
| `CHECK_INTERVAL_MINUTES` | 2 | Default check frequency |
| `BATCH_SIZE` | 150 | Checks per batch |
| `MAX_WEBSITES_PER_RUN` | 2000 | Cap per scheduler run |
| `MAX_CONCURRENT_CHECKS` | 75 | Concurrent HTTP requests |
| `HTTP_TIMEOUT_MS` | 20000 | Per-check timeout |
| `HISTORY_SAMPLE_INTERVAL_MS` | 3600000 (1 hour) | BigQuery write frequency for online checks |
| `IMMEDIATE_RECHECK_DELAY_MS` | 30000 (30 seconds) | Delay before confirmation recheck |
| `DOWN_CONFIRMATION_ATTEMPTS` | 4 | Required failures before alerting |
| `SECURITY_METADATA_TTL_MS` | 2592000000 (30 days) | SSL certificate cache duration |
| `TARGET_METADATA_TTL_MS` | 604800000 (7 days) | GeoIP cache duration |

---

## Current Cost Optimizations

The codebase already implements several smart optimizations:

### 1. History Sampling
- Only writes to BigQuery every 1 hour for checks that remain online
- Status changes always recorded immediately
- **Impact**: Reduces BigQuery writes by ~30x

### 2. Firestore Trigger Removal
- Replaced `onDocumentUpdated` trigger with direct function calls
- **Impact**: Eliminated ~170K+ wasted invocations/day

### 3. Buffered Writes
- `status-buffer.ts`: Batches Firestore status updates (400 docs/batch)
- `bigquery.ts`: Batches BigQuery inserts (400 rows/batch, 9MB limit)
- **Impact**: Significantly fewer API calls

### 4. No-Op Detection
- Status buffer hashes data to skip identical writes
- Compares normalized fields to detect meaningful changes
- **Impact**: Eliminates ~50%+ redundant writes

### 5. Security Metadata Caching
- SSL certificate info cached for 30 days
- Avoids expensive TLS handshake checks on every run
- **Impact**: Major reduction in check latency

### 6. Target Metadata Caching
- GeoIP data cached for 7 days (1 hour if geo missing)
- DNS lookups cached with target metadata
- **Impact**: Reduces DNS/GeoIP API calls

### 7. User Settings Caching
- Per-run memoization of user tier lookups
- Email/SMS/webhook settings cached per-user per-run
- **Impact**: Eliminates duplicate Firestore reads

---

## Cost Optimization Opportunities

### 1. Idle Regional Schedulers (High Impact)

**Problem**: All 3 regional schedulers run every 2 minutes even with no checks to process.

**Current Behavior**:
```typescript
if (scheduledChecks === 0) {
  logger.info(`No checks need checking (${region})`);
  return;
}
```

**Impact**: ~720 invocations/day per idle region

**Recommendations**:
- [ ] Reduce frequency for low-volume regions (EU/APAC → every 5 min)
- [ ] Implement dynamic scheduling based on regional check counts
- [ ] Consider single scheduler for low-volume periods

**Estimated Savings**: 5-15% of scheduler invocations

---

### 2. Check Frequency Tiers (High Impact)

**Problem**: All checks run at 2-minute intervals regardless of user tier.

**Recommendations**:
- [ ] Implement tier-based intervals:
  - Free tier: 5-minute intervals
  - Paid tier: 2-minute intervals
  - Enterprise: 1-minute intervals
- [ ] Allow user-configurable frequency
- [ ] Add check frequency to billing/usage tracking

**Estimated Savings**: 40-60% of check invocations

---

### 3. Memory/CPU Allocation (Medium Impact)

**Problem**: No explicit `memory` or `timeoutSeconds` configured on scheduler functions.

**Recommendations**:
```typescript
export const checkAllChecks = onSchedule({
  region: "us-central1",
  schedule: `every ${CONFIG.CHECK_INTERVAL_MINUTES} minutes`,
  memory: "512MiB",      // Test with 256MiB if sufficient
  timeoutSeconds: 540,   // 9 minutes max
  minInstances: 0,       // Scale to zero when idle
  maxInstances: 1,       // Prevent concurrent runs
  secrets: [...],
}, async () => {
  await runCheckScheduler("us-central1", { backfillMissing: true });
});
```

**Action Items**:
- [ ] Profile actual memory usage via Cloud Run metrics
- [ ] Test with 256MiB and 512MiB configurations
- [ ] Monitor cold start impact

**Estimated Savings**: 20-40% cost per invocation

---

### 4. Immediate Recheck Amplification (Medium Impact)

**Problem**: Single outage can trigger 4 rapid rechecks (30s apart).

**Current Flow**:
```
Check fails → Recheck in 30s → Recheck in 30s → Recheck in 30s → Alert
```

**Recommendations**:
- [ ] Add per-check daily recheck budget (e.g., max 20/day)
- [ ] Increase `IMMEDIATE_RECHECK_DELAY_MS` from 30s to 60s
- [ ] Make immediate recheck a paid-tier feature
- [ ] Track recheck counts in check document

**Estimated Savings**: 5-10% of check invocations

---

### 5. BigQuery Write Optimization (Medium Impact)

**Problem**: Writing history on every status change + hourly samples.

**Current**: `HISTORY_SAMPLE_INTERVAL_MS: 60 * 60 * 1000` (1 hour)

**Recommendations**:
- [ ] Increase sample interval to 2-4 hours for free users
- [ ] Only write history for paid users
- [ ] Consider batch loads instead of streaming inserts for historical data
- [ ] Implement retention policies (currently 90 days)

**Estimated Savings**: 30-50% of BigQuery costs

---

### 6. Security Check Timing (Low-Medium Impact)

**Problem**: SSL checks run inline with uptime checks (15s timeout).

**Current**:
```typescript
const SECURITY_CHECK_TIMEOUT_MS = 15000; // 15s total
securityChecks = await Promise.race([
  checkSecurityAndExpiry(website.url),
  new Promise((_, reject) => setTimeout(() => reject(...), SECURITY_CHECK_TIMEOUT_MS))
]);
```

**Recommendations**:
- [ ] Move SSL checks to separate background job
- [ ] Run SSL checks only once per day (not on every check)
- [ ] Run SSL checks only on status change
- [ ] Verify 30-day cache is working correctly

**Estimated Savings**: 10-20% reduction in check latency/CPU

---

### 7. Firestore Read Optimization (Low Impact)

**Current**: User settings queries run per-user per-run (already cached).

**Recommendations**:
- [ ] Consider denormalizing alert settings onto check documents
- [ ] Pre-aggregate user settings during check creation/update
- [ ] Evaluate if webhook queries can be optimized with composite indexes

**Note**: Already well-optimized with per-run caching.

---

## Implementation Priority

### Quick Wins (Implement First)

1. **Add explicit memory config** to scheduler functions
   - Test with 256MiB or 512MiB
   - Effort: Low | Impact: Medium

2. **Reduce EU/APAC scheduler frequency**
   - Change to every 5 minutes if check counts are low
   - Effort: Low | Impact: Low-Medium

3. **Cap immediate rechecks**
   - Add `immediateRecheckCount` field with daily reset
   - Effort: Low | Impact: Low-Medium

4. **Profile actual resource usage**
   - Review Cloud Run metrics before/after changes
   - Effort: Low | Impact: Informs other decisions

### Medium-Term

5. **Implement tier-based check frequency**
   - Requires UI changes and user communication
   - Effort: Medium | Impact: High

6. **Move SSL checks to background job**
   - Create `refreshSecurityMetadata` scheduled function
   - Effort: Medium | Impact: Medium

### Long-Term

7. **BigQuery optimization**
   - Batch loads for historical data
   - Tier-based retention policies
   - Effort: High | Impact: Medium

---

## Estimated Savings Summary

| Optimization | Estimated Savings | Effort |
|--------------|-------------------|--------|
| Tier-based check frequency | 40-60% invocations | Medium |
| Explicit memory allocation | 20-40% cost/invocation | Low |
| Reduce idle regional schedulers | 5-15% invocations | Low |
| BigQuery write reduction | 30-50% BQ costs | Low |
| Limit immediate rechecks | 5-10% invocations | Low |
| Background SSL checks | 10-20% check latency | Medium |

---

## Monitoring & Metrics

To track optimization impact, monitor these metrics:

### Cloud Run Metrics
- Invocation count per function
- Memory utilization (peak and average)
- Execution duration (p50, p95, p99)
- Cold start frequency

### Application Metrics
- Checks processed per run (by region)
- No-op write percentage
- Immediate recheck frequency
- BigQuery insert batch sizes

### Cost Metrics
- Cloud Run cost per day/week
- BigQuery storage and query costs
- Firestore read/write operations

---

## Related Files

- `functions/src/checks.ts` - Main scheduler logic
- `functions/src/config.ts` - Configuration constants
- `functions/src/check-utils.ts` - HTTP/TCP/UDP check implementation
- `functions/src/check-events.ts` - Check disabled handling
- `functions/src/status-buffer.ts` - Firestore write buffering
- `functions/src/bigquery.ts` - BigQuery write buffering
- `functions/src/check-region.ts` - Regional assignment logic
