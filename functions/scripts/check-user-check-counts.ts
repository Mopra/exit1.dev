/**
 * Check which users have the most checks
 *
 * Usage:
 *   npx tsx functions/scripts/check-user-check-counts.ts
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'exit1-dev' });

const db = getFirestore();

async function analyzeFreeTierLimits() {
  console.log('Fetching all checks and user tiers...\n');

  const checksSnapshot = await db.collection('checks').select('userId').get();

  const userCounts = new Map<string, number>();
  for (const doc of checksSnapshot.docs) {
    const userId = doc.data().userId || 'unknown';
    userCounts.set(userId, (userCounts.get(userId) || 0) + 1);
  }

  // Get tier info for all users with checks
  const userIds = [...userCounts.keys()];
  const tierMap = new Map<string, string>();

  // Batch fetch user docs (Firestore getAll supports up to 500)
  for (let i = 0; i < userIds.length; i += 500) {
    const batch = userIds.slice(i, i + 500);
    const refs = batch.map(id => db.collection('users').doc(id));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      const tier = doc.exists ? (doc.data()?.tier || 'free') : 'free';
      tierMap.set(doc.id, tier);
    }
  }

  // All users with >= 50 checks (any tier)
  const usersAtLimit: [string, number, string][] = [];
  let freeTotal = 0;
  let nanoTotal = 0;

  for (const [userId, count] of userCounts.entries()) {
    const tier = tierMap.get(userId) || 'free';
    if (tier === 'free') {
      freeTotal++;
    } else {
      nanoTotal++;
    }
    if (count >= 50) {
      usersAtLimit.push([userId, count, tier]);
    }
  }

  usersAtLimit.sort((a, b) => b[1] - a[1]);

  console.log('=== TIER BREAKDOWN ===');
  console.log(`Free users with checks: ${freeTotal}`);
  console.log(`Nano/paid users with checks: ${nanoTotal}`);
  console.log();

  console.log('=== ALL USERS WITH >= 50 CHECKS ===');
  console.log(`Count: ${usersAtLimit.length}`);
  for (const [userId, count, tier] of usersAtLimit) {
    console.log(`  ${userId}: ${count} checks (tier: ${tier})`);
  }
  console.log();

  // Distribution of free users by check count
  const brackets = [1, 5, 10, 20, 30, 40, 50, 75, 100, 200];
  console.log('=== FREE USER CHECK COUNT DISTRIBUTION ===');
  for (let i = 0; i < brackets.length; i++) {
    const min = i === 0 ? 1 : brackets[i - 1] + 1;
    const max = brackets[i];
    const count = [...userCounts.entries()].filter(([uid, c]) => {
      const tier = tierMap.get(uid) || 'free';
      return tier === 'free' && c >= min && c <= max;
    }).length;
    console.log(`  ${String(min).padStart(3)}-${String(max).padStart(3)} checks: ${count} users`);
  }
  const over200 = [...userCounts.entries()].filter(([uid, c]) => {
    const tier = tierMap.get(uid) || 'free';
    return tier === 'free' && c > 200;
  }).length;
  console.log(`  200+ checks: ${over200} users`);
}

analyzeFreeTierLimits().catch(console.error);
