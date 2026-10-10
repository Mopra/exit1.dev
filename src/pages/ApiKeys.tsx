import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  BookOpen,
  Bot,
  ChevronDown,
  Copy,
  Info,
  KeyRound,
  Plus,
  Shield,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { apiClient } from "@/api/client";
import type { ApiKey, ApiKeyAccess, CreateApiKeyResponse } from "@/api/types";
import KeyAccessPicker from "@/components/api-keys/KeyAccessPicker";
import { PageContainer, PageHeader } from "@/components/layout";
import { usePlan } from "@/hooks/usePlan";
import { nextTierWithMore } from "@/lib/subscription";
import { DowngradeBanner, FeatureGate, UpgradeBanner } from "@/components/ui";
import ChecksTableShell from "@/components/check/ChecksTableShell";
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  Checkbox,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui";
import { copyToClipboard } from "@/utils/clipboard";

const dateFmt = (ts?: number | null) => (ts ? new Date(ts).toLocaleString() : "—");

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
// Value is seconds from creation; "never" sends no expiry.
const EXPIRY_OPTIONS = [
  { value: "never", label: "Never", seconds: null },
  { value: "1h", label: "1 hour", seconds: HOUR },
  { value: "8h", label: "8 hours", seconds: 8 * HOUR },
  { value: "24h", label: "24 hours", seconds: DAY },
  { value: "7d", label: "7 days", seconds: 7 * DAY },
  { value: "30d", label: "30 days", seconds: 30 * DAY },
  { value: "90d", label: "90 days", seconds: 90 * DAY },
] as const;
type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]["value"];

const EMPTY_ACCESS: ApiKeyAccess = { checkIds: [], folders: [] };

function accessSummary(access: ApiKeyAccess): string {
  const parts: string[] = [];
  if (access.folders.length) parts.push(`${access.folders.length} ${access.folders.length === 1 ? "folder" : "folders"}`);
  if (access.checkIds.length) parts.push(`${access.checkIds.length} ${access.checkIds.length === 1 ? "check" : "checks"}`);
  return parts.join(", ") || "No checks";
}

const SCOPE_OPTIONS = [
  { value: "checks:read", label: "Read", description: "List and view checks, history, and stats" },
  { value: "checks:write", label: "Write", description: "Create, update, and toggle checks" },
  { value: "checks:delete", label: "Delete", description: "Delete checks" },
  { value: "alerts:read", label: "Read alerts", description: "See which email addresses and webhooks receive alerts" },
  {
    value: "alerts:write",
    label: "Manage alerts",
    description: "Set alert recipients, connect webhooks, and send test alerts",
  },
] as const;

