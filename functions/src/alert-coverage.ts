/**
 * Alert coverage: can this user actually be told when something breaks?
 *
 * Written after an audit found that 379 of 588 users holding a live check had no
 * reachable alert channel at all: no email settings document, no enabled webhook,
 * no SMS. Onboarding promised "we'll alert you the moment anything changes" and
 * then never wired up a channel, so the promise was false for most accounts.
 *
 * Coverage is computed with what the DELIVERY path would do, not with "is there an
 * address on file":
 *   - email and SMS go through `eventAllowedForCheck`, the same precedence the
 *     uptime alert path runs, after bounced (suppressed) recipients are removed
 *     the way alert-email.ts removes them at send time;
 *   - webhooks go through `filterWebhooksForEvent`, so a webhook that only
 *     subscribes to ssl_error, or whose check filter excludes the check, does not
 *     count. An earlier version counted "any enabled webhook" and over-reported.
 */
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { TIER_LIMITS, type Tier } from "./config";
import { filterWebhooksForEvent } from "./alert-helpers";
import {
  eventAllowedForCheck,
  stripSuppressedRecipients,
  allRecipientAddresses,
  type GateSettings,
} from "./email-gate";
import { getActiveSuppressions } from "./email-suppression";
import type { EmailSettings, SmsSettings, WebhookEvent, WebhookSettings } from "./types";

/** The event coverage is judged against. Down is the one that matters. */
export const COVERAGE_EVENT: WebhookEvent = "website_down";

export interface CoverageCheck {
  id: string;
  userId: string;
  folder?: string | null;
  disabled: boolean;
  /** Set once an outage has actually been observed on this check. */
  lastDowntime?: number | null;
}

export interface UserCoverage {
  userId: string;
  /** Every check the user owns, disabled ones included. */
  checkCount: number;
  /** Checks the scheduler will actually run. */
  enabledCheckCount: number;
  /** Enabled checks that would produce a down email to a non-suppressed address. */
  emailCoveredCheckCount: number;
  hasEmailChannel: boolean;
  /** At least one enabled check has a webhook that fires for a down event. */
  hasWebhookChannel: boolean;
  hasSmsChannel: boolean;
  /** True when at least one enabled check would reach the user somehow. */
  covered: boolean;
  /**
   * Evidence that an outage has been caught for this user, or null if none ever
   * has. Derived from `lastDowntime`, so it answers "has this ever happened?"
   * exactly, and dates it only approximately: for a user whose check has gone down
   * more than once this is the earliest LAST-downtime across their checks, not the
   * true first. Good enough for the one-shot lifecycle event, which only needs the
   * yes/no; treat the date itself as a lower bound, not a fact.
   */
  firstIncidentAt: number | null;
}

/**
 * Legacy user docs can still carry 'premium', 'scale' or 'agency'. Indexing
 * TIER_LIMITS with one of those returns undefined and the sweep dies on
 * `.smsAlerts`. Anything not in the table is treated as free, which is also what
 * the tier normaliser in init.ts does for unknown values.
 */
export function coerceTier(raw: unknown): Tier {
  return typeof raw === "string" && raw in TIER_LIMITS ? (raw as Tier) : "free";
}

/**
 * Read every check once and group by owner. At current scale (~5k checks) this is
 * a single collection scan and cheaper than per-user queries; revisit with a
 * `userId`-keyed shard if the collection grows an order of magnitude.
 */
export async function loadChecksByUser(): Promise<Map<string, CoverageCheck[]>> {
  const snap = await firestore
    .collection("checks")
    .select("userId", "folder", "disabled", "lastDowntime")
    .get();

  const byUser = new Map<string, CoverageCheck[]>();
  for (const doc of snap.docs) {
    const userId = doc.get("userId") as string | undefined;
    if (!userId) continue;
    const list = byUser.get(userId) ?? [];
    const rawFolder = doc.get("folder") as string | null | undefined;
    list.push({
      id: doc.id,
      userId,
      folder: typeof rawFolder === "string" && rawFolder.trim() ? rawFolder.trim() : null,
      disabled: doc.get("disabled") === true,
      lastDowntime: (doc.get("lastDowntime") as number | undefined) ?? null,
    });
    byUser.set(userId, list);
  }
  return byUser;
}

