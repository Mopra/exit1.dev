// ============================================================================
// DAY3 HTTP CLIENT
//
// Thin fetch wrapper over the Day3 v1 API. Handles auth, rate limiting,
// idempotency and error-envelope parsing. Deliberately has no Firebase
// dependency so it can be imported anywhere (including the VPS bundle).
//
// Retry policy:
//   - 429  → sleep for Retry-After (the API tells us exactly how long) and retry
//   - 5xx  → exponential backoff. Day3 emits occasional transient 500s on
//            otherwise-valid reads, so this is not optional. POSTs are only
//            retried when an Idempotency-Key is set, which makes the retry a
//            replay rather than a second write.
//   - network errors → treated as 5xx
// ============================================================================

import * as logger from "firebase-functions/logger";
import { DAY3_BASE_URL } from "./day3-config";
import { sleep } from "./contact-model";

export interface Day3Error {
  code: string;
  message: string;
  param?: string;
  requestId?: string;
}

export interface Day3Result<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: Day3Error | null;
}

const MAX_ATTEMPTS = 4;

// Cap a single Retry-After sleep. Day3's limit resets within a minute, so
// anything longer means something is badly wrong and we'd rather fail fast
// inside a Cloud Function than burn the invocation budget waiting.
const MAX_RETRY_AFTER_S = 30;

export interface Day3RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /**
   * Set on every POST that writes. A retry with the same key within 24h replays
   * the original response instead of writing twice. Must be deterministic for a
   * given payload — the same key with a different body is a 409.
   */
  idempotencyKey?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

const buildUrl = (path: string, query?: Day3RequestOptions["query"]): string => {
  const url = `${DAY3_BASE_URL}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
};

const parseError = (status: number, text: string): Day3Error => {
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string; param?: string; request_id?: string };
    };
    if (parsed?.error?.code) {
      return {
        code: parsed.error.code,
        message: parsed.error.message || "",
        param: parsed.error.param,
        requestId: parsed.error.request_id,
      };
    }
  } catch {
    /* non-JSON body — fall through */
  }
  return { code: `http_${status}`, message: text.slice(0, 500) };
};

/**
 * Issue one Day3 API request, with retries. Never throws — transport failures
 * surface as an error envelope so callers can branch on `code` uniformly.
 */
export async function day3Request<T>(
  apiKey: string,
  path: string,
  options: Day3RequestOptions = {},
): Promise<Day3Result<T>> {
  const method = options.method ?? "GET";
  const url = buildUrl(path, options.query);
  const retryableWrite = method !== "GET" ? Boolean(options.idempotencyKey) : true;

  let lastError: Day3Error = { code: "internal_error", message: "no attempt made" };
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let status = 0;
    let text = "";
    let retryAfter: number | null = null;

    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });

      status = res.status;
      text = await res.text();

      if (res.ok) {
        let data: T | null = null;
        try {
          data = text ? (JSON.parse(text) as T) : null;
        } catch {
          // A 2xx with an unparseable body is still a success for DELETE.
          data = null;
        }
        return { ok: true, status, data, error: null };
      }

      const header = res.headers.get("Retry-After");
      if (header) retryAfter = Number(header);
    } catch (err) {
      // Network / DNS / abort — treat as a retryable 5xx.
      status = 0;
      text = err instanceof Error ? err.message : String(err);
    }

    lastStatus = status;
    lastError = status === 0
      ? { code: "network_error", message: text }
      : parseError(status, text);

    const isRateLimit = status === 429;
    const isTransient = status === 0 || status >= 500;
    const canRetry = (isRateLimit || isTransient) && retryableWrite;
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;

    if (!canRetry || isLastAttempt) break;

    const waitMs = isRateLimit
      ? Math.min(retryAfter && Number.isFinite(retryAfter) ? retryAfter : 1, MAX_RETRY_AFTER_S) * 1000
      : 2 ** attempt * 500;

    logger.debug("Retrying Day3 request", {
      path, method, status, attempt: attempt + 1, waitMs,
    });
    await sleep(waitMs);
  }

  return { ok: false, status: lastStatus, data: null, error: lastError };
}

/**
 * Follow Day3's cursor pagination to completion. There are no page numbers or
 * offsets — loop until has_more is false.
 */
export async function day3ListAll<T>(
  apiKey: string,
  path: string,
  query: Day3RequestOptions["query"] = {},
): Promise<{ ok: boolean; items: T[]; error: Day3Error | null }> {
  const items: T[] = [];
  let cursor: string | undefined;

  do {
    const result = await day3Request<{
      data: T[];
      has_more: boolean;
      next_cursor: string | null;
    }>(apiKey, path, { query: { limit: 100, ...query, after: cursor } });

    if (!result.ok || !result.data) {
      return { ok: false, items, error: result.error };
    }

    items.push(...(result.data.data ?? []));
    cursor = result.data.has_more ? result.data.next_cursor ?? undefined : undefined;
  } while (cursor);

  return { ok: true, items, error: null };
}
