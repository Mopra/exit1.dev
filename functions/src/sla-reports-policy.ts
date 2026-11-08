// ============================================================================
// SLA REPORT VALIDATION AND SCOPE (pure)
//
// Everything a callable needs to decide before it writes an sla_reports doc,
// kept free of firebase-admin so it can be unit-tested. See
// docs/plans/sla-reporting.md, sections 3.1 and 9.
// ============================================================================

import { normalizeEmail } from "./email-suppression-policy";
import { folderMatches, folderPathError, normalizeFolderParam } from "./public-api-folder";
import type { SlaCheckInput } from "./sla-math";
import { currentPeriod, finalizeAt, isValidTimeZone } from "./sla-time";
import type { SlaBranding } from "./sla-types";

export const SLA_MAX_CHECKS_PER_REPORT = 250;
export const SLA_MAX_RECIPIENTS = 10;
export const SLA_MAX_FOLDERS = 50;
export const SLA_NAME_MIN = 2;
export const SLA_NAME_MAX = 80;
export const SLA_TARGET_MIN = 90;
export const SLA_TARGET_MAX = 99.999;
/** Check types with no availability to report. */
export const SLA_EXCLUDED_CHECK_TYPES = new Set(["dns", "domain"]);

const VALID_DOC_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export class SlaValidationError extends Error {}

export interface SlaReportInput {
  name: string;
  targetPercent: number;
  checkIds: string[];
  folderPaths: string[];
  timezone: string;
  countBlockedAsDown: boolean;
  schedule: { enabled: boolean; recipients: string[] };
  branding: SlaBranding | null;
}

function fail(message: string): never {
  throw new SlaValidationError(message);
}

export function validateTargetPercent(raw: unknown): number {
  const t = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  if (typeof t !== "number" || !Number.isFinite(t)) fail("targetPercent must be a number");
  if (t < SLA_TARGET_MIN || t > SLA_TARGET_MAX) fail(`targetPercent must be between ${SLA_TARGET_MIN} and ${SLA_TARGET_MAX}`);
  const scaled = t * 1000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) fail("targetPercent can have at most 3 decimals");
  return Math.round(scaled) / 1000;
}

export function normalizeRecipients(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("schedule.recipients must be an array");
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") fail("schedule.recipients must be email addresses");
    const email = normalizeEmail(value);
    if (!email) continue;
    if (email.length > 254 || !EMAIL_RE.test(email)) fail(`Not a valid email address: ${value}`);
    if (!out.includes(email)) out.push(email);
  }
  if (out.length > SLA_MAX_RECIPIENTS) fail(`A report can email at most ${SLA_MAX_RECIPIENTS} recipients`);
  return out;
}

export function normalizeBranding(raw: unknown): SlaBranding | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail("branding must be an object");
  const b = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const companyName = str(b.companyName);
  if (companyName && companyName.length > 80) fail("branding.companyName can be at most 80 characters");

  const logoUrl = str(b.logoUrl);
  if (logoUrl) {
    if (logoUrl.length > 500) fail("branding.logoUrl can be at most 500 characters");
    let parsed: URL;
    try {
      parsed = new URL(logoUrl);
    } catch {
      fail("branding.logoUrl must be a valid URL");
    }
    if (parsed.protocol !== "https:") fail("branding.logoUrl must use https");
    if (!/\.(png|jpe?g)$/i.test(parsed.pathname)) fail("branding.logoUrl must be a PNG or JPEG image (Outlook does not show SVG)");
  }

  const brandColor = str(b.brandColor);
  if (brandColor && !HEX_COLOR_RE.test(brandColor)) fail("branding.brandColor must be a hex color like #2563eb");

  if (!companyName && !logoUrl && !brandColor) return null;
  return { companyName, logoUrl, brandColor: brandColor ? brandColor.toLowerCase() : null };
}

