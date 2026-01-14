import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { BigQuery } from '@google-cloud/bigquery';

const app = initializeApp({
  projectId: 'exit1-dev',
});

const firestore = getFirestore(app);
const bigquery = new BigQuery({ projectId: 'exit1-dev' });
const checkId = 'IzBXlAKtSdZtvoxpH4Em';

async function checkStats() {
  console.log(`\n=== Checking Report Stats for: ${checkId} ===\n`);

  try {
    // Get check document
    const checkDoc = await firestore.collection('checks').doc(checkId).get();
    if (!checkDoc.exists) {
      console.error('❌ Check not found!');
      return;
    }

    const check = checkDoc.data();
    const now = Date.now();
    
    // Check different time ranges that Reports page might use
    const timeRanges = [
      { name: '24h', days: 1 },
      { name: '7d', days: 7 },
      { name: '30d', days: 30 },
    ];

    for (const range of timeRanges) {
      const startDate = now - (range.days * 24 * 60 * 60 * 1000);
      console.log(`\n=== ${range.name} Time Range ===`);
      console.log(`Start: ${new Date(startDate).toISOString()}`);
      console.log(`End: ${new Date(now).toISOString()}`);

      // Query getCheckStats (same as Reports page uses)
      const statsQuery = `
        WITH range_rows AS (
          SELECT timestamp, status, response_time
          FROM \`exit1-dev.checks.check_history\`
          WHERE website_id = @websiteId
            AND user_id = @userId
            AND timestamp >= @startDate
            AND timestamp <= @endDate
        ),
        prior_row AS (
          SELECT timestamp, status
          FROM \`exit1-dev.checks.check_history\`
          WHERE website_id = @websiteId
            AND user_id = @userId
            AND timestamp < @startDate
          ORDER BY timestamp DESC
          LIMIT 1
        ),
        seeded AS (
          SELECT timestamp, status FROM range_rows
          UNION ALL
          SELECT @startDate AS timestamp, status FROM prior_row
        ),
        ordered AS (
          SELECT
            timestamp,
            CASE
              WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
              ELSE 0
            END AS is_offline,
            LEAD(timestamp) OVER (ORDER BY timestamp) AS next_timestamp
          FROM seeded
          WHERE timestamp <= @endDate
        ),
        durations AS (
          SELECT
            is_offline,
            GREATEST(0, UNIX_MILLIS(COALESCE(next_timestamp, @endDate)) - UNIX_MILLIS(timestamp)) AS duration_ms
          FROM ordered
          WHERE timestamp < @endDate
        ),
        agg_durations AS (
          SELECT
            SUM(duration_ms) AS totalDurationMs,
            SUM(IF(is_offline = 0, duration_ms, 0)) AS onlineDurationMs,
            SUM(IF(is_offline = 1, duration_ms, 0)) AS offlineDurationMs
          FROM durations
        )
        SELECT * FROM agg_durations
      `;

      const [statsRows] = await bigquery.query({
        query: statsQuery,
        params: {
          websiteId: checkId,
          userId: check.userId,
          startDate: new Date(startDate),
          endDate: new Date(now)
        }
      });

      const stats = statsRows[0];
      const offlineDurationMs = Number(stats.offlineDurationMs) || 0;
      const offlineDurationDays = offlineDurationMs / (24 * 60 * 60 * 1000);
      const offlineDurationHours = offlineDurationMs / (60 * 60 * 1000);

      console.log(`\nStats from getCheckStats:`);
      console.log(`  Total Duration: ${(Number(stats.totalDurationMs) / (24 * 60 * 60 * 1000)).toFixed(2)} days`);
      console.log(`  Online Duration: ${(Number(stats.onlineDurationMs) / (24 * 60 * 60 * 1000)).toFixed(2)} days`);
      console.log(`  Offline Duration: ${offlineDurationDays.toFixed(2)} days (${offlineDurationHours.toFixed(2)} hours)`);
      console.log(`  Formatted: ${Math.floor(offlineDurationDays)}d ${Math.floor((offlineDurationMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))}h`);

      // Also check incidents
      const incidentQuery = `
        WITH range_rows AS (
          SELECT timestamp, status
          FROM \`exit1-dev.checks.check_history\`
          WHERE website_id = @websiteId
            AND user_id = @userId
            AND timestamp >= @startDate
            AND timestamp <= @endDate
        ),
        prior_row AS (
          SELECT timestamp, status
          FROM \`exit1-dev.checks.check_history\`
          WHERE website_id = @websiteId
            AND user_id = @userId
            AND timestamp < @startDate
          ORDER BY timestamp DESC
          LIMIT 1
        ),
        seeded AS (
          SELECT timestamp, status FROM range_rows
          UNION ALL
          SELECT @startDate AS timestamp, status FROM prior_row
        ),
        base AS (
          SELECT
            timestamp,
            CASE
              WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
              ELSE 0
            END AS is_offline,
            LAG(
              CASE
                WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
                ELSE 0
              END
            ) OVER (ORDER BY timestamp) AS prev_is_offline
          FROM seeded
          WHERE timestamp <= @endDate
        ),
        segmented AS (
          SELECT
            timestamp,
            is_offline,
            SUM(
              CASE
                WHEN prev_is_offline IS NULL OR is_offline != prev_is_offline THEN 1
                ELSE 0
              END
            ) OVER (ORDER BY timestamp) AS segment_id
          FROM base
        ),
        segments AS (
          SELECT
            segment_id,
            is_offline,
            MIN(timestamp) AS start_time
          FROM segmented
          GROUP BY segment_id, is_offline
        ),
        all_segments AS (
          SELECT
            segment_id,
            is_offline,
            start_time,
            LEAD(start_time) OVER (ORDER BY start_time) AS next_start_time
          FROM segments
        )
        SELECT
          UNIX_MILLIS(start_time) AS started_at_ms,
          UNIX_MILLIS(COALESCE(next_start_time, @endDate)) AS ended_at_ms
        FROM all_segments
        WHERE is_offline = 1
        ORDER BY started_at_ms ASC
      `;

      const [incidentRows] = await bigquery.query({
        query: incidentQuery,
        params: {
          websiteId: checkId,
          userId: check.userId,
          startDate: new Date(startDate),
          endDate: new Date(now)
        }
      });

      let totalIncidentDuration = 0;
      incidentRows.forEach((incident) => {
        const duration = Number(incident.ended_at_ms) - Number(incident.started_at_ms);
        totalIncidentDuration += duration;
      });

      const incidentDurationDays = totalIncidentDuration / (24 * 60 * 60 * 1000);
      console.log(`\nIncidents from getIncidentIntervals:`);
      console.log(`  Number of incidents: ${incidentRows.length}`);
      console.log(`  Total incident duration: ${incidentDurationDays.toFixed(2)} days (${(totalIncidentDuration / (60 * 60 * 1000)).toFixed(2)} hours)`);
      console.log(`  Formatted: ${Math.floor(incidentDurationDays)}d ${Math.floor((totalIncidentDuration % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))}h`);

      // Check prior_row status
      const priorRowQuery = `
        SELECT timestamp, status
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @websiteId
          AND user_id = @userId
          AND timestamp < @startDate
        ORDER BY timestamp DESC
        LIMIT 1
      `;

      const [priorRows] = await bigquery.query({
        query: priorRowQuery,
        params: {
          websiteId: checkId,
          userId: check.userId,
          startDate: new Date(startDate)
        }
      });

      if (priorRows.length > 0) {
        const priorRow = priorRows[0];
        const priorTimestamp = new Date(priorRow.timestamp.value || priorRow.timestamp);
        console.log(`\nPrior row (before query window):`);
        console.log(`  Timestamp: ${priorTimestamp.toISOString()}`);
        console.log(`  Status: ${priorRow.status}`);
        console.log(`  Time before window: ${((startDate - priorTimestamp.getTime()) / (24 * 60 * 60 * 1000)).toFixed(2)} days`);
      }
    }

    console.log('\n=== Complete ===\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.errors) {
      error.errors.forEach(err => console.error('  ', err.message));
    }
    throw error;
  }
}

checkStats().catch(console.error);
