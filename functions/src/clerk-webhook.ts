import { onRequest } from "firebase-functions/v2/https";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { Webhook } from 'svix';
import { Resend } from 'resend';
import { createClerkClient } from '@clerk/backend';
import {
  RESEND_API_KEY,
  CLERK_WEBHOOK_SECRET,
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
} from "./env";

// Type for Clerk user.created webhook payload
interface ClerkUserCreatedEvent {
  data: {
    id: string;
    email_addresses: Array<{
      id: string;
      email_address: string;
    }>;
    primary_email_address_id: string;
    first_name: string | null;
    last_name: string | null;
    created_at: number;
  };
  type: 'user.created';
}

// Helper to get Resend API key
const getResendApiKey = () => {
  try {
    return RESEND_API_KEY.value()?.trim();
  } catch {
    return process.env.RESEND_API_KEY?.trim();
  }
};

// Helper to get Clerk webhook secret
const getClerkWebhookSecret = () => {
  try {
    return CLERK_WEBHOOK_SECRET.value()?.trim();
  } catch {
    return process.env.CLERK_WEBHOOK_SECRET?.trim();
  }
};

// Helper to add a contact to Resend (global contacts)
async function addContactToResend(
  email: string,
  firstName?: string | null,
  lastName?: string | null,
  clerkUserId?: string
): Promise<{ success: boolean; contactId?: string; error?: string }> {
  const apiKey = getResendApiKey();

  if (!apiKey) {
    logger.error('Resend API key not configured');
    return { success: false, error: 'Resend API key not configured' };
  }

  const resend = new Resend(apiKey);

  try {
    // Don't set unsubscribed - let Resend use default (false) for new contacts
    // This avoids overriding existing contacts' subscription preferences
    const { data, error } = await resend.contacts.create({
      email,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
    });

    if (error) {
      if (error.message?.includes('already exists')) {
        logger.info('Contact already exists in Resend', { email });
        return { success: true };
      }
      logger.error('Failed to add contact to Resend', { email, error });
      return { success: false, error: error.message };
    }

    logger.info('Contact added to Resend', { email, contactId: data?.id, clerkUserId });
    return { success: true, contactId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Exception adding contact to Resend', { email, error: message });
    return { success: false, error: message };
  }
}

/**
 * Webhook endpoint for Clerk user.created events.
 * When a new user signs up in Clerk, this webhook adds them to Resend Contacts.
 */
export const clerkWebhook = onRequest({
  secrets: [RESEND_API_KEY, CLERK_WEBHOOK_SECRET],
  cors: false,
}, async (req, res) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const webhookSecret = getClerkWebhookSecret();
  if (!webhookSecret) {
    logger.error('Clerk webhook secret not configured');
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  // Verify the webhook signature using Svix
  const svixId = req.headers['svix-id'] as string;
  const svixTimestamp = req.headers['svix-timestamp'] as string;
  const svixSignature = req.headers['svix-signature'] as string;

  if (!svixId || !svixTimestamp || !svixSignature) {
    logger.warn('Missing Svix headers in Clerk webhook');
    res.status(400).json({ error: 'Missing webhook signature headers' });
    return;
  }

  let payload: ClerkUserCreatedEvent;

  try {
    const wh = new Webhook(webhookSecret);
    // Get raw body - Firebase Functions provides rawBody for signature verification
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody?.toString() || JSON.stringify(req.body);
    payload = wh.verify(rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkUserCreatedEvent;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    logger.error('Clerk webhook signature verification failed', { error: message });
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  // Only process user.created events
  if (payload.type !== 'user.created') {
    logger.info('Ignoring non-user.created event', { type: payload.type });
    res.status(200).json({ received: true, processed: false });
    return;
  }

  const user = payload.data;

  // Find the primary email address
  const primaryEmail = user.email_addresses.find(
    (e) => e.id === user.primary_email_address_id
  );

  if (!primaryEmail) {
    logger.warn('No primary email found for user', { userId: user.id });
    res.status(200).json({ received: true, processed: false, reason: 'no_primary_email' });
    return;
  }

  logger.info('Processing user.created webhook', {
    userId: user.id,
    email: primaryEmail.email_address,
    firstName: user.first_name,
    lastName: user.last_name,
  });

  const result = await addContactToResend(
    primaryEmail.email_address,
    user.first_name,
    user.last_name,
    user.id
  );

  if (result.success) {
    res.status(200).json({ received: true, processed: true, contactId: result.contactId });
  } else {
    // Still return 200 to prevent Clerk from retrying (we log the error)
    res.status(200).json({ received: true, processed: false, error: result.error });
  }
});

/**
 * Admin function to sync all existing Clerk users to Resend Contacts.
 * This is a one-time operation to backfill existing users.
 * Requires authentication.
 */
export const syncClerkUsersToResend = onCall({
  secrets: [RESEND_API_KEY, CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  // Get the instance to sync from (defaults to prod)
  const { instance = 'prod', dryRun = false } = request.data || {};

  if (instance !== 'prod' && instance !== 'dev') {
    throw new HttpsError('invalid-argument', 'Instance must be "prod" or "dev"');
  }

  // Get the appropriate Clerk secret key
  let secretKey: string | null = null;
  try {
    if (instance === 'prod') {
      secretKey = CLERK_SECRET_KEY_PROD.value()?.trim() || null;
    } else {
      secretKey = CLERK_SECRET_KEY_DEV.value()?.trim() || null;
    }
  } catch {
    secretKey = instance === 'prod'
      ? process.env.CLERK_SECRET_KEY_PROD?.trim() || null
      : process.env.CLERK_SECRET_KEY_DEV?.trim() || null;
  }

  if (!secretKey) {
    throw new HttpsError('failed-precondition', `Clerk ${instance} secret key not configured`);
  }

  const apiKey = getResendApiKey();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'Resend API key not configured');
  }

  const clerk = createClerkClient({ secretKey });
  const resend = new Resend(apiKey);

  const stats = {
    total: 0,
    synced: 0,
    skipped: 0,
    errors: 0,
    dryRun,
  };

  const errors: Array<{ email: string; error: string }> = [];

  try {
    // Paginate through all users
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await clerk.users.getUserList({
        limit,
        offset,
      });

      const users = response.data;

      if (users.length === 0) {
        hasMore = false;
        break;
      }

      for (const user of users) {
        stats.total++;

        // Find the primary email
        const primaryEmail = user.emailAddresses.find(
          (e) => e.id === user.primaryEmailAddressId
        );

        if (!primaryEmail) {
          logger.warn('Skipping user without primary email', { userId: user.id });
          stats.skipped++;
          continue;
        }

        if (dryRun) {
          logger.info('[DRY RUN] Would sync user', {
            userId: user.id,
            email: primaryEmail.emailAddress,
            firstName: user.firstName,
            lastName: user.lastName,
          });
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
              logger.info('Contact already exists', { email: primaryEmail.emailAddress });
              stats.skipped++;
            } else {
              logger.error('Failed to sync user', {
                email: primaryEmail.emailAddress,
                error: error.message,
              });
              stats.errors++;
              errors.push({ email: primaryEmail.emailAddress, error: error.message });
            }
          } else {
            stats.synced++;
            logger.info('Synced user to Resend', { email: primaryEmail.emailAddress });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          stats.errors++;
          errors.push({ email: primaryEmail.emailAddress, error: message });
        }

        // Delay to respect Resend rate limit (2 req/sec)
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      offset += limit;

      // Check if we've reached the end
      if (users.length < limit) {
        hasMore = false;
      }
    }

    logger.info('Sync completed', stats);

    return {
      success: true,
      stats,
      errors: errors.slice(0, 10), // Return first 10 errors only
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    logger.error('Sync failed', { error: message });
    throw new HttpsError('internal', message);
  }
});
