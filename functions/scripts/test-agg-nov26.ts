import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });

async function test() {
  const dayStart = new Date('2025-11-26T00:00:00.000Z');
  const dayEnd = new Date('2025-11-27T00:00:00.000Z');

  console.log('\n📊 Testing aggregation for Nov 26');
  console.log('Day start:', dayStart.toISOString());
  console.log('Day end:', dayEnd.toISOString());

  // Simple direct insert instead of MERGE
  const query = `
    INSERT INTO \`exit1-dev.checks.check_daily_summaries\`
    (website_id, user_id, day, total_checks, online_checks, offline_checks, issue_count, has_issues, avg_response_time, min_response_time, max_response_time, aggregated_at)
    SELECT
      website_id,
      user_id,
      DATE(timestamp) AS day,
      COUNT(*) AS total_checks,
      COUNTIF(status IN ('online', 'UP', 'REDIRECT')) AS online_checks,
      COUNTIF(status IN ('offline', 'DOWN', 'REACHABLE_WITH_ERROR')) AS offline_checks,
      0 AS issue_count,
      FALSE AS has_issues,
      AVG(IF(response_time > 0, response_time, NULL)) AS avg_response_time,
      MIN(IF(response_time > 0, response_time, NULL)) AS min_response_time,
      MAX(IF(response_time > 0, response_time, NULL)) AS max_response_time,
      CURRENT_TIMESTAMP() AS aggregated_at
    FROM \`exit1-dev.checks.check_history_new\`
    WHERE timestamp >= @dayStart
      AND timestamp < @dayEnd
    GROUP BY website_id, user_id, day
  `;

  try {
    const [job] = await bigquery.createQueryJob({
      query,
      params: { dayStart, dayEnd }
    });
    const [metadata] = await job.getMetadata();
    console.log('Insert completed!');
    console.log('DML affected rows:', metadata.statistics?.query?.numDmlAffectedRows);
    console.log('Inserted rows:', metadata.statistics?.query?.dmlStats?.insertedRowCount);
  } catch (error: any) {
    console.error('Error:', error.message);
    if (error.errors) {
      console.error('Errors:', error.errors);
    }
  }

  // Check what's in the table now
  const checkQuery = `
    SELECT COUNT(*) as count
    FROM \`exit1-dev.checks.check_daily_summaries\`
    WHERE day = DATE('2025-11-26')
  `;
  const [rows] = await bigquery.query({ query: checkQuery });
  console.log('\nRows for Nov 26 after insert:', rows[0].count);
}

test().catch(console.error);
