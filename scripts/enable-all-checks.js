import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Use Firebase Admin SDK - it will use default credentials if available
// Or you can set GOOGLE_APPLICATION_CREDENTIALS env var to a service account JSON file
const app = initializeApp({
  projectId: 'exit1-dev',
});

const firestore = getFirestore(app);

async function enableAllDisabledChecks() {
  console.log('\n=== Enabling All Disabled Checks ===\n');

  // First, get all disabled checks
  console.log('Fetching all disabled checks...');
  const snapshot = await firestore
    .collection('checks')
    .where('disabled', '==', true)
    .get();

  if (snapshot.empty) {
    console.log('No disabled checks found.\n');
    return 0;
  }

  console.log(`Found ${snapshot.size} disabled check(s).\n`);

  // Process in write batches (max 500 operations per batch)
  const writeBatchSize = 500;
  let totalUpdated = 0;
  const now = Date.now();

  for (let i = 0; i < snapshot.docs.length; i += writeBatchSize) {
    const batch = firestore.batch();
    const docsBatch = snapshot.docs.slice(i, i + writeBatchSize);

    console.log(`Processing batch ${Math.floor(i / writeBatchSize) + 1} (${docsBatch.length} checks)...`);

    docsBatch.forEach(doc => {
      const check = doc.data();
      console.log(`  - Enabling: ${check.name || doc.id} (${check.url || 'N/A'})`);
      
      batch.update(doc.ref, {
        disabled: false,
        disabledAt: null,
        disabledReason: null,
        consecutiveFailures: 0,
        lastFailureTime: null,
        lastChecked: 0, // Force immediate check on next run
        nextCheckAt: now, // Check immediately on next scheduler run
        status: 'unknown', // Reset status to trigger fresh check
        updatedAt: now,
      });
    });

    await batch.commit();
    totalUpdated += docsBatch.length;
    console.log(`  ✓ Updated ${docsBatch.length} checks in this batch\n`);
  }

  console.log(`\n=== Complete ===`);
  console.log(`Total checks enabled: ${totalUpdated}\n`);
  
  return totalUpdated;
}

enableAllDisabledChecks()
  .then((count) => {
    console.log(`Successfully enabled ${count} checks.`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error enabling checks:', error);
    process.exit(1);
  });
