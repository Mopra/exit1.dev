import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  Exit1ApiClient,
  type ApiError,
  type CheckSummary,
  type HistoryEntry,
  type StatsData,
} from "./api-client.js";

function formatTimestamp(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts).toISOString();
}

function formatError(err: unknown): string {
  const apiErr = err as ApiError;
  if (apiErr.status && apiErr.message) {
    let msg = `API error ${apiErr.status}: ${apiErr.message}`;
    if (apiErr.retryAfter) {
      msg += ` (retry after ${apiErr.retryAfter}s)`;
    }
    return msg;
  }
  return String(err);
}

function formatCheck(check: CheckSummary) {
  return {
    id: check.id,
    name: check.name,
    url: check.url,
    status: check.status,
    disabled: check.disabled,
    maintenanceMode: check.maintenanceMode,
    responseTime: check.responseTime,
    lastStatusCode: check.lastStatusCode,
    lastChecked: formatTimestamp(check.lastChecked),
    ssl: check.sslCertificate
      ? {
          valid: check.sslCertificate.valid,
          issuer: check.sslCertificate.issuer ?? null,
          daysUntilExpiry: check.sslCertificate.daysUntilExpiry ?? null,
          error: check.sslCertificate.error ?? null,
        }
      : null,
    createdAt: formatTimestamp(check.createdAt),
    updatedAt: formatTimestamp(check.updatedAt),
  };
}

function formatHistoryEntry(entry: HistoryEntry) {
  return {
    id: entry.id,
    timestamp: formatTimestamp(entry.timestamp),
    status: entry.status,
    responseTime: entry.responseTime ?? null,
    statusCode: entry.statusCode ?? null,
    error: entry.error ?? null,
  };
}

function formatStats(data: StatsData) {
  return {
    totalChecks: data.totalChecks,
    onlineChecks: data.onlineChecks,
    offlineChecks: data.offlineChecks,
    uptimePercentage: Math.round(data.uptimePercentage * 100) / 100,
    avgResponseTime: Math.round(data.avgResponseTime),
    minResponseTime: data.minResponseTime,
    maxResponseTime: data.maxResponseTime,
  };
}

export function registerTools(server: McpServer, client: Exit1ApiClient) {
  // ── list_checks ──
  server.tool(
    "list_checks",
    "List all monitored checks with their current status. Use this to get an overview of all monitors, find offline checks, or search for a specific check.",
    {
      status: z
        .enum(["online", "offline", "unknown"])
        .optional()
        .describe("Filter checks by status"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (1-100, default 25)"),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number"),
    },
    async ({ status, limit, page }) => {
      try {
        const response = await client.listChecks({ status, limit, page });
        const checks = response.data.map(formatCheck);

        const online = response.data.filter((c) => c.status === "online").length;
        const offline = response.data.filter((c) => c.status === "offline").length;
        const unknown = response.data.filter((c) => c.status === "unknown").length;
        const disabled = response.data.filter((c) => c.disabled).length;

        const parts = [];
        if (online) parts.push(`${online} online`);
        if (offline) parts.push(`${offline} offline`);
        if (unknown) parts.push(`${unknown} unknown`);
        if (disabled) parts.push(`${disabled} disabled`);

        const total = response.meta.total ?? response.data.length;
        const summary = `${total} checks total: ${parts.join(", ")}`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { summary, checks, pagination: response.meta },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    }
  );

  // ── get_check ──
  server.tool(
    "get_check",
    "Get detailed information about a specific check including status, response time, SSL certificate details, and maintenance windows.",
    {
      check_id: z.string().describe("The check ID"),
    },
    async ({ check_id }) => {
      try {
        const response = await client.getCheck(check_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(formatCheck(response.data), null, 2),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    }
  );

  // ── get_check_history ──
  server.tool(
    "get_check_history",
    "Get historical check results showing individual pings with timestamps, status, response times, and errors. Useful for investigating incidents or reviewing recent performance.",
    {
      check_id: z.string().describe("The check ID"),
      from: z
        .string()
        .optional()
        .describe("Start date (ISO 8601, e.g. 2026-03-01T00:00:00Z)"),
      to: z
        .string()
        .optional()
        .describe("End date (ISO 8601)"),
      status: z
        .enum(["online", "offline", "unknown"])
        .optional()
        .describe("Filter by status"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Results per page (1-200, default 25)"),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Page number"),
    },
    async ({ check_id, from, to, status, limit, page }) => {
      try {
        const response = await client.getCheckHistory(check_id, {
          from,
          to,
          status,
          limit,
          page,
        });
        const entries = response.data.map(formatHistoryEntry);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { entries, pagination: response.meta },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    }
  );

  // ── get_check_stats ──
  server.tool(
    "get_check_stats",
    "Get aggregate statistics for a check: uptime percentage, average/min/max response time, and check counts. Supports multiple time ranges for comparison (e.g. 1d,7d,30d).",
    {
      check_id: z.string().describe("The check ID"),
      ranges: z
        .string()
        .optional()
        .describe(
          "Comma-separated time ranges: 1h, 6h, 1d, 7d, 30d, 60d, 90d (default: 1d,7d,30d)"
        ),
    },
    async ({ check_id, ranges }) => {
      try {
        const response = await client.getCheckStats(check_id, {
          ranges: ranges ?? "1d,7d,30d",
        });

        let formatted: Record<string, unknown>;
        if (
          typeof response.data === "object" &&
          "totalChecks" in response.data
        ) {
          // Single range response
          formatted = formatStats(response.data as StatsData);
        } else {
          // Multi-range response
          formatted = {};
          for (const [range, stats] of Object.entries(response.data)) {
            formatted[range] = formatStats(stats as StatsData);
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    }
  );

  // ── get_status_page ──
  server.tool(
    "get_status_page",
    "Get the current snapshot of a public status page, showing all checks and their uptime percentages.",
    {
      status_page_id: z.string().describe("The status page ID"),
    },
    async ({ status_page_id }) => {
      try {
        const response = await client.getStatusPageSnapshot(status_page_id);
        const checks = response.data.checks.map((c) => ({
          id: c.checkId,
          name: c.name,
          url: c.url,
          status: c.status,
          lastChecked: formatTimestamp(c.lastChecked),
          uptimePercentage: c.uptimePercentage,
          folder: c.folder,
        }));

        const online = checks.filter((c) => c.status === "online").length;
        const total = checks.length;
        const summary =
          online === total
            ? `All ${total} checks operational`
            : `${online} of ${total} checks operational`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, checks }, null, 2),
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    }
  );
}
