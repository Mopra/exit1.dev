// Public API: read-only SLA reports (Pro).
//
//   GET /v1/public/sla-reports                  list with the current month's headline
//   GET /v1/public/sla-reports/:id?period=YYYY-MM   one month (default: current local month)
//
// Firestore only: the API never triggers a recompute, so a month with no
// period doc is a 404. A key restricted to some checks or folders only sees
// reports whose checks all fall inside its grant. See
// docs/plans/sla-reporting.md, section 8.1.

import type { Response } from "express";
import { firestore, getUserTier } from "./init";
import { TIER_LIMITS } from "./config";
import type { KeyAccess } from "./public-api-access";
import { SLA_FEATURE_ERROR, formatSlaPeriod, iso, periodWithinAccess } from "./public-api-sla-format";
import { currentPeriod, isValidPeriod } from "./sla-time";
import { SLA_REPORTS_COLLECTION, SLA_PERIODS_SUBCOLLECTION, type SlaPeriodDoc, type SlaReportDoc } from "./sla-types";

async function ownerHasSla(userId: string): Promise<boolean> {
  return TIER_LIMITS[await getUserTier(userId)]?.slaReporting === true;
}

async function checkFolders(userId: string, access: KeyAccess | null): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (!access) return map;
  const snap = await firestore.collection("checks").where("userId", "==", userId).select("folder").get();
  for (const d of snap.docs) map.set(d.id, typeof d.get("folder") === "string" ? d.get("folder") : null);
  return map;
}

const periodRef = (reportId: string, period: string) =>
  firestore.collection(SLA_REPORTS_COLLECTION).doc(reportId).collection(SLA_PERIODS_SUBCOLLECTION).doc(period);

export async function handleListSlaReports(res: Response, userId: string, access: KeyAccess | null): Promise<void> {
  if (!(await ownerHasSla(userId))) {
    res.status(403).json(SLA_FEATURE_ERROR);
    return;
  }
  const snap = await firestore.collection(SLA_REPORTS_COLLECTION).where("userId", "==", userId).get();
  const now = Date.now();
  const folders = await checkFolders(userId, access);
  const rows = await Promise.all(snap.docs.map(async (doc) => {
    const r = doc.data() as SlaReportDoc;
    const period = currentPeriod(now, r.timezone);
    const ps = await periodRef(doc.id, period).get();
    const p = ps.exists ? (ps.data() as SlaPeriodDoc) : null;
    if (!periodWithinAccess(access, p, folders)) return null;
    return {
      id: doc.id,
      name: r.name,
      targetPercent: r.targetPercent,
      timezone: r.timezone,
      checkCount: p ? p.checks.length : null,
      createdAt: iso(r.createdAt),
      current: p
        ? { period, availability: p.overall.availability, status: p.overall.status, budgetUsed: p.overall.budgetUsed, coverage: p.overall.coverage, dataThrough: iso(p.dataThrough) }
        : { period, availability: null, status: null, budgetUsed: null, coverage: null, dataThrough: null },
    };
  }));
  const data = rows.filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ data, meta: { total: data.length } });
}

export async function handleGetSlaReport(
  res: Response,
  userId: string,
  reportId: string,
  periodParam: unknown,
  access: KeyAccess | null,
): Promise<void> {
  if (!(await ownerHasSla(userId))) {
    res.status(403).json(SLA_FEATURE_ERROR);
    return;
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(reportId)) {
    res.status(404).json({ error: "SLA report not found" });
    return;
  }
  if (periodParam !== undefined && !isValidPeriod(periodParam)) {
    res.status(400).json({ error: "period must be YYYY-MM" });
    return;
  }
  const rs = await firestore.collection(SLA_REPORTS_COLLECTION).doc(reportId).get();
  const report = rs.exists ? (rs.data() as SlaReportDoc) : null;
  if (!report || report.userId !== userId) {
    res.status(404).json({ error: "SLA report not found" });
    return;
  }
  const period = typeof periodParam === "string" ? periodParam : currentPeriod(Date.now(), report.timezone);
  const ps = await periodRef(reportId, period).get();
  const p = ps.exists ? (ps.data() as SlaPeriodDoc) : null;
  if (!p) {
    res.status(404).json({ error: `No SLA data for ${period} yet. Open the month in the app to compute it.` });
    return;
  }
  if (!periodWithinAccess(access, p, await checkFolders(userId, access))) {
    res.status(404).json({ error: "SLA report not found" });
    return;
  }
  res.json({ data: formatSlaPeriod(reportId, report, p) });
}
