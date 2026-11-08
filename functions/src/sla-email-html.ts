// ============================================================================
// SLA MONTHLY EMAIL BUILDER (pure)
//
// The v1 deliverable of SLA reporting: the whole report in a branded HTML
// email body, built to be forwarded to clients. Email-client rules
// (docs/plans/sla-reporting.md, 7.3): nested role="presentation" tables, a
// fixed 600 px width, inline styles only (one <style> block for the mobile
// media query), web-safe fonts, light background, status as text plus color.
//
// Gmail clips HTML over ~102 KB and hides the rest, footer and unsubscribe
// link included, so the builder works to an 85 KB budget (7.4).
// ============================================================================

import type { SlaPeriodComputation, SlaStatus } from "./sla-math";
import { formatInZone, periodLabel } from "./sla-time";
import type { SlaBranding } from "./sla-types";

export const SLA_EMAIL_BUDGET_BYTES = 85 * 1024;
export const SLA_EMAIL_MAX_CHECKS = 50;
export const SLA_EMAIL_MAX_INCIDENTS = 25;
export const SLA_EMAIL_MAX_EXCLUSIONS = 10;
const SLA_EMAIL_MIN_LIMIT = 10;

export const SLA_DOCS_URL = "https://docs.exit1.dev/analytics/sla-reports";

export interface SlaEmailReport {
  id: string;
  name: string;
  timezone: string;
  branding?: SlaBranding | null;
}

export type SlaEmailPeriod = Pick<
  SlaPeriodComputation,
  "period" | "timezone" | "status" | "targetPercent" | "overall" | "checks" | "incidents" | "incidentsTotal" | "exclusions" | "dataThrough"
> & { exclusionsTotal?: number };

export interface SlaEmailOptions {
  /** "View in exit1" link, for account members. */
  appUrl: string;
  unsubscribeUrl: string;
  /** Footer: "Sent on behalf of {senderLabel} via exit1.dev". */
  senderLabel: string;
  /** Test sends get a "[Test]" subject prefix and a banner. */
  test?: boolean;
  docsUrl?: string;
  limits?: { checks?: number; incidents?: number; exclusions?: number };
}

export interface SlaEmail {
  subject: string;
  html: string;
  text: string;
  /** What the truncation settled on, for tests and logs. */
  shown: { checks: number; incidents: number; exclusions: number };
}

const FONT = "Arial, Helvetica, sans-serif";
const TEXT = "#111827";
const MUTED = "#4b5563";
const BORDER = "#e5e7eb";
const DEFAULT_BRAND = "#2563eb";

export const STATUS_LABEL: Record<SlaStatus, string> = {
  met: "Met",
  breached: "Breached",
  at_risk: "At risk",
  on_track: "On track",
  no_data: "No data",
};

// Text colors that pass WCAG AA on their pill background.
const STATUS_COLORS: Record<SlaStatus, { fg: string; bg: string }> = {
  met: { fg: "#166534", bg: "#dcfce7" },
  breached: { fg: "#991b1b", bg: "#fee2e2" },
  at_risk: { fg: "#92400e", bg: "#fef3c7" },
  on_track: { fg: "#1e40af", bg: "#dbeafe" },
  no_data: { fg: "#374151", bg: "#f3f4f6" },
};

