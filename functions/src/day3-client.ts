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
//   - 409 idempotency_conflict → the original request is still running behind
//            the key. Wait it out on a much slower schedule, then replay.
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

const MAX_ATTEMPTS = 5;

// Cap a single Retry-After sleep. Day3's limit resets within a minute, so
// anything longer means something is badly wrong and we'd rather fail fast
// inside a Cloud Function than burn the invocation budget waiting.
const MAX_RETRY_AFTER_S = 30;

export const IDEMPOTENCY_CONFLICT = "idempotency_conflict";

// Day3 holds the idempotency lock for the lifetime of the original request and
// answers a same-key retry with `idempotency_conflict` — "already in progress".
// That is a wait-and-replay, not a failure: once the original settles, the key
// returns its recorded response. Backing off in milliseconds lands inside the
// same lock, so conflicts get their own, far slower schedule. Indexed by the
// 0-based attempt that just failed; the tail value repeats.
const CONFLICT_BACKOFF_MS = [3_000, 8_000, 20_000, 30_000];

// A 5xx on a write is ambiguous — Day3 may still be applying it — so give the
// original room to settle before replaying the key, or the retry just walks
// into a conflict. Reads have nothing in flight and can come back quickly.
const TRANSIENT_BASE_MS = { read: 500, write: 2_000 };

/**
 * Timing knobs for the retry loop. The defaults above are tuned for the
 * contact backfill, whose writes run ~10s server-side and hold the idempotency
 * lock for that long. A latency-sensitive caller (a transactional send inside
 * the alert path) settles in well under a second and cannot afford a 30s
 * conflict wait, so it supplies a tighter profile instead.
 */
export interface Day3RetryProfile {
  maxAttempts?: number;
  /** Base for the exponential 5xx/network backoff, per method class. */
  transientBaseMs?: { read: number; write: number };
  /** Wait schedule for `idempotency_conflict`; the tail value repeats. */
  conflictBackoffMs?: number[];
  /** Ceiling on a single honoured `Retry-After`, in seconds. */
  maxRetryAfterS?: number;
}

const DEFAULT_RETRY_PROFILE: Required<Day3RetryProfile> = {
  maxAttempts: MAX_ATTEMPTS,
  transientBaseMs: TRANSIENT_BASE_MS,
  conflictBackoffMs: CONFLICT_BACKOFF_MS,
  maxRetryAfterS: MAX_RETRY_AFTER_S,
};

export interface RetryDecision {
  retry: boolean;
  waitMs: number;
}

/**
 * The retry policy as a pure function, so the classification is testable
 * without a network. `attempt` is the 0-based index of the attempt that just
 * failed; `status` is 0 for a network/DNS/abort failure.
 */
export function classifyRetry(input: {
  status: number;
  code: string;
  isWrite: boolean;
  hasIdempotencyKey: boolean;
  attempt: number;
  retryAfterS: number | null;
  profile?: Day3RetryProfile;
}): RetryDecision {
  const noRetry: RetryDecision = { retry: false, waitMs: 0 };
  const conflictBackoff = input.profile?.conflictBackoffMs ?? CONFLICT_BACKOFF_MS;
  const transientBase = input.profile?.transientBaseMs ?? TRANSIENT_BASE_MS;
  const maxRetryAfterS = input.profile?.maxRetryAfterS ?? MAX_RETRY_AFTER_S;

  // Replaying a write without a key would write twice.
  if (input.isWrite && !input.hasIdempotencyKey) return noRetry;

  if (input.code === IDEMPOTENCY_CONFLICT) {
    const index = Math.min(input.attempt, conflictBackoff.length - 1);
    return { retry: true, waitMs: conflictBackoff[index] };
  }

  if (input.status === 429) {
    const seconds = input.retryAfterS !== null && Number.isFinite(input.retryAfterS)
      ? input.retryAfterS
      : 1;
    return { retry: true, waitMs: Math.min(seconds, maxRetryAfterS) * 1000 };
  }

  if (input.status === 0 || input.status >= 500) {
    const base = input.isWrite ? transientBase.write : transientBase.read;
    return { retry: true, waitMs: 2 ** input.attempt * base };
  }

  return noRetry;
}

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
  /** Override the retry timings. Omit for the backfill-tuned defaults. */
  retry?: Day3RetryProfile;
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
  const isWrite = method !== "GET";
  const profile = { ...DEFAULT_RETRY_PROFILE, ...options.retry };
  const maxAttempts = Math.max(1, profile.maxAttempts);

  let lastError: Day3Error = { code: "internal_error", message: "no attempt made" };
  let lastStatus = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

    const decision = classifyRetry({
      status,
      code: lastError.code,
      isWrite,
      hasIdempotencyKey: Boolean(options.idempotencyKey),
      attempt,
      retryAfterS: retryAfter,
      profile,
    });
    const isLastAttempt = attempt === maxAttempts - 1;

    if (!decision.retry || isLastAttempt) break;

    logger.debug("Retrying Day3 request", {
      path, method, status, code: lastError.code,
      attempt: attempt + 1, waitMs: decision.waitMs,
    });
    await sleep(decision.waitMs);
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
