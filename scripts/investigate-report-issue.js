import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { BigQuery } from '@google-cloud/bigquery';

// Use Firebase Admin SDK - it will use default credentials if available
const app = initializeApp({
  projectId: 'exit1-dev',
});

const firestore = getFirestore(app);
const bigquery = new BigQuery({ projectId: 'exit1-dev' });
const checkId = 'IzBXlAKtSdZtvoxpH4Em';

async function investigate() {
  console.log(`\n=== Investigating Check Report Issue: ${checkId} ===\n`);

  try {
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
    console.log(`   Status (current): ${check.status || 'unknown'}`);
    console.log(`   Disabled: ${check.disabled || false}`);
    console.log(`   Last Checked: ${check.lastChecked ? new Date(check.lastChecked).toISOString() : 'N/A'}`);
    console.log(`   Created At: ${check.createdAt ? new Date(check.createdAt).toISOString() : 'N/A'}`);
    console.log(`   Updated At: ${check.updatedAt ? new Date(check.updatedAt).toISOString() : 'N/A'}`);

    // 2. Check BigQuery for recent check history (last 7 days)
    console.log('\n2. Fetching recent check history from BigQuery (last 7 days)...');
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    const historyQuery = `
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
      LIMIT 500
    `;

    const [historyRows] = await bigquery.query({
      query: historyQuery,
      params: {
        checkId,
        userId: check.userId,
        sevenDaysAgo: new Date(sevenDaysAgo)
      }
    });

    console.log(`\n📊 Recent Check History (last 7 days, ${historyRows.length} records):`);
    if (historyRows.length > 0) {
      // Parse status values
      const parseStatus = (row) => {
        const status = row.status || '';
        return {
          raw: status,
          isOffline: status === 'offline' || status === 'OFFLINE',
          isOnline: status === 'online' || status === 'ONLINE'
        };
      };

      const statuses = historyRows.map(parseStatus);
      const failures = statuses.filter(s => s.isOffline);
      const successes = statuses.filter(s => s.isOnline);
      const unknowns = statuses.filter(s => !s.isOffline && !s.isOnline);

      console.log(`   Total checks: ${historyRows.length}`);
      console.log(`   Online: ${successes.length}`);
      console.log(`   Offline: ${failures.length}`);
      console.log(`   Unknown: ${unknowns.length}`);
      console.log(`   Success rate: ${((successes.length / historyRows.length) * 100).toFixed(1)}%`);
      
      // Show status distribution
      const statusCounts = {};
      historyRows.forEach(row => {
        const status = row.status || 'unknown';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      });
      console.log('\n   Status distribution:');
      Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).forEach(([status, count]) => {
        console.log(`     ${status}: ${count}`);
      });
      
      // Show last 20 checks
      console.log('\n   Last 20 checks:');
      historyRows.slice(0, 20).forEach((row, i) => {
        const date = new Date(row.timestamp.value || row.timestamp);
        const statusInfo = parseStatus(row);
        console.log(`   ${i + 1}. ${date.toISOString()} - ${statusInfo.raw} (${row.status_code || 'N/A'}) ${row.error ? `- ${row.error.substring(0, 50)}` : ''}`);
      });
    } else {
      console.log('   ⚠️  No history found in BigQuery for the last 7 days!');
    }

    // 3. Check what getIncidentIntervals would return (simulating Reports page logic)
    console.log('\n3. Simulating Reports page incident intervals query...');
    // Check multiple time ranges: 5 days, 7 days, and 30 days
    const fiveDaysAgo = Date.now() - (5 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const now = Date.now();

    const incidentQuery = `
      WITH range_rows AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @checkId
          AND user_id = @userId
          AND timestamp >= @startDate
          AND timestamp <= @endDate
        ORDER BY timestamp ASC
      ),
      prior_row AS (
        SELECT timestamp, status
        FROM \`exit1-dev.checks.check_history\`
        WHERE website_id = @checkId
          AND user_id = @userId
          AND timestamp < @startDate
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      seeded AS (
        SELECT timestamp, status FROM range_rows
        UNION ALL
        SELECT @startDate AS timestamp, COALESCE(status, 'unknown') AS status FROM prior_row
      ),
      base AS (
        SELECT
          timestamp,
          CASE
            WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
            ELSE 0
          END AS is_offline,
          LAG(
            CASE
              WHEN UPPER(status) IN ('OFFLINE', 'DOWN', 'REACHABLE_WITH_ERROR') THEN 1
              ELSE 0
            END
          ) OVER (ORDER BY timestamp) AS prev_is_offline
        FROM seeded
        WHERE timestamp <= @endDate
      ),
      segmented AS (
        SELECT
          timestamp,
          is_offline,
          SUM(
            CASE
              WHEN prev_is_offline IS NULL OR is_offline != prev_is_offline THEN 1
              ELSE 0
            END
          ) OVER (ORDER BY timestamp) AS segment_id
        FROM base
      ),
      segments AS (
        SELECT
          segment_id,
          is_offline,
          MIN(timestamp) AS start_time
        FROM segmented
        GROUP BY segment_id, is_offline
      ),
      all_segments AS (
        SELECT
          segment_id,
          is_offline,
          start_time,
          LEAD(start_time) OVER (ORDER BY start_time) AS next_start_time
        FROM segments
      )
      SELECT
        UNIX_MILLIS(start_time) AS started_at_ms,
        UNIX_MILLIS(COALESCE(next_start_time, @endDate)) AS ended_at_ms,
        is_offline
      FROM all_segments
      ORDER BY started_at_ms ASC
    `;

    // Check 5 days
    console.log('\n   Checking last 5 days:');
    const [incidentRows5] = await bigquery.query({
      query: incidentQuery,
      params: {
        checkId,
        userId: check.userId,
        startDate: new Date(fiveDaysAgo),
        endDate: new Date(now)
      }
    });

    const offlineIncidents5 = incidentRows5.filter(row => row.is_offline === 1);
    console.log(`   Found ${offlineIncidents5.length} offline incident(s):`);
    offlineIncidents5.forEach((incident, i) => {
      const startDate = new Date(Number(incident.started_at_ms));
      const endDate = new Date(Number(incident.ended_at_ms));
      const durationMs = Number(incident.ended_at_ms) - Number(incident.started_at_ms);
      const durationDays = durationMs / (24 * 60 * 60 * 1000);
      console.log(`   ${i + 1}. Started: ${startDate.toISOString()}`);
      console.log(`      Ended: ${endDate.toISOString()}`);
      console.log(`      Duration: ${durationDays.toFixed(2)} days (${(durationMs / 1000 / 60).toFixed(0)} minutes)`);
    });

    // Check 7 days
    console.log('\n   Checking last 7 days:');
    const [incidentRows7] = await bigquery.query({
      query: incidentQuery,
      params: {
        checkId,
        userId: check.userId,
        startDate: new Date(sevenDaysAgo),
        endDate: new Date(now)
      }
    });

    const offlineIncidents7 = incidentRows7.filter(row => row.is_offline === 1);
    console.log(`   Found ${offlineIncidents7.length} offline incident(s):`);
    offlineIncidents7.forEach((incident, i) => {
      const startDate = new Date(Number(incident.started_at_ms));
      const endDate = new Date(Number(incident.ended_at_ms));
      const durationMs = Number(incident.ended_at_ms) - Number(incident.started_at_ms);
      const durationDays = durationMs / (24 * 60 * 60 * 1000);
      console.log(`   ${i + 1}. Started: ${startDate.toISOString()}`);
      console.log(`      Ended: ${endDate.toISOString()}`);
      console.log(`      Duration: ${durationDays.toFixed(2)} days (${(durationMs / 1000 / 60).toFixed(0)} minutes)`);
    });

    // Check 30 days (most common Reports page view)
    console.log('\n   Checking last 30 days (Reports page default):');
    const [incidentRows30] = await bigquery.query({
      query: incidentQuery,
      params: {
        checkId,
        userId: check.userId,
        startDate: new Date(thirtyDaysAgo),
        endDate: new Date(now)
      }
    });

    const offlineIncidents30 = incidentRows30.filter(row => row.is_offline === 1);
    console.log(`   Found ${offlineIncidents30.length} offline incident(s):`);
    if (offlineIncidents30.length > 0) {
      offlineIncidents30.forEach((incident, i) => {
        const startDate = new Date(Number(incident.started_at_ms));
        const endDate = new Date(Number(incident.ended_at_ms));
        const durationMs = Number(incident.ended_at_ms) - Number(incident.started_at_ms);
        const durationDays = durationMs / (24 * 60 * 60 * 1000);
        console.log(`   ${i + 1}. Started: ${startDate.toISOString()}`);
        console.log(`      Ended: ${endDate.toISOString()}`);
        console.log(`      Duration: ${durationDays.toFixed(2)} days (${(durationMs / 1000 / 60).toFixed(0)} minutes)`);
        if (durationDays > 4) {
          console.log(`      ⚠️  This incident is ${durationDays.toFixed(2)} days long - matches user report!`);
        }
      });
    } else {
      console.log('   ✅ No offline incidents found!');
    }

    // 4. Check for data gaps or anomalies
    console.log('\n4. Checking for data gaps or anomalies...');
    if (historyRows.length > 1) {
      const sortedRows = [...historyRows].sort((a, b) => {
        const aTime = new Date(a.timestamp.value || a.timestamp).getTime();
        const bTime = new Date(b.timestamp.value || b.timestamp).getTime();
        return aTime - bTime;
      });

      let maxGap = 0;
      let maxGapStart = null;
      let maxGapEnd = null;

      for (let i = 1; i < sortedRows.length; i++) {
        const prevTime = new Date(sortedRows[i - 1].timestamp.value || sortedRows[i - 1].timestamp).getTime();
        const currTime = new Date(sortedRows[i].timestamp.value || sortedRows[i].timestamp).getTime();
        const gap = currTime - prevTime;
        
        if (gap > maxGap) {
          maxGap = gap;
          maxGapStart = sortedRows[i - 1].timestamp;
          maxGapEnd = sortedRows[i].timestamp;
        }
      }

      if (maxGap > 2 * 60 * 60 * 1000) { // More than 2 hours
        console.log(`   ⚠️  Largest gap between checks: ${(maxGap / 1000 / 60).toFixed(0)} minutes`);
        console.log(`      From: ${new Date(maxGapStart.value || maxGapStart).toISOString()}`);
        console.log(`      To: ${new Date(maxGapEnd.value || maxGapEnd).toISOString()}`);
      } else {
        console.log('   ✅ No significant gaps found');
      }
    }

    // 5. Summary
    console.log('\n=== Summary ===');
    console.log(`Check ID: ${checkId}`);
    console.log(`Check Name: ${check.name}`);
    console.log(`Check URL: ${check.url}`);
    console.log(`Current Firestore Status: ${check.status || 'unknown'}`);
    console.log(`Recent BigQuery Records (last 7 days): ${historyRows.length}`);
    console.log(`Offline Incidents (last 30 days): ${offlineIncidents30.length}`);
    if (offlineIncidents30.length > 0) {
      const longestIncident = offlineIncidents30.reduce((longest, incident) => {
        const duration = Number(incident.ended_at_ms) - Number(incident.started_at_ms);
        return duration > longest.duration ? { duration, incident } : longest;
      }, { duration: 0, incident: null });
      
      if (longestIncident.incident) {
        const durationDays = longestIncident.duration / (24 * 60 * 60 * 1000);
        console.log(`Longest Offline Incident: ${durationDays.toFixed(2)} days`);
        if (durationDays > 4) {
          console.log(`⚠️  This matches the user's report of "over 4 days"`);
        } else {
          console.log(`ℹ️  Longest incident is ${durationDays.toFixed(2)} days (${(longestIncident.duration / 1000 / 60).toFixed(0)} minutes), not 4+ days`);
        }
      }
    } else {
      console.log(`✅ No offline incidents found in the last 30 days`);
    }

    console.log('\n=== Investigation Complete ===\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    if (error.message.includes('credentials') || error.message.includes('authentication')) {
      console.error('\n💡 Authentication issue. Try one of these:');
      console.error('   1. Run: gcloud auth application-default login');
      console.error('   2. Or set GOOGLE_APPLICATION_CREDENTIALS env var to a service account JSON file');
    }
    throw error;
  }
}

investigate().catch(console.error);
