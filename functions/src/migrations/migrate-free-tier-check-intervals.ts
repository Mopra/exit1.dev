/**
 * Migration Script: Update free-tier check intervals to minimum 5 minutes
 *
 * This script finds all free-tier checks with checkFrequency < 5 minutes
 * and updates them to 5 minutes to enforce the new tier-based limits.
 *
 * Usage:
 *   npx ts-node src/migrations/migrate-free-tier-check-intervals.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Preview changes without making updates (default: true)
 *   --execute    Actually perform the migration
 */

import * as admin from 'firebase-admin';

// Initialize Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS or default credentials)
if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

// Configuration - must match functions/src/config.ts
const MIN_CHECK_INTERVAL_MINUTES_FREE = 5;

interface MigrationResult {
  totalChecksScanned: number;
  checksNeedingUpdate: number;
  checksUpdated: number;
  errors: string[];
}

async function migrateFreeTierCheckIntervals(dryRun: boolean): Promise<MigrationResult> {
  const result: MigrationResult = {
    totalChecksScanned: 0,
    checksNeedingUpdate: 0,
    checksUpdated: 0,
    errors: [],
  };

  console.log('='.repeat(60));
  console.log('Migration: Free-tier check interval enforcement');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE (changes will be applied)'}`);
  console.log(`Target: checkFrequency < ${MIN_CHECK_INTERVAL_MINUTES_FREE} → ${MIN_CHECK_INTERVAL_MINUTES_FREE}`);
  console.log('='.repeat(60));
  console.log('');

  try {
    // Query all free-tier checks with checkFrequency < minimum
    // Note: Firestore requires an index for this compound query
    // If index doesn't exist, we'll fall back to filtering in memory
    let checksToUpdate: admin.firestore.QueryDocumentSnapshot[] = [];

    try {
      // Try compound query first (requires index)
      const snapshot = await firestore
        .collection('checks')
        .where('userTier', '==', 'free')
        .where('checkFrequency', '<', MIN_CHECK_INTERVAL_MINUTES_FREE)
        .get();

      checksToUpdate = snapshot.docs;
      console.log(`Found ${checksToUpdate.length} free-tier checks needing update (indexed query)`);
    } catch (indexError) {
      // Fall back to querying all free-tier checks and filtering
      console.log('Compound index not available, falling back to manual filtering...');

      const allFreeChecks = await firestore
        .collection('checks')
        .where('userTier', '==', 'free')
        .get();

      result.totalChecksScanned = allFreeChecks.size;

      checksToUpdate = allFreeChecks.docs.filter(doc => {
        const data = doc.data();
        const frequency = data.checkFrequency ?? 60; // Default was 60 minutes
        return frequency < MIN_CHECK_INTERVAL_MINUTES_FREE;
      });

      console.log(`Scanned ${result.totalChecksScanned} free-tier checks`);
      console.log(`Found ${checksToUpdate.length} checks needing update`);
    }

    result.checksNeedingUpdate = checksToUpdate.length;

    if (checksToUpdate.length === 0) {
      console.log('\nNo checks need updating. Migration complete.');
      return result;
    }

    // Group by current frequency for reporting
    const frequencyDistribution: Record<number, number> = {};
    for (const doc of checksToUpdate) {
      const freq = doc.data().checkFrequency ?? 60;
      frequencyDistribution[freq] = (frequencyDistribution[freq] || 0) + 1;
    }

    console.log('\nCurrent frequency distribution of affected checks:');
    for (const [freq, count] of Object.entries(frequencyDistribution).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  ${freq} min: ${count} checks`);
    }
    console.log('');

    if (dryRun) {
      console.log('DRY RUN - No changes made. Run with --execute to apply changes.');
      console.log('\nSample of checks that would be updated:');
      for (const doc of checksToUpdate.slice(0, 10)) {
        const data = doc.data();
        console.log(`  - ${doc.id}: "${data.name}" (${data.url}) - ${data.checkFrequency} min → ${MIN_CHECK_INTERVAL_MINUTES_FREE} min`);
      }
      if (checksToUpdate.length > 10) {
        console.log(`  ... and ${checksToUpdate.length - 10} more`);
      }
      return result;
    }

    // Execute updates in batches of 500 (Firestore batch limit)
    const BATCH_SIZE = 500;
    const batches: admin.firestore.WriteBatch[] = [];
    let currentBatch = firestore.batch();
    let operationsInCurrentBatch = 0;

    console.log(`Updating ${checksToUpdate.length} checks in batches of ${BATCH_SIZE}...`);

    for (const doc of checksToUpdate) {
      currentBatch.update(doc.ref, {
        checkFrequency: MIN_CHECK_INTERVAL_MINUTES_FREE,
        updatedAt: Date.now(),
        // Add a field to track this migration
        _migratedCheckInterval: {
          previousValue: doc.data().checkFrequency,
          migratedAt: Date.now(),
          reason: 'free-tier-minimum-enforcement',
        },
      });

      operationsInCurrentBatch++;

      if (operationsInCurrentBatch >= BATCH_SIZE) {
        batches.push(currentBatch);
        currentBatch = firestore.batch();
        operationsInCurrentBatch = 0;
      }
    }

    // Don't forget the last batch
    if (operationsInCurrentBatch > 0) {
      batches.push(currentBatch);
    }

    // Commit all batches
    console.log(`Committing ${batches.length} batch(es)...`);

    for (let i = 0; i < batches.length; i++) {
      try {
        await batches[i].commit();
        const checksInBatch = i === batches.length - 1
          ? checksToUpdate.length - (i * BATCH_SIZE)
          : BATCH_SIZE;
        result.checksUpdated += checksInBatch;
        console.log(`  Batch ${i + 1}/${batches.length} committed (${checksInBatch} checks)`);
      } catch (batchError) {
        const errorMsg = `Batch ${i + 1} failed: ${batchError}`;
        result.errors.push(errorMsg);
        console.error(`  ${errorMsg}`);
      }
    }

    console.log('');
    console.log('Migration complete!');
    console.log(`  Updated: ${result.checksUpdated}/${result.checksNeedingUpdate} checks`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
    }

  } catch (error) {
    const errorMsg = `Migration failed: ${error}`;
    result.errors.push(errorMsg);
    console.error(errorMsg);
  }

  return result;
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: npx ts-node src/migrations/migrate-free-tier-check-intervals.ts [options]

Options:
  --dry-run    Preview changes without making updates (default)
  --execute    Actually perform the migration
  --help, -h   Show this help message

This script updates all free-tier checks with checkFrequency < 5 minutes
to use a 5-minute interval, enforcing the new tier-based limits.
    `);
    process.exit(0);
  }

  try {
    const result = await migrateFreeTierCheckIntervals(dryRun);

    console.log('\n' + '='.repeat(60));
    console.log('Summary:');
    console.log(`  Total scanned: ${result.totalChecksScanned || result.checksNeedingUpdate}`);
    console.log(`  Needing update: ${result.checksNeedingUpdate}`);
    console.log(`  Updated: ${result.checksUpdated}`);
    console.log(`  Errors: ${result.errors.length}`);
    console.log('='.repeat(60));

    process.exit(result.errors.length > 0 ? 1 : 0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
