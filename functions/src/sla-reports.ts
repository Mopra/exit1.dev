// ============================================================================
// SLA REPORT CALLABLES
//
//   upsertSlaReport       create or edit (Pro, editors)
//   deleteSlaReport       delete with its periods (any tier, editors)
//   refreshSlaReport      compute one month on demand (Pro, any member, rate limited)
//   sendSlaReportTest     email one month to the signed-in user only (Pro, editors)
//   previewSlaReportEmail HTML for the editor's preview iframe (Pro, Firestore only)
//   backfillSlaRollup     admin: roll up past days into check_sla_daily
//
// All writes to sla_reports go through here (rules deny client writes): the
// server validates scope, caps, the zone and the tier. Team members pass
// `accountId` (src/lib/callable.ts). See docs/plans/sla-reporting.md.
// ============================================================================

import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore, getUserTier, getUserEmailFromClerk } from "./init";
import { TIER_LIMITS } from "./config";
import {
  CLERK_SECRET_KEY_DEV,
  CLERK_SECRET_KEY_PROD,
  DAY3_API_KEY,
  DAY3_FROM,
  RESEND_API_KEY,
  RESEND_FROM,
  SLA_UNSUBSCRIBE_SECRET,
} from "./env";
import { resolveAccount } from "./team-access";
import { FixedWindowRateLimiter } from "./rate-limit";
import { requireAdmin } from "./require-admin";
import { sendTransactionalEmail } from "./email-send";
import {
  SlaValidationError,
  nextSendAfterFor,
  normalizeBranding,
  validateSlaReportInput,
  SLA_MAX_CHECKS_PER_REPORT,
} from "./sla-reports-policy";
import {
  computeAndWritePeriods,
  loadChecksById,
  periodDocRef,
  readRollupSettings,
  resolveReportChecks,
} from "./sla-snapshot";
import { SLA_ROLLUP_VERSION, computePeriod } from "./sla-math";
import { comparePeriods, currentPeriod, isValidPeriod, isValidTimeZone, previousPeriod } from "./sla-time";
import { buildSlaEmail } from "./sla-email-html";
import { buildSlaEmailFor, slaSenderLabel } from "./sla-email";
import { sendPointAfterZoneChange, slaAppUrl } from "./sla-email-policy";
import {
  SLA_PERIODS_SUBCOLLECTION,
  SLA_REPORTS_COLLECTION,
  type SlaPeriodDoc,
  type SlaReportDoc,
} from "./sla-types";

const HOUR_MS = 60 * 60 * 1000;
/** Months back a user can open (table retention is 3 years). */
const MAX_PERIODS_BACK = 36;
/** An open month computed this recently is served as is. */
const OPEN_PERIOD_FRESH_MS = 10 * 60 * 1000;

/** BigQuery recomputes (create, edit, zone change, opening a stale month): 10 per account per hour. */
const refreshLimiter = new FixedWindowRateLimiter({ windowMs: HOUR_MS });
const REFRESH_LIMIT = 10;
/** Test emails: 5 per signed-in user per hour. */
const testLimiter = new FixedWindowRateLimiter({ windowMs: HOUR_MS });
const TEST_LIMIT = 5;

const CLERK = [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV];
const EMAIL = [RESEND_API_KEY, RESEND_FROM, DAY3_API_KEY, DAY3_FROM, SLA_UNSUBSCRIBE_SECRET];

const reportsCol = () => firestore.collection(SLA_REPORTS_COLLECTION);

async function requireSlaTier(ownerUid: string): Promise<void> {
  const tier = await getUserTier(ownerUid);
  if (!TIER_LIMITS[tier]?.slaReporting) {
    throw new HttpsError("failed-precondition", "SLA reporting is a Pro feature");
  }
}

function readReportId(data: unknown): string {
  const id = (data as { reportId?: unknown } | null)?.reportId;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new HttpsError("invalid-argument", "reportId is required");
  }
  return id;
}

