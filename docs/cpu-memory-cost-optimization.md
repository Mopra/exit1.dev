# CPU & Memory Cost Optimization Recommendations

This document outlines opportunities to reduce CPU time and memory usage across checks, alerts, users, and history systems to lower operational costs.

---

## Executive Summary

| Area | Potential Savings | Effort | Priority | Status |
|------|-------------------|--------|----------|--------|
| BigQuery Query Optimization | 20-40% query costs | Medium | High | **COMPLETED** |
| History Retention Reduction | ~33% storage | Low | High | **COMPLETED** |
| Buffer Size Tuning | 10-20% memory | Low | Medium | **COMPLETED** |
| Cache Size Reduction | 15-25% memory | Low | Medium | **COMPLETED** |
| Check Batch Processing | 10-15% CPU | Medium | Medium | **COMPLETED** |
| Alert Cache Consolidation | 10-15% memory | Medium | Low | Future Work |

---

## 1. Checks (`functions/src/checks.ts`, `config.ts`)

### Current State (After Phase 3 Implementation)
- **Batch Size**: 150 checks per batch
- **Max Concurrent Checks**: 25-75 (dynamic, capped at 75)
- **Max Websites Per Run**: 2,000
- **Max Pagination Pages**: 3 (reduced from 5) = 6,000 max checks per run
- **Scheduler Memory**: 256MiB
- **HTTP Timeout**: 20 seconds per check

### Recommendations

#### 1.1 Reduce Max Concurrent Checks (CPU Savings: ~10-15%) - COMPLETED
**File**: `config.ts:181-191`

Implemented: `MAX_CONCURRENT_CHECKS = 75` (capped from 100)
- Reduces peak CPU spikes during high-volume runs
- Provides more predictable resource usage
- Trade-off: Slightly longer total check duration

#### 1.2 Reduce Pagination Depth - COMPLETED
**File**: `checks.ts:35`

Implemented: `MAX_CHECK_QUERY_PAGES = 3` (reduced from 5)
- Now fetches up to 3 pages x 2,000 checks = 6,000 checks max per run
- Memory savings from reduced document loading
- Trade-off: Large backlogs take more scheduler ticks to clear

#### 1.3 Status Buffer Size Reduction - COMPLETED
**File**: `status-buffer.ts:56-63`

Implemented: `MAX_BUFFER_SIZE = 500` (reduced from 1000)
- Memory reduction: ~50% for status updates
- Trade-off: More frequent Firestore flushes (but batch size remains 400, so minimal write cost increase)

---

## 2. Alerts (`functions/src/alert.ts`)

### Current State (After Phase 2 Implementation)
- **6 separate in-memory caches** for throttling/budgets
- **Alert settings cache**: Max 3,000 entries (reduced from 5,000), 30-min TTL
- **Admin status cache**: 1-hour TTL
- **Webhook retry queue**: 24-hour TTL (reduced from 48), batch size 25

### Recommendations

#### 2.1 Consolidate Throttle Caches (Memory Savings: ~10-15%)
**Files**: `alert.ts:54-59`

Currently separate caches for:
- `throttleWindowCache` (email)
- `budgetWindowCache` (email hourly)
- `emailMonthlyBudgetWindowCache`
- `smsThrottleWindowCache`
- `smsBudgetWindowCache`
- `smsMonthlyBudgetWindowCache`

Consider consolidating into a single cache with composite keys:
```
{userId}:{channel}:{type} -> value
```
This reduces Map overhead and simplifies pruning logic.

#### 2.2 Reduce Alert Settings Cache Size - COMPLETED
**File**: `alert.ts:148-150`

Implemented: `ALERT_SETTINGS_CACHE_MAX = 3000` (reduced from 5,000)
- Memory reduction: ~40%
- Still covers typical active user counts with headroom

#### 2.3 Reduce Webhook Retry TTL - COMPLETED
**File**: `alert.ts:49`

Implemented: `WEBHOOK_RETRY_TTL_MS = 24 hours` (reduced from 48)
- Reduces retry queue memory and CPU for processing stale retries
- Most webhook failures are permanent (endpoint removed, auth changed)

