/**
 * Export all users from Clerk dev instance to userMigrations Firestore collection
 * 
 * Usage:
 *   npx tsx scripts/export-dev-users.ts
 * 
 * Requires:
 *   - CLERK_SECRET_KEY_DEV environment variable set to dev instance secret key
 *   - Firebase Admin SDK credentials configured
 *   - Firestore database initialized
 */

import { createClerkClient } from '@clerk/backend';
import { initializeApp, cert, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Firebase Admin
if (getApps().length === 0) {
  // Use default credentials (from gcloud or service account file)
  // For service account JSON, set GOOGLE_APPLICATION_CREDENTIALS environment variable
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'exit1-dev',
  });
}

const firestore = getFirestore();

// Initialize Clerk dev client
const devSecretKey = process.env.CLERK_SECRET_KEY_DEV;
if (!devSecretKey) {
  console.error('Error: CLERK_SECRET_KEY_DEV environment variable is not set');
  console.error('Set it with: export CLERK_SECRET_KEY_DEV="your_dev_secret_key"');
  process.exit(1);
}

const clerkClient = createClerkClient({
  secretKey: devSecretKey,
});

interface UserMigration {
  email: string;
  devClerkUserId: string;
  prodClerkUserId: string | null;
  instance: 'dev' | 'prod';
  migrated: boolean;
  migratedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

async function exportDevUsers() {
  console.log('Starting export of dev users...');
  
  let allUsers: any[] = [];
  let offset = 0;
  const limit = 500; // Clerk's max per request
  
  // Fetch all users from dev instance
  try {
    while (true) {
      console.log(`Fetching users (offset: ${offset})...`);
      const response = await clerkClient.users.getUserList({
        limit,
        offset,
      });
      
      if (response.data.length === 0) {
        break;
      }
      
      allUsers.push(...response.data);
      offset += response.data.length;
      
      console.log(`Fetched ${response.data.length} users (total: ${allUsers.length})`);
      
      // Check if we've fetched all users
      if (response.data.length < limit) {
        break;
      }
    }
    
    console.log(`\nTotal users fetched: ${allUsers.length}`);
  } catch (error) {
    console.error('Error fetching users from Clerk:', error);
    process.exit(1);
  }
  
  // Export to Firestore userMigrations collection
  console.log('\nExporting to Firestore userMigrations collection...');
  const batch = firestore.batch();
  let exportedCount = 0;
  let skippedCount = 0;
  const now = Date.now();
  
  for (const user of allUsers) {
    const emailAddress = user.emailAddresses[0]?.emailAddress;
    if (!emailAddress) {
      console.warn(`Skipping user ${user.id} - no email address`);
      skippedCount++;
      continue;
    }
    
    const normalizedEmail = emailAddress.toLowerCase().trim();
    const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
    
    // Check if migration record already exists
    const existingDoc = await migrationRef.get();
    if (existingDoc.exists) {
      const existingData = existingDoc.data();
      // Only update if it's not already migrated
      if (!existingData?.migrated) {
        batch.set(migrationRef, {
          email: normalizedEmail,
          devClerkUserId: user.id,
          prodClerkUserId: existingData?.prodClerkUserId || null,
          instance: 'dev' as const,
          migrated: false,
          migratedAt: null,
          createdAt: existingData?.createdAt || now,
          updatedAt: now,
        }, { merge: true });
        exportedCount++;
      } else {
        skippedCount++;
      }
    } else {
      // Create new migration record
      batch.set(migrationRef, {
        email: normalizedEmail,
        devClerkUserId: user.id,
        prodClerkUserId: null,
        instance: 'dev' as const,
        migrated: false,
        migratedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      exportedCount++;
    }
    
    // Commit in batches of 500 (Firestore limit)
    if (exportedCount % 500 === 0) {
      await batch.commit();
      console.log(`Committed batch (${exportedCount} users exported so far)...`);
    }
  }
  
  // Commit remaining changes
  if (exportedCount % 500 !== 0) {
    await batch.commit();
  }
  
  console.log(`\nExport complete!`);
  console.log(`- Exported: ${exportedCount} users`);
  console.log(`- Skipped: ${skippedCount} users (already migrated or no email)`);
  console.log(`- Total processed: ${allUsers.length} users`);
}

// Run the export
exportDevUsers()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error during export:', error);
    process.exit(1);
  });

