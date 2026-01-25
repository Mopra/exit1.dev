import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({ projectId: 'exit1-dev' });

async function check() {
  const query = 'SELECT COUNT(*) as count FROM `exit1-dev.checks.check_daily_summaries`';
  const [rows] = await bigquery.query({ query });
  console.log('\n📊 Daily Summaries Table Stats:');
  console.log('Total rows:', rows[0].count);
  
  const query2 = 'SELECT MIN(day) as min_day, MAX(day) as max_day FROM `exit1-dev.checks.check_daily_summaries`';
  const [rows2] = await bigquery.query({ query: query2 });
  const minDay = rows2[0].min_day?.value || rows2[0].min_day;
  const maxDay = rows2[0].max_day?.value || rows2[0].max_day;
  console.log('Date range:', minDay, 'to', maxDay);
  
  const query3 = 'SELECT COUNT(DISTINCT day) as days FROM `exit1-dev.checks.check_daily_summaries`';
  const [rows3] = await bigquery.query({ query: query3 });
  console.log('Distinct days:', rows3[0].days);
  
  const query4 = 'SELECT COUNT(DISTINCT website_id) as websites, COUNT(DISTINCT user_id) as users FROM `exit1-dev.checks.check_daily_summaries`';
  const [rows4] = await bigquery.query({ query: query4 });
  console.log('Distinct websites:', rows4[0].websites);
  console.log('Distinct users:', rows4[0].users);
}

check().catch(console.error);
