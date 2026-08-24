import * as React from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Plug,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";

import { PageContainer, PageHeader } from "@/components/layout";
import { usePlan } from "@/hooks/usePlan";
import { FeatureGate } from "@/components/ui";
import { apiClient } from "@/api/client";
import type { McpConnection } from "@/api/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmationModal,
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
import { trackEvent } from "@/lib/analytics";

// The hosted endpoint and npm package are the contract with MCP clients. Keep
// these in sync with mcp/README.md and functions/src/mcp-oauth.ts.
const REMOTE_URL = "https://app.exit1.dev/mcp/v1";
const PACKAGE = "exit1-mcp";
const KEY_PLACEHOLDER = "ek_live_your_key_here";

const INLINE_CODE = "px-1 py-0.5 rounded bg-muted text-xs";
const PATH_CODE = `${INLINE_CODE} break-all`;

/** The prompt from the marketing hero. Kept identical so both surfaces teach the same flow. */
const SETUP_PROMPT = `Set up uptime monitoring for this project with Exit1.

1. Check whether the Exit1 tools (get_account, list_checks, create_check) are
   available to you. If they are, go to step 2.

   If they are not, do NOT try to connect from inside this session, and do not
   improvise with the raw API. Most AI tools load MCP servers only at startup
   and cannot open a browser sign-in mid-conversation, so a server added now
   stays unusable until I restart. Instead:
     - In Claude Code: run
         claude mcp add --transport http exit1 ${REMOTE_URL}
       then tell me to quit, run \`claude mcp login exit1\` in my terminal (my
       browser opens to sign in or sign up), and resume you with
       \`claude --continue\`. If my version has no \`mcp login\`, I
       authenticate via /mcp after restarting instead.
     - In other tools: tell me to add the HTTP MCP server
       ${REMOTE_URL} the way my tool does it, restart it, and
       paste this prompt again.
   While you wait, do step 3 now and show me the checks you intend to create,
   so my first message after reconnecting can be "go".

2. Call get_account to see my plan limits, and list_checks to see what's
   already monitored.

3. Work out what's worth monitoring by reading this project. Don't ask me for
   URLs you can find yourself. Depending on the stack, look at deploy and
   infra config, environment files and examples, the README, DNS or domain
   config, container healthchecks, CI/CD workflows, and route or endpoint
   definitions. You're looking for:
     - the production site or app, and staging if there is one
     - health/status endpoints (these are the most valuable; assert on the
       response body, not just a 200, since a 200 with a dead database is
       still a 200)
     - public APIs and webhook receivers other systems depend on
     - scheduled jobs and workers (monitor these as heartbeats)
     - the apex domain, for SSL and registration expiry
   If this project has no deployed URL you can find, ask me for it.

4. Ask me two things in one go: which email address should receive alerts,
   and whether to add a Slack/Discord webhook. Then show me the checks you
   intend to create as one short list and create them when I confirm.

5. Send a test alert to every channel you set up and tell me to check it
   arrived. Don't leave a channel configured but untested.

Be fast and autonomous. Never put API keys, tokens or passwords into a check.
Prefer a few meaningful checks over many shallow ones.`;

