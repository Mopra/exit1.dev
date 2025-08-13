import React from 'react';
import { apiClient } from '@/api/client';
import type { ApiKey, CreateApiKeyResponse } from '@/api/types';
import { copyToClipboard } from '@/utils/clipboard';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
  Button, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  Alert, AlertDescription, Badge, Tooltip, TooltipTrigger, TooltipContent, Separator
} from '@/components/ui';

const dateFmt = (ts?: number | null) => ts ? new Date(ts).toLocaleString() : '-';

export default function Settings() {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [createdKey, setCreatedKey] = React.useState<CreateApiKeyResponse | null>(null);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    const res = await apiClient.listApiKeys();
    if (res.success && res.data) setKeys(res.data);
    setLoading(false);
  }, []);

  React.useEffect(() => { load(); }, [load]);

  async function onCreate() {
    setCreating(true);
    const res = await apiClient.createApiKey(name || 'Default');
    setCreating(false);
    if (res.success && res.data) {
      setCreatedKey(res.data);
      setOpen(false);
      setName('');
      load();
    }
  }

  async function onRevoke(id: string) {
    if (!confirm('Revoke this API key? This cannot be undone.')) return;
    const res = await apiClient.revokeApiKey(id);
    if (res.success) load();
  }

  async function copyKey() {
    if (!createdKey) return;
    const ok = await copyToClipboard(createdKey.key);
    if (!ok) alert('Copy failed');
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
                 <div>
           <h1 className="text-2xl font-semibold">API</h1>
           <p className="text-sm text-muted-foreground">Manage API keys and public endpoints.</p>
         </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="cursor-pointer">Create API Key</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>Give this key a name to identify its usage.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Backend server" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} className="cursor-pointer">Cancel</Button>
              <Button onClick={onCreate} disabled={creating} className="cursor-pointer">
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {createdKey && (
        <Alert className="bg-sky-950/40 backdrop-blur border-sky-500/30">
          <AlertDescription className="flex flex-col gap-3">
            <div className="font-medium">API key created</div>
            <div className="text-sm">
              Copy this key now. You won't be able to see it again.
            </div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-1 rounded bg-black/40">{createdKey.key}</code>
              <Button size="sm" onClick={copyKey} className="cursor-pointer">Copy</Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card className="border-slate-700/40 bg-slate-900/40 backdrop-blur">
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>Use X-Api-Key header with the public REST endpoints.</CardDescription>
        </CardHeader>
        <CardContent>
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
              {keys.map(k => (
                <TableRow key={k.id}>
                  <TableCell>{k.name || '-'}</TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-mono text-sm cursor-pointer">{k.prefix}…{k.last4}</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <span>Only shown in prefix/last4 for security.</span>
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{dateFmt(k.createdAt)}</TableCell>
                  <TableCell>{dateFmt(k.lastUsedAt ?? null)}</TableCell>
                  <TableCell>
                    {k.enabled ? <Badge>Enabled</Badge> : <Badge variant="destructive">Revoked</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="destructive" size="sm" onClick={() => onRevoke(k.id)} className="cursor-pointer">Revoke</Button>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && keys.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">No API keys yet.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="border-slate-700/40 bg-slate-900/40 backdrop-blur">
        <CardHeader>
          <CardTitle>Public API</CardTitle>
          <CardDescription>Simple read-only endpoints for checks, history, and stats.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            Add header: <code className="px-1 py-0.5 bg-black/40 rounded">X-Api-Key: YOUR_KEY</code>
          </div>
          <Separator />
                     <div className="space-y-2">
             <div className="font-medium">List checks</div>
             <code className="block p-2 rounded bg-black/40 text-xs">
               curl -H "X-Api-Key: YOUR_KEY" "https://us-central1-exit1-dev.cloudfunctions.net/publicApi/v1/public/checks?limit=25"
             </code>
           </div>
           <div className="space-y-2">
             <div className="font-medium">Check details</div>
             <code className="block p-2 rounded bg-black/40 text-xs">
               curl -H "X-Api-Key: YOUR_KEY" "https://us-central1-exit1-dev.cloudfunctions.net/publicApi/v1/public/checks/CHECK_ID"
             </code>
           </div>
                       <div className="space-y-2">
              <div className="font-medium">History (BigQuery)</div>
              <code className="block p-2 rounded bg-black/40 text-xs">
                curl -H "X-Api-Key: YOUR_KEY" "https://us-central1-exit1-dev.cloudfunctions.net/publicApi/v1/public/checks/CHECK_ID/history?limit=50&amp;from=2023-12-21T22:30:56Z&amp;to=2023-12-22T22:30:56Z&amp;status=all&amp;q="
              </code>
              <div className="text-xs text-muted-foreground">
                Use ISO 8601 format: 2023-12-21T22:30:56Z (Dec 21, 2023 10:30:56 PM UTC)
              </div>
            </div>
            <div className="space-y-2">
              <div className="font-medium">Stats</div>
              <code className="block p-2 rounded bg-black/40 text-xs">
                curl -H "X-Api-Key: YOUR_KEY" "https://us-central1-exit1-dev.cloudfunctions.net/publicApi/v1/public/checks/CHECK_ID/stats?from=2023-12-21T22:30:56Z&amp;to=2023-12-22T22:30:56Z"
              </code>
              <div className="text-xs text-muted-foreground">
                Use ISO 8601 format: 2023-12-21T22:30:56Z (Dec 21, 2023 10:30:56 PM UTC)
              </div>
            </div>
        </CardContent>
      </Card>
    </div>
  );
}
