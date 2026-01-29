/**
 * Migration script to backfill user_check_stats collection.
 *
 * This populates the user_check_stats collection for all users who have checks,
 * fixing the "active users" count on the admin dashboard.
 *
 * Usage: npx ts-node scripts/backfill-user-check-stats.ts [--dry-run]
 *
 * Examples:
 *   npx ts-node scripts/backfill-user-check-stats.ts           # Run migration
 *   npx ts-node scripts/backfill-user-check-stats.ts --dry-run # Preview only
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as crypto from "crypto";

// Initialize Firebase Admin
initializeApp({
  credential: applicationDefault(),
});

const firestore = getFirestore();
firestore.settings({ ignoreUndefinedProperties: true });

// URL canonicalization (same as in checks.ts)
const getCanonicalUrlKey = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  const protocol = url.protocol.toLowerCase();
  let hostname = url.hostname.toLowerCase();
  hostname = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;

  let port = url.port;
  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    port = "";
  }

  let pathname = url.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  return `${protocol}//${hostname}${port ? `:${port}` : ""}${pathname}${url.search}`;
};

const getCanonicalUrlKeySafe = (rawUrl: string): string | null => {
  try {
    return getCanonicalUrlKey(rawUrl);
  } catch {
    return null;
  }
};

const hashCanonicalUrl = (canonicalUrl: string): string => {
  return crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16);
};

interface UserCheckStats {
  checkCount: number;
  maxOrderIndex: number;
  lastCheckAddedAt: number;
  checksAddedLastMinute: number;
  checksAddedLastHour: number;
  checksAddedLastDay: number;
  lastMinuteWindowStart: number;
  lastHourWindowStart: number;
  lastDayWindowStart: number;
  urlHashes?: Record<string, string>;
}

async function buildUserCheckStats(uid: string): Promise<UserCheckStats> {
  const checksSnapshot = await firestore.collection("checks")
    .where("userId", "==", uid)
    .select("orderIndex", "createdAt", "url")
    .get();

  const now = Date.now();
  const oneMinuteAgo = now - (60 * 1000);
  const oneHourAgo = now - (60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  let maxOrderIndex = 0;
  let checksLastMinute = 0;
  let checksLastHour = 0;
  let checksLastDay = 0;
  const urlHashes: Record<string, string> = {};

  checksSnapshot.docs.forEach(doc => {
    const data = doc.data();
    if (typeof data.orderIndex === 'number' && data.orderIndex > maxOrderIndex) {
      maxOrderIndex = data.orderIndex;
    }
    const createdAt = data.createdAt || 0;
    if (createdAt >= oneMinuteAgo) checksLastMinute++;
    if (createdAt >= oneHourAgo) checksLastHour++;
    if (createdAt >= oneDayAgo) checksLastDay++;

    // Build URL hash index for duplicate detection
    if (data.url) {
      const canonical = getCanonicalUrlKeySafe(data.url);
      if (canonical) {
        const hash = hashCanonicalUrl(canonical);
        urlHashes[hash] = doc.id;
      }
    }
  });

  return {
    checkCount: checksSnapshot.size,
    maxOrderIndex,
    lastCheckAddedAt: now,
    checksAddedLastMinute: checksLastMinute,
    checksAddedLastHour: checksLastHour,
    checksAddedLastDay: checksLastDay,
    lastMinuteWindowStart: Math.floor(now / 60000) * 60000,
    lastHourWindowStart: Math.floor(now / 3600000) * 3600000,
    lastDayWindowStart: Math.floor(now / 86400000) * 86400000,
    urlHashes,
  };
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log(`\n🚀 Starting user_check_stats backfill...`);
  console.log(`📋 Mode: ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  const startTime = Date.now();

  try {
    // Step 1: Get all unique userIds from checks collection
    console.log('📊 Querying all checks to find unique users...');

    const checksSnapshot = await firestore.collection("checks")
      .select("userId")
      .get();

    const userIds = new Set<string>();
    checksSnapshot.docs.forEach(doc => {
      const userId = doc.data().userId;
      if (userId && typeof userId === 'string') {
        userIds.add(userId);
      }
    });

    console.log(`   Found ${checksSnapshot.size} checks`);
    console.log(`   Found ${userIds.size} unique users with checks\n`);

    // Step 2: Check existing user_check_stats
    console.log('📋 Checking existing user_check_stats...');
    const existingStatsSnapshot = await firestore.collection("user_check_stats").get();
    const existingUserIds = new Set(existingStatsSnapshot.docs.map(doc => doc.id));
    console.log(`   Found ${existingUserIds.size} existing user_check_stats documents\n`);

    // Step 3: Find users missing stats
    const missingUserIds = [...userIds].filter(uid => !existingUserIds.has(uid));
    const existingToUpdate = [...userIds].filter(uid => existingUserIds.has(uid));

    console.log(`   Users missing stats: ${missingUserIds.length}`);
    console.log(`   Users with existing stats: ${existingToUpdate.length}\n`);

    if (missingUserIds.length === 0) {
      console.log('✅ All users already have user_check_stats documents!');
      return;
    }

    // Step 4: Create stats for missing users
    console.log(`📝 Creating user_check_stats for ${missingUserIds.length} users...\n`);

    let created = 0;
    let errors = 0;
    const batchSize = 10; // Process in batches to avoid overwhelming Firestore

    for (let i = 0; i < missingUserIds.length; i += batchSize) {
      const batch = missingUserIds.slice(i, i + batchSize);

      await Promise.all(batch.map(async (uid) => {
        try {
          const stats = await buildUserCheckStats(uid);

          if (isDryRun) {
            console.log(`   [DRY RUN] Would create stats for ${uid}: ${stats.checkCount} checks`);
          } else {
            await firestore.collection("user_check_stats").doc(uid).set(stats);
            console.log(`   ✓ Created stats for ${uid}: ${stats.checkCount} checks`);
          }
          created++;
        } catch (error) {
          console.error(`   ✗ Error processing ${uid}:`, error);
          errors++;
        }
      }));

      // Progress update
      const progress = Math.min(i + batchSize, missingUserIds.length);
      console.log(`   Progress: ${progress}/${missingUserIds.length} (${Math.round(progress / missingUserIds.length * 100)}%)\n`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ Backfill completed!`);
    console.log(`   Users processed: ${created}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Duration: ${duration}s`);

    if (isDryRun) {
      console.log(`\n⚠️  This was a dry run. Run without --dry-run to apply changes.`);
    } else {
      console.log(`\n📊 Admin dashboard should now show ${userIds.size} active users.`);
    }

  } catch (error) {
    console.error('\n❌ Backfill failed:', error);
    process.exit(1);
  }
}

main();
