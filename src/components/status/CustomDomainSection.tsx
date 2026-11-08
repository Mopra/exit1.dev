import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, Globe, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, Button, ConfirmationModal, Input, Label } from '../ui';
import { apiClient } from '../../api/client';
import { copyToClipboard } from '../../utils/clipboard';
import { cn } from '../../lib/utils';
import {
  CUSTOM_DOMAIN_CNAME_TARGET,
  MAX_CUSTOM_DOMAINS_PER_ACCOUNT,
} from '../../lib/custom-domains';
import type { CustomDomainStatus, StatusPage, StatusPageCustomDomain } from '../../types';

// While a domain is pending or verifying, ask the backend to advance it every
// 15 s, for at most 10 minutes per open of the section. The new state itself
// arrives through the Status page's onSnapshot on status_pages; the callable
// result only drives the spinner.
const POLL_INTERVAL_MS = 15_000;
const POLL_MAX_MS = 10 * 60_000;

interface CustomDomainSectionProps {
  /** Live page from the onSnapshot list, so the domain state updates in place. */
  page: StatusPage;
  /** Account's Pro entitlement (usePlan().customStatusDomain). */
  entitled: boolean;
  /** Name of the cheapest tier with custom domains, for the upgrade copy. */
  upgradeTierName: string | null;
  /** Custom domains held by the account across all its pages (every status counts). */
  domainsUsed: number;
  canWrite: boolean;
}

const STATUS_LABEL: Record<CustomDomainStatus, string> = {
  pending: 'Waiting for DNS',
  verifying: 'Issuing certificate',
  active: 'Active',
  failed: 'Failed',
  disabled: 'Disabled',
};

const STATUS_CLASS: Record<CustomDomainStatus, string> = {
  pending: 'bg-warning/10 text-warning border-warning/20',
  verifying: 'bg-warning/10 text-warning border-warning/20',
  active: 'bg-success/10 text-success border-success/20',
  failed: 'bg-destructive/10 text-destructive border-destructive/20',
  disabled: 'bg-muted text-muted-foreground border-border',
};

/** Light client-side cleanup so a pasted URL works; the backend does the real validation. */
function cleanHostnameInput(value: string): string {
  return value.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
}

function StatusPill({ status }: { status: CustomDomainStatus }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_CLASS[status])}>
      {(status === 'pending' || status === 'verifying') && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyToClipboard(value)) toast.success(`${label} copied`);
        else toast.error('Could not copy to the clipboard');
      }}
      className="group flex w-full min-w-0 items-center gap-2 rounded-md border border-border/40 bg-background/60 px-2 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-muted/40 cursor-pointer"
      aria-label={`Copy ${label}`}
    >
      <span className="min-w-0 flex-1 break-all">{value}</span>
      <Copy className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
    </button>
  );
}

function DnsRecords({ domain }: { domain: StatusPageCustomDomain }) {
  const cnameTarget = domain.cnameTarget || CUSTOM_DOMAIN_CNAME_TARGET;
  const rows = [
    { type: 'TXT', name: domain.verifyRecord?.name ?? '', value: domain.verifyRecord?.value ?? '', purpose: 'Proves you own the domain' },
    { type: 'CNAME', name: domain.hostname, value: cnameTarget, purpose: 'Routes visitors to your status page' },
  ];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Add these two records at your DNS provider:</p>
      {rows.map((row) => (
        <div key={row.type} className="space-y-1.5 rounded-lg border border-border/30 bg-background/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0">{row.type}</Badge>
            <span className="text-[10px] text-muted-foreground">{row.purpose}</span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-[3.5rem_1fr] sm:items-center">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Name</span>
            <CopyValue value={row.name} label={`${row.type} name`} />
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Value</span>
            <CopyValue value={row.value} label={`${row.type} value`} />
          </div>
        </div>
      ))}
      <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
        <li>On Cloudflare, a proxied (orange cloud) CNAME is fine.</li>
        <li>If your domain has CAA records, they must allow letsencrypt.org and pki.goog.</li>
        <li>DNS changes can take a few minutes to show up. We keep checking while this is open.</li>
      </ul>
    </div>
  );
}

