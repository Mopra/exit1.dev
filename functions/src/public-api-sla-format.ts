// Pure formatting and access rules for the SLA public API routes
// (public-api-sla.ts), kept free of firebase-admin for tests.

import { canAccessCheck, type KeyAccess } from "./public-api-access";
import type { SlaPeriodDoc, SlaReportDoc } from "./sla-types";

export const iso = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export const SLA_FEATURE_ERROR = {
  error: "feature_not_in_plan",
  feature: "slaReporting",
  message: "SLA reporting is a Pro feature",
} as const;

/** Period doc as API JSON: UTC ISO timestamps plus the report's zone. */
export function formatSlaPeriod(reportId: string, report: Pick<SlaReportDoc, "name">, p: SlaPeriodDoc) {
  return {
    reportId,
    name: report.name,
    period: p.period,
    timezone: p.timezone,
    status: p.status,
    periodStart: iso(p.periodStart),
    periodEnd: iso(p.periodEnd),
    dataThrough: iso(p.dataThrough),
    computedAt: iso(p.computedAt),
    targetPercent: p.targetPercent,
    countBlockedAsDown: p.countBlockedAsDown,
    overall: p.overall,
    daily: p.daily,
    checks: p.checks,
    incidents: p.incidents.map((i) => ({ checkId: i.checkId, start: iso(i.startMs), end: iso(i.endMs), durationMs: i.durationMs, ongoing: i.endMs === null })),
    incidentsTotal: p.incidentsTotal,
    exclusions: p.exclusions.map((e) => ({ checkId: e.checkId, state: e.state, start: iso(e.startMs), end: iso(e.endMs), durationMs: e.endMs - e.startMs })),
    exclusionsTotal: p.exclusionsTotal ?? p.exclusions.length,
    sent: p.sentRecord ? { sentAt: iso(p.sentRecord.sentAt), timezone: p.sentRecord.timezone, availability: p.sentRecord.availability, status: p.sentRecord.status } : null,
  };
}

/** Whether a key's grant covers every check in a period doc. Unrestricted keys see all. */
export function periodWithinAccess(access: KeyAccess | null, p: Pick<SlaPeriodDoc, "checks"> | null, folders: Map<string, string | null>): boolean {
  if (!access) return true;
  if (!p) return false;
  return p.checks.every((c) => canAccessCheck(access, c.checkId, folders.get(c.checkId) ?? null));
}

