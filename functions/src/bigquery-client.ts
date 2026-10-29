import { BigQuery, type BigQueryOptions } from "@google-cloud/bigquery";

/**
 * Default ceiling on bytes billed for every query this codebase runs. A query
 * that would scan more fails instead of billing, so a missing date bound
 * becomes an error in the logs, not a line on the invoice.
 *
 * The largest production query in the 180 days before 2026-10-29 billed
 * 2.5 GB (the nightly retention purge). check_history_new's day partitions are
 * too small for clustering to prune, so an unbounded lookup reads every
 * partition: ~1.1 GiB for a few columns today, and it grows with the table.
 * A query that genuinely needs more passes its own `maximumBytesBilled`.
 */
export const DEFAULT_MAX_BYTES_BILLED = String(5 * 1024 * 1024 * 1024); // 5 GiB

type QueryArg = string | Record<string, unknown>;

// Returns `any` so the result fits every overload of query/createQueryJob.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withCap(query: QueryArg): any {
  const obj = typeof query === "string" ? { query } : query;
  if (!obj || obj.dryRun || obj.maximumBytesBilled !== undefined) return obj;
  return { ...obj, maximumBytesBilled: DEFAULT_MAX_BYTES_BILLED };
}

/**
 * BigQuery client that applies DEFAULT_MAX_BYTES_BILLED to every query that
 * doesn't set its own. Both `query()` paths (the jobs.query fast path and
 * createQueryJob) read the cap from the query object, so filling it in here
 * covers them.
 */
class CappedBigQuery extends BigQuery {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(query: any, options?: any, callback?: any): any {
    return super.query(withCap(query), options, callback);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createQueryJob(options: any, callback?: any): any {
    return super.createQueryJob(withCap(options), callback);
  }
}

export function createBigQuery(options: BigQueryOptions = { projectId: "exit1-dev" }): BigQuery {
  return new CappedBigQuery(options);
}
