import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore, getUserPlanInfo } from "./init";
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV } from "./env";
import { CONFIG } from "./config";
import type { Website } from "./types";
import type { BigQueryCheckHistoryRow } from "./bigquery";

/**
 * Column order must match `CSV_COLUMNS` in
 * `src/components/check/BulkImportModal.tsx` so an export can be re-imported
 * without any transformation.
 */
const CSV_COLUMNS = [
  "name",
  "url",
  "type",
  "http_method",
  "expected_status_codes",
  "check_frequency",
  "down_confirmation_attempts",
  "cache_control_no_cache",
  "request_headers",
  "request_body",
  "response_contains_text",
  "response_json_path",
  "response_expected_value",
  "redirect_expected_target",
  "redirect_match_mode",
] as const;

type CsvColumn = (typeof CSV_COLUMNS)[number];

const CSV_COLUMN_SET: ReadonlySet<string> = new Set(CSV_COLUMNS);

/** Columns emitted for the history CSV — matches BigQuery minimal column set. */
const HISTORY_COLUMNS = [
  "id",
  "website_id",
  "check_name",
  "timestamp",
  "status",
  "status_code",
  "response_time_ms",
  "error",
] as const;

const EXPORT_COOLDOWN_MS = 5 * 60 * 1000; // 1 export per user per 5 min.

/** Cap on history rows returned in a single response. Keeps the callable
 *  payload bounded — beyond this we'd need to move to signed URLs + email. */
const MAX_HISTORY_ROWS = 500_000;

/** Absolute cap on the history date-range, regardless of tier retention. */
const MAX_HISTORY_WINDOW_DAYS = 90;

/** RFC 4180 CSV cell escaper — quotes values containing `,`, `"`, `\n`, `\r`. */
function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatYyyyMmDd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Serialise a single check into the CSV column order mirrored from the
 * importer. The importer accepts:
 *   - `expected_status_codes`: split on /[,;]/ → use `;` so we never need to
 *     quote the cell just because it contains a comma.
 *   - `response_contains_text`: split on `|`.
 *   - `request_headers`: JSON.parse'd as an object.
 *   - `response_expected_value`: JSON.parse'd, falls back to raw string. We
 *     always JSON-encode so round-trips preserve the type (number/bool/null/obj).
 *   - `cache_control_no_cache`: string "true" / "false".
 */
function buildCheckRowCells(check: Website): Record<CsvColumn, string> {
  const type = check.type ?? "";

  const expectedStatusCodes = Array.isArray(check.expectedStatusCodes)
    ? check.expectedStatusCodes.join(";")
    : "";

  const requestHeaders =
    check.requestHeaders && Object.keys(check.requestHeaders).length > 0
      ? JSON.stringify(check.requestHeaders)
      : "";

  const containsText = Array.isArray(check.responseValidation?.containsText)
    ? (check.responseValidation!.containsText as string[]).join("|")
    : "";

  const jsonPath = check.responseValidation?.jsonPath ?? "";

  // Always JSON-encode so the importer's JSON.parse branch succeeds and the
  // original type (number/boolean/object/null/string) is preserved.
  const expectedValue =
    check.responseValidation && "expectedValue" in check.responseValidation &&
      check.responseValidation.expectedValue !== undefined
      ? JSON.stringify(check.responseValidation.expectedValue)
      : "";

  const redirectTarget = check.redirectValidation?.expectedTarget ?? "";
  const redirectMatchMode = check.redirectValidation?.matchMode ?? "";

  const cacheControlNoCache =
    typeof check.cacheControlNoCache === "boolean"
      ? String(check.cacheControlNoCache)
      : "";

  return {
    name: check.name ?? "",
    url: check.url ?? "",
    type,
    http_method: check.httpMethod ?? "",
    expected_status_codes: expectedStatusCodes,
    check_frequency:
      typeof check.checkFrequency === "number" ? String(check.checkFrequency) : "",
    down_confirmation_attempts:
      typeof check.downConfirmationAttempts === "number"
        ? String(check.downConfirmationAttempts)
        : "",
    cache_control_no_cache: cacheControlNoCache,
    request_headers: requestHeaders,
    request_body: check.requestBody ?? "",
    response_contains_text: containsText,
    response_json_path: jsonPath,
    response_expected_value: expectedValue,
    redirect_expected_target: redirectTarget,
    redirect_match_mode: redirectMatchMode,
  };
}

