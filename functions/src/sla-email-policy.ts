// Pure decisions of the SLA monthly email job (sla-email.ts), testable
// without firebase-admin. See docs/plans/sla-reporting.md, section 7.1.

import { normalizeEmail } from "./email-suppression-policy";
import { SLA_FINALIZE_MARGIN_MS, currentPeriod, finalizeAt, nextPeriod, periodBounds } from "./sla-time";
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
  ownerHasSla: boolean,
  nowMs: number,
): SlaSendDecision {
  const tz = report.timezone;
  const due = report.nextSendAfter ?? nowMs;
  const period = duePeriodOf(due, tz);
  const advance = nextSendAfterPeriod(period, tz, nowMs);

  if (!report.schedule?.enabled) return { kind: "skip", period, reason: "schedule_off", nextSendAfter: advance };
  if (due > nowMs) return { kind: "wait", period, reason: "not_due" };
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
