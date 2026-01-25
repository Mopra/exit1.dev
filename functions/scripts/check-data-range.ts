import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });

async function checkDataRange() {
  const query = `
    SELECT 
      MIN(timestamp) as earliest,
      MAX(timestamp) as latest,
      COUNT(*) as total_rows
    FROM \`exit1-dev.checks.check_history_new\`
  `;
  
  const [rows] = await bigquery.query({ query });
  console.log('\nData in check_history_new:');
  console.log('  Earliest:', rows[0].earliest);
  console.log('  Latest:', rows[0].latest);
  console.log('  Total rows:', rows[0].total_rows);
}

checkDataRange().catch(console.error);