/** Normalise client-supplied column list — falls back to all columns. */
function resolveColumns(input: unknown): readonly CsvColumn[] {
  if (!Array.isArray(input)) return CSV_COLUMNS;
  const picked: CsvColumn[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    if (CSV_COLUMN_SET.has(raw) && !picked.includes(raw as CsvColumn)) {
      picked.push(raw as CsvColumn);
    }
  }
  return picked.length > 0 ? picked : CSV_COLUMNS;
}

function parseBigQueryTimestamp(raw: unknown): string {
  if (raw && typeof raw === "object" && "value" in raw) {
    const v = (raw as { value?: unknown }).value;
    if (typeof v === "string" && v) return v;
  }
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === "string") return raw;
  return "";
}

function serializeHistoryRow(
  row: BigQueryCheckHistoryRow,
  checkName: string,
): string {
  const cells: Record<(typeof HISTORY_COLUMNS)[number], string> = {
    id: row.id ?? "",
    website_id: row.website_id ?? "",
    check_name: checkName,
    timestamp: parseBigQueryTimestamp(row.timestamp),
    status: row.status ?? "",
    status_code:
      typeof row.status_code === "number" ? String(row.status_code) : "",
    response_time_ms:
      typeof row.response_time === "number" ? String(row.response_time) : "",
    error: row.error ?? "",
  };
  return HISTORY_COLUMNS.map((c) => csvEscape(cells[c])).join(",");
}

interface ExportChecksCsvResult {
  success: true;
  checksCsv: string;
  checksFilename: string;
  checksRowCount: number;
  historyCsv?: string;
  historyFilename?: string;
  historyRowCount?: number;
  historyTruncated?: boolean;
}

/**
 * Pro+ CSV export of every check owned by the caller.
 *
 * Response is round-trip compatible with `BulkImportModal` — a user can
 * download the file and upload it verbatim to re-create the checks on another
 * account (or after a teardown).
 *
 * Rate-limited to 1 export per user per 5 minutes via
 * `exportRateLimits/{uid}.lastExportAt`.
 */