async function loadOwnedReport(reportId: string, accountId: string): Promise<SlaReportDoc> {
  const snap = await reportsCol().doc(reportId).get();
  const report = snap.exists ? (snap.data() as SlaReportDoc) : null;
  if (!report || report.userId !== accountId) throw new HttpsError("not-found", "SLA report not found");
  return report;
}

function consumeRefresh(accountId: string): boolean {
  return refreshLimiter.consume(`sla:${accountId}`, REFRESH_LIMIT).allowed;
}

/** Recompute one month of one report from check_sla_daily and write it. */
async function recomputePeriod(
  reportId: string,
  report: SlaReportDoc,
  period: string,
  dataThrough: number,
  previousTimezone: string | null,
): Promise<SlaPeriodDoc> {
  const { checks, truncated } = await resolveReportChecks(report);
  if (truncated) logger.warn("[sla] report scope truncated to the check cap", { reportId });
  const prev = new Map<string, string>();
  if (previousTimezone) prev.set(`${reportId}/${period}`, previousTimezone);
  const { docs, bytesBilled } = await computeAndWritePeriods([{ reportId, report, period, checks }], dataThrough, { previousTimezones: prev });
  logger.info("[sla] on-demand refresh", { reportId, period, bytesBilled });
  const doc = docs.get(`${reportId}/${period}`)!;
  if (doc.status === "final" && (!report.lastFinalPeriod || comparePeriods(period, report.lastFinalPeriod) > 0)) {
    await reportsCol().doc(reportId).update({ lastFinalPeriod: period });
  }
  return doc;
}

function rethrow(err: unknown): never {
  if (err instanceof HttpsError) throw err;
  if (err instanceof SlaValidationError) throw new HttpsError("invalid-argument", err.message);
  logger.error("[sla] callable failed", err);
  throw new HttpsError("internal", "Something went wrong with the SLA report");
}

// ── upsertSlaReport ─────────────────────────────────────────────────────────

