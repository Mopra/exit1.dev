/**
 * Daily cost watch, run from the VPS cron (vps/src/cron.ts).
 *
 * Every cost fix so far started with a bill. The Oct 23 blocked-count query
 * scanned 19 GB/day for a week before anyone saw it, because the console
 * only shows a per-service total a day late and the free tiers hide growth
 * until they run out at month end. This job looks at yesterday, line by line,
 * and emails when something moved:
 *
 * - gross cost per GCP service and per Cloud Run function (billing export),
 * - bytes billed per BigQuery query shape (the project's job log),
 * - month-to-date use of the BigQuery and Cloud Run free tiers.
 *
 * It mails only when a rule fires (cost-watch-rules.ts), plus a digest of the
 * biggest lines every Monday. Gross cost, not net: credits absorb usage until
 * the free tier runs out, which is exactly the growth we want to see early.
 *
 * Its own cost: four small reads, 63 MB billed per run (measured 2026-10-29),
 * about 2 GB a month.
 */
import * as logger from "firebase-functions/logger";
import { createBigQuery } from "./bigquery-client";
import { sendTransactionalEmail, isTransactionalEmailConfigured } from "./email-send";
import {
  findFreeTierRisks,
  findSpikes,
  topSeries,
  type CostFinding,
  type CostSeries,
  type FreeTierUsage,
} from "./cost-watch-rules";

const bigquery = createBigQuery();

const COST_WATCH_TO = "morten@exit1.dev";
const BILLING_TABLE = "`exit1-dev.checks.gcp_billing_export_resource_v1_01E559_1D01F3_74E9DA`";
const JOBS_VIEW = "`region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT";
/** Days judged plus baseline: yesterday and the 7 days before it. */
const WINDOW_DAYS = 8;
/** Query shapes below this on every day of the window are left out. */
const MIN_QUERY_GB = 0.5;

const BIGQUERY_FREE_GB = 1024 ** 4 / 1e9; // 1 TiB of analysis a month
const CLOUD_RUN_FREE_VCPU_S = 180_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type DailyRow = { d: { value: string } | string; k: string; label: string; v: number };

function toSeries(rows: DailyRow[], days: string[], group: CostSeries["group"], unit: CostSeries["unit"]): CostSeries[] {
  const byKey = new Map<string, CostSeries>();
  for (const r of rows) {
    const day = typeof r.d === "string" ? r.d : r.d.value;
    const i = days.indexOf(day);
    if (i < 0) continue;
    let s = byKey.get(r.k);
    if (!s) {
      s = { key: r.k, group, label: r.label, unit, days: days.map(() => 0) };
      byKey.set(r.k, s);
    }
    s.days[i] += Number(r.v) || 0;
  }
  return [...byKey.values()];
}

async function billingSeries(days: string[]): Promise<CostSeries[]> {
  // The export is partitioned by ingestion time and a day's rows can land a
  // day later, so the partition filter starts one day early.
  const [rows] = await bigquery.query({
    query: `
      SELECT DATE(usage_start_time) AS d,
        IF(service.description LIKE 'Cloud Run%', CONCAT('fn:', IFNULL(resource.name, '?')), CONCAT('svc:', service.description)) AS k,
        IF(service.description LIKE 'Cloud Run%', IFNULL(resource.name, '?'), service.description) AS label,
        SUM(cost) AS v
      FROM ${BILLING_TABLE}
      WHERE _PARTITIONTIME >= TIMESTAMP_SUB(TIMESTAMP(@first), INTERVAL 1 DAY)
        AND DATE(usage_start_time) BETWEEN @first AND @last
      GROUP BY d, k, label`,
    params: { first: days[0], last: days[days.length - 1] },
  });
  const all = rows as DailyRow[];
  return [
    ...toSeries(all.filter(r => r.k.startsWith("svc:")), days, "service", "DKK"),
    ...toSeries(all.filter(r => r.k.startsWith("fn:")), days, "function", "DKK"),
  ];
}

async function querySeries(days: string[]): Promise<CostSeries[]> {
  // One line per query shape: the SQL with whitespace collapsed, fingerprinted.
  const [rows] = await bigquery.query({
    query: `
      WITH j AS (
        SELECT DATE(creation_time) AS d, REGEXP_REPLACE(query, r'\\s+', ' ') AS q, total_bytes_billed AS b
        FROM ${JOBS_VIEW}
        WHERE creation_time >= TIMESTAMP(@first) AND creation_time < TIMESTAMP_ADD(TIMESTAMP(@last), INTERVAL 1 DAY)
          AND job_type = 'QUERY' AND statement_type != 'SCRIPT'
      )
      SELECT d, CAST(FARM_FINGERPRINT(q) AS STRING) AS k, ANY_VALUE(SUBSTR(TRIM(q), 1, 140)) AS label, SUM(b) / 1e9 AS v
      FROM j GROUP BY d, k`,
    params: { first: days[0], last: days[days.length - 1] },
    location: "US",
  });
  return toSeries(rows as DailyRow[], days, "query", "GB").filter(s => s.days.some(v => v >= MIN_QUERY_GB));
}

