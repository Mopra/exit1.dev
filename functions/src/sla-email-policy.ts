// Pure decisions of the SLA monthly email job (sla-email.ts), testable
// without firebase-admin. See docs/plans/sla-reporting.md, section 7.1.

import { TIER_LIMITS } from "./config";
import { normalizeEmail } from "./email-suppression-policy";
import {
  SLA_FINALIZE_MARGIN_MS,
  comparePeriods,
  currentPeriod,
  finalizeAt,
  nextPeriod,
  periodBounds,
  previousPeriod,
} from "./sla-time";
import type { SlaReportDoc } from "./sla-types";

/** A month that ended longer ago than this is skipped, not sent late. */
export const SLA_EMAIL_MAX_LATE_MS = 7 * 24 * 60 * 60 * 1000;

export const slaAppUrl = (reportId: string, period: string) =>
  `https://app.exit1.dev/sla/${encodeURIComponent(reportId)}?period=${period}`;

/** The local month a due `nextSendAfter` belongs to (the one that just ended). */
export function duePeriodOf(nextSendAfter: number, timezone: string): string {
  return currentPeriod(nextSendAfter - SLA_FINALIZE_MARGIN_MS - 1, timezone);
}

/**
 * The next send point after `period`. Skips months whose window already
 * passed, so a re-upgrade or a long outage never sends a backlog.
 */
export function nextSendAfterPeriod(period: string, timezone: string, nowMs: number): number {
  let candidate = nextPeriod(period);
  while (periodBounds(candidate, timezone).endMs + SLA_EMAIL_MAX_LATE_MS < nowMs) candidate = nextPeriod(candidate);
  return finalizeAt(candidate, timezone);
}

/**
 * Whether the owner's tier includes SLA reporting, or null when the tier
 * lookup failed open ('free' is then only a default). Null must never count
 * as "not Pro": the send job waits and retries instead of skipping the month.
 */
export function slaEntitlementOf(lookup: { tier: string; failedOpen: boolean }): boolean | null {
  if (lookup.failedOpen) return null;
  return (TIER_LIMITS as Record<string, { slaReporting?: boolean } | undefined>)[lookup.tier]?.slaReporting === true;
}

/**
 * The send point after a time zone change. Normally the end of the current
 * month in the new zone, but when the change lands between a month's end and
 * its send, the month that just ended (in the new zone) is still owed: target
 * it while it is inside the late window, unless it was already sent or the old
 * send point was not for it yet.
 */
export function sendPointAfterZoneChange(
  existing: Pick<SlaReportDoc, "nextSendAfter" | "lastSentPeriod" | "timezone">,
  timezone: string,
  nowMs: number,
): number {
  const current = currentPeriod(nowMs, timezone);
  const justEnded = previousPeriod(current);
  const pending = typeof existing.nextSendAfter === "number" ? duePeriodOf(existing.nextSendAfter, existing.timezone) : null;
  const owed =
    pending !== null &&
    comparePeriods(pending, justEnded) <= 0 &&
    (!existing.lastSentPeriod || comparePeriods(existing.lastSentPeriod, justEnded) < 0) &&
    periodBounds(justEnded, timezone).endMs + SLA_EMAIL_MAX_LATE_MS >= nowMs;
  return finalizeAt(owed ? justEnded : current, timezone);
}

export function activeRecipients(report: Pick<SlaReportDoc, "schedule" | "unsubscribed">): string[] {
  const unsubscribed = new Set((report.unsubscribed ?? []).map(normalizeEmail));
  return (report.schedule?.recipients ?? []).map(normalizeEmail).filter((r) => r && !unsubscribed.has(r));
}

export type SlaSendDecision =
  | { kind: "send"; period: string; recipients: string[]; nextSendAfter: number }
  | { kind: "skip"; period: string; reason: string; nextSendAfter: number }
  | { kind: "wait"; period: string; reason: string };

export function decideSlaSends(
  report: Pick<SlaReportDoc, "schedule" | "unsubscribed" | "timezone" | "nextSendAfter" | "lastSentPeriod">,
  periodDoc: { status: string; timezone: string } | null,
  /** null: the tier lookup failed, so wait and retry rather than skip. */
  ownerHasSla: boolean | null,
  nowMs: number,
): SlaSendDecision {
  const tz = report.timezone;
  const due = report.nextSendAfter ?? nowMs;
  const period = duePeriodOf(due, tz);
  const advance = nextSendAfterPeriod(period, tz, nowMs);

  if (!report.schedule?.enabled) return { kind: "skip", period, reason: "schedule_off", nextSendAfter: advance };
  if (due > nowMs) return { kind: "wait", period, reason: "not_due" };
  if (ownerHasSla === null) return { kind: "wait", period, reason: "tier_unknown" };
  if (!ownerHasSla) return { kind: "skip", period, reason: "not_pro", nextSendAfter: advance };
  if (report.lastSentPeriod === period) return { kind: "skip", period, reason: "already_sent", nextSendAfter: advance };
  if (periodBounds(period, tz).endMs + SLA_EMAIL_MAX_LATE_MS < nowMs) {
    return { kind: "skip", period, reason: "too_late", nextSendAfter: advance };
  }
  if (!periodDoc || periodDoc.status !== "final" || periodDoc.timezone !== tz) {
    return { kind: "wait", period, reason: "not_final" };
  }
  const recipients = activeRecipients(report);
  if (recipients.length === 0) return { kind: "skip", period, reason: "no_recipients", nextSendAfter: advance };
  return { kind: "send", period, recipients, nextSendAfter: advance };
}
