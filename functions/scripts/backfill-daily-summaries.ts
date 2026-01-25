/**
 * Script to backfill daily summaries for BigQuery cost optimization.
 * 
 * Usage: npx ts-node scripts/backfill-daily-summaries.ts [days]
 * 
 * Examples:
 *   npx ts-node scripts/backfill-daily-summaries.ts        # Backfill last 60 days
 *   npx ts-node scripts/backfill-daily-summaries.ts 30     # Backfill last 30 days
 *   npx ts-node scripts/backfill-daily-summaries.ts 90     # Backfill last 90 days
 */

import { backfillDailySummaries } from '../src/bigquery';

async function main() {
  const daysArg = process.argv[2];
  const days = daysArg ? parseInt(daysArg, 10) : 60;

  if (isNaN(days) || days < 1 || days > 365) {
    console.error('Invalid days argument. Must be between 1 and 365.');
    process.exit(1);
  }

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1); // Yesterday
  endDate.setHours(0, 0, 0, 0);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0, 0, 0, 0);

  console.log(`\n🚀 Starting daily summaries backfill...`);
  console.log(`📅 Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`📊 Days to process: ${days}\n`);

  const startTime = Date.now();

  try {
    const result = await backfillDailySummaries(startDate, endDate);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`\n✅ Backfill completed successfully!`);
    console.log(`   Days processed: ${result.daysProcessed}`);
    console.log(`   Total rows: ${result.totalRows}`);
    console.log(`   Duration: ${duration}s`);
    console.log(`   Average: ${(result.totalRows / result.daysProcessed).toFixed(1)} rows/day\n`);
  } catch (error) {
    console.error('\n❌ Backfill failed:', error);
    process.exit(1);
  }
}

main();
