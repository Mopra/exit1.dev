/**
 * Tool catalog for the remote MCP server.
 *
 * Every tool is a thin wrapper over the public REST API rather than direct
 * Firestore access. That is deliberate: tier caps, scope checks, rate limits,
 * URL validation and duplicate detection all live in `public-api.ts`, and
 * routing MCP through the same door means the tool surface can never drift from
 * the API's rules. The cost is one extra internal hop per call.
 *
 * KEEP IN SYNC with `src/tools.ts` in github.com/Mopra/exit1.dev.mcp — the same
 * catalog for the stdio (API-key) npm package. Two separate builds in two
 * separate repos, so the definitions are deliberately duplicated. The only real
 * difference is auth: that one sends X-Api-Key, this one an OAuth bearer token.
 *
 * A CI job in that repo (`npm run check:catalog`, daily and on every push) reads
 * this file from GitHub and fails on tool-name or inputSchema drift. If you add
 * or change a tool here, mirror it there — otherwise a prompt that works against
 * one transport errors against the other.
 */

import { randomUUID } from "crypto";
import { API_SCOPES, type ApiScope } from "./api-scopes";

export const PUBLIC_API_BASE =
  process.env.EXIT1_PUBLIC_API_BASE ||
  "https://us-central1-exit1-dev.cloudfunctions.net/publicApi/v1/public";

export interface ApiCallResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Minimal REST client bound to one user's OAuth access token. */
export class PublicApiClient {
  constructor(private readonly accessToken: string, private readonly baseUrl: string = PUBLIC_API_BASE) {}

  async call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {}
  ): Promise<ApiCallResult> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    // The API requires an idempotency key on POST. A fresh key per call is
    // correct here — a retried tool call is a new intent, and same-URL duplicate
    // checks are rejected by the API anyway.
    if (method === "POST") {
      headers["Idempotency-Key"] = randomUUID().replace(/-/g, "");
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return { ok: response.ok, status: response.status, body };
  }
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Tools that only read; surfaced as an annotation so clients can auto-approve. */
  readOnly: boolean;
  /**
   * Scope this tool needs. Declared per tool rather than derived from the name —
   * the REST API is the real enforcement point, but checking here lets the agent
   * see a useful message instead of an opaque 403 mid-flow, and a name-matching
   * heuristic would silently mis-scope the first tool that broke the pattern.
   */
  scope: ApiScope;
  handler: (args: Record<string, unknown>, api: PublicApiClient) => Promise<unknown>;
}

// ── Formatting helpers ──

function iso(ts: unknown): string | null {
  if (typeof ts !== "number" || !ts) return null;
  return new Date(ts).toISOString();
}

function unwrap(result: ApiCallResult): unknown {
  if (!result.ok) {
    const message =
      result.body && typeof result.body === "object" && "error" in (result.body as Record<string, unknown>)
        ? String((result.body as Record<string, unknown>).error)
        : `HTTP ${result.status}`;
    throw new ToolError(message, result.status);
  }
  return result.body;
}

export class ToolError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ToolError";
  }
}

function data(result: ApiCallResult): unknown {
  const body = unwrap(result) as { data?: unknown };
  return body?.data ?? body;
}

interface RawCheck {
  id: string;
  name?: string | null;
  url?: string;
  status?: string;
  disabled?: boolean;
  maintenanceMode?: boolean;
  responseTime?: number | null;
  lastStatusCode?: number | null;
  lastChecked?: number;
  createdAt?: number;
  updatedAt?: number;
  sslCertificate?: { valid?: boolean; issuer?: string; daysUntilExpiry?: number; error?: string } | null;
}

function formatCheck(check: RawCheck) {
  return {
    id: check.id,
    name: check.name ?? null,
    url: check.url,
    status: check.status,
    disabled: !!check.disabled,
    maintenanceMode: !!check.maintenanceMode,
    responseTimeMs: check.responseTime ?? null,
    lastStatusCode: check.lastStatusCode ?? null,
    lastChecked: iso(check.lastChecked),
    ssl: check.sslCertificate
      ? {
          valid: check.sslCertificate.valid ?? null,
          issuer: check.sslCertificate.issuer ?? null,
          daysUntilExpiry: check.sslCertificate.daysUntilExpiry ?? null,
          error: check.sslCertificate.error ?? null,
        }
      : null,
    createdAt: iso(check.createdAt),
  };
}

