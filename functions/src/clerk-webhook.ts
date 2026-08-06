import { onRequest } from "firebase-functions/v2/https";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { Webhook } from 'svix';
import { Resend } from 'resend';
import { createClerkClient } from '@clerk/backend';
import { BigQuery } from '@google-cloud/bigquery';
import {
  RESEND_API_KEY,
  DAY3_API_KEY,
  getDay3ApiKey,
  CLERK_WEBHOOK_SECRET,
  CLERK_SECRET_KEY_PROD,
  CLERK_SECRET_KEY_DEV,
} from "./env";
import { firestore, getUserTierLive, tierFromPlanKey, TIER_RANK } from "./init";
import type { UserTier as InitUserTier } from "./init";
import {
  handlePlanDowngrade,
  handleProToFreeDowngrade,
  enforceTierCeiling,
  ceilingTightens,
  backfillCheckUserTier,
} from "./plan-enforcement";
import {
  registerResendSchema,
  RESEND_RATE_LIMIT_MS,
  syncContactTopics,
  triggerResendEvent,
  upsertContactProperties,
} from "./resend-sync";
import {
  buildPropertiesForUser,
  formatSignupDate,
  sleep,
  type OnboardingAnswers,
  type UserTier,
} from "./contact-model";
import { syncContactToProviders } from "./contact-sync";
import {
  batchUpsertDay3Contacts,
  chunkForDay3,
  dedupeByEmail,
  getDay3ContactCount,
  upsertDay3Contact,
  type Day3ContactInput,
} from "./day3-sync";
import { DAY3_BATCH_SIZE } from "./day3-config";
import { requireAdmin } from "./require-admin";

// Generic Clerk webhook payload — we handle multiple event types
interface ClerkWebhookPayload {
  data: Record<string, unknown>;
  type: string;
}

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