export function CustomDomainSection({ page, entitled, upgradeTierName, domainsUsed, canWrite }: CustomDomainSectionProps) {
  const domain = page.customDomain ?? null;
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'claim' | 'check' | 'release' | null>(null);
  const [polling, setPolling] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const pollStartRef = useRef<number | null>(null);

  const isPublic = page.visibility === 'public';
  const atCap = domainsUsed >= MAX_CUSTOM_DOMAINS_PER_ACCOUNT;
  const inProgress = domain?.status === 'pending' || domain?.status === 'verifying';

  const check = useCallback(async (opts: { quiet?: boolean } = {}) => {
    // Background polls stay silent and leave the buttons alone.
    if (opts.quiet) {
      await apiClient.checkStatusPageDomain(page.id);
      return;
    }
    setBusy('check');
    const res = await apiClient.checkStatusPageDomain(page.id);
    setBusy(null);
    if (!res.success) toast.error(res.error ?? 'Failed to check the domain');
  }, [page.id]);

  // Poll while pending/verifying: every 15 s, paused while the tab is hidden,
  // stopping after 10 minutes (then only "Check now").
  useEffect(() => {
    if (!inProgress || !canWrite) {
      pollStartRef.current = null;
      setPolling(false);
      return;
    }
    if (pollStartRef.current === null) pollStartRef.current = Date.now();
    setPolling(true);
    const tick = () => {
      if (pollStartRef.current !== null && Date.now() - pollStartRef.current > POLL_MAX_MS) {
        setPolling(false);
        window.clearInterval(timer);
        return;
      }
      if (document.hidden) return;
      void check({ quiet: true });
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [inProgress, canWrite, check]);

  const handleConnect = async () => {
    const hostname = cleanHostnameInput(input);
    if (!hostname) {
      setError('Enter a hostname, for example status.yourcompany.com');
      return;
    }
    setError(null);
    setBusy('claim');
    const res = await apiClient.claimStatusPageDomain(page.id, hostname);
    setBusy(null);
    if (!res.success) {
      setError(res.error ?? 'Failed to connect the domain');
      return;
    }
    setInput('');
    pollStartRef.current = Date.now();
    toast.success('Domain added. Now add the DNS records below.');
  };

  const handleRemove = async () => {
    setConfirmRemove(false);
    setBusy('release');
    const res = await apiClient.releaseStatusPageDomain(page.id);
    setBusy(null);
    if (!res.success) {
      toast.error(res.error ?? 'Failed to remove the domain');
      return;
    }
    toast.success('Custom domain removed. You can delete the CNAME record now.');
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Custom domain</div>
        {!entitled && upgradeTierName && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase tracking-wide">{upgradeTierName}</Badge>
        )}
      </div>
      {domain && <StatusPill status={domain.status} />}
      {!domain && !entitled && (
        <Button asChild size="sm" className="cursor-pointer h-7 text-xs">
          <Link to="/billing?tab=plans">Upgrade</Link>
        </Button>
      )}
    </div>
  );

  // ── No domain yet ──
  if (!domain) {
    const blockedReason = !entitled
      ? `Custom domain is a ${upgradeTierName ?? 'Pro'} feature.`
      : atCap
        ? 'Remove a domain from another page to add one here.'
        : !isPublic
          ? 'Make this page public and save it before connecting a domain. Custom domains only serve public pages.'
          : !canWrite
            ? 'You have view access to this account.'
            : null;
    const disabled = !!blockedReason || busy !== null;
    return (
      <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
        {header}
        <p className="text-xs text-muted-foreground">
          Serve this status page on your own hostname, such as status.yourcompany.com, over HTTPS.
        </p>
        <div className={cn('space-y-2', !entitled && 'opacity-50')}>
          <Label htmlFor="status-custom-domain" className="text-xs font-medium">Hostname</Label>
          <div className="flex gap-2">
            <Input
              id="status-custom-domain"
              value={input}
              onChange={(event) => { setInput(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !disabled) { event.preventDefault(); void handleConnect(); } }}
              placeholder="status.yourcompany.com"
              className="h-8 text-xs font-mono"
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
            />
            <Button size="sm" className="h-8 gap-1.5 text-xs cursor-pointer" onClick={handleConnect} disabled={disabled || !input.trim()}>
              {busy === 'claim' ? <Loader2 className="size-3.5 animate-spin" /> : <Globe className="size-3.5" />}
              Connect
            </Button>
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          {blockedReason && <p className="text-[11px] text-muted-foreground">{blockedReason}</p>}
        </div>
        {entitled && (
          <p className={cn('text-[11px]', atCap ? 'text-warning' : 'text-muted-foreground')}>
            {domainsUsed} of {MAX_CUSTOM_DOMAINS_PER_ACCOUNT} custom domains used
          </p>
        )}
      </div>
    );
  }

  // ── Domain connected, any state ──
  const removeButton = (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive cursor-pointer"
      onClick={() => setConfirmRemove(true)}
      disabled={!canWrite || busy !== null}
    >
      {busy === 'release' ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
      Remove
    </Button>
  );
  const checkButton = (label: string) => (
    <Button
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 text-xs cursor-pointer"
      onClick={() => void check()}
      disabled={!canWrite || busy !== null}
    >
      {busy === 'check' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
      {label}
    </Button>
  );

  const disabledReasonText = domain.disabledReason === 'plan_downgrade'
    ? `Switched off because the plan no longer includes custom domains.${entitled ? ' Reconnect to turn it back on.' : ''}`
    : domain.disabledReason === 'owner'
      ? 'Switched off. Reconnect to turn it back on.'
      : null;

  return (
    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
      {header}

      <div className="flex min-w-0 items-center gap-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {domain.status === 'active' ? (
          <a
            href={`https://${domain.hostname}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 font-mono text-sm text-foreground hover:underline underline-offset-4"
          >
            <span className="truncate">{domain.hostname}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </a>
        ) : (
          <span className="truncate font-mono text-sm">{domain.hostname}</span>
        )}
      </div>

      {!isPublic && (
        <p className="text-[11px] text-warning">
          This page is private, so the custom domain shows "not available" until the page is public again.
        </p>
      )}

      {domain.status === 'disabled' && disabledReasonText && (
        <p className="text-xs text-muted-foreground">{disabledReasonText}</p>
      )}
      {domain.lastError && domain.status !== 'active' && (
        <p className={cn('text-xs', domain.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
          {domain.lastError}
        </p>
      )}
      {domain.lastError && domain.status === 'active' && (
        <p className="text-xs text-warning">{domain.lastError}</p>
      )}

      {(inProgress || domain.status === 'failed') && <DnsRecords domain={domain} />}

      <div className="flex flex-wrap items-center gap-2">
        {inProgress && checkButton('Check now')}
        {domain.status === 'failed' && checkButton('Retry')}
        {domain.status === 'disabled' && (entitled
          ? checkButton('Reconnect')
          : (
            <Button asChild size="sm" className="h-8 gap-1.5 text-xs cursor-pointer">
              <Link to="/billing?tab=plans">Upgrade to {upgradeTierName ?? 'Pro'}</Link>
            </Button>
          ))}
        {removeButton}
        {inProgress && (
          <span className="text-[11px] text-muted-foreground">
            {polling ? 'Checking every 15 seconds' : 'Use Check now after changing DNS'}
          </span>
        )}
      </div>

      <ConfirmationModal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={handleRemove}
        title={`Remove ${domain.hostname}?`}
        message={`The status page stops loading on ${domain.hostname}. It stays available on its exit1 address. Afterwards you can delete the CNAME and TXT records at your DNS provider.`}
        confirmText="Remove domain"
        variant="destructive"
      />
    </div>
  );
}
