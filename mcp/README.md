# exit1-mcp

MCP server for [Exit1](https://exit1.dev) uptime monitoring. Query your checks, history, and stats from any AI assistant that supports the [Model Context Protocol](https://modelcontextprotocol.io).

## Requirements

- Node.js 18+
- Exit1 account on Nano or Scale plan
- API key with `checks:read` scope (create one in your [Exit1 dashboard](https://app.exit1.dev))

## Supported clients

- [Claude Code](#claude-code)
- [Claude Desktop](#claude-desktop)
- [Cursor](#cursor)
- [VS Code with Copilot](#vs-code-with-copilot)
- [Windsurf](#windsurf)
- [Codex CLI](#codex-cli)
- [Gemini Code Assist / Gemini CLI](#gemini-code-assist--gemini-cli)
- [Goose](#goose)
- [ChatGPT](#chatgpt)
- [Any MCP-compatible client](#other-clients)

## Quick start

### Claude Code

```bash
claude mcp add exit1 -- npx -y exit1-mcp

# Set your API key
export EXIT1_API_KEY="ek_live_your_key_here"

# Start Claude Code
claude
```

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

### Cursor

Add to `.cursor/mcp.json` in your project (or globally at `~/.cursor/mcp.json`):

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

### VS Code with Copilot

1. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS)
2. Run **MCP: Add Server**
3. Select **Command (stdio)**
4. Enter command: `npx -y exit1-mcp`
5. Enter name: `exit1`
6. Select **User** (global) or **Workspace** (project-specific)

Then add `EXIT1_API_KEY` to your environment or to the generated `.vscode/mcp.json`:

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

### Windsurf

Add to your `mcp_config.json` (open via Windsurf settings > MCP):

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

### Codex CLI

```bash
# Add the MCP server
codex mcp add exit1 -- npx -y exit1-mcp

# Set your API key
export EXIT1_API_KEY="ek_live_your_key_here"

# Start Codex
codex
```

### Gemini Code Assist / Gemini CLI

Add to your `~/.gemini/settings.json`:

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

Restart your IDE or CLI after adding the configuration.

### Goose

```bash
goose mcp add exit1 -- npx -y exit1-mcp
```

Then set `EXIT1_API_KEY` in your environment.

### ChatGPT

ChatGPT supports MCP servers via stdio proxy. Use [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) or a similar bridge to expose the exit1-mcp server, then add it as a connector in ChatGPT settings under **Connectors**.

### Other clients

exit1-mcp works with any MCP client that supports stdio transport. The general pattern:

- **Command:** `npx`
- **Args:** `["-y", "exit1-mcp"]`
- **Environment:** `EXIT1_API_KEY` set to your API key

Consult your client's documentation for how to add stdio MCP servers.

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