const EXCLUSION_LABEL = {
  maintenance: "Maintenance",
  blocked: "Blocked probe",
  no_data: "No data",
} as const;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatPercent(availability: number | null): string {
  if (availability === null) return "No data";
  const pct = availability * 100;
  if (pct >= 100) return "100%";
  // Truncate rather than round, so 99.9996% never reads as 100%.
  return `${(Math.floor(pct * 1000) / 1000).toFixed(3)}%`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

const safeColor = (c: string | null | undefined) => (c && /^#[0-9a-fA-F]{3,6}$/.test(c) ? c : DEFAULT_BRAND);

export function slaEmailSubject(reportName: string, period: SlaEmailPeriod, test = false): string {
  const status = STATUS_LABEL[period.overall.status];
  const month = periodLabel(period.period);
  const prefix = test ? "[Test] " : "";
  const inProgress = period.status === "open" ? ", month in progress" : "";
  return `${prefix}${reportName}: ${month} SLA report, ${formatPercent(period.overall.availability)} (${status}${inProgress})`;
}

function pill(status: SlaStatus): string {
  const c = STATUS_COLORS[status];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background-color:${c.bg};color:${c.fg};font-size:12px;font-weight:bold;font-family:${FONT}">${STATUS_LABEL[status]}</span>`;
}

const td = (content: string, extra = "") =>
  `<td style="padding:8px 6px;border-bottom:1px solid ${BORDER};font-family:${FONT};font-size:13px;color:${TEXT};font-variant-numeric:tabular-nums;${extra}">${content}</td>`;
const th = (content: string, align = "left") =>
  `<th align="${align}" style="padding:8px 6px;border-bottom:2px solid ${BORDER};font-family:${FONT};font-size:12px;color:${MUTED};text-align:${align};font-weight:bold">${content}</th>`;

function section(title: string, body: string): string {
  return `<tr><td style="padding:24px 32px 0 32px"><h2 style="margin:0 0 8px 0;font-family:${FONT};font-size:16px;color:${TEXT}">${escapeHtml(title)}</h2>${body}</td></tr>`;
}

function table(head: string, rows: string, footer = ""): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%"><tr>${head}</tr>${rows}${footer}</table>`;
}

function note(text: string): string {
  return `<p style="margin:8px 0 0 0;font-family:${FONT};font-size:12px;color:${MUTED}">${text}</p>`;
}

function statCell(label: string, value: string, sub = ""): string {
  return `<td width="50%" valign="top" style="padding:8px 8px 8px 0;width:50%"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};border-radius:6px"><tr><td style="padding:12px"><div style="font-family:${FONT};font-size:12px;color:${MUTED}">${label}</div><div style="font-family:${FONT};font-size:20px;font-weight:bold;color:${TEXT};font-variant-numeric:tabular-nums;margin-top:4px">${value}</div>${sub ? `<div style="font-family:${FONT};font-size:12px;color:${MUTED};margin-top:2px">${sub}</div>` : ""}</td></tr></table></td>`;
}

function orderChecks(checks: SlaEmailPeriod["checks"]) {
  const problem = (c: SlaEmailPeriod["checks"][number]) => c.status === "breached" || c.status === "at_risk" || c.incidents > 0;
  return [...checks].sort((a, b) => {
    const pa = problem(a) ? 0 : 1;
    const pb = problem(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (a.availability ?? 2) - (b.availability ?? 2) || a.name.localeCompare(b.name);
  });
}

function render(report: SlaEmailReport, period: SlaEmailPeriod, opts: SlaEmailOptions, limits: { checks: number; incidents: number; exclusions: number }): string {
  const tz = period.timezone;
  const brand = safeColor(report.branding?.brandColor);
  const company = report.branding?.companyName?.trim() || null;
  const logo = report.branding?.logoUrl?.trim() || null;
  const month = periodLabel(period.period);
  const o = period.overall;
  const names = new Map(period.checks.map((c) => [c.checkId, c.name]));
  const docsUrl = opts.docsUrl ?? SLA_DOCS_URL;
  const target = `${period.targetPercent}%`;

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(company ?? report.name)}" width="160" height="40" style="display:block;border:0;outline:none;width:160px;height:40px;object-fit:contain">`
    : `<div style="font-family:${FONT};font-size:18px;font-weight:bold;color:${TEXT}">${escapeHtml(company ?? report.name)}</div>`;

  const banners: string[] = [];
  if (opts.test) banners.push("Test email. Only you received it.");
  if (period.status === "open") banners.push(`Preview, month in progress. Data through ${escapeHtml(formatInZone(period.dataThrough, tz))}.`);
  const bannerHtml = banners.length
    ? `<tr><td style="padding:12px 32px 0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#fef3c7" style="background-color:#fef3c7;padding:8px 12px;font-family:${FONT};font-size:13px;color:#92400e">${banners.join(" ")}</td></tr></table></td></tr>`
    : "";

  // Summary
  const budgetPct = o.budgetMs > 0 ? `${Math.round(o.budgetUsed * 100)}% used` : "No budget yet";
  const longest = period.incidents.reduce((m, i) => Math.max(m, i.durationMs), 0);
  const summary = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${statCell("Availability", formatPercent(o.availability), `Target ${escapeHtml(target)} ${pill(o.status)}`)}${statCell("Downtime", formatDuration(o.downMs), `${period.incidentsTotal} incident${period.incidentsTotal === 1 ? "" : "s"}${longest ? `, longest ${formatDuration(longest)}` : ""}`)}</tr><tr>${statCell("Error budget", formatDuration(period.status === "open" ? o.projectedBudgetMs : o.budgetMs), budgetPct)}${statCell("Coverage", `${Math.round(o.coverage * 100)}%`, `${formatDuration(o.maintenanceMs + o.blockedMs + o.noDataMs)} excluded${o.insufficientData ? ", insufficient data" : ""}`)}</tr></table>`;

  // Per-check table
  const ordered = orderChecks(period.checks);
  const shownChecks = ordered.slice(0, limits.checks);
  const restChecks = ordered.slice(limits.checks);
  const checkRows = shownChecks
    .map((c) => `<tr>${td(`${escapeHtml(c.name)}${c.deleted ? ` <span style="color:${MUTED}">(deleted)</span>` : ""}`)}${td(formatPercent(c.availability), "text-align:right")}${td(formatDuration(c.downMs), "text-align:right")}${td(String(c.incidents), "text-align:right")}${td(pill(c.status), "text-align:right")}</tr>`)
    .join("");
  const checksMore = restChecks.length
    ? note(`And ${restChecks.length} more check${restChecks.length === 1 ? "" : "s"}${restChecks.every((c) => c.status === "met" || c.status === "on_track") ? " that met the target" : ""}. See the full list in exit1.`)
    : "";
  const checksTable = table(`${th("Check")}${th("Availability", "right")}${th("Downtime", "right")}${th("Incidents", "right")}${th("Status", "right")}`, checkRows) + checksMore;

  // Incident log, longest first when capped, shown in time order
  const incidentsShown = [...period.incidents].sort((a, b) => b.durationMs - a.durationMs).slice(0, limits.incidents).sort((a, b) => a.startMs - b.startMs);
  const incidentRows = incidentsShown
    .map((i) => `<tr>${td(escapeHtml(names.get(i.checkId) ?? i.checkId))}${td(escapeHtml(formatInZone(i.startMs, tz)))}${td(i.endMs === null ? "Ongoing" : escapeHtml(formatInZone(i.endMs, tz)))}${td(formatDuration(i.durationMs), "text-align:right")}</tr>`)
    .join("");
  const moreIncidents = period.incidentsTotal - incidentsShown.length;
  const incidentsBody = period.incidentsTotal === 0
    ? note("No confirmed outages this month.")
    : table(`${th("Check")}${th("Start")}${th("End")}${th("Duration", "right")}`, incidentRows) +
      (moreIncidents > 0
        ? note(`${moreIncidents} more incident${moreIncidents === 1 ? "" : "s"} (total downtime ${formatDuration(o.downMs)}). See the full log in exit1.`)
        : "");

  // Exclusions
  const exclusionsShown = [...period.exclusions].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs)).slice(0, limits.exclusions).sort((a, b) => a.startMs - b.startMs);
  const exclusionRows = exclusionsShown
    .map((e) => `<tr>${td(escapeHtml(names.get(e.checkId) ?? e.checkId))}${td(EXCLUSION_LABEL[e.state])}${td(escapeHtml(formatInZone(e.startMs, tz)))}${td(formatDuration(e.endMs - e.startMs), "text-align:right")}</tr>`)
    .join("");
  const exclusionTotals = `Totals: maintenance ${formatDuration(o.maintenanceMs)}, blocked probes ${formatDuration(o.blockedMs)}, no data ${formatDuration(o.noDataMs)}.`;
  const exclusionsBody = period.exclusions.length === 0
    ? note("Nothing was excluded.")
    : table(`${th("Check")}${th("Reason")}${th("Start")}${th("Length", "right")}`, exclusionRows) +
      note(`${exclusionTotals} Maintenance windows and blocked probes (a firewall answered instead of the site) are not counted. Neither is time we had no data for.`);

  const methodology = `Availability = up time / (up time + down time). Confirmed outages only. Maintenance, blocked probes and unmonitored time are excluded. <a href="${escapeHtml(docsUrl)}" style="color:${brand}">How we calculate this</a>.`;

  const footer = `<tr><td style="padding:24px 32px 32px 32px;border-top:1px solid ${BORDER}">
<table role="presentation" width="140" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${brand}" style="background-color:${brand};border-radius:6px"><a href="${escapeHtml(opts.appUrl)}" style="display:inline-block;padding:10px 18px;font-family:${FONT};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none">View in exit1</a></td></tr></table>
<p style="margin:6px 0 0 0;font-family:${FONT};font-size:12px;color:${MUTED}">For account members.</p>
<p style="margin:16px 0 0 0;font-family:${FONT};font-size:12px;color:${MUTED}">Sent on behalf of ${escapeHtml(opts.senderLabel)} via exit1.dev. All times in ${escapeHtml(tz)}.</p>
<p style="margin:8px 0 0 0;font-family:${FONT};font-size:12px;color:${MUTED}"><a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:${MUTED}">Unsubscribe from this report</a></p>
</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(report.name)}: ${escapeHtml(month)}</title>
<style>@media only screen and (max-width:620px){.sla-container{width:100% !important}}</style></head>
<body style="margin:0;padding:0;background-color:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background-color:#f3f4f6"><tr><td align="center" style="padding:24px 8px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="sla-container" width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:8px">
<tr><td style="padding:24px 32px 16px 32px;border-top:4px solid ${brand}">${header}
<h1 style="margin:16px 0 4px 0;font-family:${FONT};font-size:22px;color:${TEXT}">${escapeHtml(report.name)}</h1>
<p style="margin:0;font-family:${FONT};font-size:14px;color:${MUTED}">SLA report for ${escapeHtml(month)} (${escapeHtml(tz)}) ${pill(o.status)}</p></td></tr>
${bannerHtml}
${section("Summary", summary)}
${section("Checks", checksTable)}
${section("Incidents", incidentsBody)}
${section("Exclusions", exclusionsBody)}
<tr><td style="padding:24px 32px 0 32px">${note(methodology)}</td></tr>
${footer}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}

