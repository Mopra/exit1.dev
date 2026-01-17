import { BigQuery } from '@google-cloud/bigquery';

const projectId = process.env.BQ_PROJECT_ID ?? 'exit1-dev';
const datasetId = process.env.BQ_DATASET_ID ?? 'checks';
const tableId = process.env.BQ_TABLE_ID ?? 'check_history';
const thresholdMs = Number(process.env.BQ_LATENCY_THRESHOLD_MS ?? '5000');
const apply = process.argv.includes('--apply');

if (Number.isNaN(thresholdMs) || thresholdMs <= 0) {
  throw new Error(`Invalid latency threshold: ${process.env.BQ_LATENCY_THRESHOLD_MS}`);
}

const tableRef = `\`${projectId}.${datasetId}.${tableId}\``;
const whereClause = `response_time >= ${thresholdMs}`;

const bigquery = new BigQuery({ projectId, keyFilename: undefined });

const runQuery = async (query) => {
  const [job] = await bigquery.createQueryJob({ query, useLegacySql: false });
  const [rows] = await job.getQueryResults();
  const [meta] = await job.getMetadata();
  return { rows, meta };
};

const countQuery = `SELECT COUNT(*) AS total FROM ${tableRef} WHERE ${whereClause}`;
const { rows: countRows } = await runQuery(countQuery);
const total = Number(countRows?.[0]?.total ?? 0);

console.log(`[BigQuery] Rows with response_time >= ${thresholdMs}ms: ${total}`);

if (!apply) {
  console.log('[BigQuery] Dry run only. Re-run with --apply to delete.');
  process.exit(0);
}

const deleteQuery = `DELETE FROM ${tableRef} WHERE ${whereClause}`;
const { meta } = await runQuery(deleteQuery);
const deleted = meta?.statistics?.query?.dmlStats?.deletedRowCount ?? '0';

console.log(`[BigQuery] Deleted rows: ${deleted}`);