// ── Shared schema fragments ──

const CHECK_ID_PROP = {
  check_id: { type: "string", description: "The check ID returned by list_checks or create_check" },
};

const CHECK_TYPE_ENUM = ["website", "rest_endpoint", "redirect", "ping", "tcp", "dns", "heartbeat", "domain"];

// ── Tool catalog ──

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "get_account",
    title: "Get account",
    readOnly: true,
    scope: API_SCOPES.CHECKS_READ,
    description:
      "Get the current plan, its limits, and how much of them is already used. Call this FIRST when setting up monitoring — it tells you how many checks you can create and the fastest check interval the plan allows, so you can plan within the plan instead of hitting errors halfway through.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, api) => data(await api.call("GET", "/account")),
  },

  {
    name: "list_checks",
    title: "List checks",
    readOnly: true,
    scope: API_SCOPES.CHECKS_READ,
    description:
      "List monitored checks with their current status. Use for an overview, to find offline checks, or to see what is already monitored before creating duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["online", "offline", "unknown"], description: "Filter by current status" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 25)" },
        page: { type: "integer", minimum: 1, description: "Page number" },
      },
      additionalProperties: false,
    },
    handler: async (args, api) => {
      const body = unwrap(
        await api.call("GET", "/checks", { query: { status: args.status, limit: args.limit, page: args.page } })
      ) as { data: RawCheck[]; meta: unknown };
      const checks = (body.data || []).map(formatCheck);
      const counts = checks.reduce<Record<string, number>>((acc, c) => {
        const key = c.disabled ? "disabled" : String(c.status);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      return { summary: counts, checks, pagination: body.meta };
    },
  },

  {
    name: "get_check",
    title: "Get check",
    readOnly: true,
    scope: API_SCOPES.CHECKS_READ,
    description: "Get full detail for one check: status, response time, SSL certificate state and maintenance mode.",
    inputSchema: {
      type: "object",
      properties: { ...CHECK_ID_PROP },
      required: ["check_id"],
      additionalProperties: false,
    },
    handler: async (args, api) => formatCheck(data(await api.call("GET", `/checks/${encodeURIComponent(String(args.check_id))}`)) as RawCheck),
  },

  {
    name: "get_check_history",
    title: "Get check history",
    readOnly: true,
    scope: API_SCOPES.CHECKS_READ,
    description:
      "Get individual check results over time — timestamps, status codes, response times and errors. Use when investigating an incident or confirming a fix held.",
    inputSchema: {
      type: "object",
      properties: {
        ...CHECK_ID_PROP,
        from: { type: "string", description: "Start date, ISO 8601 (e.g. 2026-07-01T00:00:00Z)" },
        to: { type: "string", description: "End date, ISO 8601" },
        status: { type: "string", enum: ["online", "offline", "unknown"] },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Results per page (default 25)" },
        page: { type: "integer", minimum: 1 },
      },
      required: ["check_id"],
      additionalProperties: false,
    },
    handler: async (args, api) => {
      const body = unwrap(
        await api.call("GET", `/checks/${encodeURIComponent(String(args.check_id))}/history`, {
          query: { from: args.from, to: args.to, status: args.status, limit: args.limit, page: args.page },
        })
      ) as { data: Array<Record<string, unknown>>; meta: unknown };
      return {
        entries: (body.data || []).map((e) => ({
          timestamp: iso(e.timestamp),
          status: e.status,
          responseTimeMs: e.responseTime ?? null,
          statusCode: e.statusCode ?? null,
          error: e.error ?? null,
        })),
        pagination: body.meta,
      };
    },
  },

  {
    name: "get_check_stats",
    title: "Get check stats",
    readOnly: true,
    scope: API_SCOPES.CHECKS_READ,
    description:
      "Get aggregate uptime percentage and response-time statistics for a check across one or more time ranges. Good for 'how has this been doing' questions and week-over-week comparisons.",
    inputSchema: {
      type: "object",
      properties: {
        ...CHECK_ID_PROP,
        ranges: {
          type: "string",
          description: "Comma-separated ranges: 1h, 6h, 1d, 7d, 30d, 60d, 90d. Default 1d,7d,30d",
        },
      },
      required: ["check_id"],
      additionalProperties: false,
    },
    handler: async (args, api) =>
      data(
        await api.call("GET", `/checks/${encodeURIComponent(String(args.check_id))}/stats`, {
          query: { ranges: args.ranges || "1d,7d,30d" },
        })
      ),
  },

  {
    name: "get_status_page",
    title: "Get status page",
    readOnly: true,
    scope: API_SCOPES.CHECKS_READ,
    description: "Get the current snapshot of a public status page, with each check's status and uptime percentage.",
    inputSchema: {
      type: "object",
      properties: { status_page_id: { type: "string", description: "The status page ID" } },
      required: ["status_page_id"],
      additionalProperties: false,
    },
    handler: async (args, api) =>
      data(await api.call("GET", `/status-pages/${encodeURIComponent(String(args.status_page_id))}/snapshot`)),
  },

  {
    name: "create_check",
    title: "Create check",
    readOnly: false,
    scope: API_SCOPES.CHECKS_WRITE,
    description:
      "Create a new monitor. Use 'website' for a page that should return 200, 'rest_endpoint' for an API endpoint (supports JSONPath assertions on the response body), 'ping' for ICMP, 'tcp' for a raw port, 'dns' for record drift, 'domain' for registration expiry, and 'heartbeat' for cron jobs that call in. Check the plan's minCheckIntervalMinutes via get_account before setting check_frequency_minutes.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to monitor. For 'dns' and 'domain' pass a bare domain. Omit for 'heartbeat'.",
        },
        name: { type: "string", maxLength: 200, description: "Human-readable name, e.g. 'Production API'" },
        type: { type: "string", enum: CHECK_TYPE_ENUM, description: "Check type (default 'website')" },
        check_frequency_minutes: {
          type: "number",
          description: "Minutes between checks. Must be >= the plan's minCheckIntervalMinutes.",
        },
        http_method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        expected_status_codes: {
          type: "array",
          items: { type: "integer", minimum: 100, maximum: 599 },
          description: "Status codes treated as healthy. Defaults to 2xx.",
        },
        request_headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra request headers. Do not put secrets here that you would not paste into a dashboard.",
        },
        request_body: { type: "string", description: "JSON request body for POST/PUT/PATCH rest_endpoint checks" },
        response_validation: {
          type: "object",
          properties: {
            containsText: { type: "array", items: { type: "string" }, maxItems: 10 },
            jsonPath: { type: "string", description: "JSONPath expression, e.g. $.status" },
            jsonPathOperator: { type: "string", enum: ["equals", "not_equals", "contains", "exists"] },
            expectedValue: { description: "Value the JSONPath result is compared against" },
          },
          additionalProperties: false,
          description: "Body assertions — this is what turns a 200 into a real health check.",
        },
        response_time_limit_ms: { type: "number", description: "Fail the check if it responds slower than this" },
        record_types: {
          type: "array",
          items: { type: "string", enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA"] },
          description: "DNS record types to baseline (type 'dns' only)",
        },
      },
      additionalProperties: false,
    },
    handler: async (args, api) => {
      const body: Record<string, unknown> = {
        url: args.url,
        name: args.name,
        type: args.type || "website",
        checkFrequency: args.check_frequency_minutes,
        httpMethod: args.http_method,
        expectedStatusCodes: args.expected_status_codes,
        requestHeaders: args.request_headers,
        requestBody: args.request_body,
        responseValidation: args.response_validation,
        responseTimeLimit: args.response_time_limit_ms,
        recordTypes: args.record_types,
      };
      for (const key of Object.keys(body)) {
        if (body[key] === undefined) delete body[key];
      }
      const created = data(await api.call("POST", "/checks", { body })) as { id: string };
      return {
        id: created.id,
        message: `Check created. It will run its first probe within a minute. View it at https://app.exit1.dev/checks/${created.id}`,
      };
    },
  },

  {
    name: "update_check",
    title: "Update check",
    readOnly: false,
    scope: API_SCOPES.CHECKS_WRITE,
    description: "Change an existing check's settings. Only the fields you pass are modified.",
    inputSchema: {
      type: "object",
      properties: {
        ...CHECK_ID_PROP,
        url: { type: "string" },
        name: { type: "string", maxLength: 200 },
        check_frequency_minutes: { type: "number" },
        http_method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        expected_status_codes: { type: "array", items: { type: "integer", minimum: 100, maximum: 599 } },
        response_validation: { type: "object", description: "Same shape as create_check.response_validation" },
        response_time_limit_ms: { type: "number" },
      },
      required: ["check_id"],
      additionalProperties: false,
    },
    handler: async (args, api) => {
      const body: Record<string, unknown> = {
        url: args.url,
        name: args.name,
        checkFrequency: args.check_frequency_minutes,
        httpMethod: args.http_method,
        expectedStatusCodes: args.expected_status_codes,
        responseValidation: args.response_validation,
        responseTimeLimit: args.response_time_limit_ms,
      };
      for (const key of Object.keys(body)) {
        if (body[key] === undefined) delete body[key];
      }
      unwrap(await api.call("PATCH", `/checks/${encodeURIComponent(String(args.check_id))}`, { body }));
      return { id: args.check_id, updated: true };
    },
  },

  {
    name: "toggle_check",
    title: "Enable or disable check",
    readOnly: false,
    scope: API_SCOPES.CHECKS_WRITE,
    description:
      "Enable or disable a check without deleting it. Disabled checks stop probing and stop alerting — use this rather than delete_check for a temporary pause.",
    inputSchema: {
      type: "object",
      properties: {
        ...CHECK_ID_PROP,
        disabled: { type: "boolean", description: "true to pause the check, false to resume it" },
      },
      required: ["check_id", "disabled"],
      additionalProperties: false,
    },
    handler: async (args, api) => {
      unwrap(
        await api.call("POST", `/checks/${encodeURIComponent(String(args.check_id))}/toggle`, {
          body: { disabled: args.disabled },
        })
      );
      return { id: args.check_id, disabled: args.disabled };
    },
  },

  {
    name: "delete_check",
    title: "Delete check",
    readOnly: false,
    scope: API_SCOPES.CHECKS_DELETE,
    description:
      "Permanently delete a check and stop monitoring it. This cannot be undone. Prefer toggle_check unless the user explicitly wants it gone.",
    inputSchema: {
      type: "object",
      properties: { ...CHECK_ID_PROP },
      required: ["check_id"],
      additionalProperties: false,
    },
    handler: async (args, api) => {
      unwrap(await api.call("DELETE", `/checks/${encodeURIComponent(String(args.check_id))}`));
      return { id: args.check_id, deleted: true };
    },
  },

  {
    name: "get_alert_settings",
    title: "Get alert settings",
    readOnly: true,
    scope: API_SCOPES.ALERTS_READ,
    description:
      "Show where alerts currently go — email recipients and connected webhooks. Call this before configuring alerts so you do not duplicate a channel the user already has.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, api) => {
      const [email, webhooks] = await Promise.all([
        api.call("GET", "/alerts/email"),
        api.call("GET", "/alerts/webhooks"),
      ]);
      return {
        email: data(email),
        webhooks: data(webhooks),
      };
    },
  },

  {
    name: "set_email_alerts",
    title: "Configure email alerts",
    readOnly: false,
    scope: API_SCOPES.ALERTS_WRITE,
    description:
      "Set which email addresses receive alerts and which events trigger them. Events: website_down, website_up, website_error, ssl_error, ssl_warning, domain_expiring, domain_expired, domain_renewed. Defaults to website_down + website_up, which is the right pair for most people.",
    inputSchema: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          items: { type: "string" },
          maxItems: 10,
          description: "Email addresses that should receive alerts",
        },
        events: { type: "array", items: { type: "string" }, description: "Events to alert on" },
        enabled: { type: "boolean", description: "Turn email alerting on or off (default true)" },
        format: { type: "string", enum: ["html", "text"], description: "Use 'text' for ticketing systems" },
      },
      additionalProperties: false,
    },
    handler: async (args, api) => {
      const body: Record<string, unknown> = {
        recipients: args.recipients,
        events: args.events,
        enabled: args.enabled,
        emailFormat: args.format,
      };
      for (const key of Object.keys(body)) {
        if (body[key] === undefined) delete body[key];
      }
      return data(await api.call("PATCH", "/alerts/email", { body }));
    },
  },

  {
    name: "add_webhook_alert",
    title: "Add webhook alert",
    readOnly: false,
    scope: API_SCOPES.ALERTS_WRITE,
    description:
      "Send alerts to Slack, Discord, Microsoft Teams or any HTTPS endpoint. Paste the incoming-webhook URL the user gives you; the platform is detected from the URL if you do not pass webhook_type.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS webhook URL (e.g. a Slack incoming webhook)" },
        name: { type: "string", maxLength: 100, description: "Label shown in the dashboard, e.g. '#alerts'" },
        webhook_type: {
          type: "string",
          enum: ["slack", "discord", "teams", "pumble", "generic"],
          description: "Override auto-detection",
        },
        events: { type: "array", items: { type: "string" }, description: "Defaults to website_down + website_up" },
        secret: { type: "string", description: "Optional HMAC signing secret for generic webhooks" },
      },
      required: ["url", "name"],
      additionalProperties: false,
    },
    handler: async (args, api) =>
      data(
        await api.call("POST", "/alerts/webhooks", {
          body: {
            url: args.url,
            name: args.name,
            webhookType: args.webhook_type,
            events: args.events,
            secret: args.secret,
          },
        })
      ),
  },

  {
    name: "send_test_alert",
    title: "Send test alert",
    readOnly: false,
    scope: API_SCOPES.ALERTS_WRITE,
    description:
      "Fire a real test alert so the user can confirm delivery works. ALWAYS finish a monitoring setup with this — a channel that was configured but never tested is the most common way monitoring silently fails. Pass channel='email' or channel='webhook' with a webhook_id.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["email", "webhook"], description: "Which channel to test" },
        webhook_id: { type: "string", description: "Required when channel is 'webhook'" },
      },
      required: ["channel"],
      additionalProperties: false,
    },
    handler: async (args, api) => {
      if (args.channel === "webhook") {
        if (!args.webhook_id) {
          throw new ToolError("webhook_id is required when channel is 'webhook'");
        }
        return data(
          await api.call("POST", `/alerts/webhooks/${encodeURIComponent(String(args.webhook_id))}/test`)
        );
      }
      return data(await api.call("POST", "/alerts/email/test"));
    },
  },
];

