/**
 * Alert coverage: can this user actually be told when something breaks?
 *
 * Written after an audit found that 380 of 588 users holding a live check had no
 * reachable alert channel at all: no email settings document, no enabled webhook,
 * no SMS. Onboarding promises "we'll alert you the moment anything changes" and
 * then never wires up a channel, so the promise was false for most accounts.
 *
 * Coverage is computed with the SAME resolution the delivery path uses
 * (`emailEventAllowedForCheck`), not an approximation, so a user reported as
 * covered here would genuinely receive the mail.
 */
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { CONFIG } from "./config";
import { eventAllowedForCheck, type GateSettings } from "./email-gate";
import type { EmailSettings, SmsSettings, WebhookEvent } from "./types";

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
  /** Enabled checks that would produce a down email. */
  emailCoveredCheckCount: number;
  hasEmailChannel: boolean;
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

/** User ids with at least one webhook that is not explicitly disabled. */
export async function loadWebhookUserIds(): Promise<Set<string>> {
  const snap = await firestore.collection("webhooks").select("userId", "enabled").get();
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    if (doc.get("enabled") === false) continue;
    const userId = doc.get("userId") as string | undefined;
    if (userId) ids.add(userId);
  }
  return ids;
}

export interface CoverageInputs {
  checksByUser: Map<string, CoverageCheck[]>;
  emailSettings: Map<string, EmailSettings>;
  smsSettings: Map<string, SmsSettings>;
  webhookUserIds: Set<string>;
}

/** Load everything the coverage calculation needs in four collection reads. */
export async function loadCoverageInputs(): Promise<CoverageInputs> {
  const [checksByUser, emailSnap, smsSnap, webhookUserIds] = await Promise.all([
    loadChecksByUser(),
    firestore.collection("emailSettings").get(),
    firestore.collection("smsSettings").get(),
    loadWebhookUserIds(),
  ]);

  const emailSettings = new Map<string, EmailSettings>();
  for (const doc of emailSnap.docs) emailSettings.set(doc.id, doc.data() as EmailSettings);

  const smsSettings = new Map<string, SmsSettings>();
  for (const doc of smsSnap.docs) smsSettings.set(doc.id, doc.data() as SmsSettings);

  return { checksByUser, emailSettings, smsSettings, webhookUserIds };
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
  tier: "free" | "indie" | "nano" | "pro",
): UserCoverage {
  const checks = inputs.checksByUser.get(userId) ?? [];
  const enabled = checks.filter((c) => !c.disabled);

  const email = inputs.emailSettings.get(userId) ?? null;
  const emailCovered = enabled.filter((c) => eventAllowedForCheck(email, c, COVERAGE_EVENT));

  // SmsSettings is structurally the same gate shape (it just has no per-check
  // recipients), so the same resolution applies.
  const smsDoc = (inputs.smsSettings.get(userId) ?? null) as GateSettings | null;
  const smsAllowedByTier = CONFIG.getTierLimits(tier).smsAlerts === true;
  const hasSmsChannel = smsAllowedByTier
    && enabled.some((c) => eventAllowedForCheck(smsDoc, c, COVERAGE_EVENT));

  const hasWebhookChannel = inputs.webhookUserIds.has(userId);

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

export function logCoverageSummary(scope: string, rows: UserCoverage[]): CoverageSummary {
  const summary = summarizeCoverage(rows);
  logger.info(`[alert-coverage] ${scope}`, summary as unknown as Record<string, unknown>);
  return summary;
}