export const upsertSlaReport = onCall({ cors: true, maxInstances: 10, secrets: CLERK }, async (request: CallableRequest) => {
  try {
    const ctx = await resolveAccount(request, "write");
    const accountId = ctx.accountId;
    await requireSlaTier(accountId);

    const raw = (request.data ?? {}) as Record<string, unknown>;
    const reportId = raw.reportId === undefined || raw.reportId === null ? null : readReportId(raw);
    const input = validateSlaReportInput(raw);
    const now = Date.now();

    const existing = reportId ? await loadOwnedReport(reportId, accountId) : null;
    if (!existing) {
      const tier = await getUserTier(accountId);
      const max = TIER_LIMITS[tier].maxSlaReports;
      const count = (await reportsCol().where("userId", "==", accountId).count().get()).data().count;
      if (count >= max) {
        throw new HttpsError("resource-exhausted", `Your plan allows ${max} SLA reports`);
      }
    }

    // Explicit checks must belong to this account (deleted ones already in the
    // report may stay, so their history keeps counting).
    const known = new Set(existing?.checkIds ?? []);
    const newIds = input.checkIds.filter((id) => !known.has(id));
    if (newIds.length > 0) {
      const found = await loadChecksById(newIds);
      const owned = new Set(found.filter((c) => c.userId === accountId).map((c) => c.id));
      const foreign = newIds.filter((id) => !owned.has(id));
      if (foreign.length > 0) throw new HttpsError("invalid-argument", `Unknown check: ${foreign[0]}`);
    }

    const scope = await resolveReportChecks({ userId: accountId, checkIds: input.checkIds, folderPaths: input.folderPaths });
    if (scope.truncated) {
      throw new HttpsError("invalid-argument", `These checks and folders cover more than ${SLA_MAX_CHECKS_PER_REPORT} checks`);
    }

    const zoneChanged = !!existing && existing.timezone !== input.timezone;
    if (zoneChanged && !consumeRefresh(accountId)) {
      throw new HttpsError("resource-exhausted", "Too many SLA recalculations this hour. Try the time zone change again later.");
    }

    const keepSendPoint = existing?.schedule?.enabled && input.schedule.enabled && !zoneChanged && typeof existing.nextSendAfter === "number";
    // A zone change between a month's end and its send must not skip that month.
    const moveSendPoint = existing?.schedule?.enabled && input.schedule.enabled && zoneChanged;
    const nextSendAfter = keepSendPoint
      ? existing!.nextSendAfter
      : moveSendPoint
        ? sendPointAfterZoneChange(existing!, input.timezone, now)
        : nextSendAfterFor(input.schedule.enabled, input.timezone, now);
    const doc: SlaReportDoc = {
      userId: accountId,
      name: input.name,
      targetPercent: input.targetPercent,
      checkIds: input.checkIds,
      folderPaths: input.folderPaths,
      timezone: input.timezone,
      countBlockedAsDown: input.countBlockedAsDown,
      schedule: input.schedule,
      branding: input.branding,
      unsubscribed: existing?.unsubscribed ?? [],
      nextSendAfter,
      lastSentPeriod: existing?.lastSentPeriod ?? null,
      lastSentAt: existing?.lastSentAt ?? null,
      lastSendError: existing?.lastSendError ?? null,
      lastFinalPeriod: existing?.lastFinalPeriod ?? null,
      createdAt: existing?.createdAt ?? now,
      createdBy: existing?.createdBy ?? ctx.actorUid,
      updatedAt: now,
      updatedBy: ctx.actorUid,
    };

    const ref = reportId ? reportsCol().doc(reportId) : reportsCol().doc();
    if (existing) {
      // Write only the fields the editor owns. `unsubscribed` (the unsubscribe
      // endpoint) and the send/rollup bookkeeping (the cron jobs) can change
      // between our read and this write; a full overwrite would undo them.
      // update() replaces each named field whole, so nested maps do not merge.
      await ref.update({
        name: doc.name,
        targetPercent: doc.targetPercent,
        checkIds: doc.checkIds,
        folderPaths: doc.folderPaths,
        timezone: doc.timezone,
        countBlockedAsDown: doc.countBlockedAsDown,
        schedule: doc.schedule,
        branding: doc.branding,
        nextSendAfter: doc.nextSendAfter,
        updatedAt: doc.updatedAt,
        updatedBy: doc.updatedBy,
      });
    } else {
      await ref.create(doc);
    }

    // A zone change can move the current month id near a month boundary; the
    // old open doc would otherwise linger. Final months are recomputed lazily.
    if (zoneChanged) {
      const oldCurrent = currentPeriod(now, existing!.timezone);
      const newCurrent = currentPeriod(now, input.timezone);
      if (oldCurrent !== newCurrent) {
        const old = await periodDocRef(ref.id, oldCurrent).get();
        if (old.exists && (old.data() as SlaPeriodDoc).status === "open") await old.ref.delete();
      }
    }

    // Recompute the current month so the page has numbers right away.
    let period: SlaPeriodDoc | null = null;
    const settings = await readRollupSettings();
    const scopeChanged = !existing ||
      zoneChanged ||
      existing.targetPercent !== doc.targetPercent ||
      existing.countBlockedAsDown !== doc.countBlockedAsDown ||
      JSON.stringify(existing.checkIds) !== JSON.stringify(doc.checkIds) ||
      JSON.stringify(existing.folderPaths) !== JSON.stringify(doc.folderPaths);
    if (settings && scopeChanged && (zoneChanged || consumeRefresh(accountId))) {
      period = await recomputePeriod(ref.id, doc, currentPeriod(now, doc.timezone), settings.dataThrough, null);
    }

    return { reportId: ref.id, period, refreshed: period !== null };
  } catch (err) {
    rethrow(err);
  }
});

// ── deleteSlaReport ─────────────────────────────────────────────────────────

export const deleteSlaReport = onCall({ cors: true, maxInstances: 10 }, async (request: CallableRequest) => {
  try {
    // Any tier: a downgraded account can still clean up.
    const ctx = await resolveAccount(request, "write");
    const reportId = readReportId(request.data);
    await loadOwnedReport(reportId, ctx.accountId);
    await firestore.recursiveDelete(reportsCol().doc(reportId));
    return { deleted: true };
  } catch (err) {
    rethrow(err);
  }
});

