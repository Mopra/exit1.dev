#!/usr/bin/env node
// One-off backfill of checks.check_sla_daily (SLA reporting).
//
//   npm run build
//   node scripts/sla-backfill.mjs --start 2025-10-01 --end 2026-11-07          # dry run: bytes only
//   node scripts/sla-backfill.mjs --start 2025-10-01 --end 2026-11-07 --apply  # writes
//
// Runs from functions/ with Application Default Credentials. --apply creates
// the table if it is missing (ensureSlaDailyTableSchema) and MERGEs one
// complete UTC day at a time, in chunks of 31 days. Without --apply nothing is
// written or created: each day's SELECT is dry-run and its bytes summed.
// Re-running a day is safe (MERGE). Cost: ~36 MB per day, ~14 GB for 13 months.

process.env.GCLOUD_PROJECT ||= "exit1-dev";
process.env.GOOGLE_CLOUD_PROJECT ||= "exit1-dev";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const start = arg("--start");
const end = arg("--end");
const apply = args.includes("--apply");
if (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(end ?? "")) {
  console.error("Usage: node scripts/sla-backfill.mjs --start YYYY-MM-DD --end YYYY-MM-DD [--apply]");
  process.exit(1);
}

const { backfillSlaRollup } = await import("../lib/sla-rollup.js");

const DAY = 86_400_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
let cursor = Date.parse(`${start}T00:00:00Z`);
const last = Date.parse(`${end}T00:00:00Z`);
let billed = 0;
let processed = 0;

while (cursor <= last) {
  const chunkEnd = Math.min(cursor + 30 * DAY, last);
  const result = await backfillSlaRollup(day(cursor), day(chunkEnd), { dryRun: !apply });
  billed += result.bytesBilled;
  processed += result.bytesProcessed;
  for (const d of result.days) {
    console.log(`${d.day}  processed ${(d.bytesProcessed / 1e6).toFixed(1)} MB  billed ${(d.bytesBilled / 1e6).toFixed(1)} MB${d.rows !== null ? `  rows ${d.rows}` : ""}`);
  }
  cursor = chunkEnd + DAY;
}

console.log(`${apply ? "APPLIED" : "DRY RUN"}: processed ${(processed / 1e9).toFixed(2)} GB, billed ${(billed / 1e9).toFixed(2)} GB`);
process.exit(0);
