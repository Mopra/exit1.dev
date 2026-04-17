import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { BigQuery } from "@google-cloud/bigquery";

const bigquery = new BigQuery({ projectId: "exit1-dev" });
const DATASET_ID = "checks";
const TABLE_ID = "onboarding_responses";

const SOURCE_OPTIONS = new Set([
  "google",
  "reddit",
  "ai_assistant",
  "twitter",
  "product_hunt",
  "hacker_news",
  "friend",
  "blog",
  "other",
]);

const USE_CASE_OPTIONS = new Set([
  "infrastructure",
  "ecommerce",
  "client_sites",
  "saas",
  "personal",
  "agency",
  "other",
]);

const TEAM_SIZE_OPTIONS = new Set([
  "solo",
  "2_5",
  "6_20",
  "21_100",
  "100_plus",
]);

const PLAN_CHOICES = new Set(["personal", "nano"]);

const SCHEMA = [
  { name: "user_id", type: "STRING", mode: "REQUIRED" },
  { name: "timestamp", type: "TIMESTAMP", mode: "REQUIRED" },
  { name: "sources", type: "STRING", mode: "REPEATED" },
  { name: "use_cases", type: "STRING", mode: "REPEATED" },
  { name: "team_size", type: "STRING", mode: "NULLABLE" },
  { name: "plan_choice", type: "STRING", mode: "NULLABLE" },
];

let schemaReady: Promise<void> | null = null;

async function ensureTable(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const dataset = bigquery.dataset(DATASET_ID);
    const table = dataset.table(TABLE_ID);
    try {
      const [exists] = await table.exists();
      if (!exists) {
        await table.create({
          schema: { fields: SCHEMA },
          timePartitioning: { type: "DAY", field: "timestamp" },
          clustering: { fields: ["user_id"] },
        });
        logger.info(`Created BigQuery table ${DATASET_ID}.${TABLE_ID}`);
      }
    } catch (e) {
      logger.warn("Onboarding table ensure failed (continuing best-effort)", {
        error: (e as Error)?.message ?? String(e),
      });
    }
  })();
  return schemaReady;
}

const sanitizeStringArray = (value: unknown, allowed: Set<string>): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item)) {
      seen.add(item);
    }
  }
  return Array.from(seen);
};

export interface OnboardingResponseRow {
  user_id: string;
  timestamp: number;
  sources: string[];
  use_cases: string[];
  team_size: string | null;
  plan_choice: string | null;
}

export const getOnboardingResponses = onCall(
  { cors: true, maxInstances: 5 },
  async (request): Promise<{ rows: OnboardingResponseRow[]; total: number }> => {
    // Admin verification is handled on the frontend using Clerk's publicMetadata.admin,
    // matching the pattern used by getAdminStats and other admin callables.
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const data = (request.data ?? {}) as { limit?: unknown };
    const rawLimit = typeof data.limit === "number" ? data.limit : 200;
    const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 1000);

    try {
      await ensureTable();

      const [rows] = await bigquery.query({
        query: `
          SELECT
            user_id,
            UNIX_MILLIS(timestamp) AS timestamp,
            sources,
            use_cases,
            team_size,
            plan_choice
          FROM \`exit1-dev.${DATASET_ID}.${TABLE_ID}\`
          ORDER BY timestamp DESC
          LIMIT @limit
        `,
        params: { limit },
      });

      const [countRows] = await bigquery.query({
        query: `SELECT COUNT(*) AS total FROM \`exit1-dev.${DATASET_ID}.${TABLE_ID}\``,
      });
      const total = Number(countRows[0]?.total ?? 0);

      const normalized: OnboardingResponseRow[] = rows.map((r: any) => ({
        user_id: r.user_id,
        timestamp: Number(r.timestamp),
        sources: Array.isArray(r.sources) ? r.sources : [],
        use_cases: Array.isArray(r.use_cases) ? r.use_cases : [],
        team_size: r.team_size ?? null,
        plan_choice: r.plan_choice ?? null,
      }));

      return { rows: normalized, total };
    } catch (e) {
      logger.error("Failed to fetch onboarding responses", {
        uid,
        error: (e as Error)?.message ?? String(e),
      });
      throw new HttpsError("internal", "Failed to fetch onboarding responses");
    }
  }
);

export const submitOnboardingResponse = onCall({ cors: true, maxInstances: 5 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const data = (request.data ?? {}) as {
    sources?: unknown;
    useCases?: unknown;
    teamSize?: unknown;
    planChoice?: unknown;
  };

  const sources = sanitizeStringArray(data.sources, SOURCE_OPTIONS);
  const useCases = sanitizeStringArray(data.useCases, USE_CASE_OPTIONS);
  const teamSize =
    typeof data.teamSize === "string" && TEAM_SIZE_OPTIONS.has(data.teamSize)
      ? data.teamSize
      : null;
  const planChoice =
    typeof data.planChoice === "string" && PLAN_CHOICES.has(data.planChoice)
      ? data.planChoice
      : null;

  if (sources.length === 0) {
    throw new HttpsError("invalid-argument", "At least one source is required");
  }
  if (useCases.length === 0) {
    throw new HttpsError("invalid-argument", "At least one use case is required");
  }
  if (!teamSize) {
    throw new HttpsError("invalid-argument", "teamSize is required");
  }

  await ensureTable();

  try {
    await bigquery.dataset(DATASET_ID).table(TABLE_ID).insert([
      {
        user_id: uid,
        timestamp: new Date(),
        sources,
        use_cases: useCases,
        team_size: teamSize,
        plan_choice: planChoice,
      },
    ]);
  } catch (e) {
    logger.error("Failed to insert onboarding response", {
      uid,
      error: (e as Error)?.message ?? String(e),
    });
    throw new HttpsError("internal", "Failed to save onboarding response");
  }

  return { success: true };
});
