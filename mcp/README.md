# exit1-mcp

MCP server for [Exit1](https://exit1.dev) uptime monitoring. Let your AI assistant set up monitoring for the project you just shipped — read your repo, create the checks, configure alerts, and send a real test alert to prove it works — then ask it about uptime in plain language afterwards.

## Two ways to connect

**Hosted (recommended).** No API key, no npm install, no plan requirement to get started. Your assistant opens a browser, you sign in (or sign up) with Clerk, approve, and you're connected.

```bash
claude mcp add --transport http exit1 https://app.exit1.dev/mcp/v1
```

**Local stdio.** This npm package. Uses a Public API key from your dashboard. Use it when your client doesn't support remote MCP servers with OAuth.

```bash
claude mcp add exit1 -- npx -y exit1-mcp
export EXIT1_API_KEY="ek_live_your_key_here"
```

Both expose the same tools. The hosted server is easier; the stdio one has no browser step, which some CI-ish setups prefer.

## Zero to monitored

Paste this into Claude Code, Cursor, Codex or any MCP-capable assistant, from inside your project:

```
Set up uptime monitoring for this project with Exit1.

1. Add the MCP server: claude mcp add --transport http exit1 https://app.exit1.dev/mcp/v1
2. Call get_account to see my plan limits.
3. Read this repo to find what should be monitored — deployed URLs in vercel.json /
   next.config / wrangler.toml / .env.production / README, and any /health or
   /api/status route handlers.
4. Show me the checks you plan to create before creating them.
5. Configure email alerts, then send a test alert so I can confirm delivery works.
```

Once connected, the server also ships a `setup_monitoring` prompt containing the full playbook — in Claude Code, `/exit1:setup_monitoring`.

## Requirements

- **Hosted:** an Exit1 account. Sign-up happens inline during the OAuth flow.
- **Local stdio:** Node.js 18+, and an API key from your [dashboard](https://app.exit1.dev/api-keys). API keys require an Indie plan or higher — MCP access follows API access.

## Supported clients

| Client | Hosted (OAuth) | Local stdio |
|---|---|---|
| Claude Code | ✅ | ✅ |
| Claude Desktop | ✅ | ✅ |
| Cursor | ✅ | ✅ |
| VS Code (Copilot) | ✅ | ✅ |
| Windsurf | ⚠️ check version | ✅ |
| Codex CLI | ⚠️ check version | ✅ |
| Gemini CLI | ⚠️ check version | ✅ |
| Goose | ⚠️ check version | ✅ |
| ChatGPT | via connector | via `mcp-remote` bridge |

Remote MCP with OAuth is still rolling out across clients. Where it isn't supported yet, the stdio path below works everywhere.

## Local stdio setup

### Claude Code

```bash
claude mcp add exit1 -- npx -y exit1-mcp

export EXIT1_API_KEY="ek_live_your_key_here"
claude
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "exit1": {
      "command": "npx",
      "args": ["-y", "exit1-mcp"],
      "env": {
        "EXIT1_API_KEY": "ek_live_your_key_here"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally). Same shape as Claude Desktop above.

### VS Code with Copilot

Run **MCP: Add Server** from the Command Palette, choose **Command (stdio)**, enter `npx -y exit1-mcp`. VS Code uses a `servers` key rather than `mcpServers`:

```json
{
  "servers": {
    "exit1": {
      "command": "npx",
      "args": ["-y", "exit1-mcp"],
      "env": {
        "EXIT1_API_KEY": "ek_live_your_key_here"
      }
    }
  }
}
```

### Windsurf / Gemini CLI / Goose

Same `mcpServers` block as Claude Desktop, in `mcp_config.json` (Windsurf settings › MCP), `~/.gemini/settings.json`, or via `goose mcp add exit1 -- npx -y exit1-mcp`. Restart the IDE or CLI afterwards.

### Codex CLI

```bash
codex mcp add exit1 -- npx -y exit1-mcp
export EXIT1_API_KEY="ek_live_your_key_here"
codex
```

### ChatGPT

Bridge the stdio server with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), then add it under **Settings › Connectors**.

## Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `get_account` | `checks:read` | Plan, limits and current usage. Call this first when setting things up. |
| `list_checks` | `checks:read` | List checks with current status. |
| `get_check` | `checks:read` | Detail for one check, including SSL state. |
| `get_check_history` | `checks:read` | Individual results over time. |
| `get_check_stats` | `checks:read` | Uptime % and response times across ranges. |
| `get_status_page` | `checks:read` | Snapshot of a public status page. |
| `create_check` | `checks:write` | Create a monitor (website, API, ping, TCP, DNS, domain, heartbeat). |
| `update_check` | `checks:write` | Change an existing check's settings. |
| `toggle_check` | `checks:write` | Pause or resume a check. |
| `delete_check` | `checks:delete` | Permanently remove a check. |
| `get_alert_settings` | `alerts:read` | See where alerts currently go. |
| `set_email_alerts` | `alerts:write` | Set email recipients and events. |
| `add_webhook_alert` | `alerts:write` | Connect Slack, Discord, Teams or a generic webhook. |
| `send_test_alert` | `alerts:write` | Fire a real test alert. |

The hosted server requests `checks:read`, `checks:write`, `alerts:read` and `alerts:write` by default — not `checks:delete`, which has to be asked for explicitly. For the stdio path, tick the scopes you want when creating the API key.

## Example prompts

- "Set up monitoring for this project."
- "Are any of my monitors down right now?"
- "What's the uptime for my API check over the last 30 days?"
- "Show me the last 10 failures for production."
- "Add a check on staging.example.com and send alerts to #ops in Slack."
- "Compare response times this week vs last week."

## Configuration

| Environment variable | Required | Description |
|---------------------|----------|-------------|
| `EXIT1_API_KEY` | stdio only | Your Exit1 API key (`ek_live_…`) |
| `EXIT1_API_URL` | No | Override the API base URL (for development) |

## Managing connections

Hosted connections are listed at [app.exit1.dev/mcp](https://app.exit1.dev/mcp) and can be revoked there at any time. Revoking kills every token issued to that client immediately.

## License

MIT
