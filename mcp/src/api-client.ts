import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL =
  "https://us-central1-exit1-dev.cloudfunctions.net/publicApi/v1/public";

export interface ApiClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface ApiError {
  status: number;
  message: string;
  retryAfter?: number;
}

export class ToolError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Minimal REST client for the Exit1 public API.
 *
 * Every tool in this package is a thin wrapper over an HTTP endpoint rather than
 * bespoke logic — tier caps, scope checks, validation and rate limits all live
 * server-side, so the tool surface can't drift from the API's rules.
 */
export class Exit1ApiClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: ApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {}
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      "X-Api-Key": this.apiKey,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    // The API requires an idempotency key on POST. A fresh key per call is
    // correct: a retried tool call is a new intent, and same-URL duplicates are
    // rejected server-side anyway.
    if (method === "POST") {
      headers["Idempotency-Key"] = randomUUID().replace(/-/g, "");
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || `HTTP ${response.status}`;
      const retryAfter = response.headers.get("Retry-After");
      throw new ToolError(
        retryAfter ? `${message} (retry after ${retryAfter}s)` : message,
        response.status
      );
    }

    return parsed;
  }

  /** Unwrap the `{ data: ... }` envelope the public API uses. */
  async data(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {}
  ): Promise<unknown> {
    const body = (await this.call(method, path, options)) as { data?: unknown } | null;
    return body && typeof body === "object" && "data" in body ? body.data : body;
  }
}