// ── refreshSlaReport ────────────────────────────────────────────────────────

export const refreshSlaReport = onCall({ cors: true, maxInstances: 10, timeoutSeconds: 120, secrets: CLERK }, async (request: CallableRequest) => {
  try {
    const ctx = await resolveAccount(request, "read");
    await requireSlaTier(ctx.accountId);
    const reportId = readReportId(request.data);
    const report = await loadOwnedReport(reportId, ctx.accountId);
    const now = Date.now();

    const current = currentPeriod(now, report.timezone);
    const rawPeriod = (request.data as { period?: unknown }).period;
    const period = rawPeriod === undefined || rawPeriod === null ? current : rawPeriod;
    if (!isValidPeriod(period)) throw new HttpsError("invalid-argument", "period must be YYYY-MM");
    if (comparePeriods(period, current) > 0) throw new HttpsError("invalid-argument", "That month has not started yet");
    let oldest = current;
    for (let i = 0; i < MAX_PERIODS_BACK; i++) oldest = previousPeriod(oldest);
    if (comparePeriods(period, oldest) < 0) throw new HttpsError("invalid-argument", "That month is older than the SLA history");

    const snap = await periodDocRef(reportId, period).get();
    const existing = snap.exists ? (snap.data() as SlaPeriodDoc) : null;
    const sameZone = existing?.timezone === report.timezone && existing?.rollupVersion === SLA_ROLLUP_VERSION;
    if (existing && sameZone && (existing.status === "final" || now - existing.computedAt < OPEN_PERIOD_FRESH_MS)) {
      return { period: existing, recomputed: false };
    }

    const settings = await readRollupSettings();
    if (!settings) throw new HttpsError("failed-precondition", "SLA data is not ready yet. Try again in a few hours.");
    if (!consumeRefresh(ctx.accountId)) {
      if (existing) return { period: existing, recomputed: false, rateLimited: true };
      throw new HttpsError("resource-exhausted", "Too many SLA recalculations this hour. Try again later.");
    }
    const previousTimezone = existing && existing.timezone !== report.timezone ? existing.timezone : null;
    const doc = await recomputePeriod(reportId, report, period, settings.dataThrough, previousTimezone);
    return { period: doc, recomputed: true };
  } catch (err) {
    rethrow(err);
  }
});

// ── sendSlaReportTest ───────────────────────────────────────────────────────

/** The month a test or preview shows: the requested one, else the last final, else the open one. */
async function pickPeriodDoc(reportId: string, requested: unknown): Promise<SlaPeriodDoc | null> {
  if (requested !== undefined && requested !== null) {
    if (!isValidPeriod(requested)) throw new HttpsError("invalid-argument", "period must be YYYY-MM");
    const s = await periodDocRef(reportId, requested).get();
    return s.exists ? (s.data() as SlaPeriodDoc) : null;
  }
  const col = reportsCol().doc(reportId).collection(SLA_PERIODS_SUBCOLLECTION);
  const finals = await col.where("status", "==", "final").orderBy("period", "desc").limit(1).get();
  if (!finals.empty) return finals.docs[0].data() as SlaPeriodDoc;
  const open = await col.orderBy("period", "desc").limit(1).get();
  return open.empty ? null : (open.docs[0].data() as SlaPeriodDoc);
}

