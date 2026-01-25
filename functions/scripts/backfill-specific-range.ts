/**
 * Script to backfill daily summaries for a specific date range.
 */

import { backfillDailySummaries } from '../src/bigquery';

async function main() {
  // Data exists from 2025-11-26 to 2026-01-25
  const startDate = new Date('2025-11-26');
  const endDate = new Date('2026-01-24'); // Yesterday

  console.log(`\n🚀 Starting daily summaries backfill...`);
  console.log(`📅 Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  
  const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  console.log(`📊 Days to process: ${daysDiff}\n`);

  const startTime = Date.now();

  try {
    const result = await backfillDailySummaries(startDate, endDate);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`\n✅ Backfill completed successfully!`);
    console.log(`   Days processed: ${result.daysProcessed}`);
    console.log(`   Total rows: ${result.totalRows}`);
    console.log(`   Duration: ${duration}s`);
    if (result.daysProcessed > 0) {
      console.log(`   Average: ${(result.totalRows / result.daysProcessed).toFixed(1)} rows/day\n`);
    }
  } catch (error) {
    console.error('\n❌ Backfill failed:', error);
    process.exit(1);
  }
}

main();
