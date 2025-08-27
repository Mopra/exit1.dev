# Firestore History Cleanup

## Overview
This document outlines the cleanup of Firestore history subcollections that was performed to optimize the data storage architecture.

## Problem
The application was storing check history data in two places:
1. **Firestore subcollections**: `checks/{websiteId}/history` - for real-time access
2. **BigQuery**: `checks.check_history` table - for historical analysis

This dual storage approach was:
- **Costly**: Firestore subcollections are expensive for large datasets
- **Redundant**: Same data stored in two places
- **Complex**: Maintaining consistency between two data sources

## Solution
Migrated to **BigQuery-only** storage for all check history data:

### Changes Made

#### 1. Backend Functions (`functions/src/index.ts`)
- **Removed Firestore subcollection storage** from `storeCheckHistory()` function
- **Updated `getCheckHistory()`** to use BigQuery instead of Firestore
- **Updated `getCheckHistoryPaginated()`** to use BigQuery instead of Firestore
- **Added `cleanupFirestoreHistory()`** function to remove existing subcollections

#### 2. Frontend Updates (`src/pages/SuccessfulChecks.tsx`)
- **Updated to use `getCheckHistoryBigQuery()`** instead of `getCheckHistory()`
- **Improved filtering** by using BigQuery's built-in filtering capabilities

#### 3. Cleanup Function
- **Created `cleanupFirestoreHistory`** Cloud Function to remove all existing history subcollections
- **Batch deletion** for efficient cleanup
- **User-scoped** - only cleans up data for the authenticated user

## Benefits

### Cost Reduction
- **Eliminated Firestore subcollection costs** for history data
- **BigQuery is more cost-effective** for large historical datasets
- **Reduced read/write operations** on Firestore

### Performance
- **Better query performance** for historical data analysis
- **Improved scalability** for large datasets
- **Reduced Firestore document count**

### Simplicity
- **Single source of truth** for history data
- **Simplified data architecture**
- **Easier maintenance**

## Data Migration
All existing check history data is preserved in BigQuery. The cleanup only removes the redundant Firestore subcollections.

## Usage

### Running the Cleanup
```bash
# Deploy the functions first
cd functions
firebase deploy --only functions

# Run the cleanup script
cd ../scripts
node cleanup-firestore-history.js
```

### API Changes
- **`getCheckHistory()`** now uses BigQuery (backward compatible)
- **`getCheckHistoryPaginated()`** now uses BigQuery (backward compatible)
- **`getCheckHistoryBigQuery()`** remains the same (recommended for new code)

## Monitoring
- Check Firebase Functions logs for cleanup progress
- Monitor BigQuery usage and costs
- Verify data integrity after cleanup

## Future Considerations
- Consider implementing data retention policies in BigQuery
- Monitor BigQuery query performance and optimize as needed
- Consider partitioning BigQuery tables for better performance