function CodeBlock({
  code,
  copyText,
  className,
  copyLabel = "Copy",
  track,
}: {
  code: string;
  /** Clipboard payload when it must differ from the displayed code. */
  copyText?: string;
  className?: string;
  copyLabel?: string;
  /**
   * Identifies which snippet was copied. Copying a setup command is the
   * strongest intent signal we get short of a completed OAuth grant, and it is
   * the step where the funnel most likely leaks — a user who copies but never
   * connects hit a problem in their client, not on this page.
   */
  track?: { transport: string; client: string };
}) {
  const [copied, setCopied] = React.useState(false);

  async function onCopy() {
    const ok = await copyToClipboard(copyText ?? code);
    setCopied(ok);
    if (ok && track) trackEvent("mcp_setup_copied", track);
    window.setTimeout(() => setCopied(false), 900);
  }

  return (
    <div className={cn("rounded-lg border border-border/60 bg-muted/30", className)}>
      <div className="flex items-center justify-end gap-2 border-b border-border/60 px-3 py-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={onCopy}
          aria-label={copied ? "Copied" : copyLabel}
          className="h-9 sm:h-7 gap-1 px-2.5 sm:px-2 cursor-pointer"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied ? "Copied" : copyLabel}
        </Button>
        <span aria-live="polite" className="sr-only">
          {copied ? "Copied to clipboard" : ""}
        </span>
      </div>
      <pre className="overflow-auto p-3 text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── Hosted client snippets ──

const remoteJson = `{
  "mcpServers": {
    "exit1": {
      "type": "http",
      "url": "${REMOTE_URL}"
    }
  }
}`;

type Client = {
  id: string;
  label: string;
  hint: React.ReactNode;
  code: string;
  /** Clipboard payload when it must differ from the displayed code (e.g. a trailing newline). */
  copyText?: string;
  copyLabel?: string;
};

const REMOTE_CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "One paste, before starting a session. The login opens your browser to sign in (or sign up). Then start claude and paste the prompt.",
    // One line chained with && on purpose: pasting two lines into cmd.exe lets
    // the first command's process swallow the second line from console input,
    // so the login silently never runs. The trailing newline in copyText makes
    // the one-liner execute on paste. Old Windows PowerShell (5.1) rejects &&;
    // those users run the halves separately.
    code: `claude mcp add --transport http exit1 ${REMOTE_URL} && claude mcp login exit1`,
    copyText: `claude mcp add --transport http exit1 ${REMOTE_URL} && claude mcp login exit1\n`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    hint: (
      <>
        Add to <code className={PATH_CODE}>%APPDATA%\Claude\claude_desktop_config.json</code>{" "}
        (Windows) or{" "}
        <code className={PATH_CODE}>
          ~/Library/Application Support/Claude/claude_desktop_config.json
        </code>{" "}
        (macOS), then restart.
      </>
    ),
    code: remoteJson,
    copyLabel: "Copy JSON",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: (
      <>
        Add to <code className={INLINE_CODE}>.cursor/mcp.json</code> in your project (or{" "}
        <code className={INLINE_CODE}>~/.cursor/mcp.json</code> globally).
      </>
    ),
    code: remoteJson,
    copyLabel: "Copy JSON",
  },
  {
    id: "vscode",
    label: "VS Code",
    hint: (
      <>
        Run <span className="font-medium text-foreground">MCP: Add Server</span> from the
        Command Palette and choose <span className="font-medium text-foreground">HTTP</span>, or
        add this to <code className={INLINE_CODE}>.vscode/mcp.json</code> using a{" "}
        <code className={INLINE_CODE}>servers</code> key.
      </>
    ),
    code: `{
  "servers": {
    "exit1": {
      "type": "http",
      "url": "${REMOTE_URL}"
    }
  }
}`,
    copyLabel: "Copy JSON",
  },
];

// ── Local (API key) snippets ──

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

const LOCAL_CLIENTS: Client[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Add the server, then export your key in the shell that launches Claude Code.",
    code: `claude mcp add exit1 -- npx -y ${PACKAGE}\n\nexport EXIT1_API_KEY="${KEY_PLACEHOLDER}"\nclaude`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    hint: "Add the server, then export your key before starting Codex.",
    code: `codex mcp add exit1 -- npx -y ${PACKAGE}\n\nexport EXIT1_API_KEY="${KEY_PLACEHOLDER}"\ncodex`,
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: (
      <>
        Add to <code className={INLINE_CODE}>.cursor/mcp.json</code> in your project (or{" "}
        <code className={INLINE_CODE}>~/.cursor/mcp.json</code> globally).
      </>
    ),
    code: jsonMcpServers(KEY_PLACEHOLDER),
    copyLabel: "Copy JSON",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    hint: (
      <>
        Add to your <code className={INLINE_CODE}>mcp_config.json</code> (Windsurf settings
        &rsaquo; MCP).
      </>
    ),
    code: jsonMcpServers(KEY_PLACEHOLDER),
    copyLabel: "Copy JSON",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    hint: (
      <>
        Add to <code className={INLINE_CODE}>~/.gemini/settings.json</code>, then restart your
        IDE or CLI.
      </>
    ),
    code: jsonMcpServers(KEY_PLACEHOLDER),
    copyLabel: "Copy JSON",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    hint: (
      <>
        ChatGPT connects to stdio servers through a bridge. Expose{" "}
        <code className={INLINE_CODE}>{PACKAGE}</code> with{" "}
        <code className={INLINE_CODE}>mcp-remote</code>, then add it under{" "}
        <span className="font-medium text-foreground">Settings &rsaquo; Connectors</span>.
      </>
    ),
    code: `EXIT1_API_KEY="${KEY_PLACEHOLDER}" npx -y mcp-remote npx -y ${PACKAGE}`,
  },
];

