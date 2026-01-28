/**
 * Diagnostic script: Check how many checks are missing userTier field
 */

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

async function diagnose() {
  console.log('Fetching all checks...\n');

  const allChecks = await firestore.collection('checks').get();

  let withTier = 0;
  let withoutTier = 0;
  let freeTier = 0;
  let nanoTier = 0;
  let otherTier = 0;

  let shortIntervalNoTier = 0;
  let shortIntervalWithTier = 0;

  const frequencyDistNoTier: Record<number, number> = {};
  const frequencyDistAll: Record<number, number> = {};

  for (const doc of allChecks.docs) {
    const data = doc.data();
    const freq = data.checkFrequency ?? 60; // default was 60

    // Track all frequency distribution
    frequencyDistAll[freq] = (frequencyDistAll[freq] || 0) + 1;

    if (data.userTier === undefined || data.userTier === null) {
      withoutTier++;
      if (freq < 5) {
        shortIntervalNoTier++;
        frequencyDistNoTier[freq] = (frequencyDistNoTier[freq] || 0) + 1;
      }
    } else {
      withTier++;
      if (data.userTier === 'free') freeTier++;
      else if (data.userTier === 'nano') nanoTier++;
      else otherTier++;

      if (freq < 5) {
        shortIntervalWithTier++;
      }
    }
  }

  console.log('='.repeat(60));
  console.log('CHECK TIER FIELD ANALYSIS');
  console.log('='.repeat(60));
  console.log(`Total checks: ${allChecks.size}`);
  console.log('');
  console.log('Tier field status:');
  console.log(`  With userTier field: ${withTier}`);
  console.log(`  Missing userTier field: ${withoutTier}`);
  console.log('');
  console.log('Tier breakdown (of those with field):');
  console.log(`  free: ${freeTier}`);
  console.log(`  nano: ${nanoTier}`);
  console.log(`  other: ${otherTier}`);
  console.log('');
  console.log('Short interval checks (< 5 min):');
  console.log(`  With userTier field: ${shortIntervalWithTier}`);
  console.log(`  Missing userTier field: ${shortIntervalNoTier}`);
  console.log('');

  if (Object.keys(frequencyDistNoTier).length > 0) {
    console.log('Frequency distribution of checks WITHOUT userTier field (< 5 min):');
    for (const [freq, count] of Object.entries(frequencyDistNoTier).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  ${freq} min: ${count} checks`);
    }
  }

  console.log('');
  console.log('All checks frequency distribution:');
  for (const [freq, count] of Object.entries(frequencyDistAll).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${freq} min: ${count} checks`);
  }
  console.log('='.repeat(60));
}

diagnose().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
