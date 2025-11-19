/**
 * Migrate a single user from Clerk dev instance to prod instance
 * 
 * Usage:
 *   npx tsx scripts/migrate-user.ts <email>
 * 
 * Example:
 *   npx tsx scripts/migrate-user.ts user@example.com
 * 
 * Requires:
 *   - CLERK_SECRET_KEY_DEV environment variable (dev instance secret key)
 *   - CLERK_SECRET_KEY_PROD environment variable (prod instance secret key)
 *   - Firebase Admin SDK credentials configured
 *   - Firestore database initialized
 */

import { createClerkClient } from '@clerk/backend';
import { initializeApp, cert, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: resolve(__dirname, '../.env.local') });

// Initialize Firebase Admin
if (getApps().length === 0) {
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  
  if (serviceAccountPath) {
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    initializeApp({
      credential: cert(serviceAccount),
      projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'exit1-dev',
    });
  } else {
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'exit1-dev',
    });
  }
}

const firestore = getFirestore();

// Initialize Clerk clients
const devSecretKey = process.env.CLERK_SECRET_KEY_DEV;
const prodSecretKey = process.env.CLERK_SECRET_KEY_PROD || process.env.CLERK_SECRET_KEY;

if (!devSecretKey) {
  console.error('Error: CLERK_SECRET_KEY_DEV environment variable is not set');
  process.exit(1);
}

if (!prodSecretKey) {
  console.error('Error: CLERK_SECRET_KEY_PROD or CLERK_SECRET_KEY environment variable is not set');
  process.exit(1);
}

const clerkDev = createClerkClient({ secretKey: devSecretKey });
const clerkProd = createClerkClient({ secretKey: prodSecretKey });

