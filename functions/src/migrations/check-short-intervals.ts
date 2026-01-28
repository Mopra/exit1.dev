/**
 * Diagnostic: Show tier breakdown of remaining short-interval checks
 */

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

async function diagnose() {
  const allChecks = await firestore.collection('checks').get();

  const shortChecks: { tier: string; freq: number; name: string; url: string }[] = [];

  for (const doc of allChecks.docs) {
    const data = doc.data();
    const freq = data.checkFrequency ?? 60;

    if (freq < 5) {
      shortChecks.push({
        tier: data.userTier || 'unknown',
        freq,
        name: data.name,
        url: data.url,
      });
    }
  }

  // Group by tier
  const byTier: Record<string, typeof shortChecks> = {};
  for (const check of shortChecks) {
    if (!byTier[check.tier]) byTier[check.tier] = [];
    byTier[check.tier].push(check);
  }

  console.log('='.repeat(60));
  console.log('SHORT INTERVAL CHECKS (< 5 min) BY TIER');
  console.log('='.repeat(60));
  console.log(`Total: ${shortChecks.length}\n`);

  for (const [tier, checks] of Object.entries(byTier)) {
    console.log(`${tier.toUpperCase()} TIER: ${checks.length} checks`);

    // Group by frequency
    const byFreq: Record<number, number> = {};
    for (const c of checks) {
      byFreq[c.freq] = (byFreq[c.freq] || 0) + 1;
    }
    for (const [freq, count] of Object.entries(byFreq).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  ${freq} min: ${count}`);
    }
    console.log('');
  }

  // Show which 1-min checks exist (these shouldn't be allowed for anyone)
  const oneMinChecks = shortChecks.filter(c => c.freq === 1);
  if (oneMinChecks.length > 0) {
    console.log('1-MINUTE CHECKS (should be migrated to 2 min for nano):');
    for (const c of oneMinChecks.slice(0, 10)) {
      console.log(`  [${c.tier}] "${c.name}" - ${c.url}`);
    }
    if (oneMinChecks.length > 10) {
      console.log(`  ... and ${oneMinChecks.length - 10} more`);
    }
  }

  console.log('='.repeat(60));
}

diagnose().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