/** Validate and normalize a create or update payload. Throws SlaValidationError. */
export function validateSlaReportInput(raw: unknown): SlaReportInput {
  if (!raw || typeof raw !== "object") fail("Missing report data");
  const d = raw as Record<string, unknown>;

  const name = typeof d.name === "string" ? d.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < SLA_NAME_MIN || name.length > SLA_NAME_MAX) {
    fail(`name must be ${SLA_NAME_MIN} to ${SLA_NAME_MAX} characters`);
  }

  const targetPercent = validateTargetPercent(d.targetPercent);

  const rawIds = d.checkIds ?? [];
  if (!Array.isArray(rawIds)) fail("checkIds must be an array");
  const checkIds = [...new Set(rawIds.map((id) => (typeof id === "string" ? id.trim() : "")))];
  if (checkIds.some((id) => !VALID_DOC_ID.test(id))) fail("checkIds contains an invalid check id");
  if (checkIds.length > SLA_MAX_CHECKS_PER_REPORT) fail(`A report can cover at most ${SLA_MAX_CHECKS_PER_REPORT} checks`);

  const rawFolders = d.folderPaths ?? [];
  if (!Array.isArray(rawFolders)) fail("folderPaths must be an array");
  const folderPaths: string[] = [];
  for (const f of rawFolders) {
    const folder = normalizeFolderParam(typeof f === "string" ? f : null);
    if (!folder) fail("folderPaths contains an empty folder");
    const err = folderPathError(folder);
    if (err) fail(err);
    if (!folderPaths.includes(folder)) folderPaths.push(folder);
  }
  if (folderPaths.length > SLA_MAX_FOLDERS) fail(`A report can include at most ${SLA_MAX_FOLDERS} folders`);
  if (checkIds.length === 0 && folderPaths.length === 0) fail("Pick at least one check or folder");

  const timezone = typeof d.timezone === "string" ? d.timezone.trim() : "";
  if (!isValidTimeZone(timezone)) fail("timezone must be a valid IANA time zone, like Europe/Copenhagen");

  if (d.countBlockedAsDown !== undefined && typeof d.countBlockedAsDown !== "boolean") {
    fail("countBlockedAsDown must be true or false");
  }

  const rawSchedule = (d.schedule ?? {}) as Record<string, unknown>;
  if (typeof rawSchedule !== "object") fail("schedule must be an object");
  const recipients = normalizeRecipients(rawSchedule.recipients);
  const enabled = rawSchedule.enabled === true;
  if (enabled && recipients.length === 0) fail("Add at least one recipient for the monthly email");

  return {
    name,
    targetPercent,
    checkIds,
    folderPaths,
    timezone,
    countBlockedAsDown: d.countBlockedAsDown === true,
    schedule: { enabled, recipients },
    branding: normalizeBranding(d.branding),
  };
}

export interface OwnerCheck {
  id: string;
  userId: string;
  name: string | null;
  url: string;
  folder: string | null;
  type: string | null;
  createdAt: number | null;
}

/**
 * Resolve a report's scope against a pool of checks: explicit ids first (a
 * missing one is kept as deleted so its history still counts), then every
 * check in a selected folder or its subfolders. DNS and domain checks have no
 * availability and are skipped. Capped at SLA_MAX_CHECKS_PER_REPORT.
 */
export function selectReportChecks(
  report: { userId: string; checkIds?: string[]; folderPaths?: string[] },
  pool: OwnerCheck[],
): { checks: SlaCheckInput[]; truncated: boolean } {
  const byId = new Map(pool.filter((c) => c.userId === report.userId).map((c) => [c.id, c]));
  const out: SlaCheckInput[] = [];
  const seen = new Set<string>();
  const add = (c: OwnerCheck) => {
    if (seen.has(c.id) || SLA_EXCLUDED_CHECK_TYPES.has(c.type ?? "")) return;
    seen.add(c.id);
    out.push({ checkId: c.id, name: c.name || c.url || c.id, url: c.url, createdAtMs: c.createdAt });
  };

  for (const id of report.checkIds ?? []) {
    const c = byId.get(id);
    if (c) add(c);
    else if (!seen.has(id)) {
      // Only ids that were never seen in the pool at all: a check owned by
      // someone else is dropped by the userId filter above, but it would also
      // land here, so ownership is verified at write time (upsert).
      seen.add(id);
      out.push({ checkId: id, name: "Deleted check", url: "", deleted: true });
    }
  }

  const folders = report.folderPaths ?? [];
  if (folders.length > 0) {
    const inFolders = [...byId.values()]
      .filter((c) => folders.some((f) => folderMatches(c.folder, f, true)))
      .sort((a, b) => (a.name || a.url).localeCompare(b.name || b.url) || a.id.localeCompare(b.id));
    for (const c of inFolders) add(c);
  }

  const truncated = out.length > SLA_MAX_CHECKS_PER_REPORT;
  return { checks: truncated ? out.slice(0, SLA_MAX_CHECKS_PER_REPORT) : out, truncated };
}

/** When the monthly email for the current local month becomes due. */
export function nextSendAfterFor(enabled: boolean, timezone: string, nowMs: number): number | null {
  if (!enabled) return null;
  return finalizeAt(currentPeriod(nowMs, timezone), timezone);
}
