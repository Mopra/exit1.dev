# BigQuery Cost Optimization - January 23, 2026

## The Problem

We discovered that BigQuery had billed us for **137GB of data scans over just 2 days**. The culprits were three functions used by the `/report` page:

- `getCheckStats` - fetches uptime statistics
- `getIncidentIntervals` - fetches downtime periods  
- `getResponseTimeBuckets` - fetches response time data for charts

### Root Causes

1. **No clustering on the table** - The `check_history` table was partitioned by `timestamp` (DAY) but had no clustering. Every query filtered by `website_id` and `user_id`, but without clustering, BigQuery scanned ALL rows within the date range partitions.

2. **Multiple separate queries** - The `getCheckReportMetrics` function called all three functions sequentially, each doing a full table scan. Some functions also ran a separate query to get the "prior row" (the row before the date range for duration calculations).

3. **Inefficient query structure** - The original queries used `UNION ALL ... ORDER BY ... LIMIT 1` which applied the LIMIT to the entire union instead of just the subquery.

## The Solution

### Phase 1: Combined Query

Created `getReportMetricsCombined()` in `bigquery.ts` - a single query that computes all three metrics (stats, incidents, response buckets) in ONE table scan instead of 3-5 separate scans.

**Key changes:**
- Single CTE-based query that shares the base data scan
- Fixed the `UNION ALL` + `LIMIT` issue by using separate CTEs for `range_rows` and `prior_row`
- Returns stats, incidents array, and buckets array in a single response

**File:** `functions/src/bigquery.ts:1616-1782`

### Phase 2: Table Clustering

Created a new clustered table `check_history_new` with:
- **Partitioning:** `DATE(timestamp)` with 90-day expiration
- **Clustering:** `user_id`, `website_id`

Clustering allows BigQuery to skip entire data blocks that don't match the filter criteria, dramatically reducing bytes scanned.

### Phase 3: Migration

1. Created `check_history_new` from `check_history_clustered` data
2. Synced any remaining rows from the original table
3. Updated `TABLE_ID` in code to point to `check_history_new`
4. Deployed all functions
5. Removed the temporary sync job

## Changes Made

### Code Changes

**`functions/src/bigquery.ts`:**
- Changed `TABLE_ID` from `'check_history'` to `'check_history_new'`
- Removed `TABLE_ID_CLUSTERED` constant
- Added `getReportMetricsCombined()` function
- Removed `syncClusteredTable()` function
- Removed `finalizeClusteredTableMigration()` function
- Updated table creation to include clustering for new tables (line 350-353)

**`functions/src/history.ts`:**
- Updated `getCheckReportMetrics` to use `getReportMetricsCombined()` instead of three separate calls
- Removed `syncClusteredBigQueryTable` scheduled function

**`functions/src/index.ts`:**
- Removed `syncClusteredBigQueryTable` export

### BigQuery Tables

| Table | Status | Description |
|-------|--------|-------------|
| `check_history_new` | **ACTIVE** | Clustered table, all traffic |
| `check_history` | Deprecated | Original unclustered table |
| `check_history_clustered` | Deprecated | Intermediate migration table |

## Expected Cost Reduction

| Optimization | Estimated Reduction |
|--------------|---------------------|
| Combined query (1 scan instead of 3-5) | 60-80% |
| Clustering (skips irrelevant blocks) | 50-90% |
| **Total expected savings** | **~90%+** |

From 137GB over 2 days (~$0.68/day at $5/TB) down to potentially ~14GB over 2 days (~$0.07/day).

## Monitoring Checklist

### Immediate (First 24 Hours)

- [ ] **Report page works** - Visit `/report`, select different websites and date ranges, verify data loads correctly
- [ ] **Stats are accurate** - Compare uptime percentages and response times with what you'd expect
- [ ] **Charts render** - Response time charts should display with data points
- [ ] **Incidents show** - If there were any downtime periods, they should appear
- [ ] **New check data appears** - Run a manual check, verify it shows up in history and reports
- [ ] **No function errors** - Check Firebase Console > Functions > Logs for errors

### First Week

- [ ] **Check BigQuery billing** - Go to [GCP Console > BigQuery > Admin > Resource Management](https://console.cloud.google.com/bigquery/admin/resource-management) to monitor bytes scanned
- [ ] **Compare daily scans** - Should see dramatic reduction from previous ~68GB/day
- [ ] **Verify data retention** - Old data (>90 days) should be automatically deleted by partition expiration
- [ ] **Badge API works** - Uptime badges should still render correctly
- [ ] **Status pages work** - Public status pages should show correct uptime data

### How to Check BigQuery Costs

1. **GCP Console Method:**
   - Go to [BigQuery Console](https://console.cloud.google.com/bigquery)
   - Click on "Resource Management" in the left sidebar
   - View "Bytes Scanned" over time

2. **Query Method:**
   ```sql
   SELECT
     DATE(creation_time) as date,
     SUM(total_bytes_billed) / POW(1024, 3) as gb_billed,
     COUNT(*) as query_count
   FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
   WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
     AND statement_type != 'SCRIPT'
   GROUP BY date
   ORDER BY date DESC
   ```

3. **Admin Stats Endpoint:**
   - The `getBigQueryUsage` admin function also reports usage stats

## Cleanup (After Verification)

Once you're confident everything is working (wait at least 2-3 days):

```sql
-- Drop old tables
DROP TABLE `exit1-dev.checks.check_history`;
DROP TABLE `exit1-dev.checks.check_history_clustered`;

-- Optionally rename to cleaner name
ALTER TABLE `exit1-dev.checks.check_history_new` RENAME TO check_history;
```

If you rename the table, update `TABLE_ID` in `functions/src/bigquery.ts` from `'check_history_new'` to `'check_history'` and redeploy.

## Rollback Plan

If something is broken:

### Quick Rollback (Use Old Table)

1. Edit `functions/src/bigquery.ts`
2. Change `TABLE_ID` from `'check_history_new'` to `'check_history'`
3. Deploy: `firebase deploy --only functions`

The old `check_history` table still has all historical data and will continue to work (just without the cost optimizations).

### Full Rollback (Revert Combined Query)

If the combined query itself is causing issues:

1. Revert `getCheckReportMetrics` in `functions/src/history.ts` to call the three separate functions
2. Deploy: `firebase deploy --only functions:getCheckReportMetrics`

## Lessons Learned

1. **Always cluster BigQuery tables** on commonly-filtered columns
2. **Combine related queries** when they scan the same data
3. **Test queries with dry-run** to estimate bytes scanned before deploying
4. **Monitor BigQuery costs** regularly - they can sneak up quickly
5. **BigQuery streaming buffer** prevents table renames for ~90 minutes after last write

## Timeline

- **4:00 PM UTC** - Identified the 137GB billing issue
- **4:15 PM UTC** - Created combined query, deployed initial fix
- **4:20 PM UTC** - Fixed bug in combined query (UNION ALL LIMIT issue)
- **4:30 PM UTC** - Created clustered table `check_history_clustered`
- **4:45 PM UTC** - Deployed sync job to keep tables in sync
- **6:30 PM UTC** - Created final `check_history_new` table
- **6:45 PM UTC** - Updated code to use new table for reads AND writes
- **6:50 PM UTC** - Deployed all functions, removed sync job
- **6:55 PM UTC** - Migration complete
