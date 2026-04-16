import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { BigQuery } from "@google-cloud/bigquery";
import { firestore } from "./init";

const bigquery = new BigQuery({ projectId: "exit1-dev" });
const DATASET_ID = "checks";
const DAILY_SUMMARY_TABLE_ID = "check_daily_summaries";
const STATS_DOC = "stats/public_checks";

// Lifetime checks performed before daily-summary aggregation was running.
// Increase if you ever reconstruct older history.
const HISTORICAL_OFFSET = 0;

interface PublicChecksStats {
  total: number;
  at: number;
  ratePerSecond: number;
}

const computeStats = async (): Promise<PublicChecksStats> => {
  // Lifetime total comes from the daily-summary table, which is not purged.
  // Also grab the last complete 7 days to derive a current throughput rate.
  const [rows] = await bigquery.query({
    query: `
      SELECT
        SUM(total_checks) AS lifetime,
        SUM(IF(day BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY), total_checks, 0)) AS last7
      FROM \`${DATASET_ID}.${DAILY_SUMMARY_TABLE_ID}\`
    `,
  });
  const lifetime = Number(rows[0]?.lifetime ?? 0);
  const last7 = Number(rows[0]?.last7 ?? 0);
  const ratePerSecond = last7 > 0 ? last7 / (7 * 24 * 60 * 60) : 0;

  return {
    total: lifetime + HISTORICAL_OFFSET,
    at: Date.now(),
    ratePerSecond,
  };
};

export const refreshPublicChecksStats = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "UTC",
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async () => {
    try {
      const stats = await computeStats();
      await firestore.doc(STATS_DOC).set(stats);
      logger.info("Public checks stats refreshed", stats);
    } catch (error) {
      logger.error("Failed to refresh public checks stats:", error);
    }
  }
);

let memCache: { stats: PublicChecksStats; expiresAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export const getPublicChecksStats = onRequest(
  {
    cors: true,
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (_req, res) => {
    try {
      const now = Date.now();
      if (memCache && memCache.expiresAt > now) {
        res.set("Cache-Control", "public, max-age=300, s-maxage=600");
        res.json(memCache.stats);
        return;
      }

      const snap = await firestore.doc(STATS_DOC).get();
      let stats = snap.exists ? (snap.data() as PublicChecksStats) : null;

      if (!stats) {
        stats = await computeStats();
        await firestore.doc(STATS_DOC).set(stats);
      }

      memCache = { stats, expiresAt: now + CACHE_TTL_MS };
      res.set("Cache-Control", "public, max-age=300, s-maxage=600");
      res.json(stats);
    } catch (error) {
      logger.error("getPublicChecksStats failed:", error);
      res.status(500).json({ error: "Failed to load stats" });
    }
  }
);
