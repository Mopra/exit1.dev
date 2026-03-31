# exit1-mcp

MCP server for [Exit1](https://exit1.dev) uptime monitoring. Query your checks, history, and stats from AI assistants like Claude, Cursor, and Windsurf.

## Requirements

- Node.js 18+
- Exit1 account on Nano or Scale plan
- API key with `checks:read` scope (create one in your [Exit1 dashboard](https://exit1.dev))

## Quick start

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

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

### Claude Code

```bash
claude mcp add exit1 -- npx -y exit1-mcp
```

Then set the environment variable `EXIT1_API_KEY` in your shell.

### Cursor

Add to `.cursor/mcp.json` in your project:

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

## Tools

| Tool | Description |
|------|-------------|
| `list_checks` | List all checks with current status. Filter by `online`, `offline`, `unknown`. |
| `get_check` | Get details for a specific check (status, response time, SSL, maintenance). |
| `get_check_history` | Get historical results with timestamps, status codes, and errors. |
| `get_check_stats` | Get uptime %, response time stats over time ranges (1d, 7d, 30d, etc.). |
| `get_status_page` | Get current snapshot of a public status page. |

## Example prompts

- "Are any of my monitors down?"
- "What's the uptime for my API check over the last 30 days?"
- "Show me the last 10 failures for production"
- "Compare response times this week vs last week"
- "What does my status page show right now?"

## Configuration

| Environment variable | Required | Description |
|---------------------|----------|-------------|
| `EXIT1_API_KEY` | Yes | Your Exit1 API key (`ek_live_...`) |
| `EXIT1_API_URL` | No | Override the API base URL (for development) |

## License

MIT