function renderText(report: SlaEmailReport, period: SlaEmailPeriod, opts: SlaEmailOptions): string {
  const o = period.overall;
  const tz = period.timezone;
  const names = new Map(period.checks.map((c) => [c.checkId, c.name]));
  const lines = [
    `${report.name}: ${periodLabel(period.period)} SLA report (${tz})`,
    period.status === "open" ? "Preview, month in progress." : "",
    "",
    `Availability: ${formatPercent(o.availability)} (target ${period.targetPercent}%, ${STATUS_LABEL[o.status]})`,
    `Downtime: ${formatDuration(o.downMs)} in ${period.incidentsTotal} incident(s)`,
    `Coverage: ${Math.round(o.coverage * 100)}%`,
    "",
  ];
  const top = [...period.incidents].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  if (top.length) {
    lines.push("Longest incidents:");
    for (const i of top) {
      lines.push(`- ${names.get(i.checkId) ?? i.checkId}: ${formatInZone(i.startMs, tz)}, ${formatDuration(i.durationMs)}${i.endMs === null ? " (ongoing)" : ""}`);
    }
    lines.push("");
  }
  lines.push(
    "Availability = up time / (up time + down time). Confirmed outages only. Maintenance, blocked probes and unmonitored time are excluded.",
    "",
    `View in exit1 (account members): ${opts.appUrl}`,
    `Sent on behalf of ${opts.senderLabel} via exit1.dev.`,
    `Unsubscribe: ${opts.unsubscribeUrl}`,
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/**
 * Build the monthly email. Renders, and while the HTML is over the 85 KB
 * budget halves the check and incident limits (down to 10 each).
 */
export function buildSlaEmail(report: SlaEmailReport, period: SlaEmailPeriod, opts: SlaEmailOptions): SlaEmail {
  const limits = {
    checks: opts.limits?.checks ?? SLA_EMAIL_MAX_CHECKS,
    incidents: opts.limits?.incidents ?? SLA_EMAIL_MAX_INCIDENTS,
    exclusions: opts.limits?.exclusions ?? SLA_EMAIL_MAX_EXCLUSIONS,
  };
  let html = render(report, period, opts, limits);
  while (Buffer.byteLength(html, "utf8") > SLA_EMAIL_BUDGET_BYTES && (limits.checks > SLA_EMAIL_MIN_LIMIT || limits.incidents > SLA_EMAIL_MIN_LIMIT)) {
    limits.checks = Math.max(SLA_EMAIL_MIN_LIMIT, Math.floor(limits.checks / 2));
    limits.incidents = Math.max(SLA_EMAIL_MIN_LIMIT, Math.floor(limits.incidents / 2));
    html = render(report, period, opts, limits);
  }
  return {
    subject: slaEmailSubject(report.name, period, opts.test),
    html,
    text: renderText(report, period, opts),
    shown: {
      checks: Math.min(limits.checks, period.checks.length),
      incidents: Math.min(limits.incidents, period.incidents.length),
      exclusions: Math.min(limits.exclusions, period.exclusions.length),
    },
  };
}
