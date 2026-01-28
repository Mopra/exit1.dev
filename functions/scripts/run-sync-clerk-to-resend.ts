/**
 * Script to run syncClerkUsersToResend locally
 * Run with: npx ts-node scripts/run-sync-clerk-to-resend.ts
 */

import { createClerkClient } from '@clerk/backend';
import { Resend } from 'resend';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY_PROD;

// Resend rate limit: 2 requests per second, so 600ms delay to be safe
const RATE_LIMIT_DELAY_MS = 600;

async function syncClerkUsersToResend(dryRun: boolean = true) {
  console.log(`\n🚀 Starting Clerk → Resend sync (dryRun: ${dryRun})\n`);

  if (!CLERK_SECRET_KEY) {
    console.error('❌ CLERK_SECRET_KEY_PROD not found in environment');
    process.exit(1);
  }

  if (!RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY not found in environment');
    process.exit(1);
  }

  const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });
  const resend = new Resend(RESEND_API_KEY);

  const stats = {
    total: 0,
    synced: 0,
    skipped: 0,
    errors: 0,
  };

  const errors: Array<{ email: string; error: string }> = [];

  try {
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      console.log(`📥 Fetching users (offset: ${offset})...`);

      const response = await clerk.users.getUserList({
        limit,
        offset,
      });

      const users = response.data;

      if (users.length === 0) {
        hasMore = false;
        break;
      }

      console.log(`   Found ${users.length} users in this batch`);

      for (const user of users) {
        stats.total++;

        const primaryEmail = user.emailAddresses.find(
          (e) => e.id === user.primaryEmailAddressId
        );

        if (!primaryEmail) {
          console.log(`   ⏭️  Skipping user ${user.id} - no primary email`);
          stats.skipped++;
          continue;
        }

        if (dryRun) {
          console.log(`   📋 [DRY RUN] Would sync: ${primaryEmail.emailAddress} (${user.firstName} ${user.lastName})`);
          stats.synced++;
          continue;
        }

        try {
          // Don't set unsubscribed - preserves existing contacts' subscription preferences
          const { error } = await resend.contacts.create({
            email: primaryEmail.emailAddress,
            firstName: user.firstName || undefined,
            lastName: user.lastName || undefined,
          });

          if (error) {
            if (error.message?.includes('already exists')) {
              console.log(`   ⏭️  Already exists: ${primaryEmail.emailAddress}`);
              stats.skipped++;
            } else {
              console.log(`   ❌ Error: ${primaryEmail.emailAddress} - ${error.message}`);
              stats.errors++;
              errors.push({ email: primaryEmail.emailAddress, error: error.message });
            }
          } else {
            console.log(`   ✅ Synced: ${primaryEmail.emailAddress}`);
            stats.synced++;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.log(`   ❌ Exception: ${primaryEmail.emailAddress} - ${message}`);
          stats.errors++;
          errors.push({ email: primaryEmail.emailAddress, error: message });
        }

        // Delay to respect Resend rate limit (2 req/sec)
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
      }

      offset += limit;

      if (users.length < limit) {
        hasMore = false;
      }
    }

    console.log('\n📊 Sync completed!\n');
    console.log('Stats:');
    console.log(`   Total users:  ${stats.total}`);
    console.log(`   Synced:       ${stats.synced}`);
    console.log(`   Skipped:      ${stats.skipped}`);
    console.log(`   Errors:       ${stats.errors}`);

    if (errors.length > 0) {
      console.log('\nErrors:');
      errors.slice(0, 10).forEach(({ email, error }) => {
        console.log(`   ${email}: ${error}`);
      });
    }

    if (dryRun) {
      console.log('\n⚠️  This was a DRY RUN. No changes were made.');
      console.log('   Run with dryRun=false to actually sync users.\n');
    }

  } catch (err) {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  }
}

// Parse command line args
const args = process.argv.slice(2);
const dryRun = !args.includes('--no-dry-run');

syncClerkUsersToResend(dryRun);
