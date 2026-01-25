import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });

async function check() {
  const query = `
    SELECT DATE(timestamp) as day, COUNT(*) as count 
    FROM \`exit1-dev.checks.check_history_new\`
    WHERE timestamp >= TIMESTAMP('2025-11-26')
      AND timestamp < TIMESTAMP('2026-01-10')
    GROUP BY day
    ORDER BY day
  `;
  const [rows] = await bigquery.query({ query });
  console.log('\n📊 Check history data by day (Nov 26 - Jan 9):');
  rows.forEach((row: any) => console.log(`  ${row.day?.value || row.day}: ${row.count} checks`));
}

check().catch(console.error);
