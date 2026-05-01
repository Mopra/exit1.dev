import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  BookOpen,
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
import type { ApiKey, CreateApiKeyResponse } from "@/api/types";
import { PageContainer, PageHeader, DocsLink } from "@/components/layout";
import { usePlan } from "@/hooks/usePlan";
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

const MAX_API_KEYS = 5;

const SCOPE_OPTIONS = [
  { value: "checks:read", label: "Read", description: "List and view checks, history, and stats" },
  { value: "checks:write", label: "Write", description: "Create, update, and toggle checks" },
  { value: "checks:delete", label: "Delete", description: "Delete checks" },
] as const;

export default function ApiKeys() {
  const { tier, pro, isLoading: nanoLoading } = usePlan();
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>(["checks:read"]);
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
    const res = await apiClient.createApiKey(name || "Default", scopes);
    setCreating(false);
    if (res.success && res.data) {
      setCreatedKey(res.data);
      setCreateOpen(false);
      setName("");
      setScopes(["checks:read"]);
      load();
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

  const atLimit = keys.length >= MAX_API_KEYS;
  const hasDowngradedKeys = keys.some((k) => k.disabledReason === 'plan_downgrade');

  return (
    <PageContainer>
      <PageHeader
        title="API Keys"
        description="Create, revoke, and rotate Public API keys"
        icon={KeyRound}
        actions={
          <div className="flex items-center gap-2">
            <DocsLink path="/api-reference/authentication" label="API authentication docs" />
            {pro && (
              <Button
                onClick={() => setCreateOpen(true)}
                className="gap-2 cursor-pointer"
                title={atLimit ? `Limit of ${MAX_API_KEYS} API keys reached` : undefined}
                disabled={atLimit}
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Create API Key</span>
              </Button>
            )}
          </div>
        }
      />

      <FeatureGate
        enabled={!nanoLoading && !pro && !hasDowngradedKeys}
        requiredTier="pro"
        currentTier={tier}
        title="API Keys"
        description="API keys let you integrate Exit1 monitoring into your own tools and dashboards. Upgrade to Pro to create API keys."
        ctaLabel="Upgrade to Pro"
      >
        <div className="space-y-4 sm:space-y-6 p-2 sm:p-4 md:p-6">
          {hasDowngradedKeys && !pro && (
            <DowngradeBanner message="All API keys were disabled after downgrading. API keys require a Pro subscription." />
          )}

          {atLimit && !hasDowngradedKeys && (
            <UpgradeBanner
              message={`You've reached the maximum of ${MAX_API_KEYS} API keys. Revoke and delete unused keys to create new ones.`}
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
                      <div className="pt-2">
                        <Button asChild variant="outline" size="sm" className="cursor-pointer gap-2">
                          <Link to="/api">
                            <BookOpen className="w-3 h-3" />
                            Open API docs
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
                  {keys.length} / {MAX_API_KEYS} {keys.length === 1 ? 'key' : 'keys'}
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
                      {!loading && pro && (
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
                                const label = s.replace("checks:", "");
                                const variant: "outline" | "default" | "destructive" =
                                  label === "delete" ? "destructive"
                                  : label === "write" ? "default"
                                  : "outline";
                                return (
                                  <Badge key={s} variant={variant} className="capitalize">
                                    {label}
                                  </Badge>
                                );
                              })}
                            </div>
                          </TableCell>
                          <TableCell className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{dateFmt(k.createdAt)}</TableCell>
                          <TableCell className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{dateFmt(k.lastUsedAt ?? null)}</TableCell>
                          <TableCell className="px-4 py-3">
                            {k.enabled ? (
                              <Badge variant="success">Enabled</Badge>
                            ) : k.disabledReason === 'plan_downgrade' ? (
                              <Badge variant="secondary">Disabled</Badge>
                            ) : (
                              <Badge variant="destructive">Revoked</Badge>
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Give this key a name and choose its permissions.
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
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCreateOpen(false)}
                className="cursor-pointer"
              >
                Cancel
              </Button>
              <Button onClick={onCreate} disabled={creating} className="cursor-pointer">
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