/** Enabled webhooks grouped by owner. Full documents: the event filter needs `events` and `checkFilter`. */
export async function loadWebhooksByUser(): Promise<Map<string, WebhookSettings[]>> {
  const snap = await firestore.collection("webhooks").where("enabled", "==", true).get();
  const byUser = new Map<string, WebhookSettings[]>();
  for (const doc of snap.docs) {
    const data = doc.data() as WebhookSettings;
    if (!data.userId) continue;
    const list = byUser.get(data.userId) ?? [];
    list.push({ ...data, id: doc.id });
    byUser.set(data.userId, list);
  }
  return byUser;
}

export interface CoverageInputs {
  checksByUser: Map<string, CoverageCheck[]>;
  /** Email settings with suppressed recipients already removed. */
  emailSettings: Map<string, GateSettings>;
  smsSettings: Map<string, GateSettings>;
  webhooksByUser: Map<string, WebhookSettings[]>;
  /** How many settings documents lost at least one address to suppression. */
  suppressionsApplied: number;
}

/**
 * Load everything the coverage calculation needs: four collection reads plus one
 * batched suppression lookup across every address any settings document names.
 */
export async function loadCoverageInputs(): Promise<CoverageInputs> {
  const [checksByUser, emailSnap, smsSnap, webhooksByUser] = await Promise.all([
    loadChecksByUser(),
    firestore.collection("emailSettings").get(),
    firestore.collection("smsSettings").get(),
    loadWebhooksByUser(),
  ]);

  const rawEmail = new Map<string, EmailSettings>();
  for (const doc of emailSnap.docs) rawEmail.set(doc.id, doc.data() as EmailSettings);

  // One getAll over every address instead of a read per user in the loop.
  const addresses = new Set<string>();
  for (const s of rawEmail.values()) for (const a of allRecipientAddresses(s)) addresses.add(a);
  const suppressed = new Set<string>();
  if (addresses.size > 0) {
    try {
      for (const state of await getActiveSuppressions([...addresses])) {
        if (state.email) suppressed.add(state.email.toLowerCase());
      }
    } catch (e) {
      // Fail open on the lookup itself: reporting a bounced address as covered is
      // the pre-existing behaviour, and far better than crashing the sweep.
      logger.warn("[alert-coverage] suppression lookup failed; treating all addresses as deliverable", {
        error: (e as Error)?.message ?? String(e),
      });
    }
  }
  const isSuppressed = (email: string) => suppressed.has(email.trim().toLowerCase());

  let suppressionsApplied = 0;
  const emailSettings = new Map<string, GateSettings>();
  for (const [uid, s] of rawEmail) {
    const stripped = suppressed.size > 0 ? stripSuppressedRecipients(s, isSuppressed) : s;
    if (stripped !== s && allRecipientAddresses(stripped).length < allRecipientAddresses(s).length) {
      suppressionsApplied++;
    }
    emailSettings.set(uid, stripped);
  }

  const smsSettings = new Map<string, GateSettings>();
  for (const doc of smsSnap.docs) smsSettings.set(doc.id, doc.data() as SmsSettings as GateSettings);

  return { checksByUser, emailSettings, smsSettings, webhooksByUser, suppressionsApplied };
}

/**
 * Resolve coverage for one user.
 *
 * `tier` gates SMS: the settings document can look perfectly configured while the
 * tier has `smsAlerts: false`, in which case nothing is ever sent and counting it
 * as coverage would hide exactly the problem we are looking for.
 */
export function computeUserCoverage(
  userId: string,
  inputs: CoverageInputs,
  rawTier: unknown,
): UserCoverage {
  const tier = coerceTier(rawTier);
  const checks = inputs.checksByUser.get(userId) ?? [];
  const enabled = checks.filter((c) => !c.disabled);

  const email = inputs.emailSettings.get(userId) ?? null;
  const emailCovered = enabled.filter((c) => eventAllowedForCheck(email, c, COVERAGE_EVENT));

  const smsDoc = inputs.smsSettings.get(userId) ?? null;
  const smsAllowedByTier = TIER_LIMITS[tier].smsAlerts === true;
  const hasSmsChannel = smsAllowedByTier
    && enabled.some((c) => eventAllowedForCheck(smsDoc, c, COVERAGE_EVENT));

  const webhooks = inputs.webhooksByUser.get(userId) ?? [];
  const hasWebhookChannel = webhooks.length > 0
    && enabled.some((c) => filterWebhooksForEvent(webhooks, COVERAGE_EVENT, c.id, c.folder).length > 0);

  let firstIncidentAt: number | null = null;
  for (const c of checks) {
    if (typeof c.lastDowntime === "number" && c.lastDowntime > 0) {
      firstIncidentAt = firstIncidentAt === null ? c.lastDowntime : Math.min(firstIncidentAt, c.lastDowntime);
    }
  }

  return {
    userId,
    checkCount: checks.length,
    enabledCheckCount: enabled.length,
    emailCoveredCheckCount: emailCovered.length,
    hasEmailChannel: emailCovered.length > 0,
    hasWebhookChannel,
    hasSmsChannel,
    covered: emailCovered.length > 0 || hasWebhookChannel || hasSmsChannel,
    firstIncidentAt,
  };
}

