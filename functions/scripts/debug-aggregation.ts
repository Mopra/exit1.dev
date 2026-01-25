import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });

async function debugAggregation() {
  // Check data for Jan 20, 2026
  const dayStart = new Date('2026-01-20T00:00:00Z');
  const dayEnd = new Date('2026-01-21T00:00:00Z');

  console.log('\n📊 Debugging aggregation for', dayStart.toISOString().split('T')[0]);
  console.log('Day start:', dayStart.toISOString());
  console.log('Day end:', dayEnd.toISOString());

  // Query 1: Count raw records for this day
  const countQuery = `
    SELECT COUNT(*) as count
    FROM \`exit1-dev.checks.check_history_new\`
    WHERE timestamp >= @dayStart
      AND timestamp < @dayEnd
  `;

  const [countRows] = await bigquery.query({ 
    query: countQuery, 
    params: { dayStart, dayEnd } 
  });
  console.log('\nRaw records for this day:', countRows[0].count);

  // Query 2: Check distinct websites/users
  const distinctQuery = `
    SELECT 
      COUNT(DISTINCT website_id) as websites,
      COUNT(DISTINCT user_id) as users
    FROM \`exit1-dev.checks.check_history_new\`
    WHERE timestamp >= @dayStart
      AND timestamp < @dayEnd
  `;

  const [distinctRows] = await bigquery.query({ 
    query: distinctQuery, 
    params: { dayStart, dayEnd } 
  });
  console.log('Distinct websites:', distinctRows[0].websites);
  console.log('Distinct users:', distinctRows[0].users);

  // Query 3: Sample of data
  const sampleQuery = `
    SELECT website_id, user_id, status, timestamp
    FROM \`exit1-dev.checks.check_history_new\`
    WHERE timestamp >= @dayStart
      AND timestamp < @dayEnd
    LIMIT 5
  `;

  const [sampleRows] = await bigquery.query({ 
    query: sampleQuery, 
    params: { dayStart, dayEnd } 
  });
  console.log('\nSample records:');
  sampleRows.forEach((row: any) => {
    console.log(`  ${row.website_id} | ${row.user_id} | ${row.status} | ${row.timestamp.value}`);
  });

  // Query 4: Check the daily_data CTE result
  const dailyDataQuery = `
    SELECT
      website_id,
      user_id,
      DATE(timestamp) AS day,
      COUNT(*) AS total_checks
    FROM \`exit1-dev.checks.check_history_new\`
    WHERE timestamp >= @dayStart
      AND timestamp < @dayEnd
    GROUP BY website_id, user_id, day
    LIMIT 10
  `;

  const [dailyDataRows] = await bigquery.query({ 
    query: dailyDataQuery, 
    params: { dayStart, dayEnd } 
  });
  console.log('\nDaily data aggregation result:');
  dailyDataRows.forEach((row: any) => {
    const day = row.day?.value || row.day;
    console.log(`  ${row.website_id} | ${row.user_id} | ${day} | ${row.total_checks} checks`);
  });
}

debugAggregation().catch(console.error);