// Helper to add a contact to Resend (global contacts) with optional custom
// properties. If the contact already exists, we fall back to a properties-only
// update so new fields (plan_tier, signup_date) are still applied.
async function addContactToResend(
  email: string,
  firstName?: string | null,
  lastName?: string | null,
  clerkUserId?: string,
  properties?: Record<string, string>,
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
      ...(properties && Object.keys(properties).length > 0 ? { properties } : {}),
    });

    if (error) {
      if (error.message?.includes('already exists')) {
        logger.info('Contact already exists in Resend', { email });
        if (properties && Object.keys(properties).length > 0) {
          const updateResult = await upsertContactProperties(resend, email, properties, {
            firstName,
            lastName,
          });
          if (!updateResult.success) {
            logger.warn('Failed to update properties on existing contact', {
              email,
              error: updateResult.error,
            });
          }
        }
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

// Try prod Clerk secret first, fall back to dev — mirrors getUserTierLive's
// behaviour so subscription events from either instance resolve correctly.
async function fetchClerkUserEitherInstance(userId: string): Promise<{
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  signupDate: string | null;
}> {
  const keys: Array<[string, string | undefined]> = [];
  try { keys.push(['prod', CLERK_SECRET_KEY_PROD.value()?.trim()]); } catch { /* noop */ }
  try { keys.push(['dev', CLERK_SECRET_KEY_DEV.value()?.trim()]); } catch { /* noop */ }

  for (const [instance, key] of keys) {
    if (!key) continue;
    try {
      const client = createClerkClient({ secretKey: key });
      const user = await client.users.getUser(userId);
      const primary = user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
        ?? user.emailAddresses?.[0];
      return {
        email: primary?.emailAddress ?? null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        signupDate: formatSignupDate(user.createdAt),
      };
    } catch (e) {
      logger.debug(`Clerk ${instance} user lookup failed for ${userId}, trying next instance`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { email: null, firstName: null, lastName: null, signupDate: null };
}

// Push just the plan_tier property to a user's contact on both providers. Used
// by the subscription webhook after a tier change. In Day3 this is all that's
// needed for tier segmentation — its segments are live filters on plan_tier,
// so there is no membership sync to do.
async function pushTierProperty(userId: string, tier: UserTier): Promise<void> {
  const resendApiKey = getResendApiKey();
  const day3ApiKey = getDay3ApiKey();
  if (!resendApiKey && !day3ApiKey) {
    logger.info('No email provider configured; skipping plan_tier sync', { userId });
    return;
  }

  const { email, firstName, lastName } = await fetchClerkUserEitherInstance(userId);
  if (!email) {
    logger.warn('Cannot push plan_tier — email not resolvable', { userId });
    return;
  }

  const { resend, day3 } = await syncContactToProviders({
    email,
    firstName,
    lastName,
    properties: { plan_tier: tier },
    resendApiKey,
    day3ApiKey,
    userId,
  });

  if (resend.success) {
    logger.info('Pushed plan_tier property to Resend', { userId, email, tier });
  }
  if (day3.success) {
    logger.info('Pushed plan_tier property to Day3', { userId, email, tier });
  }

  // Stamp each provider independently so a failure on one doesn't make the
  // other's backfill skip this user.
  const stamps: Record<string, number> = {};
  if (resend.success) stamps.resendPropertiesSyncedAt = Date.now();
  if (day3.success) stamps.day3SyncedAt = Date.now();
  if (Object.keys(stamps).length === 0) return;

  try {
    await firestore.collection('users').doc(userId).set(stamps, { merge: true });
  } catch (e) {
    logger.debug('Failed to stamp contact sync timestamps', {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Webhook endpoint for Clerk events.
 * Handles:
 *   - user.created → adds to Resend Contacts (with signup_date + plan_tier + topic opt-in)
 *   - subscription.* → syncs tier from Clerk billing to Firestore + Resend plan_tier property
 */
export const clerkWebhook = onRequest({
  secrets: [RESEND_API_KEY, DAY3_API_KEY, CLERK_WEBHOOK_SECRET, CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
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

  let payload: ClerkWebhookPayload;

  try {
    const wh = new Webhook(webhookSecret);
    // Get raw body - Firebase Functions provides rawBody for signature verification
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody?.toString() || JSON.stringify(req.body);
    payload = wh.verify(rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkWebhookPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    logger.error('Clerk webhook signature verification failed', { error: message });
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  // Handle subscription/billing events — sync tier to Firestore immediately
  if (payload.type.startsWith('subscription.')) {
    // Clerk subscription events include user_id in the data payload
    const userId = typeof payload.data.user_id === 'string'
      ? payload.data.user_id
      : typeof payload.data.id === 'string'
        ? payload.data.id
        : null;

    if (!userId) {
      logger.warn('Subscription webhook missing user_id', { type: payload.type, data: payload.data });
      res.status(200).json({ received: true, processed: false, reason: 'no_user_id' });
      return;
    }

    logger.info('Processing subscription webhook — syncing tier', {
      type: payload.type,
      userId,
    });

    try {
      // Read the cached tier directly from Firestore — do NOT call getUserTier()
      // which may refresh from Clerk and return the new tier before we can compare.
      // Any legacy values ('scale', 'agency', 'premium') are migrated to the current shape.
      let previousTier: InitUserTier = 'free';
      try {
        const userSnap = await firestore.collection('users').doc(userId).get();
        if (userSnap.exists) {
          const cached = userSnap.data()?.tier;
          if (cached === 'scale' || cached === 'agency') previousTier = 'pro';
          else if (cached === 'premium') previousTier = 'nano';
          else if (
            cached === 'free' || cached === 'indie' || cached === 'nano' || cached === 'pro'
          ) {
            previousTier = cached;
          }
          // If no cached tier exists, default to 'free' — can't detect a downgrade
        }
      } catch (e) {
        logger.warn(`[plan-enforcement] Failed to read cached tier for ${userId}, defaulting to free`, e);
      }

      // Now refresh from Clerk — this updates the cache with the new tier + subscribedPlanKey.
      const newTier = await getUserTierLive(userId);

      logger.info(`Subscription webhook: tier synced for ${userId} → ${newTier}`, {
        type: payload.type,
        previousTier,
      });

      // Push the new tier to both email providers as a contact property.
      // Best-effort — failures here should not block tier enforcement downstream.
      if (newTier !== previousTier) {
        try {
          await pushTierProperty(userId, newTier);
        } catch (e) {
          logger.warn('Failed to push plan_tier property to email providers', {
            userId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Enforcement is driven by whether the target tier's limits are tighter in
      // ANY dimension — not by rank. The ladder is non-monotonic on check
      // interval (Indie probes at 15s, Nano at 2min), so the rank-upgrade
      // Indie→Nano still has to clamp intervals. See ceilingTightens().
      const needsEnforcement = newTier !== previousTier && ceilingTightens(previousTier, newTier);

      if (needsEnforcement) {
        logger.info(`[plan-enforcement] Tightening ceiling for ${userId}: ${previousTier} → ${newTier}`);
        try {
          if (newTier === 'free') {
            // Free is special-cased: all checks are disabled outright rather
            // than pruned down to the Free cap.
            if (previousTier === 'pro') {
              await handleProToFreeDowngrade(userId);
            } else {
              await handlePlanDowngrade(userId);
            }
          } else {
            await enforceTierCeiling(userId, newTier);
          }
          logger.info(`[plan-enforcement] Enforcement completed for ${userId}`);
        } catch (enforcementError) {
          const msg = enforcementError instanceof Error ? enforcementError.message : 'Unknown error';
          logger.error(`[plan-enforcement] Enforcement failed for ${userId}`, { error: msg });
          res.status(500).json({ received: true, processed: false, error: `Downgrade enforcement failed: ${msg}` });
          return;
        }
      } else if (newTier !== previousTier) {
        // Pure upgrade — nothing exceeds the new ceiling, but re-denormalise
        // userTier on all checks so check-doc caches stay in sync.
        try {
          await backfillCheckUserTier(userId, newTier);
        } catch (e) {
          logger.warn(`[plan-enforcement] Failed to backfill userTier on checks for ${userId}`, e);
        }
      }

      res.status(200).json({ received: true, processed: true, tier: newTier, previousTier });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      logger.error('Failed to sync tier from subscription webhook', { userId, error: message });
      res.status(200).json({ received: true, processed: false, error: message });
    }
    return;
  }

  // Handle user.created events — add to Resend Contacts
  if (payload.type !== 'user.created') {
    logger.info('Ignoring unhandled event type', { type: payload.type });
    res.status(200).json({ received: true, processed: false });
    return;
  }

  const user = (payload as unknown as ClerkUserCreatedEvent).data;

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

  // New signups always start on free tier — onboarding data isn't collected yet,
  // so we only set the two properties we know for certain.
  const signupProperties = buildPropertiesForUser({
    signupDate: formatSignupDate(user.created_at),
    tier: 'free',
    onboarding: null,
  });

  const result = await addContactToResend(
    primaryEmail.email_address,
    user.first_name,
    user.last_name,
    user.id,
    signupProperties,
  );

  // Mirror the new contact into Day3. Independent of the Resend result — a
  // Resend outage must not leave Day3 missing the user. Day3 topics default to
  // subscribed, so there's no topic write to make here.
  const day3ApiKey = getDay3ApiKey();
  let day3Ok = false;
  if (day3ApiKey) {
    try {
      const day3Result = await upsertDay3Contact(day3ApiKey, {
        email: primaryEmail.email_address,
        firstName: user.first_name,
        lastName: user.last_name,
        attributes: signupProperties,
      });
      day3Ok = day3Result.success;
      if (!day3Result.success) {
        logger.warn('Failed to add contact to Day3', {
          email: primaryEmail.email_address,
          userId: user.id,
          error: day3Result.error,
        });
      } else {
        logger.info('Contact added to Day3', {
          email: primaryEmail.email_address,
          userId: user.id,
        });
      }
    } catch (e) {
      logger.warn('Exception adding contact to Day3', {
        email: primaryEmail.email_address,
        userId: user.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Opt new users into every topic. Resend topic defaults already cover this
  // for new contacts, but explicit records give the future preference center
  // real data to render.
  if (result.success) {
    const apiKey = getResendApiKey();
    if (apiKey) {
      const resend = new Resend(apiKey);
      try {
        const topicResult = await syncContactTopics(
          resend,
          primaryEmail.email_address,
        );
        if (!topicResult.success) {
          logger.warn('Failed to opt new user into topics', {
            email: primaryEmail.email_address,
            error: topicResult.error,
          });
        }
      } catch (topicErr) {
        logger.warn('Exception opting new user into topics', {
          email: primaryEmail.email_address,
          error: topicErr instanceof Error ? topicErr.message : String(topicErr),
        });
      }

      // Fire the user.created automation event. Must run after the contact
      // exists in Resend so any automation step that reads contact properties
      // has data to work with.
      const eventResult = await triggerResendEvent(
        apiKey,
        primaryEmail.email_address,
        'user.created',
        {
          userId: user.id,
          signupDate: formatSignupDate(user.created_at),
        },
      );
      if (!eventResult.success) {
        logger.warn('Failed to trigger Resend user.created event', {
          email: primaryEmail.email_address,
          error: eventResult.error,
        });
      } else {
        logger.info('Triggered Resend user.created event', {
          email: primaryEmail.email_address,
          userId: user.id,
        });
      }
    }

    // Stamp the sync timestamps so the bulk resyncs skip this user for 30 days.
    // Per-provider so one provider failing doesn't suppress the other's backfill.
    try {
      await firestore.collection('users').doc(user.id).set(
        {
          resendPropertiesSyncedAt: Date.now(),
          ...(day3Ok ? { day3SyncedAt: Date.now() } : {}),
        },
        { merge: true },
      );
    } catch (e) {
      logger.debug('Failed to stamp contact sync timestamps on user.created', {
        userId: user.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } else if (day3Ok) {
    // Resend failed but Day3 landed — still record the Day3 stamp.
    try {
      await firestore.collection('users').doc(user.id).set(
        { day3SyncedAt: Date.now() },
        { merge: true },
      );
    } catch (e) {
      logger.debug('Failed to stamp day3SyncedAt on user.created', {
        userId: user.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

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
  cors: true,
  timeoutSeconds: 540, // 9 minutes - may need time for many users
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
    // Pre-fetch all existing Resend contacts to avoid upserting (which resets unsubscribe status)
    const existingEmails = new Set<string>();
    let hasMoreContacts = true;
    let afterCursor: string | undefined;

    while (hasMoreContacts) {
      const { data: contactList, error: listError } = await resend.contacts.list({
        limit: 100,
        ...(afterCursor ? { after: afterCursor } : {}),
      });

      if (listError || !contactList) {
        const msg = `Failed to list existing Resend contacts: ${listError?.message || 'unknown error'}. Aborting sync to protect subscription preferences.`;
        logger.error(msg);
        throw new HttpsError('internal', msg);
      }

      for (const contact of contactList.data) {
        existingEmails.add(contact.email.toLowerCase());
      }

      if (contactList.has_more && contactList.data.length > 0) {
        afterCursor = contactList.data[contactList.data.length - 1].id;
        // Delay to respect Resend rate limit (2 req/sec)
        await new Promise((resolve) => setTimeout(resolve, 600));
      } else {
        hasMoreContacts = false;
      }
    }

    logger.info(`Found ${existingEmails.size} existing Resend contacts`);

    // Paginate through all Clerk users
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

        // Skip contacts that already exist in Resend to preserve their subscription preferences
        if (existingEmails.has(primaryEmail.emailAddress.toLowerCase())) {
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
          const { error } = await resend.contacts.create({
            email: primaryEmail.emailAddress,
            firstName: user.firstName || undefined,
            lastName: user.lastName || undefined,
          });

          if (error) {
            logger.error('Failed to sync user', {
              email: primaryEmail.emailAddress,
              error: error.message,
            });
            stats.errors++;
            errors.push({ email: primaryEmail.emailAddress, error: error.message });
          } else {
            stats.synced++;
            logger.info('Synced user to Resend');
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

// Resend segment IDs for tier-based segmentation.
// All paid tiers share the old Nano segment for now — Resend only has two
// segments. When marketing splits them, map each tier to its own segment ID.
const RESEND_SEGMENTS = {
  free: 'd447bbcb-254e-4891-91da-beb0b0bcd144',
  indie: '71260845-a8ec-4663-8a11-90713ce376df',
  nano: '71260845-a8ec-4663-8a11-90713ce376df',
  pro: '71260845-a8ec-4663-8a11-90713ce376df',
} as const;

/**
 * Determine a Clerk user's tier from their billing subscription using exact
 * plan-key matching (see tierFromPlanKey). Ranks active items and picks the
 * strongest.
 */
async function getTierFromClerkUser(
  clerk: ReturnType<typeof createClerkClient>,
  userId: string
): Promise<InitUserTier> {
  return clerk.billing.getUserBillingSubscription(userId).then((subscription: unknown) => {
    if (!subscription || typeof subscription !== 'object') return 'free' as InitUserTier;

    const sub = subscription as {
      subscriptionItems?: Array<{
        status?: unknown;
        plan?: { slug?: unknown; name?: unknown } | null;
      }>;
    };

    const items = Array.isArray(sub.subscriptionItems) ? sub.subscriptionItems : [];
    const activeLike = items.filter((item) => {
      const s = typeof item?.status === 'string' ? item.status.toLowerCase() : '';
      return s === 'active' || s === 'upcoming' || s === 'past_due';
    });

    const rank = TIER_RANK;
    let best: InitUserTier = 'free';
    for (const item of activeLike) {
      const slug = typeof item?.plan?.slug === 'string' ? item.plan.slug.trim() : '';
      if (!slug) continue;
      const resolved = tierFromPlanKey(slug);
      if (rank[resolved] > rank[best]) best = resolved;
    }
    return best;
  }).catch(() => 'free' as InitUserTier);
}

/**
 * Add a contact to a Resend segment via REST API.
 */
async function addContactToSegment(
  apiKey: string,
  email: string,
  segmentId: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${segmentId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    return { success: false, error: `${res.status}: ${body}` };
  }
  return { success: true };
}

/**
 * Admin function to sync Clerk user tiers to Resend segments.
 * For each Clerk user, determines their tier (free/nano) from Clerk billing,
 * then adds them to the correct Resend segment and removes from the other.
 * Does NOT delete/recreate contacts — preserves subscription preferences.
 */
export const syncSegmentsToResend = onCall({
  cors: true,
  secrets: [RESEND_API_KEY, CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
  timeoutSeconds: 540, // 9 minutes - may need time for many users
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  const { instance = 'prod', dryRun = false } = request.data || {};

  if (instance !== 'prod' && instance !== 'dev') {
    throw new HttpsError('invalid-argument', 'Instance must be "prod" or "dev"');
  }

  let secretKey: string | null = null;
  try {
    secretKey = (instance === 'prod'
      ? CLERK_SECRET_KEY_PROD.value()
      : CLERK_SECRET_KEY_DEV.value()
    )?.trim() || null;
  } catch {
    secretKey = (instance === 'prod'
      ? process.env.CLERK_SECRET_KEY_PROD
      : process.env.CLERK_SECRET_KEY_DEV
    )?.trim() || null;
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
    free: 0,
    indie: 0,
    nano: 0,
    pro: 0,
    skipped: 0,
    errors: 0,
    dryRun,
  };

  const errors: Array<{ email: string; error: string }> = [];
  const details: Array<{ email: string; tier: string }> = [];

  try {
    // Pre-fetch contacts already in segments to skip them
    const segmentedEmails = new Set<string>();

    for (const segmentId of [RESEND_SEGMENTS.free, RESEND_SEGMENTS.nano]) {
      let hasMoreContacts = true;
      let afterCursor: string | undefined;

      while (hasMoreContacts) {
        const { data: contactList, error: listError } = await resend.contacts.list({
          segmentId,
          limit: 100,
          ...(afterCursor ? { after: afterCursor } : {}),
        });

        if (listError || !contactList) {
          logger.warn('Failed to list segment contacts', {
            segmentId,
            error: listError?.message,
          });
          break;
        }

        for (const contact of contactList.data) {
          segmentedEmails.add(contact.email.toLowerCase());
        }

        if (contactList.has_more && contactList.data.length > 0) {
          afterCursor = contactList.data[contactList.data.length - 1].id;
        } else {
          hasMoreContacts = false;
        }
      }
    }

    logger.info(`Found ${segmentedEmails.size} contacts already in segments`);

    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await clerk.users.getUserList({ limit, offset });
      const users = response.data;

      if (users.length === 0) break;

      for (const user of users) {
        stats.total++;

        const primaryEmail = user.emailAddresses.find(
          (e) => e.id === user.primaryEmailAddressId
        );

        if (!primaryEmail) {
          stats.skipped++;
          continue;
        }

        const email = primaryEmail.emailAddress;

        // Skip contacts already in a segment
        if (segmentedEmails.has(email.toLowerCase())) {
          stats.skipped++;
          continue;
        }

        // Determine tier from Clerk billing
        const tier = await getTierFromClerkUser(clerk, user.id);
        const addSegment = RESEND_SEGMENTS[tier];

        details.push({ email, tier });

        if (tier === 'pro') {
          stats.pro++;
        } else if (tier === 'nano') {
          stats.nano++;
        } else if (tier === 'indie') {
          stats.indie++;
        } else {
          stats.free++;
        }

        if (dryRun) {
          continue;
        }

        try {
          // Add to correct segment only — no need to remove from other since they weren't in any
          const addResult = await addContactToSegment(apiKey, email, addSegment);
          if (!addResult.success) {
            stats.errors++;
            errors.push({ email, error: `Add to ${tier}: ${addResult.error}` });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          stats.errors++;
          errors.push({ email, error: message });
        }

        // Delay to respect Resend rate limit (2 req/sec)
        await new Promise((resolve) => setTimeout(resolve, 600));
      }

      offset += limit;
      if (users.length < limit) hasMore = false;
    }

    logger.info('Segment sync completed', stats);

    return {
      success: true,
      stats,
      details: details.slice(0, 50), // Return first 50 for review
      errors: errors.slice(0, 10),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Segment sync failed';
    logger.error('Segment sync failed', { error: message });
    throw new HttpsError('internal', message);
  }
});

interface CachedUserInfo {
  tier: UserTier;
  onboarding: OnboardingAnswers | null;
  hasOnboarding: boolean;
  resendPropertiesSyncedAt: number | null;
  day3SyncedAt: number | null;
}

// Users synced within this window are skipped by the bulk resync unless the
// caller passes force:true. Picked as a compromise: long enough that routine
// re-runs finish in seconds, short enough that monthly cadence catches drift.
export const RESEND_SYNC_FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Same rationale for Day3. Tracked separately from the Resend stamp so a
// failure on one provider never makes the other's backfill skip a user.
export const DAY3_SYNC_FRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeUserDoc(data: FirebaseFirestore.DocumentData | undefined): CachedUserInfo {
  let tier: UserTier = 'free';
  const cached = data?.tier;
  // Migrate legacy values ('scale'/'agency' → pro, 'premium' → nano).
  if (cached === 'scale' || cached === 'agency') tier = 'pro';
  else if (cached === 'premium') tier = 'nano';
  else if (cached === 'pro') tier = 'pro';
  else if (cached === 'nano') tier = 'nano';
  else if (cached === 'indie') tier = 'indie';

  const syncedRaw = data?.resendPropertiesSyncedAt;
  const resendPropertiesSyncedAt =
    typeof syncedRaw === 'number' && Number.isFinite(syncedRaw) ? syncedRaw : null;

  const day3Raw = data?.day3SyncedAt;
  const day3SyncedAt =
    typeof day3Raw === 'number' && Number.isFinite(day3Raw) ? day3Raw : null;

  const onb = data?.onboarding;
  if (!onb || typeof onb !== 'object') {
    return {
      tier, onboarding: null, hasOnboarding: false, resendPropertiesSyncedAt, day3SyncedAt,
    };
  }

  const o = onb as { sources?: unknown; useCases?: unknown; teamSize?: unknown };
  return {
    tier,
    onboarding: {
      sources: Array.isArray(o.sources) ? o.sources.filter((v): v is string => typeof v === 'string') : [],
      useCases: Array.isArray(o.useCases) ? o.useCases.filter((v): v is string => typeof v === 'string') : [],
      teamSize: typeof o.teamSize === 'string' ? o.teamSize : null,
    },
    hasOnboarding: true,
    resendPropertiesSyncedAt,
    day3SyncedAt,
  };
}

/**
 * Batch-read a page of user docs in a single Firestore round-trip. Avoids the
 * 2-reads-per-user round-trip cost that blew the per-invocation budget during
 * bulk resyncs.
 */
async function loadUserInfoBatch(userIds: string[]): Promise<Map<string, CachedUserInfo>> {
  const map = new Map<string, CachedUserInfo>();
  if (userIds.length === 0) return map;

  try {
    const refs = userIds.map((uid) => firestore.collection('users').doc(uid));
    const snaps = await firestore.getAll(...refs);
    for (const snap of snaps) {
      map.set(snap.id, normalizeUserDoc(snap.exists ? snap.data() : undefined));
    }
  } catch (e) {
    logger.warn('Failed to batch-read user docs; falling back to defaults', {
      error: e instanceof Error ? e.message : String(e),
      count: userIds.length,
    });
    for (const uid of userIds) {
      map.set(uid, {
        tier: 'free',
        onboarding: null,
        hasOnboarding: false,
        resendPropertiesSyncedAt: null,
        day3SyncedAt: null,
      });
    }
  }

  return map;
}

/**
 * Pull the most recent onboarding row per user from BigQuery, which is the
 * canonical store for these answers. Returns a map keyed by Clerk user id.
 */
async function loadLatestOnboardingFromBigQuery(): Promise<Map<string, OnboardingAnswers>> {
  const bigquery = new BigQuery({ projectId: 'exit1-dev' });
  const map = new Map<string, OnboardingAnswers>();

  try {
    const [rows] = await bigquery.query({
      query: `
        SELECT user_id, sources, use_cases, team_size
        FROM \`exit1-dev.checks.onboarding_responses\`
        QUALIFY ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY timestamp DESC) = 1
      `,
    });

    for (const row of rows as Array<{
      user_id: string;
      sources: string[] | null;
      use_cases: string[] | null;
      team_size: string | null;
    }>) {
      map.set(row.user_id, {
        sources: Array.isArray(row.sources) ? row.sources : [],
        useCases: Array.isArray(row.use_cases) ? row.use_cases : [],
        teamSize: row.team_size ?? null,
      });
    }
  } catch (e) {
    logger.warn('Failed to load onboarding data from BigQuery; continuing without', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return map;
}

// Per-invocation user cap. 400 users × ~0.65s/user (Resend update + 600ms
// sleep) ≈ 260s. When syncTopics is on we add a second API call per user, so
// drop to 250 users to stay under the 540s gateway timeout. The client
// resumes via nextOffset until done.
const DEFAULT_RESYNC_BATCH_SIZE = 400;
const DEFAULT_RESYNC_BATCH_SIZE_WITH_TOPICS = 250;
const MAX_RESYNC_BATCH_SIZE = 600;

/**
 * Admin function to backfill Clerk users' Resend contacts with the full
 * property set (signup_date, plan_tier, team_size, per-source/use-case flags).
 *
 * Resumable: processes up to `batchSize` users per invocation, then returns
 * `{ done, nextOffset }`. The client (AdminDashboard) loops until `done`.
 * Schema registration + BQ onboarding preload happen every invocation but are
 * cheap (~15s once registered; ~1s BQ).
 */
export const resyncResendProperties = onCall({
  cors: true,
  timeoutSeconds: 540,
  secrets: [RESEND_API_KEY, CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }

  const {
    instance = 'prod',
    dryRun = false,
    syncTopics: shouldSyncTopics = false,
    startOffset = 0,
    batchSize: rawBatchSize,
    force = false,
  } = (request.data || {}) as {
    instance?: string;
    dryRun?: boolean;
    syncTopics?: boolean;
    startOffset?: number;
    batchSize?: number;
    force?: boolean;
  };

  if (instance !== 'prod' && instance !== 'dev') {
    throw new HttpsError('invalid-argument', 'Instance must be "prod" or "dev"');
  }

  const normalizedOffset = Math.max(0, Math.floor(Number(startOffset) || 0));
  const defaultBatch = shouldSyncTopics
    ? DEFAULT_RESYNC_BATCH_SIZE_WITH_TOPICS
    : DEFAULT_RESYNC_BATCH_SIZE;
  const normalizedBatchSize = Math.min(
    MAX_RESYNC_BATCH_SIZE,
    Math.max(1, Math.floor(Number(rawBatchSize) || defaultBatch)),
  );

  let secretKey: string | null = null;
  try {
    secretKey = (instance === 'prod'
      ? CLERK_SECRET_KEY_PROD.value()
      : CLERK_SECRET_KEY_DEV.value()
    )?.trim() || null;
  } catch {
    secretKey = (instance === 'prod'
      ? process.env.CLERK_SECRET_KEY_PROD
      : process.env.CLERK_SECRET_KEY_DEV
    )?.trim() || null;
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
    batchTotal: 0,
    updated: 0,
    skipped: 0,
    skippedFresh: 0,
    errors: 0,
    withOnboarding: 0,
    firestoreBackfilled: 0,
    topicsUpdated: 0,
    dryRun,
    syncTopics: shouldSyncTopics,
    force,
    startOffset: normalizedOffset,
    batchSize: normalizedBatchSize,
  };
  const errors: Array<{ email: string; error: string }> = [];

  try {
    // Schema registration runs every invocation — it's idempotent and cheap
    // once properties exist (each create returns "already exists" fast). Skip
    // on dry runs to avoid any side effects.
    const schema = dryRun
      ? { created: [], existed: [], failed: [] }
      : normalizedOffset === 0
        ? await registerResendSchema(apiKey)
        : { created: [], existed: [], failed: [] };

    if (normalizedOffset === 0) {
      logger.info('Resend schema ready', {
        created: schema.created.length,
        existed: schema.existed.length,
        failed: schema.failed.length,
      });
    }

    // Onboarding preload — BigQuery query is ~1s and fits easily in budget.
    // Re-querying each batch keeps the function stateless.
    const onboardingByUser = await loadLatestOnboardingFromBigQuery();
    if (normalizedOffset === 0) {
      logger.info(`Loaded ${onboardingByUser.size} onboarding responses from BigQuery`);
    }

    const targetTotal = normalizedOffset + normalizedBatchSize;
    let offset = normalizedOffset;
    let reachedEnd = false;
    const pageSize = 100;

    while (offset < targetTotal && !reachedEnd) {
      const remaining = targetTotal - offset;
      const limit = Math.min(pageSize, remaining);
      const response = await clerk.users.getUserList({ limit, offset });
      const users = response.data;

      if (users.length === 0) {
        reachedEnd = true;
        break;
      }

      // One Firestore round-trip for all users in this page (tier + onboarding).
      const userInfoMap = await loadUserInfoBatch(users.map((u) => u.id));

      // Accumulate onboarding backfills + sync-timestamp writes for the page
      // into one batch commit, so Firestore writes don't pace-limit the loop.
      const firestoreBatch = firestore.batch();
      let pendingWrites = 0;

      const freshCutoff = Date.now() - RESEND_SYNC_FRESH_WINDOW_MS;

      for (const user of users) {
        stats.batchTotal++;

        const primaryEmail = user.emailAddresses.find(
          (e) => e.id === user.primaryEmailAddressId
        );
        if (!primaryEmail) {
          stats.skipped++;
          continue;
        }
        const email = primaryEmail.emailAddress;

        const info = userInfoMap.get(user.id) ?? {
          tier: 'free' as UserTier,
          onboarding: null,
          hasOnboarding: false,
          resendPropertiesSyncedAt: null,
          day3SyncedAt: null,
        };

        // Skip users whose properties were pushed recently. The subscription
        // webhook, user.created webhook, and onboarding submit each keep this
        // timestamp warm, so skipping here is safe.
        if (
          !force
          && !dryRun
          && info.resendPropertiesSyncedAt
          && info.resendPropertiesSyncedAt >= freshCutoff
        ) {
          stats.skippedFresh++;
          continue;
        }

        const bqOnboarding = onboardingByUser.get(user.id) ?? null;
        const onboarding = bqOnboarding ?? info.onboarding;

        if (onboarding) stats.withOnboarding++;

        const userRef = firestore.collection('users').doc(user.id);

        // Backfill Firestore denormalization for users whose onboarding only
        // lives in BigQuery — makes future webhooks / resyncs cheaper.
        if (!dryRun && bqOnboarding && !info.hasOnboarding) {
          firestoreBatch.set(
            userRef,
            {
              onboarding: {
                sources: bqOnboarding.sources,
                useCases: bqOnboarding.useCases,
                teamSize: bqOnboarding.teamSize,
                backfilledAt: Date.now(),
              },
            },
            { merge: true },
          );
          pendingWrites++;
          stats.firestoreBackfilled++;
        }

        const properties = buildPropertiesForUser({
          signupDate: formatSignupDate(user.createdAt),
          tier: info.tier,
          onboarding,
        });

        if (dryRun) {
          stats.updated++;
          continue;
        }

        const result = await upsertContactProperties(resend, email, properties, {
          firstName: user.firstName,
          lastName: user.lastName,
        });
        let propsOk = false;
        if (result.success) {
          stats.updated++;
          propsOk = true;
        } else {
          stats.errors++;
          errors.push({ email, error: result.error || 'unknown' });
        }
        await sleep(RESEND_RATE_LIMIT_MS);

        let topicsOk = !shouldSyncTopics;
        if (shouldSyncTopics) {
          // No preserveExisting: no preference UI exists yet, so there are
          // no manual opt-outs to protect. One blind update call per user
          // instead of list+update cuts 600ms+ per user.
          const topicResult = await syncContactTopics(resend, email);
          if (topicResult.success) {
            stats.topicsUpdated += topicResult.updated;
            topicsOk = true;
          } else if (topicResult.error && !/not found|does not exist/i.test(topicResult.error)) {
            errors.push({ email, error: `topics: ${topicResult.error}` });
          }
          await sleep(RESEND_RATE_LIMIT_MS);
        }

        // Only stamp the sync timestamp if every required operation succeeded.
        // A partial failure stays retriable on the next run.
        if (propsOk && topicsOk) {
          firestoreBatch.set(
            userRef,
            { resendPropertiesSyncedAt: Date.now() },
            { merge: true },
          );
          pendingWrites++;
        }
      }

      if (pendingWrites > 0) {
        try {
          await firestoreBatch.commit();
        } catch (e) {
          logger.warn('Firestore batch commit failed during resync; timestamps not recorded', {
            error: e instanceof Error ? e.message : String(e),
            pendingWrites,
          });
        }
      }

      offset += users.length;
      if (users.length < limit) reachedEnd = true;
    }

    const done = reachedEnd;
    const nextOffset = done ? offset : offset;

    logger.info('Resend property resync batch completed', { ...stats, done, nextOffset });

    return {
      success: true,
      done,
      nextOffset,
      stats,
      schema,
      errors: errors.slice(0, 20),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Resend property resync failed';
    logger.error('Resend property resync failed', { error: message });
    throw new HttpsError('internal', message);
  }
});

// Per-invocation user cap for the Day3 backfill. Much higher than the Resend
// equivalent because Day3 moves 1,000 contacts per request instead of one every
// 600ms — Clerk pagination (100/page) is the real bottleneck here, not Day3.
const DEFAULT_DAY3_BACKFILL_SIZE = 2000;
const MAX_DAY3_BACKFILL_SIZE = 5000;

/**
 * Admin function to backfill every Clerk user into the Day3 audience with the
 * full property set — the Day3 counterpart to resyncResendProperties.
 *
 * Resumable: processes up to `batchSize` users per invocation, then returns
 * { done, nextOffset }. The client loops until done.
 *
 * Notes specific to Day3:
 *   - Contacts go in via /contacts/batch (1,000 per request, one rate-limit
 *     unit). Never loop single creates for an import.
 *   - Payloads are de-duplicated case-insensitively: two emails differing only
 *     in case count as a duplicate and reject the *entire* request.
 *   - `upsert` is passed in the body, not the query string, so re-runs update
 *     existing contacts instead of failing them as contact_already_exists.
 *   - A 200 does not mean every row landed — per-row failures come back in
 *     rowFailures and are reported, not swallowed.
 *   - Signup dates land in the signup_date attribute only. Day3 ignores
 *     created_at, so contact creation dates are always the import date.
 */
export const backfillDay3Contacts = onCall({
  cors: true,
  timeoutSeconds: 540,
  secrets: [DAY3_API_KEY, CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Authentication required');
  }
  await requireAdmin(uid);

  const {
    instance = 'prod',
    dryRun = false,
    startOffset = 0,
    batchSize: rawBatchSize,
    force = false,
    runId: rawRunId,
  } = (request.data || {}) as {
    instance?: string;
    dryRun?: boolean;
    startOffset?: number;
    batchSize?: number;
    force?: boolean;
    runId?: string;
  };

  if (instance !== 'prod' && instance !== 'dev') {
    throw new HttpsError('invalid-argument', 'Instance must be "prod" or "dev"');
  }

  const normalizedOffset = Math.max(0, Math.floor(Number(startOffset) || 0));
  const normalizedBatchSize = Math.min(
    MAX_DAY3_BACKFILL_SIZE,
    Math.max(1, Math.floor(Number(rawBatchSize) || DEFAULT_DAY3_BACKFILL_SIZE)),
  );

  // Idempotency keys must be stable across our internal 5xx retries but
  // different across deliberate re-runs — Day3 replays a 24h-old response for a
  // repeated key, which would silently skip fresh data. The client passes one
  // runId for the whole loop.
  const runId = typeof rawRunId === 'string' && rawRunId.trim()
    ? rawRunId.trim().slice(0, 40)
    : `r${Date.now()}`;

  let secretKey: string | null = null;
  try {
    secretKey = (instance === 'prod'
      ? CLERK_SECRET_KEY_PROD.value()
      : CLERK_SECRET_KEY_DEV.value()
    )?.trim() || null;
  } catch {
    secretKey = (instance === 'prod'
      ? process.env.CLERK_SECRET_KEY_PROD
      : process.env.CLERK_SECRET_KEY_DEV
    )?.trim() || null;
  }

  if (!secretKey) {
    throw new HttpsError('failed-precondition', `Clerk ${instance} secret key not configured`);
  }

  const day3ApiKey = getDay3ApiKey();
  if (!day3ApiKey) {
    throw new HttpsError('failed-precondition', 'Day3 API key not configured');
  }

  const clerk = createClerkClient({ secretKey });

  const stats = {
    batchTotal: 0,
    created: 0,
    updated: 0,
    rowFailures: 0,
    skippedNoEmail: 0,
    skippedFresh: 0,
    dedupedAway: 0,
    withOnboarding: 0,
    dryRun,
    force,
    runId,
    startOffset: normalizedOffset,
    batchSize: normalizedBatchSize,
  };
  const errors: Array<{ email: string; error: string }> = [];

  try {
    const onboardingByUser = await loadLatestOnboardingFromBigQuery();
    if (normalizedOffset === 0) {
      logger.info(`Day3 backfill: loaded ${onboardingByUser.size} onboarding responses from BigQuery`);
    }

    // Collect this invocation's users first, then push them to Day3 in
    // 1,000-contact chunks. emailToUserId lets us stamp only the rows that
    // actually landed.
    const pending: Day3ContactInput[] = [];
    const emailToUserId = new Map<string, string>();

    const targetTotal = normalizedOffset + normalizedBatchSize;
    let offset = normalizedOffset;
    let reachedEnd = false;
    const pageSize = 100;
    const freshCutoff = Date.now() - DAY3_SYNC_FRESH_WINDOW_MS;

    while (offset < targetTotal && !reachedEnd) {
      const remaining = targetTotal - offset;
      const limit = Math.min(pageSize, remaining);
      const response = await clerk.users.getUserList({ limit, offset });
      const users = response.data;

      if (users.length === 0) {
        reachedEnd = true;
        break;
      }

      const userInfoMap = await loadUserInfoBatch(users.map((u) => u.id));

      for (const user of users) {
        stats.batchTotal++;

        const primaryEmail = user.emailAddresses.find(
          (e) => e.id === user.primaryEmailAddressId
        );
        if (!primaryEmail) {
          stats.skippedNoEmail++;
          continue;
        }
        const email = primaryEmail.emailAddress;

        const info = userInfoMap.get(user.id) ?? {
          tier: 'free' as UserTier,
          onboarding: null,
          hasOnboarding: false,
          resendPropertiesSyncedAt: null,
          day3SyncedAt: null,
        };

        if (!force && !dryRun && info.day3SyncedAt && info.day3SyncedAt >= freshCutoff) {
          stats.skippedFresh++;
          continue;
        }

        const onboarding = onboardingByUser.get(user.id) ?? info.onboarding;
        if (onboarding) stats.withOnboarding++;

        pending.push({
          email,
          firstName: user.firstName,
          lastName: user.lastName,
          attributes: buildPropertiesForUser({
            signupDate: formatSignupDate(user.createdAt),
            tier: info.tier,
            onboarding,
          }),
        });
        emailToUserId.set(email.trim().toLowerCase(), user.id);
      }

      offset += users.length;
      if (users.length < limit) reachedEnd = true;
    }

    // Case-insensitive dedupe before chunking — a duplicate inside one payload
    // rejects the whole request, and Clerk can hold two users whose emails
    // differ only in case.
    const deduped = dedupeByEmail(pending);
    stats.dedupedAway = pending.length - deduped.length;
    if (stats.dedupedAway > 0) {
      logger.warn('Day3 backfill de-duplicated contacts by lowercased email', {
        dropped: stats.dedupedAway,
      });
    }

    const syncedUserIds: string[] = [];

    if (!dryRun) {
      const chunks = chunkForDay3(deduped, DAY3_BATCH_SIZE);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const outcome = await batchUpsertDay3Contacts(
          day3ApiKey,
          chunk,
          `day3-backfill-${runId}-${normalizedOffset}-${i}`,
        );

        if (!outcome.ok) {
          const code = outcome.requestError?.code || 'unknown';
          const message = outcome.requestError?.message || 'unknown error';

          // Out of subscriber headroom: the batch is rejected whole and never
          // partially applied, so the run can simply be repeated after
          // upgrading. Don't retry and don't split to sneak under the cap.
          if (code === 'plan_limit_reached') {
            throw new HttpsError(
              'resource-exhausted',
              `Day3 rejected the import: the account is out of subscriber headroom (${message}). `
              + 'Upgrade the Day3 plan, then re-run this backfill — nothing was partially applied.',
            );
          }

          throw new HttpsError('internal', `Day3 batch failed (${code}): ${message}`);
        }

        stats.created += outcome.created;
        stats.updated += outcome.updated;
        stats.rowFailures += outcome.rowFailures.length;

        const failedEmails = new Set(outcome.rowFailures.map((f) => f.email));
        for (const failure of outcome.rowFailures) {
          errors.push({ email: failure.email, error: `${failure.code}: ${failure.message}` });
        }

        for (const contact of chunk) {
          const key = contact.email.trim().toLowerCase();
          if (failedEmails.has(key)) continue;
          const userId = emailToUserId.get(key);
          if (userId) syncedUserIds.push(userId);
        }
      }

      // Stamp day3SyncedAt for everything that landed. Firestore caps a batch
      // at 500 writes, so commit in chunks.
      const STAMP_CHUNK = 400;
      const now = Date.now();
      for (let i = 0; i < syncedUserIds.length; i += STAMP_CHUNK) {
        const slice = syncedUserIds.slice(i, i + STAMP_CHUNK);
        const batch = firestore.batch();
        for (const userId of slice) {
          batch.set(
            firestore.collection('users').doc(userId),
            { day3SyncedAt: now },
            { merge: true },
          );
        }
        try {
          await batch.commit();
        } catch (e) {
          logger.warn('Day3 backfill: stamp commit failed; those users stay retriable', {
            error: e instanceof Error ? e.message : String(e),
            count: slice.length,
          });
        }
      }
    }

    const done = reachedEnd;
    const audienceCount = await getDay3ContactCount(day3ApiKey);

    logger.info('Day3 backfill batch completed', {
      ...stats, done, nextOffset: offset, day3Total: audienceCount.total,
    });

    return {
      success: true,
      done,
      nextOffset: offset,
      stats,
      day3Total: audienceCount.total,
      errors: errors.slice(0, 20),
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    const message = err instanceof Error ? err.message : 'Day3 backfill failed';
    logger.error('Day3 backfill failed', { error: message });
    throw new HttpsError('internal', message);
  }
});
