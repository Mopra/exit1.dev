import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BookOpen, Info, KeyRound, Shield } from "lucide-react";

import { apiClient } from "@/api/client";
import type { ApiKey, CreateApiKeyResponse } from "@/api/types";
import { PageContainer, PageHeader, DocsLink } from "@/components/layout";
import { usePlan } from "@/hooks/usePlan";
import { DowngradeBanner, FeatureGate } from "@/components/ui";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

const dateFmt = (ts?: number | null) => (ts ? new Date(ts).toLocaleString() : "-");

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
    if (!ok) alert("Copy failed");
  }

  const atLimit = keys.length >= MAX_API_KEYS;
  const hasDowngradedKeys = keys.some((k) => k.disabledReason === 'plan_downgrade');

  return (
    <PageContainer className="overflow-visible">
      <PageHeader
        title="API keys"
        description="Create, revoke, and rotate Public API keys."
        icon={KeyRound}
        actions={
          pro ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground hidden sm:inline">{keys.length} / {MAX_API_KEYS} keys</span>
            <span className="hidden sm:inline"><DocsLink path="/api-reference/authentication" label="API authentication docs" /></span>
            <Button asChild variant="outline" className="cursor-pointer hidden sm:inline-flex">
              <Link to="/api" className="inline-flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                API docs
              </Link>
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button className="cursor-pointer" size="sm" disabled={atLimit}>Create API key</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create API key</DialogTitle>
                  <DialogDescription>Give this key a name to identify its usage.</DialogDescription>
                </DialogHeader>
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
                  {SCOPE_OPTIONS.map((scope) => {
                    const checked = scopes.includes(scope.value);
                    const isRead = scope.value === "checks:read";
                    return (
                      <label
                        key={scope.value}
                        className="flex items-start gap-3 cursor-pointer"
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
                        />
                        <div className="space-y-0.5">
                          <div className="text-sm font-medium leading-none">{scope.label}</div>
                          <div className="text-xs text-muted-foreground">{scope.description}</div>
                        </div>
                      </label>
                    );
                  })}
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
          </div>
          ) : undefined
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
      <div className="p-2 sm:p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {hasDowngradedKeys && !pro && (
            <DowngradeBanner message="All API keys were disabled after downgrading. API keys require a Pro subscription." />
          )}
          <div className="grid gap-4 sm:gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="border-sky-500/30 bg-sky-500/5 backdrop-blur">
              <CardHeader>
                <CardTitle>Manage keys</CardTitle>
                <CardDescription>Keys grant access to checks, history, and stats based on their scopes.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {atLimit && (
                  <Alert className="border-amber-500/30 bg-amber-500/10 backdrop-blur">
                    <Info className="h-4 w-4 text-amber-200" />
                    <AlertDescription className="text-sm">
                      You&apos;ve reached the maximum of {MAX_API_KEYS} API keys. Revoke and delete unused keys to create new ones.
                    </AlertDescription>
                  </Alert>
                )}
                {createdKey && (
                  <Alert className="bg-sky-950/40 backdrop-blur border-sky-500/30">
                    <AlertDescription className="flex flex-col gap-3">
                      <div className="font-medium">API key created</div>
                      <div className="text-sm">Copy this key now. You won&apos;t be able to see it again.</div>
                      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                        <code className="px-2 py-1 rounded bg-black/40 font-mono text-xs break-all min-w-0 max-w-full">
                          {createdKey.key}
                        </code>
                        <Button size="sm" onClick={copyCreatedKey} className="cursor-pointer shrink-0">
                          Copy
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

                    <div className="w-full overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Key</TableHead>
                            <TableHead>Scopes</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead>Last used</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {keys.map((k) => (
                            <TableRow key={k.id}>
                              <TableCell>{k.name || "-"}</TableCell>
                              <TableCell>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="font-mono text-xs cursor-pointer">
                                      {k.prefix}…{k.last4}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <span>Only shown as prefix/last4 for security.</span>
                                  </TooltipContent>
                                </Tooltip>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {(k.scopes && k.scopes.length > 0 ? k.scopes : ["checks:read"]).map((s) => (
                                    <Badge key={s} variant="secondary" className="text-[10px] px-1.5 py-0">
                                      {s.replace("checks:", "")}
                                    </Badge>
                                  ))}
                                </div>
                              </TableCell>
                              <TableCell className="text-xs">{dateFmt(k.createdAt)}</TableCell>
                              <TableCell className="text-xs">{dateFmt(k.lastUsedAt ?? null)}</TableCell>
                              <TableCell>
                                {k.enabled ? (
                                  <Badge>Enabled</Badge>
                                ) : k.disabledReason === 'plan_downgrade' ? (
                                  <Badge variant="secondary">Disabled</Badge>
                                ) : (
                                  <Badge variant="destructive">Revoked</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-right">
                                {k.enabled ? (
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => setRevokeId(k.id)}
                                    className="cursor-pointer"
                                  >
                                    Revoke
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setDeleteId(k.id)}
                                    className="cursor-pointer"
                                  >
                                    Delete
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                          {loading && (
                            <TableRow>
                              <TableCell colSpan={7} className="text-center text-muted-foreground">
                                Loading API keys...
                              </TableCell>
                            </TableRow>
                          )}
                          {!loading && keys.length === 0 && (
                            <TableRow>
                              <TableCell colSpan={7} className="text-center text-muted-foreground">
                                No API keys yet.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>

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
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="border-sky-500/30 bg-sky-500/5 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-base">Docs</CardTitle>
                  <CardDescription>Endpoint reference and examples live in the API docs.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button asChild variant="secondary" className="cursor-pointer w-full">
                    <Link to="/api" className="inline-flex items-center justify-center gap-2">
                      <BookOpen className="h-4 w-4" />
                      Open API docs
                    </Link>
                  </Button>
                </CardContent>
              </Card>

              <Alert className="border-sky-500/30 bg-sky-950/40 backdrop-blur">
                <Info className="h-4 w-4 text-sky-200" />
                <AlertDescription className="space-y-3">
                  <div className="font-medium">Rate limits</div>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">Per-minute limits:</span>
                    </div>
                    <div className="ml-4">
                      • Pre-auth (per IP): 20 requests/minute
                    </div>
                    <div className="ml-4">
                      • Per API key: 5 requests/minute
                    </div>
                    <div className="ml-4">
                      • Per endpoint: 1 request/minute
                    </div>
                    <div className="mt-3">
                      <span className="font-medium text-foreground">Daily quotas:</span>
                    </div>
                    <div className="ml-4">
                      • Per API key: 500 requests/day
                    </div>
                    <div className="ml-4">
                      • Per user (all keys): 2,000 requests/day
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground pt-2">
                    Rate limits help keep the API reliable and affordable. Exceeding limits returns a 429 status with Retry-After headers.
                  </div>
                </AlertDescription>
              </Alert>

              <Card className="border-sky-500/30 bg-sky-500/5 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-base">Security tips</CardTitle>
                  <CardDescription>Best practices for safe integrations.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <div>Rotate keys when team members change.</div>
                  <div>Keep keys in server-side secrets, never in client code.</div>
                  <div>Revoke unused keys to reduce exposure.</div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
      </FeatureGate>
    </PageContainer>
  );
}
