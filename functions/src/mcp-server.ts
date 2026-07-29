/**
 * Remote MCP server — Streamable HTTP, stateless, OAuth-protected.
 *
 * Reachable at https://app.exit1.dev/mcp (Hosting rewrite → this function).
 *
 * Stateless is the right shape for Cloud Functions: every request builds its own
 * Server + transport, handles one JSON-RPC message and exits. No session state
 * survives between invocations, which matters because instances come and go and
 * there is no sticky routing.
 *
 * Auth: a Bearer access token minted by mcp-oauth.ts. A missing or bad token
 * gets a 401 carrying WWW-Authenticate with the resource-metadata pointer — that
 * header is what makes a client discover our authorization server and start the
 * browser flow, so it must be present on every unauthenticated response.
 */

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveBearerToken, buildWwwAuthenticate } from "./mcp-oauth";
import {
  MCP_TOOLS,
  MCP_TOOLS_BY_NAME,
  MCP_PROMPTS,
  PublicApiClient,
  ToolError,
} from "./mcp-tools";
import { hasScope } from "./api-scopes";

const SERVER_NAME = "exit1";
const SERVER_VERSION = "1.0.0";

const SERVER_INSTRUCTIONS = `Exit1 is uptime monitoring for websites, APIs, domains and cron jobs.

When a user asks you to set up monitoring, start with get_account to learn their
plan limits, then read their repository to find what should actually be monitored
rather than asking them to type URLs. Finish by calling send_test_alert so they
see a real alert arrive — a channel that was never tested is the most common way
monitoring silently fails.

The setup_monitoring prompt contains the full playbook.`;

function buildServer(accessToken: string, scopes: string[]): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  const api = new PublicApiClient(accessToken);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly,
        destructiveHint: tool.name === "delete_check",
        idempotentHint: tool.readOnly || tool.name === "update_check" || tool.name === "toggle_check",
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = MCP_TOOLS_BY_NAME.get(name);

    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const needed = tool.scope;
    if (!hasScope(scopes, needed)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `This connection was not granted the "${needed}" scope, so ${name} is unavailable. Reconnect at https://app.exit1.dev/mcp to grant it.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler((args || {}) as Record<string, unknown>, api);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result && typeof result === "object" ? (result as Record<string, unknown>) : undefined,
      };
    } catch (error) {
      // Tool errors go back as isError content, not protocol errors — the model
      // should see the message and correct itself (wrong interval, plan limit
      // reached, duplicate URL) rather than have the call blow up.
      const message = error instanceof ToolError ? error.message : error instanceof Error ? error.message : String(error);
      logger.warn("MCP tool call failed", { tool: name, message });
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: MCP_PROMPTS.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = MCP_PROMPTS.find((p) => p.name === request.params.name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: prompt.text },
        },
      ],
    };
  });

  return server;
}

export const mcpServer = onRequest(
  {
    // Tool calls hop through the public API, so give them room; the default 60s
    // is tight when a test email and a webhook delivery land in the same turn.
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 20,
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
    );
    res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const authHeader = (req.header("authorization") || req.header("Authorization") || "").trim();
    const token = /^Bearer\s+/i.test(authHeader) ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";

    if (!token) {
      res.set("WWW-Authenticate", buildWwwAuthenticate());
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Authorization required" },
        id: null,
      });
      return;
    }

    const principal = await resolveBearerToken(token);
    if (!principal) {
      res.set("WWW-Authenticate", buildWwwAuthenticate("The access token is invalid or expired"));
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or expired access token" },
        id: null,
      });
      return;
    }

    // Stateless mode: no session id, and JSON responses rather than SSE. Cloud
    // Functions bill for wall-clock and terminate idle streams, so a held-open
    // SSE channel is exactly what we don't want here.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const server = buildServer(token, principal.scopes);

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      // Firebase has already consumed and parsed the body, so hand the parsed
      // value in — the transport would otherwise wait on a stream that never emits.
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("MCP request handling failed", { userId: principal.userId, error });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  }
);