export const exportChecksCsv = onCall(
  {
    secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV],
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 10,
  },
  async (request): Promise<ExportChecksCsvResult> => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }

    // Tier gate — Pro or Agency only.
    const { tier } = await getUserPlanInfo(uid);
    if (tier !== "pro" && tier !== "agency") {
      throw new HttpsError(
        "permission-denied",
        "CSV export is available on Pro and Agency plans",
      );
    }

    const data = (request.data ?? {}) as {
      columns?: unknown;
      includeHistory?: unknown;
      startDate?: unknown;
      endDate?: unknown;
    };

    const columns = resolveColumns(data.columns);
    const includeHistory = data.includeHistory === true;

    // History params are only validated when history is requested.
    let historyWindow: { startMs: number; endMs: number } | null = null;
    if (includeHistory) {
      const startMs = Number(data.startDate);
      const endMs = Number(data.endDate);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new HttpsError(
          "invalid-argument",
          "startDate and endDate are required when includeHistory is true",
        );
      }
      if (endMs <= startMs) {
        throw new HttpsError("invalid-argument", "endDate must be after startDate");
      }
      const dayMs = 24 * 60 * 60 * 1000;
      const windowDays = Math.ceil((endMs - startMs) / dayMs);
      if (windowDays > MAX_HISTORY_WINDOW_DAYS) {
        throw new HttpsError(
          "invalid-argument",
          `History window capped at ${MAX_HISTORY_WINDOW_DAYS} days per export`,
        );
      }
      // Clamp window to tier retention — silently, since the client already
      // ought to be showing the correct max.
      const retentionDays = CONFIG.getHistoryRetentionDaysForTier(tier);
      const retentionFloor = Date.now() - retentionDays * dayMs;
      historyWindow = {
        startMs: Math.max(startMs, retentionFloor),
        endMs,
      };
    }

    // Rate limit.
    const rateLimitRef = firestore.collection("exportRateLimits").doc(uid);
    const now = Date.now();
    try {
      const rlSnap = await rateLimitRef.get();
      const lastExportAt = Number(
        (rlSnap.data() as { lastExportAt?: unknown } | undefined)?.lastExportAt ?? 0,
      );
      if (lastExportAt > 0 && now - lastExportAt < EXPORT_COOLDOWN_MS) {
        const waitMs = EXPORT_COOLDOWN_MS - (now - lastExportAt);
        const waitSec = Math.ceil(waitMs / 1000);
        throw new HttpsError(
          "resource-exhausted",
          `Export cooldown active. Please wait ${waitSec}s before exporting again.`,
          { retryAfterSeconds: waitSec },
        );
      }
    } catch (e) {
      // Re-throw HttpsError as-is; swallow read errors (fail-open on missing doc).
      if (e instanceof HttpsError) throw e;
      logger.warn("exportChecksCsv: rate-limit read failed, allowing export", {
        uid,
        error: (e as Error)?.message ?? String(e),
      });
    }

    // Fetch all checks owned by the user. Pro/Agency caps (500/1000) fit
    // comfortably in a single callable response — no pagination needed.
    let checks: Website[];
    try {
      const snap = await firestore
        .collection("checks")
        .where("userId", "==", uid)
        .get();
      checks = snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as Website);
    } catch (e) {
      logger.error("exportChecksCsv: Firestore query failed", {
        uid,
        error: (e as Error)?.message ?? String(e),
      });
      throw new HttpsError("internal", "Failed to load checks for export");
    }

    // Stable ordering — `orderIndex` when present, then `createdAt` — so the
    // exported file is deterministic across runs.
    checks.sort((a, b) => {
      const ai = typeof a.orderIndex === "number" ? a.orderIndex : Number.POSITIVE_INFINITY;
      const bi = typeof b.orderIndex === "number" ? b.orderIndex : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      const ac = (a as { createdAt?: number }).createdAt ?? 0;
      const bc = (b as { createdAt?: number }).createdAt ?? 0;
      return ac - bc;
    });

    const header = columns.join(",");
    const rows = checks.map((c) => {
      const cells = buildCheckRowCells(c);
      return columns.map((col) => csvEscape(cells[col])).join(",");
    });
    const checksCsv = [header, ...rows].join("\n");
    const checksFilename = `checks-${formatYyyyMmDd(new Date(now))}.csv`;

    // History CSV (optional) — scan BigQuery once for every row across the
    // user's checks in the window. Capped at MAX_HISTORY_ROWS.
    let historyCsv: string | undefined;
    let historyFilename: string | undefined;
    let historyRowCount: number | undefined;
    let historyTruncated: boolean | undefined;
    if (includeHistory && historyWindow) {
      try {
        const { getUserCheckHistoryForExport } = await import("./bigquery.js");
        // Fetch one extra row so we can detect truncation.
        const fetched = await getUserCheckHistoryForExport(
          uid,
          historyWindow.startMs,
          historyWindow.endMs,
          MAX_HISTORY_ROWS + 1,
        );
        const truncated = fetched.length > MAX_HISTORY_ROWS;
        const limited = truncated ? fetched.slice(0, MAX_HISTORY_ROWS) : fetched;

        const nameById = new Map<string, string>();
        for (const c of checks) {
          if (c.id) nameById.set(c.id, c.name ?? "");
        }

        const historyHeader = HISTORY_COLUMNS.join(",");
        const historyRows = limited.map((row) =>
          serializeHistoryRow(row, nameById.get(row.website_id ?? "") ?? ""),
        );
        historyCsv = [historyHeader, ...historyRows].join("\n");
        historyFilename = `check-runs-${formatYyyyMmDd(new Date(historyWindow.startMs))}-to-${formatYyyyMmDd(new Date(historyWindow.endMs))}.csv`;
        historyRowCount = limited.length;
        historyTruncated = truncated;
      } catch (e) {
        logger.error("exportChecksCsv: history query failed", {
          uid,
          error: (e as Error)?.message ?? String(e),
        });
        throw new HttpsError("internal", "Failed to load check history for export");
      }
    }

    // Stamp rate-limit AFTER successfully building the CSV. Best-effort.
    try {
      await rateLimitRef.set({ lastExportAt: now }, { merge: true });
    } catch (e) {
      logger.warn("exportChecksCsv: failed to stamp rate-limit doc", {
        uid,
        error: (e as Error)?.message ?? String(e),
      });
    }

    logger.info("exportChecksCsv: exported checks", {
      uid,
      tier,
      checksRowCount: checks.length,
      columns: columns.length,
      includeHistory,
      historyRowCount,
      historyTruncated,
    });

    return {
      success: true,
      checksCsv,
      checksFilename,
      checksRowCount: checks.length,
      ...(historyCsv !== undefined && {
        historyCsv,
        historyFilename,
        historyRowCount,
        historyTruncated,
      }),
    };
  },
);
