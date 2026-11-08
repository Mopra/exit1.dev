// ============================================================================
// SLA MONTHLY EMAIL JOB (VPS cron `slaMonthlyEmails`, 30 min after each rollup)
//
// Sends each report's branded monthly email once its local month is final.
// Reads only the reports that are due (schedule on, nextSendAfter passed), so
// a run with nothing due costs one query. All mail goes through the normal
// seam (sendTransactionalEmail, category 'reports': Day3, Resend fallback).
//
// Imported by the VPS runner, so no Cloud Function definitions here. Email
// code changes need a VPS rebuild in both regions, like the alert code.
// ============================================================================

import * as logger from "firebase-functions/logger";
import { firestore, getUserEmailFromClerk } from "./init";
import { sendTransactionalEmail } from "./email-send";
import { isEmailSuppressedCached } from "./email-suppression";
import { getSlaUnsubscribeSecret } from "./env";
import { buildSlaEmail, type SlaEmail } from "./sla-email-html";
import { decideSlaSends, slaAppUrl } from "./sla-email-policy";
import { slaUnsubscribeUrl } from "./sla-unsubscribe-token";
import { ownerHasSlaReporting, periodDocRef } from "./sla-snapshot";
import { SLA_REPORTS_COLLECTION, type SlaPeriodDoc, type SlaReportDoc, type SlaSentRecord } from "./sla-types";

const SEND_SPACING_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Sent on behalf of ...": company name, else the owner's email, else the report name. */
export async function slaSenderLabel(report: SlaReportDoc): Promise<string> {
  const company = report.branding?.companyName?.trim();
  if (company) return company;
  try {
    const email = await getUserEmailFromClerk(report.userId);
    if (email) return email;
  } catch {
    // Fall through to the report name.
  }
  return report.name;
}

/** Build one recipient's copy (the unsubscribe link is per recipient). */
export function buildSlaEmailFor(
  reportId: string,
  report: SlaReportDoc,
  period: SlaPeriodDoc,
  recipient: string,
  senderLabel: string,
  opts: { test?: boolean } = {},
): SlaEmail {
  const secret = getSlaUnsubscribeSecret();
  if (!secret) throw new Error("SLA_UNSUBSCRIBE_SECRET is not configured");
  return buildSlaEmail(
    { id: reportId, name: report.name, timezone: period.timezone, branding: report.branding ?? null },
    period,
    {
      appUrl: slaAppUrl(reportId, period.period),
      unsubscribeUrl: slaUnsubscribeUrl(secret, reportId, recipient),
      senderLabel,
      test: opts.test,
    },
  );
}

export interface SlaEmailRunResult {
  due: number;
  sent: number;
  skipped: number;
  waiting: number;
  failed: number;
}

export async function runSlaMonthlyEmails(nowMs: number = Date.now()): Promise<SlaEmailRunResult> {
  const result: SlaEmailRunResult = { due: 0, sent: 0, skipped: 0, waiting: 0, failed: 0 };
  // Index: sla_reports (schedule.enabled ASC, nextSendAfter ASC).
  const snap = await firestore
    .collection(SLA_REPORTS_COLLECTION)
    .where("schedule.enabled", "==", true)
    .where("nextSendAfter", "<=", nowMs)
    .get();
  result.due = snap.size;
  if (snap.empty) return result;

  if (!getSlaUnsubscribeSecret()) {
    logger.error("[sla-email] SLA_UNSUBSCRIBE_SECRET is not set; not sending without a working unsubscribe link");
    result.waiting = snap.size;
    return result;
  }

  const proByOwner = new Map<string, Promise<boolean>>();
  for (const doc of snap.docs) {
    const report = doc.data() as SlaReportDoc;
    const ref = doc.ref;
    try {
      let pro = proByOwner.get(report.userId);
      if (!pro) {
        pro = ownerHasSlaReporting(report.userId).catch(() => false);
        proByOwner.set(report.userId, pro);
      }
      const ownerPro = await pro;

      // Read the period doc only when it can matter.
      let periodDoc: SlaPeriodDoc | null = null;
      const probe = decideSlaSends(report, { status: "final", timezone: report.timezone }, ownerPro, nowMs);
      if (probe.kind === "send") {
        const ps = await periodDocRef(doc.id, probe.period).get();
        periodDoc = ps.exists ? (ps.data() as SlaPeriodDoc) : null;
      }
      const decision = probe.kind === "send" ? decideSlaSends(report, periodDoc, ownerPro, nowMs) : probe;

      if (decision.kind === "wait") {
        result.waiting++;
        logger.info("[sla-email] waiting", { reportId: doc.id, period: decision.period, reason: decision.reason });
        continue;
      }
      if (decision.kind === "skip") {
        result.skipped++;
        await ref.update({ nextSendAfter: decision.nextSendAfter });
        logger.info("[sla-email] skipped", { reportId: doc.id, period: decision.period, reason: decision.reason });
        continue;
      }

      const period = periodDoc as SlaPeriodDoc;
      const senderLabel = await slaSenderLabel(report);
      let delivered = 0;
      let suppressed = 0;
      const errors: string[] = [];
      for (const recipient of decision.recipients) {
        if (await isEmailSuppressedCached(recipient)) {
          suppressed++;
          continue;
        }
        if (delivered + errors.length > 0) await sleep(SEND_SPACING_MS);
        try {
          const email = buildSlaEmailFor(doc.id, report, period, recipient, senderLabel);
          await sendTransactionalEmail({
            to: recipient,
            subject: email.subject,
            html: email.html,
            text: email.text,
            category: "reports",
            meta: { reportId: doc.id, period: decision.period, uid: report.userId },
          });
          delivered++;
        } catch (err) {
          errors.push(`${recipient}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const lastSendError = errors.length ? errors.join("; ").slice(0, 1000) : null;
      if (delivered === 0 && errors.length > 0) {
        // Nothing went out: stay due, retry on the next run (bounded by the 7-day window).
        result.failed++;
        await ref.update({ lastSendError });
        logger.warn("[sla-email] all sends failed", { reportId: doc.id, period: decision.period, errors });
        continue;
      }

      const sentAt = Date.now();
      await ref.update({
        lastSentPeriod: decision.period,
        lastSentAt: sentAt,
        lastSendError,
        nextSendAfter: decision.nextSendAfter,
      });
      if (delivered > 0) {
        const sentRecord: SlaSentRecord = {
          sentAt,
          timezone: period.timezone,
          availability: period.overall.availability,
          status: period.overall.status,
          recipients: delivered,
        };
        await periodDocRef(doc.id, decision.period).set({ sentRecord }, { merge: true });
        result.sent++;
      } else {
        result.skipped++;
      }
      logger.info("[sla-email] sent", { reportId: doc.id, period: decision.period, delivered, suppressed, failed: errors.length });
    } catch (err) {
      result.failed++;
      logger.error("[sla-email] report failed", { reportId: doc.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
