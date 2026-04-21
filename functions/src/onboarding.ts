import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { BigQuery } from "@google-cloud/bigquery";
import { createClerkClient } from "@clerk/backend";
import { Resend } from "resend";
import { firestore, getUserTier } from "./init";
import { CLERK_SECRET_KEY_PROD, RESEND_API_KEY } from "./env";
import {
  buildPropertiesForUser,
  formatSignupDate,
  upsertContactProperties,
} from "./resend-sync";

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
  email: string | null;
}

async function fetchEmailsForUserIds(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;

  const prodSecretKey = CLERK_SECRET_KEY_PROD.value();
  if (!prodSecretKey) {
    logger.warn("CLERK_SECRET_KEY_PROD not configured; skipping email enrichment");
    return map;
  }

  const client = createClerkClient({ secretKey: prodSecretKey });
  const CHUNK = 100; // Clerk's getUserList supports batched userId filter

  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    try {
      const res = await client.users.getUserList({ userId: chunk, limit: chunk.length });
      for (const u of res.data ?? []) {
        const primary = u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId);
        const email = primary?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? null;
        if (email) map.set(u.id, email);
      }
    } catch (e) {
      logger.warn("Failed to fetch Clerk users for email enrichment", {
        error: (e as Error)?.message ?? String(e),
        chunkSize: chunk.length,
      });
    }
  }

  return map;
}

