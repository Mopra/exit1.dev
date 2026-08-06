/**
 * Batching rules for multi-check BigQuery reads.
 *
 * Two different cost models sit behind these helpers, and conflating them caused a
 * long-lived bug: status pages allow 50 checks while the batch queries silently capped
 * at 25, so every check past the 25th (in sorted-id order) rendered blank forever.
 *
 * - Daily-summary reads are partitioned by day and filtered by user_id, so widening the
 *   IN UNNEST list barely moves bytes scanned. These CHUNK — every requested id is answered.
 * - Raw history-table reads scale with breadth, so they keep a hard cap — but the cap must
 *   always be logged, never silent.
 */

/** Ids per daily-summary query. Bounds parameter size, not scan cost. */
export const SUMMARY_QUERY_CHUNK = 50;

/** Backstop against a pathological caller; far above any real page or dashboard. */
export const MAX_SUMMARY_WEBSITES = 500;

/**
 * Split ids into query-sized chunks. Every input id appears in exactly one chunk —
 * that total-coverage property is the whole point, so it is what the tests assert.
 */
export const chunkIds = (ids: string[], size: number): string[][] => {
  if (size <= 0) throw new Error(`chunkIds: size must be positive, got ${size}`);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
};

export type TruncationNotice = {
  requested: number;
  limit: number;
  dropped: number;
};

/**
 * Apply a hard cap, reporting whenever it actually drops anything.
 * Returns the notice separately so the caller owns the logging.
 */
export const capWebsiteIds = (
  ids: string[],
  limit: number
): { ids: string[]; notice: TruncationNotice | null } => {
  if (ids.length <= limit) return { ids, notice: null };
  return {
    ids: ids.slice(0, limit),
    notice: { requested: ids.length, limit, dropped: ids.length - limit },
  };
};
