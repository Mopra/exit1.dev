import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { BigQuery } from '@google-cloud/bigquery';

// Try to use application default credentials, fallback to service account if available
let app;
try {
  // First try application default credentials (works with gcloud auth)
  const { applicationDefault } = await import('firebase-admin/app');
  app = initializeApp({
    credential: applicationDefault(),
    projectId: 'exit1-dev',
  });
} catch (error) {
  console.log('Application default credentials not available, trying service account...');
  // If that fails, you can set GOOGLE_APPLICATION_CREDENTIALS env var to a service account key file
  // Or use Firebase CLI token
  throw new Error('Please run: gcloud auth application-default login\nOr set GOOGLE_APPLICATION_CREDENTIALS to a service account key file');
}

const firestore = getFirestore(app);
const bigquery = new BigQuery({ projectId: 'exit1-dev' });

const checkId = '4JrF2RS7Ee38Fy22aqme';

async function investigate() {
  console.log(`\n=== Investigating Check: ${checkId} ===\n`);

  // 1. Get check document from Firestore
  console.log('1. Fetching check document from Firestore...');
  const checkDoc = await firestore.collection('checks').doc(checkId).get();
  
  if (!checkDoc.exists) {
    console.error('❌ Check not found!');
    return;
  }

  const check = checkDoc.data();
  console.log('\n📋 Check Details:');
  console.log(`   Name: ${check.name}`);
  console.log(`   URL: ${check.url}`);
  console.log(`   User ID: ${check.userId}`);
  console.log(`   Status: ${check.status || 'unknown'}`);
  console.log(`   Disabled: ${check.disabled || false}`);
  console.log(`   Disabled At: ${check.disabledAt ? new Date(check.disabledAt).toISOString() : 'N/A'}`);
  console.log(`   Disabled Reason: ${check.disabledReason || 'N/A'}`);
  console.log(`   Consecutive Failures: ${check.consecutiveFailures || 0}`);
  console.log(`   Last Failure Time: ${check.lastFailureTime ? new Date(check.lastFailureTime).toISOString() : 'N/A'}`);
  console.log(`   Last Checked: ${check.lastChecked ? new Date(check.lastChecked).toISOString() : 'N/A'}`);
  console.log(`   Created At: ${check.createdAt ? new Date(check.createdAt).toISOString() : 'N/A'}`);
  console.log(`   Updated At: ${check.updatedAt ? new Date(check.updatedAt).toISOString() : 'N/A'}`);

  // 2. Calculate days since first failure
  if (check.lastFailureTime) {
    const now = Date.now();
    const daysSinceFirstFailure = (now - check.lastFailureTime) / (24 * 60 * 60 * 1000);
    console.log(`\n⏱️  Days Since First Failure: ${daysSinceFirstFailure.toFixed(2)}`);
    
    // Check auto-disable conditions
    const DISABLE_AFTER_DAYS = 7;
    console.log(`\n🔍 Auto-Disable Conditions:`);
    console.log(`   Threshold: ${DISABLE_AFTER_DAYS} days of continuous failures`);
    console.log(`   Current: ${daysSinceFirstFailure.toFixed(2)} days`);
    
    const wouldDisable = daysSinceFirstFailure >= DISABLE_AFTER_DAYS;
    console.log(`   Would Auto-Disable: ${wouldDisable ? 'YES ✅' : 'NO ❌'}`);
  }

  // 3. Query BigQuery for recent check history
  console.log('\n2. Fetching recent check history from BigQuery...');
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  
  const query = `
    SELECT 
      timestamp,
      status,
      response_time,
      status_code,
      error
    FROM \`exit1-dev.checks.check_history\`
    WHERE website_id = @checkId 
      AND user_id = @userId
      AND timestamp >= @sevenDaysAgo
    ORDER BY timestamp DESC
    LIMIT 100
  `;

  const [rows] = await bigquery.query({
    query,
    params: {
      checkId,
      userId: check.userId,
      sevenDaysAgo: new Date(sevenDaysAgo)
    }
  });

  console.log(`\n📊 Recent Check History (last 7 days, ${rows.length} records):`);
  if (rows.length > 0) {
    const failures = rows.filter(r => r.status === 'DOWN' || r.status === 'offline');
    const successes = rows.filter(r => r.status === 'UP' || r.status === 'online');
    console.log(`   Total checks: ${rows.length}`);
    console.log(`   Failures: ${failures.length}`);
    console.log(`   Successes: ${successes.length}`);
    console.log(`   Success rate: ${((successes.length / rows.length) * 100).toFixed(1)}%`);
    
    console.log('\n   Last 10 checks:');
    rows.slice(0, 10).forEach((row, i) => {
      const date = new Date(row.timestamp.value || row.timestamp);
      console.log(`   ${i + 1}. ${date.toISOString()} - ${row.status} (${row.status_code || 'N/A'}) ${row.error ? `- ${row.error}` : ''}`);
    });
  } else {
    console.log('   No history found in BigQuery');
  }

  console.log('\n=== Investigation Complete ===\n');
}

investigate().catch(console.error);