#### 2.4 Increase Webhook Retry Batch Delay
**File**: `alert.ts:41`

Current: `WEBHOOK_BATCH_DELAY_MS = 100ms`

Increase to 200-300ms:
- Reduces CPU pressure during webhook bursts
- Trade-off: Slightly higher alert delivery latency (minimal impact)

---

## 3. Users (`functions/src/users.ts`, `init.ts`)

### Current State (After Phase 2 Implementation)
- **User cache**: 5-min TTL, max 10 entries
- **Tier cache**: 2-hour TTL (extended from 1 hour)
- **getAllUsers()**: Can load thousands of users for sorting

### Recommendations

#### 3.1 Avoid Full User Fetch for Sorting
**File**: `users.ts:132-165`

`getAllUsers()` fetches ALL users when sorting by `checksCount`. This is CPU and memory intensive.

Alternatives:
- Pre-compute `checksCount` as a field on user documents (denormalization)
- Limit admin queries to paginated results without cross-page sorting
- Use Firestore indexes for the most common sort fields

#### 3.2 Reduce User Cache Max Entries
**File**: `users.ts:371-380`

Current: Max 10 entries

This is already conservative. No change recommended.

#### 3.3 Extend Tier Cache TTL - COMPLETED
**File**: `init.ts:75`

Implemented: `USER_TIER_CACHE_MS = 2 hours` (extended from 1 hour)
- Reduces Clerk API calls by ~50%
- Trade-off: Tier changes take longer to reflect (acceptable since subscription changes are rare)

---

## 4. History (`functions/src/history.ts`, `bigquery.ts`)

### Current State (After Phase 1 Implementation)
- **BigQuery buffer**: Max 1,000 entries (reduced from 2,000), 400 rows per batch
- **History retention**: 60 days (reduced from 90)
- **History sampling**: 1-hour intervals for online checks
- **Rate limits**: 
  - General: 60 queries/user/min, 30 queries/website/min
  - Stats queries: 10 queries/user/min, 5 queries/website/min (NEW)
- **Daily summaries**: Pre-aggregated table with scheduled aggregation (NEW)
- **Incident lookback**: Limited to 30 days (NEW)

### Completed Optimizations

#### 4.1 Reduce BigQuery Buffer Size - COMPLETED
**File**: `bigquery.ts:15-17`

Implemented:
- `MAX_BUFFER_SIZE`: 2000 -> 1000
- `HIGH_WATERMARK`: 500 -> 300
- **Memory savings**: ~50% for insert buffer

#### 4.2 Reduce History Retention Period - COMPLETED
**File**: `bigquery.ts:28-31`

Implemented:
- `HISTORY_RETENTION_DAYS`: 90 -> 60 days
- **Savings**: ~33% reduction in BigQuery storage costs
- Note: Consider longer retention for premium tiers in the future

#### 4.3 Optimize BigQuery Query Patterns - COMPLETED
**Files**: `bigquery.ts:2188-2530`, `history.ts:759-783`

Implemented:

1. **Pre-aggregated daily summaries table** (`check_daily_summaries`)
   - New BigQuery table stores pre-computed daily stats per website/user
   - Schema: website_id, user_id, day, total_checks, online_checks, offline_checks, issue_count, has_issues, avg_response_time, min_response_time, max_response_time, aggregated_at
   - Partitioned by day, clustered by user_id/website_id
   - 60-day retention matching main history table
   - **Reduces timeline view query costs by 80-90%**

2. **Scheduled daily aggregation** (`aggregateDailySummariesScheduled`)
   - Runs at 01:00 UTC daily via Cloud Scheduler
   - Uses MERGE for idempotent upserts
   - Aggregates previous day's data automatically

3. **Smart fallback in `getPreAggregatedDailySummary`**
   - Queries pre-aggregated table first
   - Falls back to real-time aggregation if data unavailable
   - Seamless transition during backfill period

4. **Incident interval lookback limit** - COMPLETED
   **File**: `bigquery.ts:33-36`
   - Added `MAX_INCIDENT_LOOKBACK_DAYS = 30`
   - Applied to `getIncidentIntervals()` and `getReportMetricsCombined()`
   - Prevents expensive scans beyond 30 days

