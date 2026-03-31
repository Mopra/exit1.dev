#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Exit1ApiClient } from "./api-client.js";
import { registerTools } from "./tools.js";

const apiKey = process.env.EXIT1_API_KEY;
if (!apiKey) {
  console.error(
    "Error: EXIT1_API_KEY environment variable is required.\n" +
      "Create an API key at https://exit1.dev (Nano plan or higher)."
  );
  process.exit(1);
}

const client = new Exit1ApiClient({
  apiKey,
  baseUrl: process.env.EXIT1_API_URL,
});

const server = new McpServer({
  name: "exit1-mcp",
  version: "0.1.0",
});

registerTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