export default function ApiKeys() {
  // API keys (and therefore MCP) are available on EVERY tier, Free included —
  // Free mints one. Read `apiAccess`/`maxApiKeys` off the tier row rather than
  // `paid`, which used to stand in for this and locked Free out entirely.
  const { tier, apiAccess: hasApiAccess, maxApiKeys, isLoading: nanoLoading } = usePlan();
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>(["checks:read"]);
  const [expiry, setExpiry] = React.useState<ExpiryValue>("never");
  const [restricted, setRestricted] = React.useState(false);
  const [access, setAccess] = React.useState<ApiKeyAccess>(EMPTY_ACCESS);
  const [createdKey, setCreatedKey] = React.useState<CreateApiKeyResponse | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [revokeId, setRevokeId] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [isInfoOpen, setIsInfoOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    const res = await apiClient.listApiKeys();
    if (res.success && res.data) setKeys(res.data);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const location = useLocation();
  const navigate = useNavigate();
  React.useEffect(() => {
    const state = location.state as { intent?: string } | null;
    if (state?.intent === 'create-api-key') {
      setCreateOpen(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  async function onCreate() {
    setCreating(true);
    const res = await apiClient.createApiKey(name || "Default", {
      scopes,
      expiresInSeconds: EXPIRY_OPTIONS.find((o) => o.value === expiry)?.seconds ?? null,
      access: restricted ? access : null,
    });
    setCreating(false);
    if (res.success && res.data) {
      setCreatedKey(res.data);
      setCreateOpen(false);
      setName("");
      setScopes(["checks:read"]);
      setExpiry("never");
      setRestricted(false);
      setAccess(EMPTY_ACCESS);
      load();
    } else {
      // A failed create used to be swallowed here, so a blocked request or a
      // backend refusal looked like a dead button. Keep the dialog open and
      // say what happened so the user (and support) can see it.
      toast.error(res.error || "Failed to create API key");
    }
  }

  async function onRevokeConfirm() {
    if (!revokeId) return;
    setRevoking(true);
    const res = await apiClient.revokeApiKey(revokeId);
    setRevoking(false);
    setRevokeId(null);
    if (res.success) load();
  }

  async function onDeleteConfirm() {
    if (!deleteId) return;
    setDeleting(true);
    const res = await apiClient.deleteApiKey(deleteId);
    setDeleting(false);
    setDeleteId(null);
    if (res.success) load();
  }

  async function copyCreatedKey() {
    if (!createdKey) return;
    const ok = await copyToClipboard(createdKey.key);
    if (ok) toast.success("API key copied");
    else toast.error("Copy failed");
  }

  // Ready-to-paste MCP config with the freshly created key inlined. The key is
  // only available right after creation, so this is the one moment we can save
  // the user a round-trip to the MCP setup page.
  const mcpConfig = createdKey
    ? `{
  "mcpServers": {
    "exit1": {
      "command": "npx",
      "args": ["-y", "exit1-mcp"],
      "env": {
        "EXIT1_API_KEY": "${createdKey.key}"
      }
    }
  }
}`
    : "";

  async function copyMcpConfig() {
    if (!mcpConfig) return;
    const ok = await copyToClipboard(mcpConfig);
    if (ok) toast.success("MCP config copied");
    else toast.error("Copy failed");
  }

  const restrictedEmpty = restricted && access.checkIds.length === 0 && access.folders.length === 0;
  // Snapshot "now" once per render for the expired badges.
  const now = Date.now();

  const atLimit = keys.length >= maxApiKeys;
  const hasDowngradedKeys = keys.some((k) => k.disabledReason === 'plan_downgrade');
  const nextApiKeyTier = nextTierWithMore(tier, 'maxApiKeys', maxApiKeys);

  return (
    <PageContainer>
      <PageHeader
        title="API Keys"
        description="Create, revoke, and rotate Public API keys"
        icon={KeyRound}
        actions={
          <div className="flex items-center gap-2">
            {hasApiAccess && (
              <Button
                onClick={() => setCreateOpen(true)}
                className="gap-2 cursor-pointer"
                title={atLimit ? `Limit of ${maxApiKeys} API keys reached` : undefined}
                disabled={atLimit}
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Create API Key</span>
              </Button>
            )}
          </div>
        }
      />

      {/* Every tier can mint API keys today, so this gate is inert — kept so a
          future tier without `apiAccess` degrades to an upsell rather than a
          create button that 403s. */}
      <FeatureGate
        enabled={!nanoLoading && !hasApiAccess && !hasDowngradedKeys}
        requiredTier="indie"
        currentTier={tier}
        title="API Keys"
        description="API keys let you integrate Exit1 monitoring into your own tools and dashboards."
        ctaLabel="Upgrade"
      >
        <div className="space-y-4 sm:space-y-6 p-2 sm:p-4 md:p-6">
          {hasDowngradedKeys && (
            <DowngradeBanner message={`Some API keys were disabled after downgrading — your plan includes ${maxApiKeys} ${maxApiKeys === 1 ? 'key' : 'keys'}.`} />
          )}

          {atLimit && !hasDowngradedKeys && (
            <UpgradeBanner
              message={
                nextApiKeyTier
                  ? `You've reached the maximum of ${maxApiKeys} API ${maxApiKeys === 1 ? 'key' : 'keys'}. Upgrade to ${nextApiKeyTier.name} for up to ${nextApiKeyTier.max}, or revoke a key to free a slot.`
                  : `You've reached the maximum of ${maxApiKeys} API keys. Revoke and delete unused keys to create new ones.`
              }
              ctaLabel="View billing"
              ctaHref="/billing"
            />
          )}

          {createdKey && (
            <Alert className="bg-background/80 border-primary/30 backdrop-blur-md shadow-lg shadow-primary/10">
              <KeyRound className="h-4 w-4 text-primary" />
              <AlertDescription className="flex flex-col gap-3">
                <div>
                  <div className="font-medium text-foreground">API key created</div>
                  <div className="text-sm text-muted-foreground">
                    Copy this key now. You won't be able to see it again.
                    {createdKey.expiresAt ? ` It stops working on ${dateFmt(createdKey.expiresAt)}.` : ""}
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                  <code className="px-2 py-1 rounded bg-muted/60 font-mono text-xs break-all min-w-0 max-w-full">
                    {createdKey.key}
                  </code>
                  <Button
                    size="sm"
                    onClick={copyCreatedKey}
                    className="cursor-pointer shrink-0 gap-1.5"
                  >
                    <Copy className="w-3 h-3" />
                    Copy
                  </Button>
                </div>

                <div className="space-y-2 rounded-md border border-primary/20 bg-background/40 p-3">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Bot className="w-3.5 h-3.5 text-primary" />
                    Use with AI assistants (MCP)
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Paste this into Claude Desktop, Cursor, Windsurf, or any MCP client — your key is already filled in.
                  </div>
                  <pre className="overflow-auto rounded-md border border-primary/20 bg-black/40 p-3 text-xs leading-relaxed text-foreground">
                    <code>{mcpConfig}</code>
                  </pre>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={copyMcpConfig}
                      className="cursor-pointer gap-1.5"
                    >
                      <Copy className="w-3 h-3" />
                      Copy config
                    </Button>
                    <Button asChild size="sm" variant="ghost" className="cursor-pointer gap-1.5">
                      <Link to="/mcp">
                        <Bot className="w-3 h-3" />
                        More setup options
                      </Link>
                    </Button>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <Card className="bg-background/80 border-primary/30 backdrop-blur-md shadow-lg shadow-primary/10">
            <Collapsible open={isInfoOpen} onOpenChange={setIsInfoOpen}>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-primary/5 transition-colors">
                  <CardTitle className="flex items-center justify-between text-base font-semibold">
                    <span className="flex items-center gap-2">
                      <Info className="w-4 h-4 text-primary" />
                      Rate limits & security
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 text-primary transition-transform ${isInfoOpen ? 'rotate-180' : ''}`}
                    />
                  </CardTitle>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="text-sm text-foreground/90 space-y-4">
                  <CardDescription>
                    What to expect when you put a key into production.
                  </CardDescription>
                  <div className="grid gap-6 sm:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Per-minute limits
                      </div>
                      <ul className="list-disc pl-4 space-y-1 text-slate-100/80">
                        <li>Pre-auth (per IP): 20 requests/minute</li>
                        <li>Per API key: 5 requests/minute</li>
                        <li>Per endpoint: 1 request/minute</li>
                      </ul>
                      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground pt-2">
                        Daily quotas
                      </div>
                      <ul className="list-disc pl-4 space-y-1 text-slate-100/80">
                        <li>Per API key: 500 requests/day</li>
                        <li>Per user (all keys): 2,000 requests/day</li>
                      </ul>
                      <p className="text-xs text-muted-foreground pt-1">
                        Exceeding limits returns a 429 status with Retry-After headers.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Security tips
                      </div>
                      <ul className="list-disc pl-4 space-y-1 text-slate-100/80">
                        <li>Rotate keys when team members change.</li>
                        <li>Keep keys in server-side secrets, never in client code.</li>
                        <li>Revoke unused keys to reduce exposure.</li>
                        <li>Scope keys narrowly — grant only the permissions a service needs.</li>
                      </ul>
                      <div className="flex flex-wrap gap-2 pt-2">
                        <Button asChild variant="outline" size="sm" className="cursor-pointer gap-2">
                          <Link to="/api">
                            <BookOpen className="w-3 h-3" />
                            Open API docs
                          </Link>
                        </Button>
                        <Button asChild variant="outline" size="sm" className="cursor-pointer gap-2">
                          <Link to="/mcp">
                            <Bot className="w-3 h-3" />
                            Set up MCP
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
          </Card>

          <Card className="border-0">
            <CardHeader className="pt-4 pb-4 px-0">
              <CardTitle>API keys</CardTitle>
              <CardDescription>
                Keys grant access to checks, history, and stats based on their scopes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pb-4 px-0">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="text-sm text-muted-foreground">
                  {keys.length} / {maxApiKeys} {keys.length === 1 ? 'key' : 'keys'}
                </div>
              </div>

              <ChecksTableShell
                minWidthClassName="min-w-[900px]"
                hasRows={keys.length > 0}
                emptyState={
                  <div className="text-center py-8">
                    <div className="flex flex-col items-center gap-3">
                      <KeyRound className="w-8 h-8 text-muted-foreground/40" />
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          {loading ? "Loading API keys..." : "No API keys yet"}
                        </div>
                        {!loading && (
                          <div className="text-xs text-muted-foreground">
                            Create your first key to start integrating with the API.
                          </div>
                        )}
                      </div>
                      {!loading && hasApiAccess && (
                        <Button
                          size="sm"
                          onClick={() => setCreateOpen(true)}
                          className="gap-2 cursor-pointer mt-1"
                          disabled={atLimit}
                        >
                          <Plus className="w-3 h-3" />
                          Create API Key
                        </Button>
                      )}
                    </div>
                  </div>
                }
                table={
                  <Table>
                    <TableHeader className="bg-muted border-b">
                      <TableRow>
                        <TableHead className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Name</TableHead>
                        <TableHead className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Key</TableHead>
                        <TableHead className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Scopes</TableHead>
                        <TableHead className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Access</TableHead>
                        <TableHead className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Created</TableHead>
                        <TableHead className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Last used</TableHead>
                        <TableHead className="px-4 py-3 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Status</TableHead>
                        <TableHead className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {keys.map((k) => (
                        <TableRow key={k.id}>
                          <TableCell className="px-4 py-3 font-medium">{k.name || "—"}</TableCell>
                          <TableCell className="px-4 py-3">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="font-mono text-xs cursor-help text-muted-foreground">
                                  {k.prefix}…{k.last4}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <span>Only shown as prefix/last4 for security.</span>
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell className="px-4 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              {(k.scopes && k.scopes.length > 0 ? k.scopes : ["checks:read"]).map((s) => {
                                // Scopes are "<group>:<action>". Checks are the
                                // common case so they show bare ("write"); other
                                // groups keep their prefix ("alerts write") so
                                // two different writes can't be confused.
                                const [group, action = ""] = s.split(":");
                                const label = group === "checks" ? action : `${group} ${action}`;
                                const variant: "outline" | "default" | "destructive" =
                                  action === "delete" ? "destructive"
                                  : action === "write" ? "default"
                                  : "outline";
                                return (
                                  <Badge key={s} variant={variant} className="capitalize">
                                    {label}
                                  </Badge>
                                );
                              })}
                            </div>
                          </TableCell>
                          <TableCell className="px-4 py-3 text-xs whitespace-nowrap">
                            {k.access ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help">{accessSummary(k.access)}</span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <div className="space-y-1">
                                    {k.access.folders.map((f) => <div key={f}>Folder: {f}</div>)}
                                    {k.access.checkIds.length > 0 && (
                                      <div>{k.access.checkIds.length} individual {k.access.checkIds.length === 1 ? "check" : "checks"}</div>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-muted-foreground">All checks</span>
                            )}
                          </TableCell>
                          <TableCell className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{dateFmt(k.createdAt)}</TableCell>
                          <TableCell className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{dateFmt(k.lastUsedAt ?? null)}</TableCell>
                          <TableCell className="px-4 py-3">
                            {!k.enabled ? (
                              k.disabledReason === 'plan_downgrade' ? (
                                <Badge variant="secondary">Disabled</Badge>
                              ) : (
                                <Badge variant="destructive">Revoked</Badge>
                              )
                            ) : k.expiresAt && k.expiresAt <= now ? (
                              <Badge variant="secondary">Expired</Badge>
                            ) : (
                              <Badge variant="success">Enabled</Badge>
                            )}
                            {k.enabled && k.expiresAt && k.expiresAt > now && (
                              <div className="mt-1 text-[11px] text-muted-foreground whitespace-nowrap">
                                Expires {dateFmt(k.expiresAt)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="px-4 py-3 text-right">
                            {k.enabled ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRevokeId(k.id)}
                                className="cursor-pointer text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
                              >
                                <Shield className="w-3 h-3" />
                                Revoke
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setDeleteId(k.id)}
                                className="cursor-pointer text-muted-foreground hover:text-foreground gap-1.5"
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                }
              />
            </CardContent>
          </Card>
        </div>

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Give this key a name, choose its permissions, and optionally limit how long and on what it works.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Backend server"
                />
              </div>
              <div className="space-y-3">
                <Label className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5" />
                  Permissions
                </Label>
                <div className="space-y-2">
                  {SCOPE_OPTIONS.map((scope) => {
                    const checked = scopes.includes(scope.value);
                    const isRead = scope.value === "checks:read";
                    return (
                      <label
                        key={scope.value}
                        className="flex items-start gap-3 cursor-pointer rounded-md border border-border/50 p-3 hover:bg-muted/40 transition-colors"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={isRead}
                          onCheckedChange={(v) => {
                            if (isRead) return;
                            setScopes((prev) =>
                              v
                                ? [...prev, scope.value]
                                : prev.filter((s) => s !== scope.value)
                            );
                          }}
                          className="mt-0.5"
                        />
                        <div className="space-y-0.5 min-w-0">
                          <div className="text-sm font-medium leading-none flex items-center gap-2">
                            {scope.label}
                            {isRead && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                Always on
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{scope.description}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="key-expiry">Expires</Label>
                <Select value={expiry} onValueChange={(v) => setExpiry(v as ExpiryValue)}>
                  <SelectTrigger id="key-expiry" className="w-full cursor-pointer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="cursor-pointer">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  A short expiry suits a key you hand to an AI tool or a one-off script.
                </p>
              </div>
              <div className="space-y-3">
                <Label>Access</Label>
                <RadioGroup
                  value={restricted ? "selected" : "all"}
                  onValueChange={(v) => setRestricted(v === "selected")}
                  className="gap-2"
                >
                  <label className="flex items-center gap-3 cursor-pointer text-sm">
                    <RadioGroupItem value="all" />
                    All checks
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer text-sm">
                    <RadioGroupItem value="selected" />
                    Only selected checks and folders
                  </label>
                </RadioGroup>
                {restricted && <KeyAccessPicker value={access} onChange={setAccess} />}
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCreateOpen(false)}
                className="cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                onClick={onCreate}
                disabled={creating || restrictedEmpty}
                title={restrictedEmpty ? "Select at least one check or folder" : undefined}
                className="cursor-pointer"
              >
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={!!revokeId}
          onOpenChange={(open) => {
            if (!open) setRevokeId(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
              <AlertDialogDescription>
                This key will stop working immediately. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="cursor-pointer" disabled={revoking}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={onRevokeConfirm}
                className="cursor-pointer"
                disabled={revoking}
              >
                {revoking ? "Revoking..." : "Revoke"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={!!deleteId}
          onOpenChange={(open) => {
            if (!open) setDeleteId(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete API key?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the revoked key record. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="cursor-pointer" disabled={deleting}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={onDeleteConfirm}
                className="cursor-pointer"
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </FeatureGate>
    </PageContainer>
  );
}
