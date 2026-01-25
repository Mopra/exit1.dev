import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });

async function check() {
  const table = bigquery.dataset('checks').table('check_daily_summaries');
  const [metadata] = await table.getMetadata();
  
  console.log('\n📋 Daily Summaries Table Schema:');
  console.log(JSON.stringify(metadata.schema.fields, null, 2));
  
  console.log('\nTime Partitioning:', metadata.timePartitioning);
  console.log('Clustering:', metadata.clustering);
}

check().catch(console.error);
