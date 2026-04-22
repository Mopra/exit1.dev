import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore, getUserPlanInfo } from "./init";
import { CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV } from "./env";
import type { Website } from "./types";

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

const EXPORT_COOLDOWN_MS = 5 * 60 * 1000; // 1 export per user per 5 min.

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
function serializeCheckRow(check: Website): string {
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

  const cells: Record<(typeof CSV_COLUMNS)[number], string> = {
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

  return CSV_COLUMNS.map((col) => csvEscape(cells[col])).join(",");
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
    timeoutSeconds: 60,
    maxInstances: 10,
  },
  async (request) => {
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

    const header = CSV_COLUMNS.join(",");
    const rows = checks.map(serializeCheckRow);
    const csv = [header, ...rows].join("\n");

    const filename = `checks-${formatYyyyMmDd(new Date(now))}.csv`;

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
      rowCount: checks.length,
    });

    return {
      success: true as const,
      csv,
      rowCount: checks.length,
      filename,
    };
  },
);
