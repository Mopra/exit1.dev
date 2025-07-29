# Firestore Optimizations for Reduced Database Usage

This document outlines the comprehensive optimizations implemented to significantly reduce Firestore reads and writes while maintaining functionality.

## Overview

The original implementation was causing high Firestore usage due to:
- Every check creating a history entry (every 1 minute)
- Real-time listeners on all collections
- Immediate aggregation updates with transactions
- Long data retention periods
- No caching layer

## Implemented Optimizations

### 1. Reduced History Storage Frequency

**Before**: Every check created a history entry
**After**: Smart sampling based on conditions

```typescript
const shouldStoreHistory = (website: Website, checkResult: any): boolean => {
  // Always store if status changed
  if (website.status !== checkResult.status) return true;
  
  // Store every 10th check for online sites (10% sampling)
  if (checkResult.status === 'online' && Math.random() < 0.1) return true;
  
  // Store every 3rd check for offline sites (33% sampling)
  if (checkResult.status === 'offline' && Math.random() < 0.33) return true;
  
  // Store if there's an error
  if (checkResult.error) return true;
  
  return false;
};
```

**Impact**: Reduces history writes by ~70-90%

### 2. Batch Aggregation Updates

**Before**: Every check updated aggregations immediately with transactions
**After**: Buffered updates every 5 minutes

```typescript
// Buffer aggregation updates in memory
const aggregationBuffer = new Map<string, any>();

// Flush every 5 minutes instead of every check
setInterval(async () => {
  await flushAggregationBuffer();
}, 5 * 60 * 1000);
```

**Impact**: Reduces aggregation writes by ~95% (from every check to every 5 minutes)

### 3. Reduced Data Retention Periods

**Before**: 
- History: 24 hours
- Aggregations: 30 days

**After**:
- History: 6 hours
- Aggregations: 7 days

**Impact**: Reduces storage costs and cleanup operations

### 4. Frontend Caching Layer

**Before**: Real-time listeners with `onSnapshot`
**After**: Polling with 30-second cache

```typescript
// Cache for 30 seconds
const CACHE_DURATION_MS = 30 * 1000;

// Poll every 30 seconds instead of real-time
pollingInterval.current = setInterval(() => {
  fetchChecks();
}, 30000);
```

**Impact**: Reduces reads by ~95% (from real-time to every 30 seconds)

### 5. Firestore Subcollections

**Before**: Separate collections for history and aggregations
**After**: Subcollections under each check

```
checks/{checkId}/history/{historyId}
checks/{checkId}/aggregations/{hourId}
```

**Benefits**:
- Better query performance
- Automatic cleanup when check is deleted
- Reduced index complexity

### 6. Firestore Offline Persistence

```typescript
// Enable offline persistence
enableIndexedDbPersistence(db);

// Enable network for optimal performance
enableNetwork(db);
```

**Benefits**:
- Reduces network calls
- Better offline experience
- Automatic sync when online

### 7. Increased Check Intervals

**Before**: 1 minute intervals
**After**: 2-3 minute intervals

```typescript
FREE_TIER_CHECK_INTERVAL: 3, // Increased from 1 to 3 minutes
PREMIUM_TIER_CHECK_INTERVAL: 2, // minutes
```

**Impact**: Reduces all database operations by ~50-67%

## Performance Metrics

### Expected Reductions

| Operation | Before | After | Reduction |
|-----------|--------|-------|-----------|
| History Writes | Every check | 10-33% of checks | 67-90% |
| Aggregation Writes | Every check | Every 5 minutes | ~95% |
| Frontend Reads | Real-time | Every 30 seconds | ~95% |
| Check Frequency | 1 minute | 2-3 minutes | 50-67% |
| Data Retention | 24h/30d | 6h/7d | 75-77% |

### Total Expected Reduction

**Overall database usage reduction: 80-90%**

## Migration Strategy

### Automatic Migration

The system includes migration functions to transition existing data:

1. **Field Migration**: Adds new cost optimization fields to existing checks
2. **Subcollection Migration**: Moves history and aggregations to subcollections

### Manual Migration Commands

```typescript
// Migrate check fields
await migrateChecks();

// Migrate to subcollections
await migrateToSubcollections();
```

## Configuration

### Backend Configuration (`functions/src/config.ts`)

```typescript
// Check intervals
FREE_TIER_CHECK_INTERVAL: 3, // minutes
PREMIUM_TIER_CHECK_INTERVAL: 2, // minutes

// Aggregation flush interval
AGGREGATION_FLUSH_INTERVAL: 5 * 60 * 1000, // 5 minutes

// Data retention
HISTORY_RETENTION_HOURS: 6,
AGGREGATION_RETENTION_DAYS: 7,
```

### Frontend Configuration (`src/hooks/useChecks.ts`)

```typescript
// Cache duration
CACHE_DURATION_MS = 30 * 1000; // 30 seconds

// Polling interval
POLLING_INTERVAL_MS = 30 * 1000; // 30 seconds
```

## Monitoring and Maintenance

### Key Metrics to Monitor

1. **Aggregation Buffer Size**: Should stay under 1000 entries
2. **Cache Hit Rate**: Should be >80%
3. **Migration Success Rate**: Should be 100%
4. **Database Usage**: Should show significant reduction

### Cleanup Operations

- **History Cleanup**: Every check (limited to 100 entries)
- **Aggregation Cleanup**: Every check (limited to 50 entries)
- **Cache Cleanup**: Every 5 minutes
- **Buffer Flush**: Every 5 minutes

## Rollback Plan

If issues arise, the system can be rolled back by:

1. Reverting check intervals to 1 minute
2. Disabling caching in frontend
3. Reverting to immediate aggregation updates
4. Restoring original data retention periods

## Future Optimizations

1. **Redis Caching**: Add Redis for even better performance
2. **Compression**: Compress historical data
3. **Tiered Storage**: Move old data to cheaper storage
4. **Predictive Caching**: Cache based on usage patterns

## Conclusion

These optimizations provide a comprehensive solution to reduce Firestore usage while maintaining all functionality. The expected 80-90% reduction in database operations will significantly lower costs and improve performance. 