// ----------------------------------------------------------------------------
// One loader for every consumer
// ----------------------------------------------------------------------------

export interface CoverageUser {
  userId: string;
  tier: Tier;
  /** Present when the user went through the survey flow (possibly with every answer skipped). */
  onboarding: { sources: string[]; useCases: string[]; teamSize: string | null } | null;
  lifecycle: {
    firstIncidentEventAt: number;
    noChannelNotifiedAt: number;
    activationSyncedAt: number;
    activationFingerprint: string | null;
  };
}

export interface CoverageRows {
  inputs: CoverageInputs;
  /** Every user doc, projected to the fields coverage consumers read. */
  users: Map<string, CoverageUser>;
  /** One row per user doc. Check owners with no user doc are reported separately. */
  rows: UserCoverage[];
  /** Check owners with no `users` document at all. Counted so the denominators are honest. */
  orphanCheckOwners: number;
}

/**
 * The sweep, the mailer and the admin report used to each build their own
 * "load inputs, map tiers, compute per user" block, and they had already drifted:
 * two iterated check owners (so an orphaned owner was counted), one iterated user
 * docs (so it was dropped). Everyone reads this now.
 */
export async function loadCoverageRows(): Promise<CoverageRows> {
  const [inputs, usersSnap] = await Promise.all([
    loadCoverageInputs(),
    firestore.collection("users").select("tier", "onboarding", "lifecycle").get(),
  ]);

  const users = new Map<string, CoverageUser>();
  for (const doc of usersSnap.docs) {
    const rawOnboarding = doc.get("onboarding") as
      | { sources?: unknown; useCases?: unknown; teamSize?: unknown }
      | undefined;
    const onboarding = rawOnboarding && Array.isArray(rawOnboarding.sources)
      ? {
        sources: (rawOnboarding.sources as unknown[]).filter((s): s is string => typeof s === "string"),
        useCases: Array.isArray(rawOnboarding.useCases)
          ? (rawOnboarding.useCases as unknown[]).filter((s): s is string => typeof s === "string")
          : [],
        teamSize: typeof rawOnboarding.teamSize === "string" ? rawOnboarding.teamSize : null,
      }
      : null;
    const lc = (doc.get("lifecycle") as Record<string, unknown> | undefined) ?? {};
    users.set(doc.id, {
      userId: doc.id,
      tier: coerceTier(doc.get("tier")),
      onboarding,
      lifecycle: {
        firstIncidentEventAt: Number(lc.firstIncidentEventAt) || 0,
        // `lifecycle.noChannelEventAt` is deliberately not read: it recorded a
        // Resend automation event that no automation ever acted on, and reading it
        // is what disqualified 378 users from their only notice.
        noChannelNotifiedAt: Number(lc.noChannelNotifiedAt) || 0,
        activationSyncedAt: Number(lc.activationSyncedAt) || 0,
        activationFingerprint: typeof lc.activationFingerprint === "string" ? lc.activationFingerprint : null,
      },
    });
  }

  const rows: UserCoverage[] = [];
  for (const u of users.values()) rows.push(computeUserCoverage(u.userId, inputs, u.tier));

  let orphanCheckOwners = 0;
  for (const owner of inputs.checksByUser.keys()) if (!users.has(owner)) orphanCheckOwners++;
  if (orphanCheckOwners > 0) {
    logger.info("[alert-coverage] check owners with no users document", { orphanCheckOwners });
  }

  return { inputs, users, rows, orphanCheckOwners };
}

export interface CoverageSummary {
  usersWithEnabledChecks: number;
  usersCovered: number;
  usersUncovered: number;
  enabledChecks: number;
  emailCoveredChecks: number;
}

export function summarizeCoverage(rows: UserCoverage[]): CoverageSummary {
  const active = rows.filter((r) => r.enabledCheckCount > 0);
  return {
    usersWithEnabledChecks: active.length,
    usersCovered: active.filter((r) => r.covered).length,
    usersUncovered: active.filter((r) => !r.covered).length,
    enabledChecks: active.reduce((n, r) => n + r.enabledCheckCount, 0),
    emailCoveredChecks: active.reduce((n, r) => n + r.emailCoveredCheckCount, 0),
  };
}