type Tool = { name: string; scope: string; description: string };

const TOOLS: Tool[] = [
  { name: "get_account", scope: "checks:read", description: "Plan, limits and current usage. The assistant calls this first when setting things up." },
  { name: "list_checks", scope: "checks:read", description: "List all checks with current status." },
  { name: "get_check", scope: "checks:read", description: "Detail for one check — status, response time, SSL, maintenance." },
  { name: "get_check_history", scope: "checks:read", description: "Historical results with timestamps, status codes, and errors." },
  { name: "get_check_stats", scope: "checks:read", description: "Uptime % and response-time stats over ranges (1d, 7d, 30d, …)." },
  { name: "get_status_page", scope: "checks:read", description: "Current snapshot of a public status page." },
  { name: "create_check", scope: "checks:write", description: "Create a monitor — website, API endpoint, ping, TCP, DNS, domain or heartbeat." },
  { name: "update_check", scope: "checks:write", description: "Change an existing check's settings." },
  { name: "toggle_check", scope: "checks:write", description: "Pause or resume a check without deleting it." },
  { name: "delete_check", scope: "checks:delete", description: "Permanently remove a check. Not granted by default." },
  { name: "get_alert_settings", scope: "alerts:read", description: "See which email addresses and webhooks receive alerts." },
  { name: "set_email_alerts", scope: "alerts:write", description: "Set alert recipients and which events trigger them." },
  { name: "add_webhook_alert", scope: "alerts:write", description: "Connect Slack, Discord, Teams or a generic webhook." },
  { name: "send_test_alert", scope: "alerts:write", description: "Fire a real test alert to prove delivery works." },
];

const EXAMPLE_PROMPTS = [
  "Set up monitoring for this project.",
  "Are any of my monitors down right now?",
  "What's the uptime for my API check over the last 30 days?",
  "Add a check on staging.example.com and alert #ops in Slack.",
  "Show me the last 10 failures for production.",
];

