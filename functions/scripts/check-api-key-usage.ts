/**
 * Check API Key Usage
 *
 * This script helps identify which API keys are being used most frequently.
 * Run this locally to analyze API key usage patterns.
 *
 * Usage:
 *   npx tsx functions/scripts/check-api-key-usage.ts
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin
const serviceAccount = require('../../service-account-key.json');
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

interface ApiKeyUsage {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  lastUsedAt: number;
  lastUsedPath: string;
  createdAt: number;
  daysSinceLastUse: number;
}

async function checkApiKeyUsage() {
  console.log('Fetching API keys...\n');

  const apiKeysSnapshot = await db.collection('apiKeys').get();
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);
  const oneHourAgo = now - (60 * 60 * 1000);

  const apiKeys: ApiKeyUsage[] = [];
  const recentlyUsedKeys: ApiKeyUsage[] = [];
  const activeInLastHour: ApiKeyUsage[] = [];

  for (const doc of apiKeysSnapshot.docs) {
    const data = doc.data();
    const lastUsedAt = data.lastUsedAt || 0;
    const daysSinceLastUse = lastUsedAt > 0 ? (now - lastUsedAt) / (24 * 60 * 60 * 1000) : 9999;

    const keyUsage: ApiKeyUsage = {
      id: doc.id,
      userId: data.userId || 'unknown',
      name: data.name || 'Unnamed',
      enabled: data.enabled ?? true,
      lastUsedAt,
      lastUsedPath: data.lastUsedPath || 'N/A',
      createdAt: data.createdAt || 0,
      daysSinceLastUse
    };

    apiKeys.push(keyUsage);

    if (lastUsedAt > oneDayAgo) {
      recentlyUsedKeys.push(keyUsage);
    }

    if (lastUsedAt > oneHourAgo) {
      activeInLastHour.push(keyUsage);
    }
  }

  // Sort by most recently used
  apiKeys.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  recentlyUsedKeys.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  activeInLastHour.sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  console.log('='.repeat(80));
  console.log('API KEY USAGE SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total API keys: ${apiKeys.length}`);
  console.log(`Active in last 24h: ${recentlyUsedKeys.length}`);
  console.log(`Active in last hour: ${activeInLastHour.length}`);
  console.log(`Enabled keys: ${apiKeys.filter(k => k.enabled).length}`);
  console.log(`Disabled keys: ${apiKeys.filter(k => !k.enabled).length}`);
  console.log();

  if (activeInLastHour.length > 0) {
    console.log('='.repeat(80));
    console.log('ACTIVE IN LAST HOUR (Potential high usage culprits)');
    console.log('='.repeat(80));
    for (const key of activeInLastHour) {
      const minutesAgo = Math.floor((now - key.lastUsedAt) / (60 * 1000));
      console.log(`\nAPI Key: ${key.id}`);
      console.log(`  Name: ${key.name}`);
      console.log(`  User ID: ${key.userId}`);
      console.log(`  Enabled: ${key.enabled}`);
      console.log(`  Last used: ${minutesAgo} minute(s) ago`);
      console.log(`  Last path: ${key.lastUsedPath}`);
    }
    console.log();
  }

  if (recentlyUsedKeys.length > 0) {
    console.log('='.repeat(80));
    console.log('RECENTLY USED API KEYS (Last 24 hours)');
    console.log('='.repeat(80));
    for (const key of recentlyUsedKeys) {
      const hoursAgo = Math.floor((now - key.lastUsedAt) / (60 * 60 * 1000));
      console.log(`\nAPI Key: ${key.id}`);
      console.log(`  Name: ${key.name}`);
      console.log(`  User ID: ${key.userId}`);
      console.log(`  Enabled: ${key.enabled}`);
      console.log(`  Last used: ${hoursAgo} hour(s) ago`);
      console.log(`  Last path: ${key.lastUsedPath}`);
    }
    console.log();
  }

  console.log('='.repeat(80));
  console.log('ALL API KEYS (sorted by most recent usage)');
  console.log('='.repeat(80));
  console.log();
  console.log('ID                           | Name              | User ID           | Status   | Last Used');
  console.log('-'.repeat(120));
  for (const key of apiKeys.slice(0, 20)) { // Show top 20
    const lastUsed = key.lastUsedAt > 0
      ? new Date(key.lastUsedAt).toISOString()
      : 'Never';
    const status = key.enabled ? 'Enabled' : 'Disabled';
    console.log(
      `${key.id.padEnd(28)} | ${key.name.slice(0, 17).padEnd(17)} | ${key.userId.slice(0, 17).padEnd(17)} | ${status.padEnd(8)} | ${lastUsed}`
    );
  }

  if (apiKeys.length > 20) {
    console.log(`\n... and ${apiKeys.length - 20} more keys`);
  }

  console.log();
  console.log('='.repeat(80));
  console.log('RECOMMENDATIONS');
  console.log('='.repeat(80));

  if (activeInLastHour.length > 0) {
    console.log('\n⚠️  WARNING: Found API keys active in the last hour!');
    console.log('   These keys are likely responsible for the high invocation rate.');
    console.log('   Consider:');
    console.log('   1. Contacting the user to understand their use case');
    console.log('   2. Disabling the key if usage seems abusive');
    console.log('   3. Monitoring Cloud Functions logs for request patterns');
  }

  const enabledButUnused = apiKeys.filter(k => k.enabled && k.lastUsedAt === 0);
  if (enabledButUnused.length > 0) {
    console.log(`\nℹ️  ${enabledButUnused.length} enabled key(s) have never been used.`);
    console.log('   Consider disabling unused keys for security.');
  }

  console.log('\nTo disable an API key, run:');
  console.log('  firebase firestore:set apiKeys/KEY_ID \'{"enabled": false}\' --merge');
  console.log();
}

checkApiKeyUsage().catch(console.error);