export const sendSlaReportTest = onCall({ cors: true, maxInstances: 5, secrets: [...CLERK, ...EMAIL] }, async (request: CallableRequest) => {
  try {
    const ctx = await resolveAccount(request, "write");
    await requireSlaTier(ctx.accountId);
    const reportId = readReportId(request.data);
    const report = await loadOwnedReport(reportId, ctx.accountId);

    if (!testLimiter.consume(`sla-test:${ctx.actorUid}`, TEST_LIMIT).allowed) {
      throw new HttpsError("resource-exhausted", `You can send ${TEST_LIMIT} test emails per hour`);
    }
    const period = await pickPeriodDoc(reportId, (request.data as { period?: unknown }).period);
    if (!period) throw new HttpsError("failed-precondition", "This report has no numbers yet. Open it once, then send a test.");

    const to = await getUserEmailFromClerk(ctx.actorUid);
    if (!to) throw new HttpsError("failed-precondition", "Your account has no email address");

    const email = buildSlaEmailFor(reportId, report, period, to, await slaSenderLabel(report), { test: true });
    const result = await sendTransactionalEmail({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      category: "reports",
      meta: { reportId, period: period.period, uid: ctx.accountId, test: true },
    });
    return { sentTo: to, period: period.period, provider: result.provider };
  } catch (err) {
    rethrow(err);
  }
});

// ── previewSlaReportEmail ───────────────────────────────────────────────────

export const previewSlaReportEmail = onCall({ cors: true, maxInstances: 10, secrets: CLERK }, async (request: CallableRequest) => {
  try {
    const ctx = await resolveAccount(request, "read");
    await requireSlaTier(ctx.accountId);
    const data = (request.data ?? {}) as { reportId?: unknown; period?: unknown; draft?: Record<string, unknown> };
    const reportId = data.reportId ? readReportId(data) : null;
    const report = reportId ? await loadOwnedReport(reportId, ctx.accountId) : null;

    // Unsaved editor values win over the stored report.
    const draft = data.draft ?? {};
    const name = typeof draft.name === "string" && draft.name.trim() ? draft.name.trim().slice(0, 80) : report?.name ?? "New SLA report";
    const timezone = typeof draft.timezone === "string" && draft.timezone ? draft.timezone : report?.timezone ?? "UTC";
    if (!isValidTimeZone(timezone)) throw new HttpsError("invalid-argument", "timezone must be an IANA time zone");
    const targetPercent = typeof draft.targetPercent === "number" ? draft.targetPercent : report?.targetPercent ?? 99.9;
    let branding = report?.branding ?? null;
    if (draft.branding !== undefined) branding = normalizeBranding(draft.branding);

    const stored = reportId ? await pickPeriodDoc(reportId, data.period) : null;
    const period = stored ?? computePeriod({
      period: currentPeriod(Date.now(), timezone),
      timezone,
      targetPercent,
      countBlockedAsDown: false,
      checks: [],
      rows: [],
      dataThroughMs: Date.now(),
    });

    const email = buildSlaEmail(
      { id: reportId ?? "preview", name, timezone: period.timezone, branding },
      { ...period, targetPercent: stored ? period.targetPercent : targetPercent },
      {
        appUrl: slaAppUrl(reportId ?? "preview", period.period),
        unsubscribeUrl: "https://app.exit1.dev/sla",
        senderLabel: branding?.companyName || name,
      },
    );
    return { subject: email.subject, html: email.html, text: email.text, period: stored ? period.period : null };
  } catch (err) {
    rethrow(err);
  }
});

// ── backfillSlaRollup (admin) ───────────────────────────────────────────────

export const backfillSlaRollup = onCall({
  cors: true,
  maxInstances: 1,
  timeoutSeconds: 3600,
  memory: "512MiB",
  secrets: CLERK,
}, async (request: CallableRequest) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Authentication required");
  await requireAdmin(uid);
  const { startDay, endDay, dryRun } = (request.data ?? {}) as { startDay?: unknown; endDay?: unknown; dryRun?: unknown };
  if (typeof startDay !== "string" || typeof endDay !== "string") {
    throw new HttpsError("invalid-argument", "startDay and endDay are required (YYYY-MM-DD, at most 31 days)");
  }
  try {
    const { backfillSlaRollup: run } = await import("./sla-rollup.js");
    const result = await run(startDay, endDay, { dryRun: dryRun === true });
    logger.info("[sla] backfill", { uid, startDay, endDay, dryRun: dryRun === true, bytesBilled: result.bytesBilled });
    return { success: true, ...result };
  } catch (err) {
    throw new HttpsError("internal", `Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});
