/**
 * Query: Check interval distribution across all checks
 */

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

async function run() {
  console.log('Fetching all checks...\n');

  const allChecks = await firestore.collection('checks').get();

  const byFreq: Record<number, { free: number; nano: number }> = {};

  for (const doc of allChecks.docs) {
    const data = doc.data();
    const freq = data.checkFrequency ?? 60;
    const tier = data.userTier || 'free';

    if (!byFreq[freq]) byFreq[freq] = { free: 0, nano: 0 };
    if (tier === 'nano') byFreq[freq].nano++;
    else byFreq[freq].free++;
  }

  console.log('='.repeat(65));
  console.log('CHECK INTERVAL DISTRIBUTION');
  console.log('='.repeat(65));
  console.log('Interval        | Free     | Nano     | Total');
  console.log('-'.repeat(65));

  let totalFree = 0, totalNano = 0;

  const sorted = Object.entries(byFreq).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [freq, counts] of sorted) {
    const f = Number(freq);
    let label: string;
    if (f < 60) {
      label = f + ' min';
    } else if (f === 60) {
      label = '1 hour';
    } else if (f === 1440) {
      label = '24 hours';
    } else {
      label = (f / 60) + ' hours';
    }

    const total = counts.free + counts.nano;
    totalFree += counts.free;
    totalNano += counts.nano;
    console.log(label.padEnd(16) + '| ' + String(counts.free).padEnd(9) + '| ' + String(counts.nano).padEnd(9) + '| ' + total);
  }

  console.log('-'.repeat(65));
  console.log('TOTAL'.padEnd(16) + '| ' + String(totalFree).padEnd(9) + '| ' + String(totalNano).padEnd(9) + '| ' + (totalFree + totalNano));
  console.log('='.repeat(65));
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
