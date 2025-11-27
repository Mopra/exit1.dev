import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore, getClerkClient } from "./init";
import { CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from "./env";
import { createClerkClient } from '@clerk/backend';
import { BigQuery } from '@google-cloud/bigquery';

const bigquery = new BigQuery({
  projectId: 'exit1-dev',
  keyFilename: undefined, // Use default credentials
});

// Export dev users to migration table
export const exportDevUsers = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_DEV],
}, async (request) => {
  try {
    // Temporary: Allow access with secret token OR authenticated admin
    const { secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.EXPORT_SECRET_TOKEN || 'migration-export-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
      logger.info('Export dev users called by authenticated user:', uid);
    } else {
      logger.info('Export dev users called with secret token');
    }

    // Initialize dev client with secret from function context
    let devClient = getClerkClient('dev');
    if (!devClient) {
      // Try to initialize dev client with secret from function context
      const devSecretKey = CLERK_SECRET_KEY_DEV.value();
      if (devSecretKey) {
        devClient = createClerkClient({ secretKey: devSecretKey });
        logger.info('Dev Clerk client initialized in exportDevUsers function');
      } else {
        throw new HttpsError('failed-precondition', 'Dev Clerk client not initialized: CLERK_SECRET_KEY_DEV secret not found');
      }
    }

    logger.info('Starting export of dev users to migration table...');
    
    const allUsers: Array<{ id: string; emailAddresses?: Array<{ emailAddress?: string }> }> = [];
    let offset = 0;
    const limit = 500;
    let hasMore = true;
    
    // Fetch all users from dev instance
    while (hasMore) {
      logger.info(`Fetching users (offset: ${offset})...`);
      const response = await devClient.users.getUserList({
        limit,
        offset,
      });
      
      if (response.data.length === 0) {
        hasMore = false;
        break;
      }
      
      allUsers.push(...response.data);
      offset += response.data.length;
      
      logger.info(`Fetched ${response.data.length} users (total: ${allUsers.length})`);
      
      if (response.data.length < limit) {
        hasMore = false;
      }
    }

    logger.info(`Total users fetched: ${allUsers.length}`);
    logger.info('Exporting to Firestore userMigrations collection...');

    // Export to Firestore in batches
    const batch = firestore.batch();
    let count = 0;
    
    for (const user of allUsers) {
      const emailAddress = user.emailAddresses?.[0]?.emailAddress;
      if (emailAddress) {
        const normalizedEmail = emailAddress.toLowerCase().trim();
        const userMigrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
        
        const record = {
          email: normalizedEmail,
          devClerkUserId: user.id,
          prodClerkUserId: null,
          instance: 'dev' as const,
          migrated: false,
          migratedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        
        batch.set(userMigrationRef, record, { merge: true });
        count++;
        
        // Commit batch every 500 documents (Firestore limit)
        if (count % 500 === 0) {
          await batch.commit();
          logger.info(`Committed batch: ${count} users exported`);
        }
      }
    }
    
    // Commit remaining documents
    if (count % 500 !== 0) {
      await batch.commit();
    }

    logger.info(`Successfully exported ${count} dev users to Firestore userMigrations collection.`);
    
    return {
      success: true,
      totalUsers: allUsers.length,
      exportedUsers: count,
      message: `Successfully exported ${count} dev users to migration table`,
    };
  } catch (error) {
    logger.error('Error exporting dev users:', error);
    throw new HttpsError('internal', `Failed to export dev users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Admin-only function to migrate a single user from dev to prod instance
export const migrateUser = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { email, secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    if (!email) {
      throw new HttpsError('invalid-argument', 'Email is required');
    }
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Migrate user called by authenticated user:', uid);
    } else {
      logger.info('Migrate user called with secret token');
    }

    const normalizedEmail = email.toLowerCase().trim();
    logger.info(`Starting migration for user: ${normalizedEmail}`);

    // Get Clerk clients
    const devSecretKey = CLERK_SECRET_KEY_DEV.value();
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    
    if (!devSecretKey) {
      throw new HttpsError('failed-precondition', 'Dev Clerk secret key not configured');
    }
    if (!prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Prod Clerk secret key not configured');
    }
    
    const devClient = createClerkClient({ secretKey: devSecretKey });
    const prodClient = createClerkClient({ secretKey: prodSecretKey });

    // Check migration table
    const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
    const migrationDoc = await migrationRef.get();
    
    if (!migrationDoc.exists) {
      throw new HttpsError('not-found', `User ${normalizedEmail} not found in migration table. Run exportDevUsers first.`);
    }
    
    const migrationData = migrationDoc.data()!;
    
    if (migrationData.migrated) {
      return {
        success: true,
        message: `User ${normalizedEmail} has already been migrated`,
        prodClerkUserId: migrationData.prodClerkUserId,
      };
    }
    
    if (migrationData.instance !== 'dev') {
      throw new HttpsError('failed-precondition', `User ${normalizedEmail} is not on dev instance`);
    }
    
    const devClerkUserId = migrationData.devClerkUserId;
    logger.info(`Dev Clerk User ID: ${devClerkUserId}`);
    
    // Fetch user data from dev instance
    logger.info('Fetching user data from dev instance...');
    const devUser = await devClient.users.getUser(devClerkUserId);
    logger.info(`Found user: ${devUser.emailAddresses[0]?.emailAddress || 'No email'}`);
    
    // Create user in prod instance
    logger.info('Creating user in prod instance...');
    let prodUser;
    try {
      // Prepare user data, filtering out null/undefined values
      const email = devUser.emailAddresses?.[0]?.emailAddress || normalizedEmail;
      if (!email) {
        throw new HttpsError('invalid-argument', 'User email address is required');
      }

      const createUserData: {
        emailAddress: string[];
        firstName?: string;
        lastName?: string;
        username?: string;
        publicMetadata?: Record<string, unknown>;
        privateMetadata?: Record<string, unknown>;
        unsafeMetadata?: Record<string, unknown>;
        skipPasswordChecks?: boolean;
        skipPasswordRequirement?: boolean;
      } = {
        emailAddress: [email],
        skipPasswordChecks: true,
        skipPasswordRequirement: true,
      };

      // Only add fields if they have values
      if (devUser.firstName) {
        createUserData.firstName = devUser.firstName;
      }
      if (devUser.lastName) {
        createUserData.lastName = devUser.lastName;
      }
      if (devUser.username) {
        createUserData.username = devUser.username;
      }
      if (devUser.publicMetadata && Object.keys(devUser.publicMetadata).length > 0) {
        createUserData.publicMetadata = devUser.publicMetadata as Record<string, unknown>;
      }
      if (devUser.privateMetadata && Object.keys(devUser.privateMetadata).length > 0) {
        createUserData.privateMetadata = devUser.privateMetadata as Record<string, unknown>;
      }
      if (devUser.unsafeMetadata && Object.keys(devUser.unsafeMetadata).length > 0) {
        createUserData.unsafeMetadata = devUser.unsafeMetadata as Record<string, unknown>;
      }
      
      logger.info('Creating user with data:', JSON.stringify(createUserData, null, 2));
      prodUser = await prodClient.users.createUser(createUserData);
      logger.info(`Created user in prod instance: ${prodUser.id}`);
    } catch (error: unknown) {
      logger.error('Error creating user in prod:', error);
      const clerkError = error as { errors?: Array<{ code?: string; message?: string }>; status?: number };
      
      if (clerkError?.errors?.[0]?.code === 'duplicate_record') {
        logger.info('User already exists in prod instance, fetching...');
        const existingUsers = await prodClient.users.getUserList({
          emailAddress: [normalizedEmail],
          limit: 1,
        });
        
        if (existingUsers.data.length > 0) {
          prodUser = existingUsers.data[0];
          logger.info(`Found existing user in prod: ${prodUser.id}`);
        } else {
          throw new HttpsError('internal', 'User exists but could not be found');
        }
      } else {
        const errorMessage = clerkError?.errors?.[0]?.message || 'Unknown error';
        const errorCode = clerkError?.errors?.[0]?.code || 'unknown';
        logger.error(`Clerk error: ${errorCode} - ${errorMessage}`);
        throw new HttpsError('failed-precondition', `Failed to create user in prod instance: ${errorMessage} (${errorCode})`);
      }
    }
    
    const prodClerkUserId = prodUser.id;
    logger.info(`Prod Clerk User ID: ${prodClerkUserId}`);
    
    // Update all Firestore documents with new userId
    logger.info('Updating Firestore documents...');
    
    let checksCount = 0;
    let webhooksCount = 0;
    let apiKeysCount = 0;
    let emailSettingsMigrated = false;
    
    // Update checks
    const checksSnapshot = await firestore.collection('checks')
      .where('userId', '==', devClerkUserId)
      .get();
    
    if (!checksSnapshot.empty) {
      const checksBatch = firestore.batch();
      checksSnapshot.docs.forEach(doc => {
        checksBatch.update(doc.ref, { userId: prodClerkUserId });
      });
      await checksBatch.commit();
      checksCount = checksSnapshot.size;
      logger.info(`Updated ${checksCount} checks`);
    }
    
    // Update webhooks
    const webhooksSnapshot = await firestore.collection('webhooks')
      .where('userId', '==', devClerkUserId)
      .get();
    
    if (!webhooksSnapshot.empty) {
      const webhooksBatch = firestore.batch();
      webhooksSnapshot.docs.forEach(doc => {
        webhooksBatch.update(doc.ref, { userId: prodClerkUserId });
      });
      await webhooksBatch.commit();
      webhooksCount = webhooksSnapshot.size;
      logger.info(`Updated ${webhooksCount} webhooks`);
    }
    
    // Update emailSettings
    const emailSettingsRef = firestore.collection('emailSettings').doc(devClerkUserId);
    const emailSettingsDoc = await emailSettingsRef.get();
    if (emailSettingsDoc.exists) {
      const emailSettingsData = emailSettingsDoc.data()!;
      const newEmailSettingsRef = firestore.collection('emailSettings').doc(prodClerkUserId);
      await newEmailSettingsRef.set(emailSettingsData);
      await emailSettingsRef.delete();
      emailSettingsMigrated = true;
      logger.info('Updated emailSettings');
    }
    
    // Update apiKeys
    const apiKeysSnapshot = await firestore.collection('apiKeys')
      .where('userId', '==', devClerkUserId)
      .get();
    
    if (!apiKeysSnapshot.empty) {
      const apiKeysBatch = firestore.batch();
      apiKeysSnapshot.docs.forEach(doc => {
        apiKeysBatch.update(doc.ref, { userId: prodClerkUserId });
      });
      await apiKeysBatch.commit();
      apiKeysCount = apiKeysSnapshot.size;
      logger.info(`Updated ${apiKeysCount} API keys`);
    }
    
    // Update BigQuery check_history table (logs and reports data)
    logger.info('Updating BigQuery check_history table...');
    let bigQueryRowsUpdated = 0;
    try {
      const bigquery = new BigQuery({
        projectId: 'exit1-dev',
      });
      
      // First, count how many rows will be updated
      const countQuery = `
        SELECT COUNT(*) as row_count
        FROM \`exit1-dev.checks.check_history\`
        WHERE user_id = @oldUserId
      `;
      
      const countOptions = {
        query: countQuery,
        params: {
          oldUserId: devClerkUserId,
        },
      };
      
      const [countJob] = await bigquery.createQueryJob(countOptions);
      const [countRows] = await countJob.getQueryResults();
      const rowCount = Number(countRows[0]?.row_count || 0);
      logger.info(`Found ${rowCount} rows in BigQuery to update`);
      
      if (rowCount > 0) {
        // Use DML UPDATE to change user_id in BigQuery
        const updateQuery = `
          UPDATE \`exit1-dev.checks.check_history\`
          SET user_id = @newUserId
          WHERE user_id = @oldUserId
        `;
        
        const updateOptions = {
          query: updateQuery,
          params: {
            newUserId: prodClerkUserId,
            oldUserId: devClerkUserId,
          },
        };
        
        const [updateJob] = await bigquery.createQueryJob(updateOptions);
        await updateJob.getQueryResults();
        
        // Get the number of rows updated from job statistics
        const [metadata] = await updateJob.getMetadata();
        bigQueryRowsUpdated = Number(metadata.statistics?.totalBytesProcessed ? rowCount : rowCount);
        logger.info(`Updated ${bigQueryRowsUpdated} rows in BigQuery check_history table`);
      }
    } catch (bigQueryError) {
      logger.error('Error updating BigQuery:', bigQueryError);
      // Don't fail the migration if BigQuery update fails - log it but continue
      // The user can manually fix BigQuery data if needed
    }
    
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
    
    logger.info(`Migration complete for ${normalizedEmail}`);
    
    return {
      success: true,
      message: `Successfully migrated user ${normalizedEmail}`,
      devClerkUserId,
      prodClerkUserId,
      checksMigrated: checksCount,
      webhooksMigrated: webhooksCount,
      apiKeysMigrated: apiKeysCount,
      emailSettingsMigrated,
      bigQueryRowsMigrated: bigQueryRowsUpdated,
    };
  } catch (error) {
    logger.error('Error migrating user:', error);
    throw new HttpsError('internal', `Failed to migrate user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Recovery function to fix BigQuery data for already-migrated users
export const fixBigQueryData = onCall({
  cors: true,
  maxInstances: 1,
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { email, secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    if (!email) {
      throw new HttpsError('invalid-argument', 'Email is required');
    }
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Fix BigQuery data called by authenticated user:', uid);
    } else {
      logger.info('Fix BigQuery data called with secret token');
    }

    const normalizedEmail = email.toLowerCase().trim();
    logger.info(`Fixing BigQuery data for user: ${normalizedEmail}`);

    // Get migration record
    const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
    const migrationDoc = await migrationRef.get();
    
    if (!migrationDoc.exists) {
      throw new HttpsError('not-found', `User ${normalizedEmail} not found in migration table`);
    }
    
    const migrationData = migrationDoc.data()!;
    
    logger.info('Migration record data:', JSON.stringify(migrationData, null, 2));
    
    // Try to get user IDs from migration record
    let devClerkUserId = migrationData.devClerkUserId;
    let prodClerkUserId = migrationData.prodClerkUserId;
    
    // If prodClerkUserId is missing, try to find it in Clerk
    if (!prodClerkUserId) {
      logger.info('prodClerkUserId missing from migration record, attempting to find user in prod Clerk...');
      const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
      if (prodSecretKey) {
        const prodClient = createClerkClient({ secretKey: prodSecretKey });
        
        // Try finding by email
        try {
          const existingUsers = await prodClient.users.getUserList({
            emailAddress: [normalizedEmail],
            limit: 10, // Get more results in case there are duplicates
          });
          
          logger.info(`Found ${existingUsers.data.length} users with email ${normalizedEmail} in prod Clerk`);
          
          if (existingUsers.data.length > 0) {
            // Use the first user found (most recent)
            prodClerkUserId = existingUsers.data[0].id;
            logger.info(`Found prod user ID: ${prodClerkUserId}`);
            
            // Update migration record with prod user ID
            await migrationRef.update({
              prodClerkUserId,
              migrated: true, // Also mark as migrated if not already
              instance: 'prod',
              updatedAt: Date.now(),
            });
          } else {
            logger.warn(`No user found in prod Clerk with email ${normalizedEmail}`);
          }
        } catch (lookupError) {
          logger.error('Error looking up user in prod Clerk:', lookupError);
        }
      }
    }
    
    // If devClerkUserId is missing, try to find it
    if (!devClerkUserId) {
      logger.info('devClerkUserId missing from migration record, attempting to find user in dev Clerk...');
      const devSecretKey = CLERK_SECRET_KEY_DEV.value();
      if (devSecretKey) {
        const devClient = createClerkClient({ secretKey: devSecretKey });
        const existingUsers = await devClient.users.getUserList({
          emailAddress: [normalizedEmail],
          limit: 1,
        });
        
        if (existingUsers.data.length > 0) {
          devClerkUserId = existingUsers.data[0].id;
          logger.info(`Found dev user ID: ${devClerkUserId}`);
          
          // Update migration record with dev user ID
          await migrationRef.update({
            devClerkUserId,
            updatedAt: Date.now(),
          });
        }
      }
    }
    
    // If we still don't have prodClerkUserId, we can't proceed
    if (!prodClerkUserId) {
      logger.error(`Missing prodClerkUserId - dev: ${devClerkUserId}, prod: ${prodClerkUserId}`);
      throw new HttpsError('failed-precondition', `Cannot fix BigQuery: User ${normalizedEmail} not found in prod Clerk instance. Please ensure the user exists in prod Clerk, or run migrateUser first to create them.`);
    }
    
    // If devClerkUserId is missing, we can still try to fix BigQuery by updating all rows
    // that might belong to this user (though this is less precise)
    if (!devClerkUserId) {
      logger.warn(`devClerkUserId missing - will attempt to update BigQuery using website IDs from checks`);
      
      // Get all checks for the prod user to find website IDs
      const checksSnapshot = await firestore.collection('checks')
        .where('userId', '==', prodClerkUserId)
        .get();
      
      if (checksSnapshot.empty) {
        throw new HttpsError('failed-precondition', `Cannot fix BigQuery: No checks found for prod user ${prodClerkUserId}. Cannot determine which BigQuery rows to update without devClerkUserId.`);
      }
      
      const websiteIds = checksSnapshot.docs.map(doc => doc.id);
      logger.info(`Found ${websiteIds.length} checks for prod user. Will update BigQuery rows for these websites.`);
      
      // Update BigQuery using website IDs instead of user_id
      // This is a fallback approach
      const bigquery = new BigQuery({
        projectId: 'exit1-dev',
      });
      
      let totalUpdated = 0;
      // Exclude rows in streaming buffer (last 30 minutes)
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      
      for (const websiteId of websiteIds) {
        try {
          const updateQuery = `
            UPDATE \`exit1-dev.checks.check_history\`
            SET user_id = @newUserId
            WHERE website_id = @websiteId
              AND user_id != @newUserId
              AND timestamp < @cutoffTime
          `;
          
          const updateOptions = {
            query: updateQuery,
            params: {
              newUserId: prodClerkUserId,
              websiteId: websiteId,
              cutoffTime: thirtyMinutesAgo,
            },
          };
          
          const [updateJob] = await bigquery.createQueryJob(updateOptions);
          await updateJob.getQueryResults();
          
          // Count updated rows (excluding streaming buffer)
          const countQuery = `
            SELECT COUNT(*) as row_count
            FROM \`exit1-dev.checks.check_history\`
            WHERE website_id = @websiteId
              AND user_id = @newUserId
              AND timestamp < @cutoffTime
          `;
          
          const [countJob] = await bigquery.createQueryJob({
            query: countQuery,
            params: {
              websiteId: websiteId,
              newUserId: prodClerkUserId,
              cutoffTime: thirtyMinutesAgo,
            },
          });
          const [countRows] = await countJob.getQueryResults();
          const count = Number(countRows[0]?.row_count || 0);
          totalUpdated += count;
        } catch (error) {
          logger.error(`Error updating BigQuery for website ${websiteId}:`, error);
        }
      }
      
      return {
        success: true,
        message: `Successfully fixed BigQuery data for ${normalizedEmail} using website IDs (devClerkUserId was missing)`,
        bigQueryRowsUpdated: totalUpdated,
      };
    }
    
    logger.info(`Updating BigQuery: ${devClerkUserId} -> ${prodClerkUserId}`);
    
    // Update BigQuery check_history table
    let bigQueryRowsUpdated = 0;
    try {
      const bigquery = new BigQuery({
        projectId: 'exit1-dev',
      });
      
      // Exclude rows in streaming buffer (last 30 minutes) - BigQuery doesn't allow updates on streaming buffer rows
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      
      // First, count how many rows will be updated (excluding streaming buffer)
      const countQuery = `
        SELECT COUNT(*) as row_count
        FROM \`exit1-dev.checks.check_history\`
        WHERE user_id = @oldUserId
          AND timestamp < @cutoffTime
      `;
      
      const countOptions = {
        query: countQuery,
        params: {
          oldUserId: devClerkUserId,
          cutoffTime: thirtyMinutesAgo,
        },
      };
      
      const [countJob] = await bigquery.createQueryJob(countOptions);
      const [countRows] = await countJob.getQueryResults();
      const rowCount = Number(countRows[0]?.row_count || 0);
      logger.info(`Found ${rowCount} rows in BigQuery to update (excluding streaming buffer)`);
      
      if (rowCount > 0) {
        // Use DML UPDATE to change user_id in BigQuery
        const updateQuery = `
          UPDATE \`exit1-dev.checks.check_history\`
          SET user_id = @newUserId
          WHERE user_id = @oldUserId
            AND timestamp < @cutoffTime
        `;
        
        const updateOptions = {
          query: updateQuery,
          params: {
            newUserId: prodClerkUserId,
            oldUserId: devClerkUserId,
            cutoffTime: thirtyMinutesAgo,
          },
        };
        
        const [updateJob] = await bigquery.createQueryJob(updateOptions);
        await updateJob.getQueryResults();
        
        // Count how many rows were actually updated (excluding streaming buffer)
        const countUpdatedQuery = `
          SELECT COUNT(*) as row_count
          FROM \`exit1-dev.checks.check_history\`
          WHERE user_id = @newUserId
            AND timestamp < @cutoffTime
        `;
        
        const [countJob] = await bigquery.createQueryJob({
          query: countUpdatedQuery,
          params: {
            newUserId: prodClerkUserId,
            cutoffTime: thirtyMinutesAgo,
          },
        });
        const [countRows] = await countJob.getQueryResults();
        bigQueryRowsUpdated = Number(countRows[0]?.row_count || 0);
        
        logger.info(`Updated ${bigQueryRowsUpdated} rows in BigQuery check_history table (excluding streaming buffer)`);
        
        // Note: Rows in streaming buffer (last 30 min) will be updated automatically on next insert
        // since new inserts use the prod user_id
      } else {
        logger.info('No rows found in BigQuery to update');
      }
    } catch (bigQueryError) {
      logger.error('Error updating BigQuery:', bigQueryError);
      throw new HttpsError('internal', `Failed to update BigQuery: ${bigQueryError instanceof Error ? bigQueryError.message : 'Unknown error'}`);
    }
    
    return {
      success: true,
      message: `Successfully fixed BigQuery data for ${normalizedEmail}`,
      bigQueryRowsUpdated,
    };
  } catch (error) {
    logger.error('Error fixing BigQuery data:', error);
    throw new HttpsError('internal', `Failed to fix BigQuery data: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Bulk migration function to migrate all remaining dev users
export const migrateAllUsers = onCall({
  cors: true, // Allow all origins for callable functions
  maxInstances: 1,
  timeoutSeconds: 540, // 9 minutes (max for 2nd gen functions)
  memory: '512MiB',
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { secretToken, batchSize = 10 } = request.data || {};
    const uid = request.auth?.uid;
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Migrate all users called by authenticated user:', uid);
    } else {
      logger.info('Migrate all users called with secret token');
    }

    // Get Clerk clients
    const devSecretKey = CLERK_SECRET_KEY_DEV.value();
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    
    if (!devSecretKey || !prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Clerk secret keys not configured');
    }
    
    const devClient = createClerkClient({ secretKey: devSecretKey });
    const prodClient = createClerkClient({ secretKey: prodSecretKey });

    // Get all users that need migration (instance = 'dev' and migrated = false)
    logger.info('Fetching users that need migration...');
    
    // Query for all dev users in migration table (Firestore doesn't handle missing fields well in compound queries)
    // We'll filter in memory for users that aren't migrated
    // Limit to smaller batches to avoid timeout
    const migrationSnapshot = await firestore.collection('userMigrations')
      .where('instance', '==', 'dev')
      .limit(200) // Reduced limit to speed up query
      .get();
    
    logger.info(`Total users in migration table with instance='dev': ${migrationSnapshot.size}`);
    
    // Filter in memory for users that aren't migrated (optimized filter)
    const allDevUsers = migrationSnapshot.docs.filter(doc => {
      const data = doc.data();
      return data.instance === 'dev' && (!data.migrated || data.migrated === false);
    });
    
    logger.info(`Found ${allDevUsers.length} unmigrated dev users`);
    
    // Limit to 20 for this batch to avoid timeout (can run multiple times)
    const usersToMigrate = allDevUsers.slice(0, 20).map(doc => ({
      email: doc.id,
      data: doc.data(),
    }));
    
    logger.info(`Processing ${usersToMigrate.length} users in this batch`);
    
    if (usersToMigrate.length === 0) {
      return {
        success: true,
        message: 'No users found that need migration',
        totalUsers: 0,
        migratedUsers: 0,
        failedUsers: 0,
        results: [],
      };
    }
    
    const results: Array<{
      email: string;
      success: boolean;
      message?: string;
      error?: string;
    }> = [];
    
    let migratedCount = 0;
    let failedCount = 0;
    
    // Migrate users in batches (smaller batches to avoid timeout)
    const actualBatchSize = Math.min(batchSize || 2, 2); // Max 2 at a time to avoid timeouts
    for (let i = 0; i < usersToMigrate.length; i += actualBatchSize) {
      const batch = usersToMigrate.slice(i, i + actualBatchSize);
      logger.info(`Processing batch ${Math.floor(i / actualBatchSize) + 1} (${batch.length} users)...`);
      
        // Process batch sequentially to avoid rate limits
        for (const user of batch) {
          const normalizedEmail = user.email.toLowerCase().trim();
          // Reduced logging to speed up execution
          if (i % 10 === 0) {
            logger.info(`Migrating user ${normalizedEmail} (${i + batch.indexOf(user) + 1}/${usersToMigrate.length})...`);
          }
        
        try {
          const migrationRef = firestore.collection('userMigrations').doc(normalizedEmail);
          const migrationData = user.data;
          
          if (migrationData.migrated) {
            results.push({
              email: normalizedEmail,
              success: true,
              message: 'Already migrated',
            });
            continue;
          }
          
          const devClerkUserId = migrationData.devClerkUserId;
          if (!devClerkUserId) {
            throw new Error('devClerkUserId missing from migration record');
          }
          
          // Fetch user from dev instance
          const devUser = await devClient.users.getUser(devClerkUserId);
          
          // Create user in prod instance
          let prodUser;
          try {
            const email = devUser.emailAddresses?.[0]?.emailAddress || normalizedEmail;
            
            // Validate email
            if (!email || !email.includes('@')) {
              throw new Error(`Invalid email address: ${email}`);
            }
            
            // Check if user already exists in prod first
            try {
              const existingUsers = await prodClient.users.getUserList({
                emailAddress: [normalizedEmail],
                limit: 1,
              });
              if (existingUsers.data.length > 0) {
                prodUser = existingUsers.data[0];
                logger.info(`User already exists in prod: ${prodUser.id}`);
              }
            } catch (lookupError) {
              logger.warn(`Error checking for existing user ${normalizedEmail}:`, lookupError);
              // Continue to try creating
            }
            
            // If user doesn't exist, create them
            if (!prodUser) {
              const createUserData: {
                emailAddress: string[];
                firstName?: string;
                lastName?: string;
                username?: string;
                publicMetadata?: Record<string, unknown>;
                privateMetadata?: Record<string, unknown>;
                unsafeMetadata?: Record<string, unknown>;
                skipPasswordChecks?: boolean;
                skipPasswordRequirement?: boolean;
              } = {
                emailAddress: [email],
                skipPasswordChecks: true,
                skipPasswordRequirement: true,
              };
              
              // Only add fields if they have valid values
              if (devUser.firstName && devUser.firstName.trim()) {
                createUserData.firstName = devUser.firstName.trim();
              }
              if (devUser.lastName && devUser.lastName.trim()) {
                createUserData.lastName = devUser.lastName.trim();
              }
              if (devUser.username && devUser.username.trim()) {
                createUserData.username = devUser.username.trim();
              }
              if (devUser.publicMetadata && Object.keys(devUser.publicMetadata).length > 0) {
                createUserData.publicMetadata = devUser.publicMetadata as Record<string, unknown>;
              }
              if (devUser.privateMetadata && Object.keys(devUser.privateMetadata).length > 0) {
                createUserData.privateMetadata = devUser.privateMetadata as Record<string, unknown>;
              }
              if (devUser.unsafeMetadata && Object.keys(devUser.unsafeMetadata).length > 0) {
                createUserData.unsafeMetadata = devUser.unsafeMetadata as Record<string, unknown>;
              }
              
              logger.info(`Creating user in prod: ${email}`);
              prodUser = await prodClient.users.createUser(createUserData);
              logger.info(`Created user in prod: ${prodUser.id}`);
            }
          } catch (error: unknown) {
            const clerkError = error as { 
              errors?: Array<{ code?: string; message?: string; longMessage?: string }>; 
              status?: number;
              message?: string;
            };
            
            logger.error(`Error creating user ${normalizedEmail}:`, {
              error: clerkError,
              code: clerkError?.errors?.[0]?.code,
              message: clerkError?.errors?.[0]?.message,
              longMessage: clerkError?.errors?.[0]?.longMessage,
              status: clerkError?.status,
            });
            
            // Try to find user one more time if it's a duplicate error
            if (clerkError?.errors?.[0]?.code === 'duplicate_record' || 
                clerkError?.status === 422 ||
                clerkError?.message?.toLowerCase().includes('already exists')) {
              try {
                const existingUsers = await prodClient.users.getUserList({
                  emailAddress: [normalizedEmail],
                  limit: 1,
                });
                if (existingUsers.data.length > 0) {
                  prodUser = existingUsers.data[0];
                  logger.info(`Found existing user in prod after error: ${prodUser.id}`);
                } else {
                  throw new Error(`User exists but could not be found: ${clerkError?.errors?.[0]?.message || clerkError?.message}`);
                }
              } catch {
                throw new Error(`Failed to create or find user: ${clerkError?.errors?.[0]?.message || clerkError?.message || 'Unknown error'}`);
              }
            } else {
              throw new Error(`Failed to create user: ${clerkError?.errors?.[0]?.message || clerkError?.message || 'Unknown error'} (${clerkError?.errors?.[0]?.code || 'unknown'})`);
            }
          }
          
          const prodClerkUserId = prodUser.id;
          
          // Update Firestore documents
          const checksSnapshot = await firestore.collection('checks')
            .where('userId', '==', devClerkUserId)
            .get();
          
          if (!checksSnapshot.empty) {
            const checksBatch = firestore.batch();
            checksSnapshot.docs.forEach(doc => {
              checksBatch.update(doc.ref, { userId: prodClerkUserId });
            });
            await checksBatch.commit();
          }
          
          const webhooksSnapshot = await firestore.collection('webhooks')
            .where('userId', '==', devClerkUserId)
            .get();
          
          if (!webhooksSnapshot.empty) {
            const webhooksBatch = firestore.batch();
            webhooksSnapshot.docs.forEach(doc => {
              webhooksBatch.update(doc.ref, { userId: prodClerkUserId });
            });
            await webhooksBatch.commit();
          }
          
          const emailSettingsRef = firestore.collection('emailSettings').doc(devClerkUserId);
          const emailSettingsDoc = await emailSettingsRef.get();
          if (emailSettingsDoc.exists) {
            const emailSettingsData = emailSettingsDoc.data()!;
            const newEmailSettingsRef = firestore.collection('emailSettings').doc(prodClerkUserId);
            await newEmailSettingsRef.set(emailSettingsData);
            await emailSettingsRef.delete();
          }
          
          const apiKeysSnapshot = await firestore.collection('apiKeys')
            .where('userId', '==', devClerkUserId)
            .get();
          
          if (!apiKeysSnapshot.empty) {
            const apiKeysBatch = firestore.batch();
            apiKeysSnapshot.docs.forEach(doc => {
              apiKeysBatch.update(doc.ref, { userId: prodClerkUserId });
            });
            await apiKeysBatch.commit();
          }
          
            // Skip BigQuery updates during bulk migration to avoid timeout
            // BigQuery can be updated later using the fixBigQueryData function
            logger.info(`Skipping BigQuery update for ${normalizedEmail} during bulk migration (use fixBigQueryData later)`);
          
          // Update migration record
          await migrationRef.set({
            email: normalizedEmail,
            devClerkUserId,
            prodClerkUserId,
            instance: 'prod' as const,
            migrated: true,
            migratedAt: Date.now(),
            createdAt: migrationData.createdAt,
            updatedAt: Date.now(),
          }, { merge: true });
          
          migratedCount++;
          results.push({
            email: normalizedEmail,
            success: true,
            message: 'Migrated successfully',
          });
          
          logger.info(`Successfully migrated ${normalizedEmail}`);
        } catch (error) {
          failedCount++;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const errorDetails = error instanceof Error ? {
            message: error.message,
            stack: error.stack,
          } : String(error);
          logger.error(`Failed to migrate ${normalizedEmail}:`, {
            error: errorDetails,
            email: normalizedEmail,
          });
          results.push({
            email: normalizedEmail,
            success: false,
            error: errorMessage,
          });
        }
      }
      
      // Small delay between batches to avoid rate limits (reduced delay)
      if (i + actualBatchSize < usersToMigrate.length) {
        await new Promise(resolve => setTimeout(resolve, 300)); // Reduced to 300ms
      }
    }
    
    logger.info(`Bulk migration complete: ${migratedCount} migrated, ${failedCount} failed`);
    
    return {
      success: true,
      message: `Bulk migration complete: ${migratedCount} users migrated, ${failedCount} failed`,
      totalUsers: usersToMigrate.length,
      migratedUsers: migratedCount,
      failedUsers: failedCount,
      results: results.slice(0, 100), // Limit results to first 100 to avoid response size limits
    };
  } catch (error) {
    logger.error('Error in bulk migration:', error);
    throw new HttpsError('internal', `Failed to migrate users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Validation function to verify all migrated users and their data
export const validateMigration = onCall({
  cors: true,
  maxInstances: 1,
  timeoutSeconds: 540, // 9 minutes (max for 2nd gen functions)
  memory: '512MiB',
  secrets: [CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD],
}, async (request) => {
  try {
    const { secretToken } = request.data || {};
    const uid = request.auth?.uid;
    
    // Check secret token (temporary for migration)
    const validSecretToken = process.env.MIGRATE_SECRET_TOKEN || 'migration-migrate-2024';
    const hasValidToken = secretToken === validSecretToken;
    
    // If no valid token, require authentication
    if (!hasValidToken) {
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Authentication required or provide valid secretToken');
      }
      logger.info('Validate migration called by authenticated user:', uid);
    } else {
      logger.info('Validate migration called with secret token');
    }

    // Get Clerk clients
    const devSecretKey = CLERK_SECRET_KEY_DEV.value();
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    
    if (!devSecretKey || !prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Clerk secret keys not configured');
    }
    
    const prodClient = createClerkClient({ secretKey: prodSecretKey });

    logger.info('Starting migration validation...');
    
    // Get all migrated users (limit to avoid timeout)
    const migrationSnapshot = await firestore.collection('userMigrations')
      .where('migrated', '==', true)
      .limit(50) // Limit to 50 users per validation to avoid timeout
      .get();
    
    logger.info(`Found ${migrationSnapshot.size} migrated users to validate`);
    
    const results: Array<{
      email: string;
      valid: boolean;
      issues: string[];
      checksCount?: number;
      webhooksCount?: number;
      apiKeysCount?: number;
      hasEmailSettings?: boolean;
      prodUserExists?: boolean;
    }> = [];
    
    let validCount = 0;
    let invalidCount = 0;
    
    // Process users in smaller batches to avoid timeout
    const batchSize = 5;
    for (let i = 0; i < migrationSnapshot.docs.length; i += batchSize) {
      const batch = migrationSnapshot.docs.slice(i, i + batchSize);
      logger.info(`Validating batch ${Math.floor(i / batchSize) + 1} (${batch.length} users)...`);
      
      // Process batch in parallel for speed
      const batchPromises = batch.map(async (doc) => {
        const normalizedEmail = doc.id;
        const migrationData = doc.data();
        const issues: string[] = [];
        
        const prodClerkUserId = migrationData.prodClerkUserId;
        
        // Verify prod user exists (most important check)
        let prodUserExists = false;
        try {
          if (prodClerkUserId) {
            await prodClient.users.getUser(prodClerkUserId);
            prodUserExists = true;
          } else {
            issues.push('prodClerkUserId missing');
          }
        } catch {
          issues.push('Prod user not found in Clerk');
        }
        
        // Quick checks for data migration (simplified to avoid timeout)
        let checksCount = 0;
        let webhooksCount = 0;
        let apiKeysCount = 0;
        let hasEmailSettings = false;
        
        if (prodClerkUserId && prodUserExists) {
          // Count checks (quick check)
          try {
            const checksSnapshot = await firestore.collection('checks')
              .where('userId', '==', prodClerkUserId)
              .limit(1) // Just check if any exist, don't count all
              .get();
            checksCount = checksSnapshot.size > 0 ? 1 : 0; // Simplified: just indicate if checks exist
          } catch {
            // Skip if query fails
          }
          
          // Count webhooks (quick check)
          try {
            const webhooksSnapshot = await firestore.collection('webhooks')
              .where('userId', '==', prodClerkUserId)
              .limit(1)
              .get();
            webhooksCount = webhooksSnapshot.size > 0 ? 1 : 0;
          } catch {
            // Skip if query fails
          }
          
          // Count API keys (quick check)
          try {
            const apiKeysSnapshot = await firestore.collection('apiKeys')
              .where('userId', '==', prodClerkUserId)
              .limit(1)
              .get();
            apiKeysCount = apiKeysSnapshot.size > 0 ? 1 : 0;
          } catch {
            // Skip if query fails
          }
          
          // Check email settings
          try {
            const emailSettingsRef = firestore.collection('emailSettings').doc(prodClerkUserId);
            const emailSettingsDoc = await emailSettingsRef.get();
            hasEmailSettings = emailSettingsDoc.exists;
          } catch {
            // Skip if query fails
          }
        }
        
        const isValid = issues.length === 0 && prodUserExists;
        
        return {
          email: normalizedEmail,
          valid: isValid,
          issues,
          checksCount,
          webhooksCount,
          apiKeysCount,
          hasEmailSettings,
          prodUserExists,
        };
      });
      
      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);
      
      // Count valid/invalid
      for (const result of batchResults) {
        if (result.valid) {
          validCount++;
        } else {
          invalidCount++;
        }
        results.push(result);
      }
      
      // Small delay between batches
      if (i + batchSize < migrationSnapshot.docs.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    logger.info(`Validation complete: ${validCount} valid, ${invalidCount} invalid`);
    
    return {
      success: true,
      message: `Validation complete: ${validCount} users valid, ${invalidCount} users have issues`,
      totalUsers: migrationSnapshot.size,
      validUsers: validCount,
      invalidUsers: invalidCount,
      results: results.slice(0, 200), // Limit to first 200 to avoid response size limits
    };
  } catch (error) {
    logger.error('Error validating migration:', error);
    throw new HttpsError('internal', `Failed to validate migration: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Get admin statistics (admin only)
export const getAdminStats = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  logger.info('getAdminStats called by user:', uid);

  try {
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // Get total users count from Clerk (prod instance)
    // IMPORTANT: Always use prod instance for admin stats
    // Use CLERK_SECRET_KEY_PROD explicitly to avoid confusion with CLERK_SECRET_KEY
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    if (!prodSecretKey) {
      throw new Error('Clerk prod secret key (CLERK_SECRET_KEY_PROD) not found. Please ensure it is set via firebase functions:secrets:set CLERK_SECRET_KEY_PROD');
    }
    
    const prodClient = createClerkClient({ secretKey: prodSecretKey });
    logger.info('Using Clerk prod client for admin stats (explicitly initialized from CLERK_SECRET_KEY_PROD)');

    // Get total count from Clerk
    const clerkUsers = await prodClient.users.getUserList({
      limit: 1, // Just need the total count
    });
    const totalUsers = clerkUsers.totalCount || 0;
    logger.info(`Total users from prod Clerk: ${totalUsers}`);

    // Get all checks data for detailed stats
    const checksSnapshot = await firestore.collection('checks').get();
    const totalChecks = checksSnapshot.size;
    
    // Calculate checks by status
    const checksByStatus = {
      online: 0,
      offline: 0,
      unknown: 0,
      disabled: 0,
    };
    
    const uniqueUserIds = new Set<string>();
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    let recentChecks = 0;
    
    checksSnapshot.forEach(doc => {
      const check = doc.data();
      uniqueUserIds.add(check.userId);
      
      // Count by status
      if (check.disabled) {
        checksByStatus.disabled++;
      } else if (check.status === 'UP' || check.status === 'online') {
        checksByStatus.online++;
      } else if (check.status === 'DOWN' || check.status === 'offline') {
        checksByStatus.offline++;
      } else {
        checksByStatus.unknown++;
      }
      
      // Count recent checks (created in last 7 days)
      if (check.createdAt && check.createdAt >= sevenDaysAgo) {
        recentChecks++;
      }
    });
    
    const activeUsers = uniqueUserIds.size;
    const averageChecksPerUser = totalUsers > 0 ? (totalChecks / totalUsers) : 0;

    // Get total webhooks count
    const webhooksSnapshot = await firestore.collection('webhooks').count().get();
    const totalWebhooks = webhooksSnapshot.data().count || 0;

    // Get enabled webhooks count
    const enabledWebhooksSnapshot = await firestore.collection('webhooks')
      .where('enabled', '==', true)
      .count()
      .get();
    const enabledWebhooks = enabledWebhooksSnapshot.data().count || 0;

    // Get recent users (created in last 7 days) - approximate from Clerk
    // Use the same explicit prod client
    let recentUsers = 0;
    try {
      const recentClerkUsers = await prodClient.users.getUserList({
        limit: 500, // Get recent users (Clerk doesn't support date filtering directly)
      });
      recentUsers = recentClerkUsers.data.filter(user => {
        const createdAt = user.createdAt || 0;
        return createdAt >= sevenDaysAgo;
      }).length;
      logger.info(`Found ${recentUsers} recent users from prod Clerk`);
    } catch (error) {
      logger.error('Error getting recent users from Clerk:', error);
      recentUsers = 0;
    }

    // Get total check executions count from BigQuery
    let totalCheckExecutions = 0;
    let recentCheckExecutions = 0;
    try {
      // Use parameterized query for total count
      const query = `
        SELECT COUNT(*) as total
        FROM \`exit1-dev.checks.check_history\`
      `;
      const [rows] = await bigquery.query({ query });
      if (rows && rows.length > 0) {
        const row = rows[0] as { total: number | string };
        totalCheckExecutions = Number(row.total) || 0;
      }
      
      // Get recent check executions (last 7 days) using parameterized query with Date object
      const recentQuery = `
        SELECT COUNT(*) as total
        FROM \`exit1-dev.checks.check_history\`
        WHERE timestamp >= @startDate
      `;
      const [recentRows] = await bigquery.query({
        query: recentQuery,
        params: {
          startDate: new Date(sevenDaysAgo)
        }
      });
      if (recentRows && recentRows.length > 0) {
        const row = recentRows[0] as { total: number | string };
        recentCheckExecutions = Number(row.total) || 0;
      }
    } catch (error) {
      logger.error('Error getting check executions from BigQuery:', error);
      // Log the full error for debugging
      if (error instanceof Error) {
        logger.error('BigQuery error details:', {
          message: error.message,
          stack: error.stack
        });
      }
      // Don't fail the whole request if BigQuery query fails
      totalCheckExecutions = 0;
      recentCheckExecutions = 0;
    }

    // Get badge usage stats
    let checksWithBadges = 0;
    let totalBadgeViews = 0;
    let recentBadgeViews = 0;
    let uniqueDomainsWithBadges = 0;
    try {
      // Count unique checks with badges (from badge_stats collection)
      const badgeStatsSnapshot = await firestore.collection('badge_stats').get();
      checksWithBadges = badgeStatsSnapshot.size;
      
      // Sum total views from all badge stats
      badgeStatsSnapshot.forEach(doc => {
        const data = doc.data();
        const views = data.totalViews || 0;
        totalBadgeViews += typeof views === 'number' ? views : 0;
      });

      // Get unique domains from badge_views collection (where badges are actually displayed)
      // This counts domains where badges are installed, not domains being checked
      const uniqueDomains = new Set<string>();
      const badgeViewsSnapshot = await firestore.collection('badge_views')
        .where('domain', '!=', null)
        .get();
      
      badgeViewsSnapshot.forEach(doc => {
        const domain = doc.data().domain;
        if (domain && typeof domain === 'string') {
          uniqueDomains.add(domain);
        }
      });

      uniqueDomainsWithBadges = uniqueDomains.size;

      // Count recent badge views (last 7 days)
      const recentBadgeViewsSnapshot = await firestore.collection('badge_views')
        .where('timestamp', '>=', sevenDaysAgo)
        .count()
        .get();
      recentBadgeViews = recentBadgeViewsSnapshot.data().count || 0;
    } catch (error) {
      logger.warn('Error getting badge stats:', error);
      // Don't fail the whole request if badge stats fail
      checksWithBadges = 0;
      totalBadgeViews = 0;
      recentBadgeViews = 0;
      uniqueDomainsWithBadges = 0;
    }

    logger.info(`Admin stats: ${totalUsers} users, ${totalChecks} checks, ${totalCheckExecutions} check executions, ${checksWithBadges} checks with badges, ${uniqueDomainsWithBadges} unique domains with badges installed`);

    return {
      success: true,
      data: {
        totalUsers,
        activeUsers,
        totalChecks,
        totalCheckExecutions,
        totalWebhooks,
        enabledWebhooks,
        checksByStatus,
        averageChecksPerUser: Math.round(averageChecksPerUser * 10) / 10, // Round to 1 decimal
        recentActivity: {
          newUsers: recentUsers,
          newChecks: recentChecks,
          checkExecutions: recentCheckExecutions,
        },
        badgeUsage: {
          checksWithBadges,
          uniqueDomainsWithBadges, // Count of unique domains where badges are installed
          totalBadgeViews,
          recentBadgeViews,
        },
      },
    };
  } catch (error) {
    logger.error('Error getting admin stats:', error);
    throw new Error(`Failed to get admin stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Get list of all domains with badges installed (admin only)
export const getBadgeDomains = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Authentication required");
  }

  logger.info('getBadgeDomains called by user:', uid);

  try {
    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin
    // The frontend already ensures only admin users can access this function

    // Get all badge views with domains
    const badgeViewsSnapshot = await firestore.collection('badge_views')
      .where('domain', '!=', null)
      .get();
    
    // Group by domain: which checks are displayed on each domain
    const domainMap = new Map<string, {
      domain: string;
      checks: Map<string, {
        checkId: string;
        checkName?: string;
        checkUrl?: string; // The URL being checked (not where badge is displayed)
        viewCount: number;
        firstSeen: number;
        lastSeen: number;
      }>;
      totalViews: number;
    }>();

    // Process all badge views
    for (const doc of badgeViewsSnapshot.docs) {
      const data = doc.data();
      const domain = data.domain as string;
      const checkId = data.checkId as string;
      
      if (!domain || !checkId) continue;
      
      if (!domainMap.has(domain)) {
        domainMap.set(domain, {
          domain,
          checks: new Map(),
          totalViews: 0,
        });
      }
      
      const domainInfo = domainMap.get(domain)!;
      domainInfo.totalViews++;
      
      // Track this check on this domain
      if (!domainInfo.checks.has(checkId)) {
        // Get check details
        const checkDoc = await firestore.collection('checks').doc(checkId).get();
        const checkData = checkDoc.data();
        
        domainInfo.checks.set(checkId, {
          checkId,
          checkName: checkData?.name,
          checkUrl: checkData?.url, // The URL being monitored
          viewCount: 0,
          firstSeen: data.timestamp || data.createdAt || Date.now(),
          lastSeen: data.timestamp || data.createdAt || Date.now(),
        });
      }
      
      // Update view count and last seen
      const checkInfo = domainInfo.checks.get(checkId)!;
      checkInfo.viewCount++;
      if (data.timestamp && data.timestamp > checkInfo.lastSeen) {
        checkInfo.lastSeen = data.timestamp;
      }
      if (data.timestamp && data.timestamp < checkInfo.firstSeen) {
        checkInfo.firstSeen = data.timestamp;
      }
    }

    // Convert to array format
    const domains = Array.from(domainMap.values())
      .map(domainInfo => ({
        domain: domainInfo.domain,
        checks: Array.from(domainInfo.checks.values()),
        totalViews: domainInfo.totalViews,
      }))
      .sort((a, b) => b.totalViews - a.totalViews); // Sort by total views

    return {
      success: true,
      data: {
        totalDomains: domains.length,
        domains,
      },
    };
  } catch (error) {
    logger.error('Error getting badge domains:', error);
    throw new Error(`Failed to get badge domains: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// Diagnose and fix user alert settings (admin only)
export const diagnoseUserAlerts = onCall({
  cors: true,
  maxInstances: 10,
  secrets: [CLERK_SECRET_KEY_PROD],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  try {
    const { email, fix = false } = request.data || {};
    if (!email || typeof email !== 'string') {
      throw new HttpsError('invalid-argument', 'Email is required');
    }

    logger.info(`diagnoseUserAlerts called by user ${uid} for email: ${email}, fix: ${fix}`);

    // Note: Admin verification is handled on the frontend using Clerk's publicMetadata.admin

    // Find user by email
    const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
    if (!prodSecretKey) {
      throw new HttpsError('failed-precondition', 'Clerk configuration not found');
    }
    const clerkClient = createClerkClient({ secretKey: prodSecretKey });
    
    const normalizedEmail = email.toLowerCase().trim();
    const users = await clerkClient.users.getUserList({
      emailAddress: [normalizedEmail],
      limit: 1,
    });

    if (users.data.length === 0) {
      return {
        success: false,
        message: `No user found with email ${email}`,
      };
    }

    const user = users.data[0];
    const userId = user.id;
    logger.info(`Found user: ${userId} for email: ${email}`);

    const issues: string[] = [];
    const fixes: string[] = [];

    // Check email settings
    const emailDoc = await firestore.collection('emailSettings').doc(userId).get();
    if (emailDoc.exists) {
      const emailSettings = emailDoc.data() as { events?: string[]; recipient?: string };
      logger.info(`Email settings found: ${JSON.stringify(emailSettings)}`);
      
      if (!emailSettings.events || !Array.isArray(emailSettings.events)) {
        issues.push('Email settings: events array is missing or invalid');
        if (fix) {
          const defaultEvents = ['website_down', 'website_up', 'website_error', 'ssl_error', 'ssl_warning'];
          await firestore.collection('emailSettings').doc(userId).update({
            events: defaultEvents,
            updatedAt: Date.now(),
          });
          fixes.push('Added default events array to email settings');
        }
      } else if (!emailSettings.events.includes('website_up')) {
        issues.push('Email settings: website_up event is not enabled');
        if (fix) {
          const updatedEvents = [...emailSettings.events, 'website_up'];
          await firestore.collection('emailSettings').doc(userId).update({
            events: updatedEvents,
            updatedAt: Date.now(),
          });
          fixes.push('Added website_up to email settings events');
        }
      } else {
        logger.info('Email settings: website_up is enabled');
      }
    } else {
      issues.push('Email settings: No email settings found');
      if (fix) {
        const defaultEvents = ['website_down', 'website_up', 'website_error', 'ssl_error', 'ssl_warning'];
        await firestore.collection('emailSettings').doc(userId).set({
          userId,
          recipient: normalizedEmail,
          enabled: true,
          events: defaultEvents,
          minConsecutiveEvents: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        fixes.push('Created email settings with website_up enabled');
      }
    }

    // Check webhook settings
    const webhooksSnapshot = await firestore.collection('webhooks')
      .where('userId', '==', userId)
      .where('enabled', '==', true)
      .get();

    logger.info(`Found ${webhooksSnapshot.size} enabled webhooks for user ${userId}`);

    if (webhooksSnapshot.empty) {
      issues.push('Webhooks: No enabled webhooks found');
    } else {
      for (const doc of webhooksSnapshot.docs) {
        const webhook = doc.data() as { url?: string; events?: string[] };
        const webhookId = doc.id;
        
        if (!webhook.events || !Array.isArray(webhook.events)) {
          issues.push(`Webhook ${webhook.url || webhookId}: events array is missing or invalid`);
          if (fix) {
            const defaultEvents = ['website_down', 'website_up', 'website_error', 'ssl_error', 'ssl_warning'];
            await doc.ref.update({
              events: defaultEvents,
              updatedAt: Date.now(),
            });
            fixes.push(`Added default events array to webhook ${webhook.url || webhookId}`);
          }
        } else if (!webhook.events.includes('website_up')) {
          issues.push(`Webhook ${webhook.url || webhookId}: website_up event is not enabled`);
          if (fix) {
            const updatedEvents = [...webhook.events, 'website_up'];
            await doc.ref.update({
              events: updatedEvents,
              updatedAt: Date.now(),
            });
            fixes.push(`Added website_up to webhook ${webhook.url || webhookId} events`);
          }
        } else {
          logger.info(`Webhook ${webhook.url || webhookId}: website_up is enabled`);
        }
      }
    }

    return {
      success: true,
      userId,
      email: normalizedEmail,
      issues,
      fixes: fix ? fixes : [],
      message: issues.length === 0 
        ? 'No issues found - website_up is enabled for all alerts'
        : fix 
          ? `Found ${issues.length} issue(s) and fixed ${fixes.length} of them`
          : `Found ${issues.length} issue(s). Set fix=true to automatically fix them`,
    };
  } catch (error) {
    logger.error('Error diagnosing user alerts:', error);
    throw new HttpsError('internal', `Failed to diagnose user alerts: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

