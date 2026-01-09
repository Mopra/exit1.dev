import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { BigQuery } from '@google-cloud/bigquery';

// Use Firebase Admin SDK - it will use default credentials if available
// Or you can set GOOGLE_APPLICATION_CREDENTIALS env var to a service account JSON file
const app = initializeApp({
  projectId: 'exit1-dev',
});

const firestore = getFirestore(app);
const bigquery = new BigQuery({ projectId: 'exit1-dev' });
const checkId = '4JrF2RS7Ee38Fy22aqme';

async function investigate() {
  console.log(`\n=== Investigating Check: ${checkId} ===\n`);

  try {
    // Get check document
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

    // Calculate auto-disable conditions
    const DISABLE_AFTER_DAYS = 7;
    const now = Date.now();
    const daysSinceFirstFailure = check.lastFailureTime ? 
      (now - check.lastFailureTime) / (24 * 60 * 60 * 1000) : 0;
    
    console.log(`\n⏱️  Days Since First Failure: ${daysSinceFirstFailure.toFixed(2)}`);
    
    console.log(`\n🔍 Auto-Disable Conditions:`);
    console.log(`   Threshold: ${DISABLE_AFTER_DAYS} days of continuous failures`);
    console.log(`   Current: ${daysSinceFirstFailure.toFixed(2)} days`);
    
    const wouldDisable = daysSinceFirstFailure >= DISABLE_AFTER_DAYS;
    console.log(`   Would Auto-Disable: ${wouldDisable ? 'YES ✅' : 'NO ❌'}`);

    if (check.disabled && check.disabledAt) {
      const disabledDate = new Date(check.disabledAt);
      console.log(`\n🚫 Check was disabled at: ${disabledDate.toISOString()}`);
      console.log(`   Reason: ${check.disabledReason || 'Unknown'}`);
      
      if (check.lastFailureTime) {
        const timeBetweenFailureAndDisable = (check.disabledAt - check.lastFailureTime) / (24 * 60 * 60 * 1000);
        console.log(`   Days between first failure and disable: ${timeBetweenFailureAndDisable.toFixed(2)}`);
      }
    }

    // Query BigQuery for check history (since check creation to see when it was disabled)
    console.log('\n📊 Fetching check history from BigQuery (since check creation)...');
    try {
      const checkCreatedAt = check.createdAt || (Date.now() - (90 * 24 * 60 * 60 * 1000)); // Fallback to 90 days ago
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
          AND timestamp >= @checkCreatedAt
        ORDER BY timestamp DESC
        LIMIT 1000
      `;

      const [rows] = await bigquery.query({
        query,
        params: {
          checkId,
          userId: check.userId,
          checkCreatedAt: new Date(checkCreatedAt)
        }
      });

      if (rows.length > 0) {
        const failures = rows.filter(r => r.status === 'DOWN' || r.status === 'offline');
        const successes = rows.filter(r => r.status === 'UP' || r.status === 'online');
        console.log(`   Total checks: ${rows.length}`);
        console.log(`   Failures: ${failures.length}`);
        console.log(`   Successes: ${successes.length}`);
        console.log(`   Success rate: ${((successes.length / rows.length) * 100).toFixed(1)}%`);
        
        // Find the longest failure streak
        let maxFailureStreak = 0;
        let currentStreak = 0;
        let failureStartTime = null;
        let longestFailureStart = null;
        let longestFailureEnd = null;
        
        for (const row of rows.reverse()) { // Reverse to go chronologically
          const isFailure = row.status === 'DOWN' || row.status === 'offline';
          if (isFailure) {
            if (currentStreak === 0) {
              failureStartTime = row.timestamp?.value || row.timestamp;
            }
            currentStreak++;
            if (currentStreak > maxFailureStreak) {
              maxFailureStreak = currentStreak;
              longestFailureStart = failureStartTime;
              longestFailureEnd = row.timestamp?.value || row.timestamp;
            }
          } else {
            currentStreak = 0;
            failureStartTime = null;
          }
        }
        
        if (maxFailureStreak > 0) {
          console.log(`\n   Longest failure streak: ${maxFailureStreak} consecutive failures`);
          if (longestFailureStart) {
            const startDate = new Date(longestFailureStart);
            const endDate = new Date(longestFailureEnd);
            const daysDiff = (endDate - startDate) / (24 * 60 * 60 * 1000);
            console.log(`   From: ${startDate.toISOString()}`);
            console.log(`   To: ${endDate.toISOString()}`);
            console.log(`   Duration: ${daysDiff.toFixed(2)} days`);
            
            if (daysDiff >= 7) {
              console.log(`   ⚠️  This streak lasted ${daysDiff.toFixed(2)} days, which would trigger auto-disable!`);
            }
          }
        }
        
        // Find all failure periods
        console.log('\n   Failure Analysis:');
        const failurePeriods = [];
        let currentFailurePeriod = null;
        
        for (const row of rows.reverse()) { // Go chronologically
          const isFailure = row.status === 'DOWN' || row.status === 'offline';
          const timestamp = new Date(row.timestamp?.value || row.timestamp);
          
          if (isFailure) {
            if (!currentFailurePeriod) {
              currentFailurePeriod = { start: timestamp, end: timestamp, count: 1 };
            } else {
              currentFailurePeriod.end = timestamp;
              currentFailurePeriod.count++;
            }
          } else {
            if (currentFailurePeriod) {
              failurePeriods.push(currentFailurePeriod);
              currentFailurePeriod = null;
            }
          }
        }
        
        if (currentFailurePeriod) {
          failurePeriods.push(currentFailurePeriod);
        }
        
        if (failurePeriods.length > 0) {
          console.log(`   Found ${failurePeriods.length} failure period(s):`);
          failurePeriods.forEach((period, i) => {
            const duration = (period.end - period.start) / (24 * 60 * 60 * 1000);
            console.log(`   ${i + 1}. ${period.count} failures from ${period.start.toISOString()} to ${period.end.toISOString()} (${duration.toFixed(2)} days)`);
            if (duration >= 7) {
              console.log(`      ⚠️  This period lasted ${duration.toFixed(2)} days - would trigger auto-disable!`);
            }
          });
        } else {
          console.log('   No failure periods found');
        }
        
        console.log('\n   Last 10 checks:');
        rows.slice(-10).reverse().forEach((row, i) => {
          const date = new Date(row.timestamp?.value || row.timestamp);
          console.log(`   ${i + 1}. ${date.toISOString()} - ${row.status} (${row.status_code || 'N/A'}) ${row.error ? `- ${row.error.substring(0, 50)}` : ''}`);
        });
      } else {
        console.log('   No history found in BigQuery since check creation');
      }
    } catch (error) {
      console.error('   Error querying BigQuery:', error.message);
    }

    console.log('\n=== Investigation Complete ===\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.message.includes('credentials') || error.message.includes('authentication')) {
      console.error('\n💡 Authentication issue. Try one of these:');
      console.error('   1. Restart your terminal after installing Google Cloud SDK');
      console.error('   2. Run: gcloud auth application-default login');
      console.error('   3. Or set GOOGLE_APPLICATION_CREDENTIALS env var to a service account JSON file');
    }
    throw error;
  }
}

investigate().catch(console.error);
