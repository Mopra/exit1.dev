// ============================================================================
// DUAL-PROVIDER CONTACT SYNC
//
// Single entry point for "this user's marketing contact data changed". Fans out
// to Resend and Day3 independently: one provider failing never affects the
// other, and neither ever fails the user-facing operation that triggered it.
//
// Resend remains authoritative. Day3 is additive during the migration.
//
// Deliberately NOT fanned out:
//   - Automation events (triggerResendEvent). Day3 v1 has no events API, so
//     lifecycle automations stay Resend-only.
//   - Topic opt-in. Day3's topics were created with default_subscribed: true,
//     so new contacts are subscribed without a per-contact write.
// ============================================================================

import * as logger from "firebase-functions/logger";
import { Resend } from "resend";
import { upsertContactProperties } from "./resend-sync";
import { deleteDay3Contact, upsertDay3Contact } from "./day3-sync";

export interface ProviderResult {
  attempted: boolean;
  success: boolean;
  error?: string;
}

export interface ContactSyncResult {
  resend: ProviderResult;
  day3: ProviderResult;
}

export interface ContactSyncInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  properties: Record<string, string>;
  resendApiKey?: string;
  day3ApiKey?: string;
  /** Included in logs so failures are traceable to a user. */
  userId?: string;
}

const skipped: ProviderResult = { attempted: false, success: false };

/**
 * Push a user's contact properties to both providers.
 *
 * Never throws — every failure is captured per provider and logged. Callers
 * that need to know whether to stamp a sync timestamp should check the
 * individual results.
 */
export async function syncContactToProviders(
  input: ContactSyncInput,
): Promise<ContactSyncResult> {
  const { email, firstName, lastName, properties, userId } = input;

  const [resendResult, day3Result] = await Promise.all([
    syncToResend(input),
    syncToDay3(input),
  ]);

  if (!resendResult.success && resendResult.attempted) {
    logger.warn("Resend contact sync failed", { userId, email, error: resendResult.error });
  }
  if (!day3Result.success && day3Result.attempted) {
    logger.warn("Day3 contact sync failed", { userId, email, error: day3Result.error });
  }
  if (resendResult.success && day3Result.success) {
    logger.debug("Contact synced to both providers", {
      userId, email, propertyCount: Object.keys(properties).length,
      firstName: Boolean(firstName), lastName: Boolean(lastName),
    });
  }

  return { resend: resendResult, day3: day3Result };
}

async function syncToResend(input: ContactSyncInput): Promise<ProviderResult> {
  if (!input.resendApiKey) return skipped;
  try {
    const resend = new Resend(input.resendApiKey);
    const result = await upsertContactProperties(
      resend,
      input.email,
      input.properties,
      { firstName: input.firstName, lastName: input.lastName },
    );
    return { attempted: true, success: result.success, error: result.error };
  } catch (err) {
    return {
      attempted: true,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function syncToDay3(input: ContactSyncInput): Promise<ProviderResult> {
  if (!input.day3ApiKey) return skipped;
  try {
    const result = await upsertDay3Contact(input.day3ApiKey, {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      attributes: input.properties,
    });
    return { attempted: true, success: result.success, error: result.error };
  } catch (err) {
    return {
      attempted: true,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove a user's contact record on account deletion.
 *
 * Day3 only, deliberately. Resend's existing behaviour leaves the contact in
 * place on account deletion (a pre-existing gap, unchanged here so this
 * migration doesn't alter live Resend behaviour). Day3 gets the correct
 * behaviour from the start because we're about to send marketing campaigns from
 * it, and deleted users must not receive them.
 */
export async function deleteContactFromDay3(
  day3ApiKey: string | undefined,
  email: string,
  userId?: string,
): Promise<ProviderResult> {
  if (!day3ApiKey) return skipped;
  try {
    const result = await deleteDay3Contact(day3ApiKey, email);
    if (!result.success) {
      logger.warn("Day3 contact delete failed", { userId, email, error: result.error });
    }
    return { attempted: true, success: result.success, error: result.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Day3 contact delete threw", { userId, email, error: message });
    return { attempted: true, success: false, error: message };
  }
}
