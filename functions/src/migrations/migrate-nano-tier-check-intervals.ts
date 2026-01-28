/**
 * Migration Script: Update nano-tier 1-minute checks to 2 minutes
 *
 * Usage:
 *   npx ts-node src/migrations/migrate-nano-tier-check-intervals.ts [--dry-run]
 *   npx ts-node src/migrations/migrate-nano-tier-check-intervals.ts --execute
 */

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

const MIN_CHECK_INTERVAL_MINUTES_NANO = 2;

async function migrate(dryRun: boolean) {
  console.log('='.repeat(60));
  console.log('Migration: Nano-tier 1-minute check enforcement');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Target: checkFrequency < ${MIN_CHECK_INTERVAL_MINUTES_NANO} → ${MIN_CHECK_INTERVAL_MINUTES_NANO}`);
  console.log('='.repeat(60));
  console.log('');

  // Query all nano tier checks and filter in memory (avoids needing composite index)
  const allNanoChecks = await firestore
    .collection('checks')
    .where('userTier', '==', 'nano')
    .get();

  const checksToUpdate = allNanoChecks.docs.filter(doc => {
    const freq = doc.data().checkFrequency ?? 60;
    return freq < MIN_CHECK_INTERVAL_MINUTES_NANO;
  });

  console.log(`Scanned ${allNanoChecks.size} nano-tier checks`);
  console.log(`Found ${checksToUpdate.length} checks needing update\n`);

  if (checksToUpdate.length === 0) {
    console.log('No checks need updating. Done.');
    return;
  }

  // Show what would be updated
  console.log('Checks to update:');
  for (const doc of checksToUpdate) {
    const data = doc.data();
    console.log(`  - "${data.name}" (${data.url}) - ${data.checkFrequency} min → ${MIN_CHECK_INTERVAL_MINUTES_NANO} min`);
  }
  console.log('');

  if (dryRun) {
    console.log('DRY RUN - No changes made. Run with --execute to apply.');
    return;
  }

  // Execute updates
  const batch = firestore.batch();
  for (const doc of checksToUpdate) {
    batch.update(doc.ref, {
      checkFrequency: MIN_CHECK_INTERVAL_MINUTES_NANO,
      updatedAt: Date.now(),
      _migratedCheckInterval: {
        previousValue: doc.data().checkFrequency,
        migratedAt: Date.now(),
        reason: 'nano-tier-minimum-enforcement',
      },
    });
  }

  await batch.commit();
  console.log(`Updated ${checksToUpdate.length} checks to ${MIN_CHECK_INTERVAL_MINUTES_NANO} minutes.`);
  console.log('Migration complete!');
}

const dryRun = !process.argv.includes('--execute');
migrate(dryRun).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
