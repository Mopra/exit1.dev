# BigQuery Clustering Migration

## Status: COMPLETED (January 23, 2026)

## Background

On January 23, 2026, we identified that `getCheckStats`, `getIncidentIntervals`, and `getResponseTimeBuckets` were causing 137GB of BigQuery scans over 2 days due to:

1. **No clustering** on the `check_history` table
2. **Multiple separate queries** scanning the same data

## What Was Done

1. **Created a new clustered table** (`check_history_new`)
   - Partitioned by `DATE(timestamp)`
   - Clustered by `user_id`, `website_id`
   - 90-day partition expiration

2. **Combined the report metrics query** - `getCheckReportMetrics` now uses a single query instead of 3-5 separate scans

3. **Updated all functions** to use `check_history_new` for both reads AND writes

4. **Deployed all functions** on January 23, 2026

## Current State

- **Active table**: `check_history_new` (clustered)
- **Old tables to clean up**:
  - `check_history` - original unclustered table
  - `check_history_clustered` - intermediate migration table

## Cleanup (Optional)

After verifying everything works for a day or two, you can drop the old tables:

```sql
DROP TABLE `exit1-dev.checks.check_history`;
DROP TABLE `exit1-dev.checks.check_history_clustered`;
```

Then optionally rename `check_history_new` to `check_history`:
```sql
ALTER TABLE `exit1-dev.checks.check_history_new` RENAME TO check_history;
```

And update `TABLE_ID` in `functions/src/bigquery.ts` from `'check_history_new'` to `'check_history'`.

## Expected Cost Savings

| Optimization | Reduction |
|--------------|-----------|
| Combined query (1 scan instead of 3-5) | ~60-80% |
| Clustering (skips irrelevant data blocks) | ~50-90% |
| **Total expected savings** | **~90%+** |

## Rollback Plan

If something goes wrong:

1. Update `TABLE_ID` in `functions/src/bigquery.ts` back to `'check_history'`
2. Redeploy functions: `firebase deploy --only functions`

The old `check_history` table still exists with all historical data.