export const getOnboardingResponses = onCall(
  { cors: true, maxInstances: 5, secrets: [CLERK_SECRET_KEY_PROD] },
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

      const uniqueUserIds = Array.from(new Set((rows as Array<{ user_id: string }>).map((r) => r.user_id)));
      const emailMap = await fetchEmailsForUserIds(uniqueUserIds);

      const normalized: OnboardingResponseRow[] = (rows as OnboardingResponseRow[]).map((r) => ({
        user_id: r.user_id,
        timestamp: Number(r.timestamp),
        sources: Array.isArray(r.sources) ? r.sources : [],
        use_cases: Array.isArray(r.use_cases) ? r.use_cases : [],
        team_size: r.team_size ?? null,
        plan_choice: r.plan_choice ?? null,
        email: emailMap.get(r.user_id) ?? null,
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

export const submitOnboardingResponse = onCall(
  { cors: true, maxInstances: 5, secrets: [CLERK_SECRET_KEY_PROD, RESEND_API_KEY] },
  async (request) => {
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

  const submittedAt = Date.now();

  await ensureTable();

  try {
    await bigquery.dataset(DATASET_ID).table(TABLE_ID).insert([
      {
        user_id: uid,
        timestamp: new Date(submittedAt),
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

  // Persist completion + denormalized answers on the user doc so the resync
  // job can read them without a BigQuery query per user.
  try {
    await firestore
      .collection("users")
      .doc(uid)
      .set(
        {
          onboardingCompletedAt: submittedAt,
          onboarding: {
            sources,
            useCases,
            teamSize,
            planChoice,
            submittedAt,
          },
        },
        { merge: true },
      );
  } catch (e) {
    logger.warn("Failed to persist onboarding on user doc", {
      uid,
      error: (e as Error)?.message ?? String(e),
    });
  }

  // Push the new properties to Resend. Best-effort — never block the user on
  // marketing-CRM sync failures.
  try {
    await syncOnboardingToResend(uid, { sources, useCases, teamSize });
  } catch (e) {
    logger.warn("Failed to sync onboarding properties to Resend", {
      uid,
      error: (e as Error)?.message ?? String(e),
    });
  }

  return { success: true };
});

async function syncOnboardingToResend(
  uid: string,
  onboarding: { sources: string[]; useCases: string[]; teamSize: string | null },
): Promise<void> {
  const resendKey = (() => {
    try {
      return RESEND_API_KEY.value()?.trim();
    } catch {
      return process.env.RESEND_API_KEY?.trim();
    }
  })();
  if (!resendKey) {
    logger.info("Resend API key not configured; skipping onboarding property sync", { uid });
    return;
  }

  const clerkKey = (() => {
    try {
      return CLERK_SECRET_KEY_PROD.value()?.trim();
    } catch {
      return process.env.CLERK_SECRET_KEY_PROD?.trim();
    }
  })();
  if (!clerkKey) {
    logger.info("Clerk prod secret not configured; skipping onboarding property sync", { uid });
    return;
  }

  const clerk = createClerkClient({ secretKey: clerkKey });
  let email: string | null = null;
  let firstName: string | null = null;
  let lastName: string | null = null;
  let signupDate: string | null = null;

  try {
    const user = await clerk.users.getUser(uid);
    const primary = user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
      ?? user.emailAddresses?.[0];
    email = primary?.emailAddress ?? null;
    firstName = user.firstName ?? null;
    lastName = user.lastName ?? null;
    signupDate = formatSignupDate(user.createdAt);
  } catch (e) {
    logger.warn("Failed to fetch Clerk user during Resend onboarding sync", {
      uid,
      error: (e as Error)?.message ?? String(e),
    });
    return;
  }

  if (!email) {
    logger.warn("No email found for Clerk user during Resend onboarding sync", { uid });
    return;
  }

  const tier = await getUserTier(uid);
  const properties = buildPropertiesForUser({
    signupDate,
    tier,
    onboarding,
  });

  const resend = new Resend(resendKey);
  const result = await upsertContactProperties(resend, email, properties, {
    firstName,
    lastName,
  });

  if (!result.success) {
    logger.warn("Resend onboarding property sync failed", {
      uid,
      email,
      error: result.error,
    });
  } else {
    logger.info("Synced onboarding properties to Resend", { uid, email });
    try {
      await firestore.collection("users").doc(uid).set(
        { resendPropertiesSyncedAt: Date.now() },
        { merge: true },
      );
    } catch (e) {
      logger.debug("Failed to stamp resendPropertiesSyncedAt on onboarding submit", {
        uid,
        error: (e as Error)?.message ?? String(e),
      });
    }
  }
}

export const deleteOnboardingResponses = onCall(
  { cors: true, maxInstances: 5 },
  async (request): Promise<{ deleted: number; pending: number }> => {
    // Admin verification is handled on the frontend via Clerk's publicMetadata.admin,
    // matching the pattern used by getOnboardingResponses and other admin callables.
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    const data = (request.data ?? {}) as { rows?: unknown };
    if (!Array.isArray(data.rows) || data.rows.length === 0) {
      throw new HttpsError("invalid-argument", "rows must be a non-empty array");
    }
    if (data.rows.length > 500) {
      throw new HttpsError("invalid-argument", "Cannot delete more than 500 rows at once");
    }

    const pairs: Array<{ userId: string; ts: number }> = [];
    for (const item of data.rows) {
      if (!item || typeof item !== "object") continue;
      const row = item as { user_id?: unknown; timestamp?: unknown };
      if (typeof row.user_id !== "string" || typeof row.timestamp !== "number") continue;
      if (!Number.isFinite(row.timestamp)) continue;
      pairs.push({ userId: row.user_id, ts: row.timestamp });
    }

    if (pairs.length === 0) {
      throw new HttpsError("invalid-argument", "No valid rows provided");
    }

    await ensureTable();

    const runDelete = async (batch: Array<{ userId: string; ts: number }>) => {
      const params: Record<string, string | number> = {};
      const clauses: string[] = [];
      batch.forEach((p, i) => {
        params[`uid_${i}`] = p.userId;
        params[`ts_${i}`] = p.ts;
        clauses.push(`(user_id = @uid_${i} AND timestamp = TIMESTAMP_MILLIS(@ts_${i}))`);
      });
      const query = `
        DELETE FROM \`exit1-dev.${DATASET_ID}.${TABLE_ID}\`
        WHERE ${clauses.join(" OR ")}
      `;
      await bigquery.query({ query, params });
    };

    const isStreamingBufferError = (msg: string) =>
      /streaming buffer/i.test(msg);

    // BigQuery DML fails atomically if any target row sits in the streaming buffer.
    // The buffer typically holds rows for up to ~90 min, so defensively skip anything
    // younger than 2 hours and report it as pending instead of failing the whole batch.
    const BUFFER_SAFETY_MS = 2 * 60 * 60 * 1000;
    const cutoffMs = Date.now() - BUFFER_SAFETY_MS;
    const safe = pairs.filter((p) => p.ts < cutoffMs);
    const pending = pairs.length - safe.length;

    if (safe.length === 0) {
      logger.info("All targeted rows are within streaming-buffer window; nothing deleted", {
        uid,
        pending,
        cutoffMs,
      });
      return { deleted: 0, pending };
    }

    try {
      await runDelete(safe);
      logger.info("Deleted onboarding responses", {
        uid,
        deleted: safe.length,
        pending,
      });
      return { deleted: safe.length, pending };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (isStreamingBufferError(msg)) {
        logger.warn("Streaming-buffer error despite 2h cutoff; reporting all as pending", {
          uid,
          attempted: safe.length,
        });
        return { deleted: 0, pending: pairs.length };
      }
      logger.error("Failed to delete onboarding responses", { uid, error: msg });
      throw new HttpsError("internal", "Failed to delete onboarding responses");
    }
  }
);

export const getOnboardingStatus = onCall(
  { cors: true, maxInstances: 5 },
  async (request): Promise<{ completed: boolean; completedAt: number | null }> => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    try {
      const snap = await firestore.collection("users").doc(uid).get();
      const completedAt = Number((snap.data() as { onboardingCompletedAt?: unknown } | undefined)?.onboardingCompletedAt) || 0;
      return { completed: completedAt > 0, completedAt: completedAt > 0 ? completedAt : null };
    } catch (e) {
      logger.warn("Failed to read onboarding status", {
        uid,
        error: (e as Error)?.message ?? String(e),
      });
      return { completed: false, completedAt: null };
    }
  }
);
