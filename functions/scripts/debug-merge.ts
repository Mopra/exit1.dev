import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });

async function debugMerge() {
  const date = new Date('2026-01-20');
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  console.log('\n📊 Debugging MERGE for', dayStart.toISOString().split('T')[0]);
  console.log('Day start (UTC):', dayStart.toISOString());
  console.log('Day end (UTC):', dayEnd.toISOString());

  // Test just the source subquery
  const sourceQuery = `
    WITH daily_data AS (
      SELECT
        website_id,
        user_id,
        DATE(timestamp) AS day,
        COUNT(*) AS total_checks,
        COUNTIF(status IN ('online', 'UP', 'REDIRECT')) AS online_checks,
        COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) AS offline_checks,
        AVG(IF(response_time > 0, response_time, NULL)) AS avg_response_time,
        MIN(IF(response_time > 0, response_time, NULL)) AS min_response_time,
        MAX(IF(response_time > 0, response_time, NULL)) AS max_response_time
      FROM \`exit1-dev.checks.check_history_new\`
      WHERE timestamp >= @dayStart
        AND timestamp < @dayEnd
      GROUP BY website_id, user_id, day
    )
    SELECT COUNT(*) as total_source_rows, SUM(total_checks) as total_checks_sum
    FROM daily_data
  `;

  console.log('\n1. Testing source subquery...');
  const [sourceRows] = await bigquery.query({
    query: sourceQuery,
    params: { dayStart, dayEnd }
  });
  console.log('Source rows count:', sourceRows[0].total_source_rows);
  console.log('Total checks sum:', sourceRows[0].total_checks_sum);

  // Check what's in the target table
  const targetQuery = `
    SELECT COUNT(*) as count
    FROM \`exit1-dev.checks.check_daily_summaries\`
    WHERE day = DATE(@dayStart)
  `;

  console.log('\n2. Checking target table for this day...');
  const [targetRows] = await bigquery.query({
    query: targetQuery,
    params: { dayStart }
  });
  console.log('Existing rows in target for this day:', targetRows[0].count);

  // Test the full MERGE query
  console.log('\n3. Running MERGE query...');
  const mergeQuery = `
    MERGE INTO \`exit1-dev.checks.check_daily_summaries\` AS target
    USING (
      WITH daily_data AS (
        SELECT
          website_id,
          user_id,
          DATE(timestamp) AS day,
          COUNT(*) AS total_checks,
          COUNTIF(status IN ('online', 'UP', 'REDIRECT')) AS online_checks,
          COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) AS offline_checks,
          AVG(IF(response_time > 0, response_time, NULL)) AS avg_response_time,
          MIN(IF(response_time > 0, response_time, NULL)) AS min_response_time,
          MAX(IF(response_time > 0, response_time, NULL)) AS max_response_time
        FROM \`exit1-dev.checks.check_history_new\`
        WHERE timestamp >= @dayStart
          AND timestamp < @dayEnd
        GROUP BY website_id, user_id, day
      ),
      range_rows AS (
        SELECT website_id, user_id, timestamp, status
        FROM \`exit1-dev.checks.check_history_new\`
        WHERE timestamp >= @dayStart
          AND timestamp < @dayEnd
      ),
      prior_rows AS (
        SELECT website_id, user_id, timestamp, status
        FROM \`exit1-dev.checks.check_history_new\`
        WHERE timestamp < @dayStart
        QUALIFY ROW_NUMBER() OVER (PARTITION BY website_id, user_id ORDER BY timestamp DESC) = 1
      ),
      seeded AS (
        SELECT website_id, user_id, timestamp, status FROM range_rows
        UNION ALL
        SELECT website_id, user_id, @dayStart AS timestamp, status FROM prior_rows
      ),
      ordered AS (
        SELECT
          website_id,
          user_id,
          timestamp,
          CASE WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1 ELSE 0 END AS is_offline,
          LEAD(timestamp) OVER (PARTITION BY website_id, user_id ORDER BY timestamp) AS next_timestamp
        FROM seeded
        WHERE timestamp <= @dayEnd
      ),
      segments AS (
        SELECT
          website_id,
          user_id,
          timestamp AS start_time,
          COALESCE(next_timestamp, @dayEnd) AS end_time,
          is_offline
        FROM ordered
        WHERE timestamp < @dayEnd
      ),
      issue_counts AS (
        SELECT
          website_id,
          user_id,
          COUNTIF(is_offline = 1 AND start_time < @dayEnd AND end_time > @dayStart) AS issue_count
        FROM segments
        GROUP BY website_id, user_id
      )
      SELECT
        daily_data.website_id,
        daily_data.user_id,
        daily_data.day,
        daily_data.total_checks,
        daily_data.online_checks,
        daily_data.offline_checks,
        COALESCE(issue_counts.issue_count, 0) AS issue_count,
        COALESCE(issue_counts.issue_count, 0) > 0 AS has_issues,
        daily_data.avg_response_time,
        daily_data.min_response_time,
        daily_data.max_response_time,
        CURRENT_TIMESTAMP() AS aggregated_at
      FROM daily_data
      LEFT JOIN issue_counts 
        ON daily_data.website_id = issue_counts.website_id 
        AND daily_data.user_id = issue_counts.user_id
    ) AS source
    ON target.website_id = source.website_id 
      AND target.user_id = source.user_id 
      AND target.day = source.day
    WHEN MATCHED THEN
      UPDATE SET
        total_checks = source.total_checks,
        online_checks = source.online_checks,
        offline_checks = source.offline_checks,
        issue_count = source.issue_count,
        has_issues = source.has_issues,
        avg_response_time = source.avg_response_time,
        min_response_time = source.min_response_time,
        max_response_time = source.max_response_time,
        aggregated_at = source.aggregated_at
    WHEN NOT MATCHED THEN
      INSERT (website_id, user_id, day, total_checks, online_checks, offline_checks, 
              issue_count, has_issues, avg_response_time, min_response_time, max_response_time, aggregated_at)
      VALUES (source.website_id, source.user_id, source.day, source.total_checks, source.online_checks, 
              source.offline_checks, source.issue_count, source.has_issues, source.avg_response_time,
              source.min_response_time, source.max_response_time, source.aggregated_at)
  `;

  try {
    const [job] = await bigquery.createQueryJob({
      query: mergeQuery,
      params: { dayStart, dayEnd }
    });
    const [result] = await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    
    console.log('Query results:', result);
    console.log('DML affected rows:', metadata.statistics?.query?.numDmlAffectedRows);
    console.log('Full stats:', JSON.stringify(metadata.statistics?.query, null, 2));
  } catch (error) {
    console.error('MERGE error:', error);
  }

  // Check target again
  console.log('\n4. Checking target table after MERGE...');
  const [targetRowsAfter] = await bigquery.query({
    query: targetQuery,
    params: { dayStart }
  });
  console.log('Rows in target for this day after MERGE:', targetRowsAfter[0].count);
}

debugMerge().catch(console.error);
