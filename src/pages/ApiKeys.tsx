import * as React from "react";
import { Link } from "react-router-dom";
import { BookOpen, Info, KeyRound } from "lucide-react";

import { apiClient } from "@/api/client";
import type { ApiKey, CreateApiKeyResponse } from "@/api/types";
import { PageContainer, PageHeader } from "@/components/layout";
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

export default function ApiKeys() {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
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

  async function onCreate() {
    setCreating(true);
    const res = await apiClient.createApiKey(name || "Default");
    setCreating(false);
    if (res.success && res.data) {
      setCreatedKey(res.data);
      setCreateOpen(false);
      setName("");
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

  return (
    <PageContainer className="overflow-visible">
      <PageHeader
        title="API keys"
        description="Create, revoke, and rotate Public API keys."
        icon={KeyRound}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" className="cursor-pointer">
              <Link to="/api" className="inline-flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                API docs
              </Link>
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button className="cursor-pointer">Create API key</Button>
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
        }
      />

      <div className="p-4 sm:p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Card className="border-sky-500/30 bg-sky-500/5 backdrop-blur">
              <CardHeader>
                <CardTitle>Manage keys</CardTitle>
                <CardDescription>Keys grant read-only access to checks, history, and stats.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {createdKey && (
                  <Alert className="bg-sky-950/40 backdrop-blur border-sky-500/30">
                    <AlertDescription className="flex flex-col gap-3">
                      <div className="font-medium">API key created</div>
                      <div className="text-sm">Copy this key now. You won&apos;t be able to see it again.</div>
                      <div className="flex items-center gap-2">
                        <code className="px-2 py-1 rounded bg-black/40 font-mono text-xs">
                          {createdKey.key}
                        </code>
                        <Button size="sm" onClick={copyCreatedKey} className="cursor-pointer">
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
                              <TableCell className="text-xs">{dateFmt(k.createdAt)}</TableCell>
                              <TableCell className="text-xs">{dateFmt(k.lastUsedAt ?? null)}</TableCell>
                              <TableCell>
                                {k.enabled ? (
                                  <Badge>Enabled</Badge>
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
                              <TableCell colSpan={6} className="text-center text-muted-foreground">
                                Loading API keys...
                              </TableCell>
                            </TableRow>
                          )}
                          {!loading && keys.length === 0 && (
                            <TableRow>
                              <TableCell colSpan={6} className="text-center text-muted-foreground">
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
                      <span className="font-medium text-foreground">Pre-auth (per IP):</span> ~60 requests/minute
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Per API key (default):</span> ~30 requests/minute
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Stats endpoint:</span> ~15 requests/minute (BigQuery-heavy)
                    </div>
                    <div>
                      <span className="font-medium text-foreground">History endpoint:</span> ~10 requests/minute (BigQuery-heavy)
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
    </PageContainer>
  );
}
