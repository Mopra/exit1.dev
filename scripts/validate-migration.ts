/**
 * Validate that a migrated user's data is correct
 * 
 * Usage:
 *   npx tsx scripts/validate-migration.ts <email>
 * 
 * Example:
 *   npx tsx scripts/validate-migration.ts user@example.com
 * 
 * Requires:
 *   - Firebase Admin SDK credentials configured
 *   - Firestore database initialized
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Firebase Admin
if (getApps().length === 0) {
  const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? require(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined;
  
  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount),
    });
  } else {
    initializeApp({
      credential: require('firebase-admin').applicationDefault(),
    });
  }
}

const firestore = getFirestore();

interface ValidationResult {
  email: string;
  isValid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    checks: number;
    webhooks: number;
    emailSettings: boolean;
    apiKeys: number;
  };
}

async function validateMigration(email: string): Promise<ValidationResult> {
  const normalizedEmail = email.toLowerCase().trim();
  console.log(`\nValidating migration for: ${normalizedEmail}`);
  
  const result: ValidationResult = {
    email: normalizedEmail,
    isValid: true,
    errors: [],
    warnings: [],
    stats: {
      checks: 0,
      webhooks: 0,
      emailSettings: false,
      apiKeys: 0,
    },
  };
  
  // Check migration table
  const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
  const migrationDoc = await migrationRef.get();
  
  if (!migrationDoc.exists) {
    result.isValid = false;
    result.errors.push('User not found in migration table');
    return result;
  }
  
  const migrationData = migrationDoc.data()!;
  
  if (!migrationData.migrated) {
    result.isValid = false;
    result.errors.push('User has not been migrated yet');
    return result;
  }
  
  if (!migrationData.prodClerkUserId) {
    result.isValid = false;
    result.errors.push('Prod Clerk User ID is missing');
    return result;
  }
  
  const devClerkUserId = migrationData.devClerkUserId;
  const prodClerkUserId = migrationData.prodClerkUserId;
  
  console.log(`Dev Clerk User ID: ${devClerkUserId}`);
  console.log(`Prod Clerk User ID: ${prodClerkUserId}`);
  
  // Check for any documents still using dev userId
  console.log('\nChecking for documents still using dev userId...');
  
  const checksWithDevId = await firestore.collection('checks')
    .where('userId', '==', devClerkUserId)
    .get();
  
  if (checksWithDevId.size > 0) {
    result.isValid = false;
    result.errors.push(`Found ${checksWithDevId.size} checks still using dev userId`);
  }
  
  const webhooksWithDevId = await firestore.collection('webhooks')
    .where('userId', '==', devClerkUserId)
    .get();
  
  if (webhooksWithDevId.size > 0) {
    result.isValid = false;
    result.errors.push(`Found ${webhooksWithDevId.size} webhooks still using dev userId`);
  }
  
  const apiKeysWithDevId = await firestore.collection('apiKeys')
    .where('userId', '==', devClerkUserId)
    .get();
  
  if (apiKeysWithDevId.size > 0) {
    result.isValid = false;
    result.errors.push(`Found ${apiKeysWithDevId.size} API keys still using dev userId`);
  }
  
  // Check documents using prod userId
  console.log('\nChecking documents using prod userId...');
  
  const checksWithProdId = await firestore.collection('checks')
    .where('userId', '==', prodClerkUserId)
    .get();
  
  result.stats.checks = checksWithProdId.size;
  console.log(`Found ${checksWithProdId.size} checks with prod userId`);
  
  const webhooksWithProdId = await firestore.collection('webhooks')
    .where('userId', '==', prodClerkUserId)
    .get();
  
  result.stats.webhooks = webhooksWithProdId.size;
  console.log(`Found ${webhooksWithProdId.size} webhooks with prod userId`);
  
  const emailSettingsDoc = await firestore.collection('emailSettings').doc(prodClerkUserId).get();
  result.stats.emailSettings = emailSettingsDoc.exists;
  console.log(`Email settings: ${emailSettingsDoc.exists ? 'Found' : 'Not found'}`);
  
  const apiKeysWithProdId = await firestore.collection('apiKeys')
    .where('userId', '==', prodClerkUserId)
    .get();
  
  result.stats.apiKeys = apiKeysWithProdId.size;
  console.log(`Found ${apiKeysWithProdId.size} API keys with prod userId`);
  
  // Check for orphaned emailSettings with dev userId
  const emailSettingsDevDoc = await firestore.collection('emailSettings').doc(devClerkUserId).get();
  if (emailSettingsDevDoc.exists) {
    result.warnings.push('Email settings still exist with dev userId (should be migrated)');
  }
  
  // Summary
  console.log('\n=== Validation Summary ===');
  console.log(`Valid: ${result.isValid ? 'Yes' : 'No'}`);
  console.log(`Errors: ${result.errors.length}`);
  console.log(`Warnings: ${result.warnings.length}`);
  console.log(`\nData Statistics:`);
  console.log(`- Checks: ${result.stats.checks}`);
  console.log(`- Webhooks: ${result.stats.webhooks}`);
  console.log(`- Email Settings: ${result.stats.emailSettings ? 'Yes' : 'No'}`);
  console.log(`- API Keys: ${result.stats.apiKeys}`);
  
  if (result.errors.length > 0) {
    console.log('\nErrors:');
    result.errors.forEach(error => console.log(`  - ${error}`));
  }
  
  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    result.warnings.forEach(warning => console.log(`  - ${warning}`));
  }
  
  return result;
}

// Get email from command line arguments
const email = process.argv[2];

if (!email) {
  console.error('Error: Email address is required');
  console.error('Usage: npx tsx scripts/validate-migration.ts <email>');
  process.exit(1);
}

// Run the validation
validateMigration(email)
  .then((result) => {
    if (result.isValid) {
      console.log('\n✓ Migration validation passed!');
      process.exit(0);
    } else {
      console.log('\n✗ Migration validation failed!');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('Error during validation:', error);
    process.exit(1);
  });