async function freeTierUsage(now: number): Promise<FreeTierUsage[]> {
  const d = new Date(now - DAY_MS); // through yesterday
  const monthStart = isoDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = isoDay(d.getTime());
  const daysElapsed = d.getUTCDate();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

  const [[bq]] = await bigquery.query({
    query: `
      SELECT SUM(total_bytes_billed) / 1e9 AS gb,
        SUM(IF(DATE(creation_time) < @last, total_bytes_billed, 0)) / 1e9 AS gb_before
      FROM ${JOBS_VIEW}
      WHERE creation_time >= TIMESTAMP(@first) AND creation_time < TIMESTAMP_ADD(TIMESTAMP(@last), INTERVAL 1 DAY)
        AND job_type = 'QUERY' AND statement_type != 'SCRIPT'`,
    params: { first: monthStart, last },
    location: "US",
  });
  const [[run]] = await bigquery.query({
    query: `
      SELECT SUM(usage.amount) AS s, SUM(IF(DATE(usage_start_time) < @last, usage.amount, 0)) AS s_before
      FROM ${BILLING_TABLE}
      WHERE _PARTITIONTIME >= TIMESTAMP_SUB(TIMESTAMP(@first), INTERVAL 1 DAY)
        AND DATE(usage_start_time) BETWEEN @first AND @last
        AND sku.description LIKE 'Cloud Run functions CPU%'`,
    params: { first: monthStart, last },
  });
  return [
    {
      name: "BigQuery analysis", unit: "GB", limit: BIGQUERY_FREE_GB, daysElapsed, daysInMonth,
      used: Number(bq?.gb) || 0, usedDayBefore: Number(bq?.gb_before) || 0,
    },
    {
      name: "Cloud Run Functions CPU", unit: "vCPU-s", limit: CLOUD_RUN_FREE_VCPU_S, daysElapsed, daysInMonth,
      used: Number(run?.s) || 0, usedDayBefore: Number(run?.s_before) || 0,
    },
  ];
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function buildEmail(findings: CostFinding[], series: CostSeries[], tiers: FreeTierUsage[], digest: boolean) {
  const lines: string[] = [];
  if (findings.length) {
    lines.push("What moved:", ...findings.map(f => `- ${f.message}`), "");
  } else {
    lines.push("Nothing moved this week beyond the thresholds.", "");
  }
  if (digest) {
    lines.push("Free tiers this month:");
    for (const t of tiers) lines.push(`- ${t.name}: ${Math.round(t.used).toLocaleString("en-US")} of ${Math.round(t.limit).toLocaleString("en-US")} ${t.unit} after ${t.daysElapsed} days`);
    for (const [group, title] of [["service", "Services"], ["function", "Cloud Run functions"], ["query", "BigQuery query shapes"]] as const) {
      lines.push("", `${title}, last ${WINDOW_DAYS} days:`);
      for (const t of topSeries(series, group, 8)) lines.push(`- ${t.total.toFixed(t.unit === "GB" ? 1 : 2)} ${t.unit}  ${t.label}`);
    }
  }
  lines.push("", "Sent by the cost watch (functions/src/cost-watch.ts). Thresholds live in cost-watch-rules.ts.");
  const text = lines.join("\n");
  const html = `<pre style="font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap">${esc(text)}</pre>`;
  const subject = findings.length
    ? `exit1 cost watch: ${findings.length} thing${findings.length === 1 ? "" : "s"} moved`
    : "exit1 weekly cost digest";
  return { subject, text, html };
}

export async function runCostWatch(now: number = Date.now()): Promise<void> {
  const yesterday = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - DAY_MS;
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => isoDay(yesterday - (WINDOW_DAYS - 1 - i) * DAY_MS));

  const [billing, queries, tiers] = await Promise.all([billingSeries(days), querySeries(days), freeTierUsage(now)]);
  const series = [...billing, ...queries];
  const findings = [...findSpikes(series), ...findFreeTierRisks(tiers)];
  const digest = new Date(now).getUTCDay() === 1;

  logger.info("[cost-watch] run", { day: days[days.length - 1], lines: series.length, findings: findings.map(f => f.message) });
  if (!findings.length && !digest) return;

  if (!isTransactionalEmailConfigured()) {
    logger.error("[cost-watch] no email provider configured; findings only in this log");
    return;
  }
  await sendTransactionalEmail({ to: COST_WATCH_TO, ...buildEmail(findings, series, tiers, digest), category: "internal" });
}