async function migrateUser(email: string) {
  const normalizedEmail = email.toLowerCase().trim();
  console.log(`\nMigrating user: ${normalizedEmail}`);
  
  // Check migration table
  const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
  const migrationDoc = await migrationRef.get();
  
  if (!migrationDoc.exists) {
    console.error(`Error: User ${normalizedEmail} not found in migration table`);
    console.error('Run export-dev-users.ts first to populate the migration table');
    process.exit(1);
  }
  
  const migrationData = migrationDoc.data()!;
  
  if (migrationData.migrated) {
    console.log(`User ${normalizedEmail} has already been migrated`);
    console.log(`Prod Clerk User ID: ${migrationData.prodClerkUserId}`);
    return;
  }
  
  if (migrationData.instance !== 'dev') {
    console.error(`Error: User ${normalizedEmail} is not on dev instance`);
    process.exit(1);
  }
  
  const devClerkUserId = migrationData.devClerkUserId;
  console.log(`Dev Clerk User ID: ${devClerkUserId}`);
  
  // Fetch user data from dev instance
  console.log('\nFetching user data from dev instance...');
  let devUser;
  try {
    devUser = await clerkDev.users.getUser(devClerkUserId);
    console.log(`Found user: ${devUser.emailAddresses[0]?.emailAddress || 'No email'}`);
  } catch (error) {
    console.error('Error fetching user from dev instance:', error);
    process.exit(1);
  }
  
  // Create user in prod instance
  console.log('\nCreating user in prod instance...');
  let prodUser;
  try {
    // Prepare user data for creation
    const createUserData: any = {
      emailAddress: [devUser.emailAddresses[0]?.emailAddress || normalizedEmail],
      firstName: devUser.firstName || undefined,
      lastName: devUser.lastName || undefined,
      username: devUser.username || undefined,
      publicMetadata: devUser.publicMetadata || {},
      privateMetadata: devUser.privateMetadata || {},
      unsafeMetadata: devUser.unsafeMetadata || {},
    };
    
    // Note: Password cannot be migrated directly - user will need to reset password
    // or use password export from Clerk (requires support request)
    
    prodUser = await clerkProd.users.createUser(createUserData);
    console.log(`Created user in prod instance: ${prodUser.id}`);
  } catch (error: any) {
    if (error?.errors?.[0]?.code === 'duplicate_record') {
      console.log('User already exists in prod instance, fetching...');
      // User might already exist - try to find by email
      const existingUsers = await clerkProd.users.getUserList({
        emailAddress: [normalizedEmail],
        limit: 1,
      });
      
      if (existingUsers.data.length > 0) {
        prodUser = existingUsers.data[0];
        console.log(`Found existing user in prod: ${prodUser.id}`);
      } else {
        console.error('Error: User exists but could not be found');
        process.exit(1);
      }
    } else {
      console.error('Error creating user in prod instance:', error);
      process.exit(1);
    }
  }
  
  const prodClerkUserId = prodUser.id;
  console.log(`Prod Clerk User ID: ${prodClerkUserId}`);
  
  // Update all Firestore documents with new userId
  console.log('\nUpdating Firestore documents...');
  
  // Update checks
  const checksSnapshot = await firestore.collection('checks')
    .where('userId', '==', devClerkUserId)
    .get();
  
  const checksBatch = firestore.batch();
  checksSnapshot.docs.forEach(doc => {
    checksBatch.update(doc.ref, { userId: prodClerkUserId });
  });
  await checksBatch.commit();
  console.log(`Updated ${checksSnapshot.size} checks`);
  
  // Update webhooks
  const webhooksSnapshot = await firestore.collection('webhooks')
    .where('userId', '==', devClerkUserId)
    .get();
  
  const webhooksBatch = firestore.batch();
  webhooksSnapshot.docs.forEach(doc => {
    webhooksBatch.update(doc.ref, { userId: prodClerkUserId });
  });
  await webhooksBatch.commit();
  console.log(`Updated ${webhooksSnapshot.size} webhooks`);
  
  // Update emailSettings
  const emailSettingsRef = firestore.collection('emailSettings').doc(devClerkUserId);
  const emailSettingsDoc = await emailSettingsRef.get();
  if (emailSettingsDoc.exists) {
    const emailSettingsData = emailSettingsDoc.data()!;
    const newEmailSettingsRef = firestore.collection('emailSettings').doc(prodClerkUserId);
    await newEmailSettingsRef.set(emailSettingsData);
    await emailSettingsRef.delete();
    console.log('Updated emailSettings');
  }
  
  // Update apiKeys
  const apiKeysSnapshot = await firestore.collection('apiKeys')
    .where('userId', '==', devClerkUserId)
    .get();
  
  const apiKeysBatch = firestore.batch();
  apiKeysSnapshot.docs.forEach(doc => {
    apiKeysBatch.update(doc.ref, { userId: prodClerkUserId });
  });
  await apiKeysBatch.commit();
  console.log(`Updated ${apiKeysSnapshot.size} API keys`);
  
  // Update migration table
  const now = Date.now();
  await migrationRef.set({
    email: normalizedEmail,
    devClerkUserId,
    prodClerkUserId,
    instance: 'prod' as const,
    migrated: true,
    migratedAt: now,
    createdAt: migrationData.createdAt,
    updatedAt: now,
  }, { merge: true });
  
  console.log('\nMigration complete!');
  console.log(`- Dev Clerk User ID: ${devClerkUserId}`);
  console.log(`- Prod Clerk User ID: ${prodClerkUserId}`);
  console.log(`- Checks migrated: ${checksSnapshot.size}`);
  console.log(`- Webhooks migrated: ${webhooksSnapshot.size}`);
  console.log(`- API keys migrated: ${apiKeysSnapshot.size}`);
  console.log('\nNote: User will need to reset their password or use password export from Clerk');
}

// Get email from command line arguments
const email = process.argv[2];

if (!email) {
  console.error('Error: Email address is required');
  console.error('Usage: npx tsx scripts/migrate-user.ts <email>');
  process.exit(1);
}

// Run the migration
migrateUser(email)
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error during migration:', error);
    process.exit(1);
  });

