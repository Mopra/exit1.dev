import * as React from "react";
import { Link } from "react-router-dom";
import { Bot, Copy, KeyRound, Sparkles, Terminal } from "lucide-react";

import { PageContainer, PageHeader } from "@/components/layout";
import { usePlan } from "@/hooks/usePlan";
import { FeatureGate } from "@/components/ui";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/utils/clipboard";

// The npm package and env var are the contract with the MCP server. Keep these
// in sync with mcp/README.md if the package is ever renamed.
const PACKAGE = "exit1-mcp";
const KEY_PLACEHOLDER = "ek_live_your_key_here";

function CodeBlock({
  code,
  className,
  copyLabel = "Copy",
}: {
  code: string;
  className?: string;
  copyLabel?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  async function onCopy() {
    const ok = await copyToClipboard(code);
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 900);
  }

  return (
    <div
      className={cn(
        "rounded-md border border-primary/20 bg-black/40 backdrop-blur",
        className
      )}
    >
      <div className="flex items-center justify-end gap-2 border-b border-primary/15 px-3 py-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onCopy}
          className="h-7 gap-1 px-2 cursor-pointer"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied" : copyLabel}
        </Button>
      </div>
      <pre className="overflow-auto p-3 text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Standard MCP config block ("mcpServers" key) shared by Claude Desktop,
// Cursor, Windsurf, and Gemini.
const jsonMcpServers = (key: string) =>
  `{
  "mcpServers": {
    "exit1": {
      "command": "npx",
      "args": ["-y", "${PACKAGE}"],
      "env": {
        "EXIT1_API_KEY": "${key}"
      }
    }
  }
}`;

// VS Code uses a "servers" key instead of "mcpServers".
const jsonVsCode = (key: string) =>
  `{
  "servers": {
    "exit1": {
      "command": "npx",
      "args": ["-y", "${PACKAGE}"],
      "env": {
        "EXIT1_API_KEY": "${key}"
      }
    }
  }
}`;

type Client = {
  id: string;
  label: string;
  /** Where the snippet goes / how to apply it. */
  hint: React.ReactNode;
  /** Builds the snippet from a key placeholder. */
  code: (key: string) => string;
  copyLabel?: string;
  footnote?: React.ReactNode;
};

const CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Add the server, then export your key in the shell that launches Claude Code.",
    code: () =>
      `claude mcp add exit1 -- npx -y ${PACKAGE}\n\n# Set your API key, then start Claude Code\nexport EXIT1_API_KEY="${KEY_PLACEHOLDER}"\nclaude`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    hint: (
      <>
        Add to your config:{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">
          %APPDATA%\Claude\claude_desktop_config.json
        </code>{" "}
        (Windows) or{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">
          ~/Library/Application Support/Claude/claude_desktop_config.json
        </code>{" "}
        (macOS).
      </>
    ),
    code: (key) => jsonMcpServers(key),
    copyLabel: "Copy JSON",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: (
      <>
        Add to{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">.cursor/mcp.json</code>{" "}
        in your project (or{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">~/.cursor/mcp.json</code>{" "}
        globally).
      </>
    ),
    code: (key) => jsonMcpServers(key),
    copyLabel: "Copy JSON",
  },
  {
    id: "vscode",
    label: "VS Code",
    hint: (
      <>
        Run <span className="font-medium text-foreground">MCP: Add Server</span>{" "}
        from the Command Palette, or add to{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">.vscode/mcp.json</code>.
        Note VS Code uses a{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">servers</code> key.
      </>
    ),
    code: (key) => jsonVsCode(key),
    copyLabel: "Copy JSON",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    hint: (
      <>
        Add to your{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">mcp_config.json</code>{" "}
        (Windsurf settings &rsaquo; MCP).
      </>
    ),
    code: (key) => jsonMcpServers(key),
    copyLabel: "Copy JSON",
  },
  {
    id: "codex",
    label: "Codex CLI",
    hint: "Add the server, then export your key before starting Codex.",
    code: () =>
      `codex mcp add exit1 -- npx -y ${PACKAGE}\n\nexport EXIT1_API_KEY="${KEY_PLACEHOLDER}"\ncodex`,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    hint: (
      <>
        Add to{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">~/.gemini/settings.json</code>,
        then restart your IDE or CLI.
      </>
    ),
    code: (key) => jsonMcpServers(key),
    copyLabel: "Copy JSON",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    hint: (
      <>
        ChatGPT connects to stdio servers through a bridge. Expose{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">{PACKAGE}</code> with{" "}
        <code className="px-1 py-0.5 rounded bg-black/40">mcp-remote</code>, then
        add it under <span className="font-medium text-foreground">Settings &rsaquo; Connectors</span>.
      </>
    ),
    code: () =>
      `# Bridge the stdio server so ChatGPT can reach it\nEXIT1_API_KEY="${KEY_PLACEHOLDER}" npx -y mcp-remote npx -y ${PACKAGE}`,
  },
];

type Tool = { name: string; description: string };

const TOOLS: Tool[] = [
  { name: "list_checks", description: "List all checks with current status. Filter by online, offline, or unknown." },
  { name: "get_check", description: "Get details for a specific check — status, response time, SSL, maintenance." },
  { name: "get_check_history", description: "Historical results with timestamps, status codes, and errors." },
  { name: "get_check_stats", description: "Uptime % and response-time stats over time ranges (1d, 7d, 30d, …)." },
  { name: "get_status_page", description: "Current snapshot of a public status page." },
];

const EXAMPLE_PROMPTS = [
  "Are any of my monitors down right now?",
  "What's the uptime for my API check over the last 30 days?",
  "Show me the last 10 failures for production.",
  "Compare response times this week vs last week.",
  "What does my status page show right now?",
];

export default function Mcp() {
  const { tier, pro, isLoading } = usePlan();

  return (
    <PageContainer>
      <PageHeader
        title="MCP"
        description="Connect your monitors to AI assistants with the Model Context Protocol"
        icon={Bot}
        actions={
          <Button asChild variant="secondary" className="cursor-pointer">
            <Link to="/api-keys" className="inline-flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              API keys
            </Link>
          </Button>
        }
      />

      <FeatureGate
        enabled={!isLoading && !pro}
        requiredTier="pro"
        currentTier={tier}
        title="Connect exit1 to AI"
        description="The exit1 MCP server lets AI assistants read your checks, history, and stats. It uses a Public API key, so it's available on the same plans as the API."
        ctaLabel="Upgrade"
      >
        <div className="p-2 sm:p-4 md:p-6">
          <div className="mx-auto max-w-4xl space-y-6">
            {/* Overview */}
            <Card className="border-primary/30 bg-primary/5 backdrop-blur">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" />
                  What is MCP?
                </CardTitle>
                <CardDescription>
                  The{" "}
                  <a
                    href="https://modelcontextprotocol.io"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-primary"
                  >
                    Model Context Protocol
                  </a>{" "}
                  is an open standard for connecting AI assistants to live data. The{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40 text-xs">{PACKAGE}</code>{" "}
                  server exposes your exit1 monitoring data to Claude, Cursor, ChatGPT,
                  and other MCP-compatible tools — so you can ask about uptime in plain
                  language.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <span className="font-medium">Package:</span>{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40 text-xs">npx -y {PACKAGE}</code>
                </div>
                <div>
                  <span className="font-medium">Auth:</span>{" "}
                  <span className="text-muted-foreground">
                    a Public API key in the{" "}
                    <code className="px-1 py-0.5 rounded bg-black/40 text-xs">EXIT1_API_KEY</code>{" "}
                    environment variable. The MCP tools are read-only, so a key with{" "}
                  </span>
                  <Badge variant="outline">checks:read</Badge>{" "}
                  <span className="text-muted-foreground">is enough.</span>
                </div>
                <Alert className="border-primary/30 bg-background/80 backdrop-blur">
                  <KeyRound className="h-4 w-4 text-primary" />
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      <strong className="font-semibold">Need a key?</strong> Create one
                      with read access and paste it into the config below.
                    </span>
                    <Button asChild variant="secondary" className="cursor-pointer shrink-0">
                      <Link to="/api-keys" state={{ intent: "create-api-key" }}>
                        Create API key
                      </Link>
                    </Button>
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>

            {/* Setup */}
            <Card className="border-primary/30 bg-primary/5 backdrop-blur">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5 text-primary" />
                  Set up your client
                </CardTitle>
                <CardDescription>
                  Pick your assistant and drop in the snippet. Replace{" "}
                  <code className="px-1 py-0.5 rounded bg-black/40 text-xs">{KEY_PLACEHOLDER}</code>{" "}
                  with your own key.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue={CLIENTS[0].id}>
                  <TabsList className="flex h-auto flex-wrap justify-start gap-1">
                    {CLIENTS.map((c) => (
                      <TabsTrigger key={c.id} value={c.id} className="cursor-pointer">
                        {c.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {CLIENTS.map((c) => (
                    <TabsContent key={c.id} value={c.id} className="mt-3 space-y-3">
                      <div className="text-sm text-muted-foreground">{c.hint}</div>
                      <CodeBlock code={c.code(KEY_PLACEHOLDER)} copyLabel={c.copyLabel} />
                      {c.footnote && (
                        <div className="text-xs text-muted-foreground">{c.footnote}</div>
                      )}
                    </TabsContent>
                  ))}
                </Tabs>
              </CardContent>
            </Card>

            {/* Tools */}
            <Card className="border-primary/30 bg-primary/5 backdrop-blur">
              <CardHeader>
                <CardTitle>Tools</CardTitle>
                <CardDescription>What the assistant can call once connected.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="w-full overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tool</TableHead>
                        <TableHead>Description</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {TOOLS.map((t) => (
                        <TableRow key={t.name}>
                          <TableCell className="font-mono text-xs whitespace-nowrap">{t.name}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{t.description}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Example prompts */}
            <Card className="border-primary/30 bg-primary/5 backdrop-blur">
              <CardHeader>
                <CardTitle>Try asking</CardTitle>
                <CardDescription>Once connected, talk to your monitors in plain language.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {EXAMPLE_PROMPTS.map((p) => (
                    <li key={p} className="flex items-start gap-2 text-sm">
                      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="text-muted-foreground">&ldquo;{p}&rdquo;</span>
                    </li>
                  ))}
                </ul>
                <Separator className="my-4" />
                <div className="text-xs text-muted-foreground">
                  Full setup details and per-client docs live at{" "}
                  <a
                    href="https://docs.exit1.dev"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:text-primary"
                  >
                    docs.exit1.dev
                  </a>
                  .
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </FeatureGate>
    </PageContainer>
  );
}
