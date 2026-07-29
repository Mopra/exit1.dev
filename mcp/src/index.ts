#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Exit1ApiClient, ToolError } from "./api-client.js";
import { TOOLS, TOOLS_BY_NAME, PROMPTS } from "./tools.js";

const apiKey = process.env.EXIT1_API_KEY;
if (!apiKey) {
  console.error(
    "Error: EXIT1_API_KEY environment variable is required.\n" +
      "Create an API key at https://app.exit1.dev/api-keys (Indie plan or higher).\n\n" +
      "Prefer not to manage a key? Use the hosted server instead — it signs you in\n" +
      "through your browser and needs no key:\n" +
      "  claude mcp add --transport http exit1 https://app.exit1.dev/mcp/v1"
  );
  process.exit(1);
}

const client = new Exit1ApiClient({
  apiKey,
  baseUrl: process.env.EXIT1_API_URL,
});

const server = new Server(
  { name: "exit1", version: "0.2.0" },
  {
    capabilities: { tools: {}, prompts: {} },
    instructions: `Exit1 is uptime monitoring for websites, APIs, domains and cron jobs.

When a user asks you to set up monitoring, start with get_account to learn their
plan limits, then read their repository to find what should actually be monitored
rather than asking them to type URLs. Finish by calling send_test_alert so they
see a real alert arrive.

The setup_monitoring prompt contains the full playbook.`,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((tool) => ({
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
  const tool = TOOLS_BY_NAME.get(name);

  if (!tool) {
    return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    const result = await tool.handler((args || {}) as Record<string, unknown>, client);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result && typeof result === "object" ? (result as Record<string, unknown>) : undefined,
    };
  } catch (error) {
    // Tool failures come back as isError content rather than protocol errors so
    // the model can read the message and correct itself — wrong interval, plan
    // limit reached, missing scope — instead of the call blowing up.
    let message = error instanceof Error ? error.message : String(error);
    if (error instanceof ToolError && error.status === 403) {
      message = `${message}\n\nThis tool needs the "${tool.scope}" scope. Add it to your API key at https://app.exit1.dev/api-keys`;
    }
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const prompt = PROMPTS.find((p) => p.name === request.params.name);
  if (!prompt) {
    throw new Error(`Unknown prompt: ${request.params.name}`);
  }
  return {
    description: prompt.description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text: prompt.text } }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