function dateFmt(ts: number | null): string {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

/** Connected AI tools, with per-connection revoke. */
function ConnectionsCard() {
  const [connections, setConnections] = React.useState<McpConnection[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<McpConnection | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const result = await apiClient.listMcpConnections();
    if (result.success && result.data) {
      setConnections(result.data);
      setError(null);
    } else {
      setConnections([]);
      setError(result.error || "Failed to load connections");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function confirmRevoke() {
    if (!revoking) return;
    setBusy(true);
    const result = await apiClient.revokeMcpConnection(revoking.clientId);
    setBusy(false);
    setRevoking(null);
    if (result.success) {
      void load();
    } else {
      setError(result.error || "Failed to revoke the connection");
    }
  }

  return (
    <>
      <Card className="bg-card border-0 shadow-lg">
        <CardHeader className="p-4 sm:p-6 lg:p-8">
          <CardTitle className="text-xl flex items-center gap-2">
            <Plug className="h-5 w-5 text-primary" />
            Connected tools
          </CardTitle>
          <CardDescription>
            AI tools you&rsquo;ve authorized. Revoking one immediately invalidates every token
            issued to it.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertTitle>Couldn&rsquo;t load connections</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {connections === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading&hellip;
            </div>
          ) : connections.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              Nothing connected yet. Run the command below in your AI tool and approve the
              browser prompt.
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted border-b">
                  <TableRow>
                    <TableHead scope="col" className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Tool
                    </TableHead>
                    <TableHead scope="col" className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Access
                    </TableHead>
                    <TableHead scope="col" className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Connected
                    </TableHead>
                    <TableHead scope="col" className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Last used
                    </TableHead>
                    <TableHead scope="col" className="px-4 py-3" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((c) => (
                    <TableRow key={c.clientId}>
                      <TableCell className="px-4 py-3 text-sm font-medium whitespace-nowrap">
                        {c.clientName}
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {c.scopes.map((s) => {
                            const [group, action = ""] = s.split(":");
                            const label = group === "checks" ? action : `${group} ${action}`;
                            return (
                              <Badge
                                key={s}
                                variant={action === "delete" ? "destructive" : action === "write" ? "default" : "outline"}
                                className="capitalize"
                              >
                                {label}
                              </Badge>
                            );
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {dateFmt(c.createdAt)}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {dateFmt(c.lastUsedAt)}
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevoking(c)}
                          className="cursor-pointer text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
                        >
                          <Trash2 className="w-3 h-3" />
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmationModal
        isOpen={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={confirmRevoke}
        title="Revoke this connection?"
        message={`${revoking?.clientName ?? "This tool"} will lose access immediately and will have to reconnect through your browser. Your checks and alerts are not affected.`}
        confirmText={busy ? "Revoking…" : "Revoke"}
        variant="destructive"
      />
    </>
  );
}

export default function Mcp() {
  // The stdio path needs an API key, which every tier can mint (Free included).
  // The hosted OAuth path is intentionally not gated either: it IS the signup
  // flow for agent-first users, and everything an agent can do is still bounded
  // by the tier limits the REST API enforces on every call.
  const { tier, apiAccess: hasApiAccess, isLoading } = usePlan();

  // Top of the MCP funnel. Without this we can only see completed grants, which
  // cannot distinguish "nobody finds this page" from "people find it and bounce"
  // — two different problems with two different fixes.
  React.useEffect(() => {
    trackEvent("mcp_page_viewed", { tier });
  }, [tier]);

  return (
    <PageContainer>
      <PageHeader
        title="MCP"
        description="Let your AI assistant set up and read your monitoring"
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

      <div className="flex-1 w-full">
        <div className="w-full mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 space-y-6">
          {/* Connect */}
          <Card className="bg-card border-0 shadow-lg">
            <CardHeader className="p-4 sm:p-6 lg:p-8">
              <CardTitle className="text-xl flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Connect in one command
              </CardTitle>
              <CardDescription>
                The hosted server signs you in through your browser — no API key to create, copy
                or rotate. Your assistant can then read your monitors, create new ones, and set up
                alerts.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-4">
              <Tabs defaultValue={REMOTE_CLIENTS[0].id}>
                <TabsList className="mb-4">
                  {REMOTE_CLIENTS.map((c) => (
                    <TabsTrigger key={c.id} value={c.id} className="cursor-pointer shrink-0 sm:flex-none">
                      {c.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {REMOTE_CLIENTS.map((c) => (
                  <TabsContent key={c.id} value={c.id} className="space-y-3">
                    <div className="text-sm text-muted-foreground">{c.hint}</div>
                    <CodeBlock
                      code={c.code}
                      copyText={c.copyText}
                      copyLabel={c.copyLabel}
                      track={{ transport: "hosted", client: c.id }}
                    />
                  </TabsContent>
                ))}
              </Tabs>
              <div className="text-xs text-muted-foreground">
                Remote MCP with OAuth is still rolling out across clients. If yours doesn&rsquo;t
                support it yet, use the API-key setup further down — same tools.
              </div>
            </CardContent>
          </Card>

          {/* The prompt */}
          <Card className="bg-card border-0 shadow-lg">
            <CardHeader className="p-4 sm:p-6 lg:p-8">
              <CardTitle className="text-xl flex items-center gap-2">
                <Terminal className="h-5 w-5 text-primary" />
                Set up monitoring from your editor
              </CardTitle>
              <CardDescription>
                Connect the server first (above), then paste this into your assistant from inside
                your project. It reads the repo, works out what should be monitored, and finishes
                by sending you a real test alert.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-3">
              <CodeBlock
                code={SETUP_PROMPT}
                copyLabel="Copy prompt"
                track={{ transport: "prompt", client: "setup_monitoring" }}
              />
              <div className="text-xs text-muted-foreground">
                Once connected, the same playbook is available as a built-in prompt —{" "}
                <code className={INLINE_CODE}>/exit1:setup_monitoring</code> in Claude Code.
              </div>
            </CardContent>
          </Card>

          <ConnectionsCard />

          {/* Tools */}
          <Card className="bg-card border-0 shadow-lg">
            <CardHeader className="p-4 sm:p-6 lg:p-8">
              <CardTitle className="text-xl">Tools</CardTitle>
              <CardDescription>
                What the assistant can call once connected. Delete access is never granted by
                default — a client has to ask for it, and you have to approve it.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
              <div className="w-full overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted border-b">
                    <TableRow>
                      <TableHead scope="col" className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                        Tool
                      </TableHead>
                      <TableHead scope="col" className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                        Scope
                      </TableHead>
                      <TableHead scope="col" className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                        Description
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {TOOLS.map((t) => (
                      <TableRow key={t.name}>
                        <TableCell className="px-4 py-3 align-top font-mono text-xs whitespace-nowrap">{t.name}</TableCell>
                        <TableCell className="px-4 py-3 align-top font-mono text-xs whitespace-nowrap text-muted-foreground">{t.scope}</TableCell>
                        <TableCell className="px-4 py-3 align-top text-xs text-muted-foreground whitespace-normal break-words min-w-[12rem] sm:min-w-0">{t.description}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* API key path */}
          <Card className="bg-card border-0 shadow-lg">
            <CardHeader className="p-4 sm:p-6 lg:p-8">
              <CardTitle className="text-xl flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-primary" />
                Connect with an API key
              </CardTitle>
              <CardDescription>
                For clients that don&rsquo;t support remote MCP servers yet. Runs the{" "}
                <code className={INLINE_CODE}>{PACKAGE}</code> package locally over stdio.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
              <FeatureGate
                enabled={!isLoading && !hasApiAccess}
                requiredTier="indie"
                currentTier={tier}
                title="API keys are unavailable on your plan"
                description="The local setup authenticates with a Public API key. The hosted setup above works without one."
                ctaLabel="Upgrade"
              >
                <div className="space-y-4">
                  <Alert className="border-primary/20 bg-primary/10">
                    <KeyRound className="h-4 w-4 text-primary" />
                    <AlertTitle>Grant the right scopes</AlertTitle>
                    <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <span>
                        Creating checks needs <code className={INLINE_CODE}>checks:write</code>;
                        configuring and testing alerts needs{" "}
                        <code className={INLINE_CODE}>alerts:write</code>.
                      </span>
                      <Button asChild variant="secondary" className="cursor-pointer shrink-0 w-full sm:w-auto">
                        <Link to="/api-keys" state={{ intent: "create-api-key" }}>
                          Create API key
                        </Link>
                      </Button>
                    </AlertDescription>
                  </Alert>

                  <Tabs defaultValue={LOCAL_CLIENTS[0].id}>
                    <TabsList className="mb-4">
                      {LOCAL_CLIENTS.map((c) => (
                        <TabsTrigger key={c.id} value={c.id} className="cursor-pointer shrink-0 sm:flex-none">
                          {c.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    {LOCAL_CLIENTS.map((c) => (
                      <TabsContent key={c.id} value={c.id} className="space-y-3">
                        <div className="text-sm text-muted-foreground">{c.hint}</div>
                        <CodeBlock
                          code={c.code}
                          copyLabel={c.copyLabel}
                          track={{ transport: "stdio", client: c.id }}
                        />
                      </TabsContent>
                    ))}
                  </Tabs>
                </div>
              </FeatureGate>
            </CardContent>
          </Card>

          {/* Example prompts */}
          <Card className="bg-card border-0 shadow-lg">
            <CardHeader className="p-4 sm:p-6 lg:p-8">
              <CardTitle className="text-xl">Try asking</CardTitle>
              <CardDescription>Talk to your monitors in plain language.</CardDescription>
            </CardHeader>
            <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
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
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-primary"
                >
                  docs.exit1.dev
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                .
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