export const MCP_TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

// ── Prompts ──

export const SETUP_MONITORING_PROMPT = `You are setting up uptime monitoring for this project with Exit1.

Be fast and autonomous. Do not ask the user for URLs you can find yourself.

1. CHECK THE PLAN
   Call get_account for the limits (maxChecks, minCheckIntervalMinutes) and
   list_checks to see what already exists. Everything below has to fit inside
   those numbers, and you should not recreate something already monitored.

2. FIND WHAT IS WORTH MONITORING — read the project, whatever the stack is
   Look wherever this particular project would keep it: deploy and infra
   config, environment files and examples, the README, DNS or domain config,
   container healthchecks, CI/CD workflows, and route or endpoint definitions.
   You are looking for:
     - the production site or app, and staging if there is one
     - health/status endpoints — the highest-value target by far. Assert on the
       response body, not just the status code: a 200 with a dead database is
       still a 200. Use response_validation with a JSONPath assertion.
     - public APIs and webhook receivers that other systems depend on
     - scheduled jobs, cron and workers — monitor these as type 'heartbeat'
     - the apex domain — SSL expiry is tracked automatically on https checks,
       and type 'domain' tracks registration expiry
   If the project has no deployed URL you can find, ask for it.

3. ASK ONCE, THEN CREATE
   In a single message, ask which email address should receive alerts and
   whether to add a Slack or Discord webhook. In the same message, show the
   checks you intend to create as one short list — URL, type, interval, and
   what makes each one healthy. Create them once the user confirms.
   Intervals: the fastest the plan allows for anything user-facing, something
   slower for background jobs.

4. CONFIGURE ALERTS
   Call get_alert_settings first so you do not duplicate a channel the user
   already has, then set_email_alerts and add_webhook_alert as needed.

5. PROVE IT WORKS
   Call send_test_alert for every channel you configured and tell the user to
   confirm it arrived. If it did not, fix it now — never leave a channel
   configured but untested.

6. HAND OFF
   Summarise what is monitored and what will trigger an alert, and link
   https://app.exit1.dev/checks.

Never put API keys, tokens or passwords into a check. Prefer a few meaningful
checks over many shallow ones.`;

export const MCP_PROMPTS = [
  {
    name: "setup_monitoring",
    title: "Set up monitoring for this project",
    description:
      "Read the current repository, work out what should be monitored, create the checks, configure alerts, and send a test alert to prove delivery works.",
    text: SETUP_MONITORING_PROMPT,
  },
];