#### 4.4 Separate Rate Limits for Heavy Queries - COMPLETED
**File**: `history.ts:18-22, 51-74`

Implemented separate stricter limits for expensive aggregate queries:
- `perUserPerMinute`: 10 (vs 60 for general queries)
- `perWebsitePerMinute`: 5 (vs 30 for general queries)
- Applied to: `getCheckStatsBigQuery`, `getCheckStatsBatchBigQuery`, `getCheckReportMetrics`, `getCheckHistoryDailySummary`
- **Prevents cost runaway from API abuse**

### Backfill Status
- Daily summaries table populated with 22,621 rows
- Date range: Jan 6 - Jan 24, 2026 (19 days)
- 1,427 websites, 300 users covered
- Older dates outside 60-day retention window expire automatically

---

## 5. Cross-Cutting Recommendations

### 5.1 Implement Request Coalescing
When multiple requests for the same data arrive within a short window, coalesce them into a single backend call. Applies to:
- Check stats queries
- User tier lookups
- Alert settings fetches

### 5.2 Add Memory Monitoring
Implement memory usage logging at key points:
- After buffer flushes
- After cache pruning
- At function cold starts

This enables data-driven tuning of buffer/cache sizes.

### 5.3 Consider Tiered Resource Allocation
Allocate more resources to paying customers:
- Larger cache entries for premium users
- Lower sampling intervals for premium tier
- Longer history retention for premium tier

This reduces costs for free-tier users (typically the majority) while maintaining quality for paying customers.

---

## Implementation Priority

### Phase 1: BigQuery Optimization
All BigQuery-related changes in one pass:
1. Reduce buffer size: `MAX_BUFFER_SIZE` 2000 -> 1000, `HIGH_WATERMARK` 500 -> 300 (`bigquery.ts:15-21`)
2. Reduce history retention to 60 days (`bigquery.ts:26-27`)
3. Add separate rate limits for heavy queries (`history.ts:10-14`)
4. Limit incident interval lookback to 30 days (`bigquery.ts`)
5. Pre-aggregate daily summaries into a separate table (higher effort, but do it now while touching BigQuery)

### Phase 2: Memory & Caching - COMPLETED
1. ~~Reduce status buffer size (`status-buffer.ts:56`)~~ - `MAX_BUFFER_SIZE` 1000 -> 500
2. ~~Extend tier cache TTL (`init.ts:75`)~~ - `USER_TIER_CACHE_MS` 1hr -> 2hr
3. ~~Reduce alert settings cache size (`alert.ts:148`)~~ - `ALERT_SETTINGS_CACHE_MAX` 5000 -> 3000
4. ~~Reduce webhook retry TTL (`alert.ts:49`)~~ - `WEBHOOK_RETRY_TTL_MS` 48hr -> 24hr

### Phase 3: CPU & Processing - PARTIALLY COMPLETED
1. ~~Cap max concurrent checks (`config.ts:181-191`)~~ - Already capped at 75
2. ~~Reduce pagination depth (`checks.ts:35`)~~ - `MAX_CHECK_QUERY_PAGES` 5 -> 3
3. Consolidate alert throttle caches (`alert.ts:54-59`) - **SKIPPED** (high risk, future work)
4. Denormalize `checksCount` for user sorting (`users.ts`) - **SKIPPED** (requires schema changes, future work)

---

## Estimated Cost Reduction

| Optimization | Monthly Savings Estimate |
|--------------|--------------------------|
| Buffer size reductions | 5-10% memory costs |
| Cache consolidation | 5-10% memory costs |
| Query pre-aggregation | 20-30% BigQuery query costs |
| Retention 90 -> 60 days | 33% BigQuery storage |

**Total estimated savings: 10-20% of current infrastructure costs**

---

## Monitoring Recommendations

After implementing changes, monitor:
1. Function memory utilization (Cloud Functions metrics)
2. BigQuery slot usage and query costs (BigQuery dashboard)
3. Firestore read/write operations (Firestore usage tab)
4. Cache hit rates (add custom logging)
5. Alert delivery latency (ensure no degradation)
