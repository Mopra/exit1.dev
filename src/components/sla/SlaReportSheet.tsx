import * as React from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { toast } from 'sonner';
import { Eye, Gauge, Loader2, Mail, X } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  Label,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetTitle,
  Switch,
} from '@/components/ui';
import ConfirmationModal from '@/components/ui/ConfirmationModal';
import { TimezonePicker } from '@/components/ui/TimezonePicker';
import KeyAccessPicker from '@/components/api-keys/KeyAccessPicker';
import { apiClient } from '@/api/client';
import { db } from '@/firebase';
import { useAccountId } from '@/AccountProvider';
import { cn } from '@/lib/utils';
import { detectedTimeZone } from '@/lib/timezones';
import {
  SLA_EXCLUDED_CHECK_TYPES,
  SLA_MAX_RECIPIENTS,
  SLA_TARGET_MAX,
  SLA_TARGET_MIN,
  SLA_TARGET_PRESETS,
  formatTarget,
} from '@/lib/sla';
import type { SlaReport, SlaReportInput, StatusPage } from '@/types';

const fieldLabel = 'text-xs font-medium text-muted-foreground';
const sectionTitle = 'text-sm font-semibold tracking-tight';
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

interface SlaReportSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null creates a new report. */
  report: SlaReport | null;
  onSaved?: (reportId: string) => void;
}

interface FormState {
  name: string;
  target: string;
  checkIds: string[];
  folders: string[];
  timezone: string;
  countBlockedAsDown: boolean;
  emailEnabled: boolean;
  recipients: string[];
  companyName: string;
  logoUrl: string;
  brandColor: string;
}

function initialState(report: SlaReport | null): FormState {
  return {
    name: report?.name ?? '',
    target: String(report?.targetPercent ?? 99.9),
    checkIds: report?.checkIds ?? [],
    folders: report?.folderPaths ?? [],
    timezone: report?.timezone ?? detectedTimeZone(),
    countBlockedAsDown: report?.countBlockedAsDown ?? false,
    emailEnabled: report?.schedule?.enabled ?? false,
    recipients: report?.schedule?.recipients ?? [],
    companyName: report?.branding?.companyName ?? '',
    logoUrl: report?.branding?.logoUrl ?? '',
    brandColor: report?.branding?.brandColor ?? '',
  };
}

function normalizeEmail(raw: string): string {
  const angle = /<([^>]+)>/.exec(raw);
  return (angle ? angle[1] : raw).trim().toLowerCase();
}

/** Client-side mirror of validateSlaReportInput, so most mistakes never reach the server. */
function validate(f: FormState): { input: SlaReportInput | null; errors: Partial<Record<keyof FormState, string>> } {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const name = f.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) errors.name = 'Use 2 to 80 characters.';

  const target = Number(f.target);
  if (!f.target.trim() || !Number.isFinite(target)) errors.target = 'Enter a percentage.';
  else if (target < SLA_TARGET_MIN || target > SLA_TARGET_MAX) errors.target = `Between ${SLA_TARGET_MIN} and ${SLA_TARGET_MAX}.`;
  else if (Math.abs(target * 1000 - Math.round(target * 1000)) > 1e-6) errors.target = 'At most 3 decimals.';

  if (f.checkIds.length === 0 && f.folders.length === 0) errors.checkIds = 'Pick at least one check or folder.';
  if (f.emailEnabled && f.recipients.length === 0) errors.recipients = 'Add at least one recipient, or switch the email off.';

  const logoUrl = f.logoUrl.trim();
  if (logoUrl) {
    let ok = false;
    try {
      const u = new URL(logoUrl);
      ok = u.protocol === 'https:' && /\.(png|jpe?g)$/i.test(u.pathname);
    } catch {
      ok = false;
    }
    if (!ok) errors.logoUrl = 'An https link to a PNG or JPEG. Outlook does not show SVG.';
  }
  const brandColor = f.brandColor.trim();
  if (brandColor && !HEX_RE.test(brandColor)) errors.brandColor = 'A hex color like #2563eb.';
  if (f.companyName.trim().length > 80) errors.companyName = 'At most 80 characters.';

  if (Object.keys(errors).length > 0) return { input: null, errors };
  const companyName = f.companyName.trim() || null;
  return {
    errors,
    input: {
      name,
      targetPercent: Math.round(target * 1000) / 1000,
      checkIds: f.checkIds,
      folderPaths: f.folders,
      timezone: f.timezone,
      countBlockedAsDown: f.countBlockedAsDown,
      schedule: { enabled: f.emailEnabled, recipients: f.recipients },
      branding: companyName || logoUrl || brandColor
        ? { companyName, logoUrl: logoUrl || null, brandColor: brandColor ? brandColor.toLowerCase() : null }
        : null,
    },
  };
}

export function SlaReportSheet({ open, onOpenChange, report, onSaved }: SlaReportSheetProps) {
  const accountId = useAccountId();
  const [form, setForm] = React.useState<FormState>(() => initialState(report));
  const [showErrors, setShowErrors] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmTz, setConfirmTz] = React.useState(false);
  const [recipientDraft, setRecipientDraft] = React.useState('');
  const [recipientError, setRecipientError] = React.useState<string | null>(null);
  const [statusPages, setStatusPages] = React.useState<StatusPage[] | null>(null);
  const [preview, setPreview] = React.useState<{ html: string; subject?: string } | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  // Reset each time the sheet opens. Live snapshot updates to `report` while
  // it is open must not wipe what the user is typing, hence the ref.
  const reportRef = React.useRef(report);
  reportRef.current = report;
  React.useEffect(() => {
    if (!open) return;
    setForm(initialState(reportRef.current));
    setShowErrors(false);
    setRecipientDraft('');
    setRecipientError(null);
  }, [open]);

  // Status pages for "Copy from status page", fetched once per open.
  React.useEffect(() => {
    if (!open || !accountId || statusPages) return;
    let cancelled = false;
    getDocs(query(collection(db, 'status_pages'), where('userId', '==', accountId)))
      .then((snap) => {
        if (cancelled) return;
        setStatusPages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StatusPage, 'id'>) })));
      })
      .catch(() => !cancelled && setStatusPages([]));
    return () => {
      cancelled = true;
    };
  }, [open, accountId, statusPages]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const { input, errors } = validate(form);
  const err = (key: keyof FormState) => (showErrors ? errors[key] : undefined);
  const unsubscribed = new Set(report?.unsubscribed ?? []);
  const tzChanged = !!report && report.timezone !== form.timezone;
  const pagesWithBranding = (statusPages ?? []).filter((p) => p.branding?.logoUrl || p.branding?.brandColor);

  const addRecipients = () => {
    const parts = recipientDraft.split(/[\s,;]+/).map(normalizeEmail).filter(Boolean);
    if (parts.length === 0) return;
    const bad = parts.find((p) => !EMAIL_RE.test(p) || p.length > 254);
    if (bad) {
      setRecipientError(`Not a valid email address: ${bad}`);
      return;
    }
    const next = [...form.recipients];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    if (next.length > SLA_MAX_RECIPIENTS) {
      setRecipientError(`A report can email at most ${SLA_MAX_RECIPIENTS} people.`);
      return;
    }
    set('recipients', next);
    setRecipientDraft('');
    setRecipientError(null);
  };

  const copyBranding = (page: StatusPage) => {
    const logo = page.branding?.logoUrl ?? '';
    setForm((f) => ({
      ...f,
      companyName: f.companyName || page.name || '',
      logoUrl: logo,
      brandColor: page.branding?.brandColor ?? f.brandColor,
    }));
    if (logo && !/\.(png|jpe?g)(\?|#|$)/i.test(logo)) {
      toast.message('That logo may not be a PNG or JPEG', { description: 'Email clients like Outlook do not show SVG. Use a PNG or JPEG link.' });
    }
  };

  const save = async () => {
    if (!input) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    const res = await apiClient.upsertSlaReport(input, report?.id);
    setSaving(false);
    if (!res.success) {
      toast.error(res.error ?? 'Could not save the report');
      return;
    }
    toast.success(report ? 'SLA report saved' : 'SLA report created');
    onOpenChange(false);
    if (res.data?.reportId) onSaved?.(res.data.reportId);
  };

  const onSaveClick = () => {
    if (!input) {
      setShowErrors(true);
      return;
    }
    if (tzChanged) setConfirmTz(true);
    else void save();
  };

  const openPreview = async () => {
    if (!input) {
      setShowErrors(true);
      return;
    }
    setPreviewing(true);
    const res = await apiClient.previewSlaReportEmail(report?.id ?? null, input);
    setPreviewing(false);
    if (!res.success || !res.data?.html) {
      toast.error(res.error ?? 'Could not build the preview');
      return;
    }
    setPreview(res.data);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0 overflow-hidden flex flex-col">
          <SheetTitle className="sr-only">{report ? 'Edit SLA report' : 'New SLA report'}</SheetTitle>
          <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-viewport]]:!overflow-x-hidden [&_[data-slot=scroll-viewport]>div]:!block [&_[data-slot=scroll-viewport]>div]:!w-full">
            <div className="p-7 sm:p-8 min-w-0 space-y-8">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10 shrink-0">
                  <Gauge className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold tracking-tight">{report ? 'Edit SLA report' : 'New SLA report'}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Availability per calendar month, against a target you promise a client.
                  </p>
                </div>
              </div>

              {/* Basics */}
              <section className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="sla-name" className={fieldLabel}>Name</Label>
                  <Input
                    id="sla-name"
                    value={form.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder="Acme Corp hosting"
                    maxLength={80}
                    aria-invalid={!!err('name')}
                  />
                  {err('name') && <p className="text-xs text-destructive">{err('name')}</p>}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="sla-target" className={fieldLabel}>Availability target</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    {SLA_TARGET_PRESETS.map((t) => (
                      <Button
                        key={t}
                        type="button"
                        size="sm"
                        variant={Number(form.target) === t ? 'default' : 'outline'}
                        className="cursor-pointer font-mono h-8 px-3"
                        onClick={() => set('target', String(t))}
                      >
                        {formatTarget(t)}
                      </Button>
                    ))}
                    <div className="relative w-28 shrink-0">
                      <Input
                        id="sla-target"
                        inputMode="decimal"
                        value={form.target}
                        onChange={(e) => set('target', e.target.value.replace(',', '.'))}
                        className="h-8 pr-6 font-mono text-sm"
                        aria-label="Custom target"
                        aria-invalid={!!err('target')}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                    </div>
                  </div>
                  {err('target') ? (
                    <p className="text-xs text-destructive">{err('target')}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {allowedPerMonth(Number(form.target))}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label className={fieldLabel}>Time zone</Label>
                  <TimezonePicker value={form.timezone} onChange={(tz) => set('timezone', tz)} />
                  <p className="text-xs text-muted-foreground">
                    Months start and end at local midnight here, daylight saving included.
                  </p>
                  {tzChanged && (
                    <p className="text-xs text-warning">
                      Past months will be recalculated in the new time zone when you open them. Emails already sent are kept on record.
                    </p>
                  )}
                </div>
              </section>

              {/* Scope */}
              <section className="space-y-3">
                <div>
                  <h3 className={sectionTitle}>Checks</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {form.checkIds.length + form.folders.length === 0
                      ? 'Pick the checks this contract covers. Folders work as tags.'
                      : `${count(form.checkIds.length, 'check')} and ${count(form.folders.length, 'folder')} selected`}
                  </p>
                </div>
                <KeyAccessPicker
                  value={{ checkIds: form.checkIds, folders: form.folders }}
                  onChange={(next) => setForm((f) => ({ ...f, checkIds: next.checkIds, folders: next.folders }))}
                  excludeTypes={SLA_EXCLUDED_CHECK_TYPES}
                  footnote="A folder includes its subfolders and any checks added to it later. DNS and domain checks have no availability, so they are not listed. Up to 250 checks per report."
                />
                {err('checkIds') && <p className="text-xs text-destructive">{err('checkIds')}</p>}
              </section>

              {/* Counting */}
              <section className="space-y-3">
                <h3 className={sectionTitle}>Counting</h3>
                <label className="flex items-start justify-between gap-4 rounded-lg border border-border/60 p-3 cursor-pointer">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">Count blocked probes as down</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      Off by default. A firewall challenge means the probe never reached the server, so that time is excluded.
                    </span>
                  </span>
                  <Switch
                    checked={form.countBlockedAsDown}
                    onCheckedChange={(v) => set('countBlockedAsDown', v)}
                    className="shrink-0 mt-0.5"
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Only confirmed outages count as down. Maintenance and unmonitored time are always excluded.
                </p>
              </section>

              {/* Email */}
              <section className="space-y-4">
                <label className="flex items-start justify-between gap-4 cursor-pointer">
                  <span className="min-w-0">
                    <span className={cn(sectionTitle, 'block')}>Monthly email</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      The full report, sent on the 1st in this time zone. Made to be forwarded to clients.
                    </span>
                  </span>
                  <Switch checked={form.emailEnabled} onCheckedChange={(v) => set('emailEnabled', v)} className="shrink-0 mt-0.5" />
                </label>

                <div className={cn('space-y-4', !form.emailEnabled && 'opacity-60')}>
                  <div className="space-y-2">
                    <Label htmlFor="sla-recipient" className={fieldLabel}>
                      Recipients <span className="font-normal">({form.recipients.length} of {SLA_MAX_RECIPIENTS})</span>
                    </Label>
                    {form.recipients.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {form.recipients.map((r) => {
                          const off = unsubscribed.has(r);
                          return (
                            <span
                              key={r}
                              className={cn(
                                'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs',
                                off && 'text-muted-foreground line-through decoration-muted-foreground/60',
                              )}
                              title={off ? 'Unsubscribed. Remove and add again only if they asked for it.' : undefined}
                            >
                              <span className="truncate">{r}</span>
                              {off && <span className="no-underline shrink-0 text-[10px] uppercase tracking-wide">unsubscribed</span>}
                              <button
                                type="button"
                                className="shrink-0 rounded-full p-0.5 cursor-pointer hover:bg-muted"
                                aria-label={`Remove ${r}`}
                                onClick={() => set('recipients', form.recipients.filter((x) => x !== r))}
                              >
                                <X className="size-3" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Input
                        id="sla-recipient"
                        type="email"
                        value={recipientDraft}
                        onChange={(e) => {
                          setRecipientDraft(e.target.value);
                          setRecipientError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            addRecipients();
                          }
                        }}
                        onBlur={addRecipients}
                        placeholder="client@example.com"
                        className="h-9 text-sm"
                        disabled={form.recipients.length >= SLA_MAX_RECIPIENTS}
                      />
                      <Button type="button" variant="outline" size="sm" className="h-9 cursor-pointer shrink-0" onClick={addRecipients}>
                        Add
                      </Button>
                    </div>
                    {recipientError && <p className="text-xs text-destructive">{recipientError}</p>}
                    {err('recipients') && <p className="text-xs text-destructive">{err('recipients')}</p>}
                    <p className="text-xs text-muted-foreground">
                      Every email has an unsubscribe link. People outside your team can be added.
                    </p>
                  </div>

                  <div className="space-y-3 rounded-lg border border-border/60 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className={fieldLabel}>Branding</span>
                      {pagesWithBranding.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs cursor-pointer">
                              Copy from status page
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="max-w-64">
                            <DropdownMenuLabel className="text-xs">Status pages</DropdownMenuLabel>
                            {pagesWithBranding.map((p) => (
                              <DropdownMenuItem key={p.id} className="cursor-pointer" onSelect={() => copyBranding(p)}>
                                <span className="truncate">{p.name}</span>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="sla-company" className={fieldLabel}>Company name</Label>
                      <Input
                        id="sla-company"
                        value={form.companyName}
                        onChange={(e) => set('companyName', e.target.value)}
                        placeholder="Your agency"
                        maxLength={80}
                        className="h-9 text-sm"
                      />
                      {err('companyName') && <p className="text-xs text-destructive">{err('companyName')}</p>}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="sla-logo" className={fieldLabel}>Logo URL</Label>
                      <Input
                        id="sla-logo"
                        value={form.logoUrl}
                        onChange={(e) => set('logoUrl', e.target.value)}
                        placeholder="https://example.com/logo.png"
                        className="h-9 text-sm font-mono"
                      />
                      {err('logoUrl') ? (
                        <p className="text-xs text-destructive">{err('logoUrl')}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">PNG or JPEG over https. Without a logo the company name is shown.</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="sla-color" className={fieldLabel}>Brand color</Label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          aria-label="Pick brand color"
                          value={HEX_RE.test(form.brandColor) && form.brandColor.length === 7 ? form.brandColor : '#2563eb'}
                          onChange={(e) => set('brandColor', e.target.value)}
                          className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-1"
                        />
                        <Input
                          id="sla-color"
                          value={form.brandColor}
                          onChange={(e) => set('brandColor', e.target.value)}
                          placeholder="#2563eb"
                          className="h-9 text-sm font-mono w-32"
                        />
                        {form.brandColor && (
                          <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs cursor-pointer" onClick={() => set('brandColor', '')}>
                            Clear
                          </Button>
                        )}
                      </div>
                      {err('brandColor') && <p className="text-xs text-destructive">{err('brandColor')}</p>}
                    </div>
                  </div>

                  <Button type="button" variant="outline" size="sm" className="cursor-pointer gap-2" onClick={openPreview} disabled={previewing}>
                    {previewing ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
                    Preview email
                  </Button>
                </div>
              </section>
            </div>
          </ScrollArea>

          <div className="flex items-center justify-end gap-2 border-t border-border px-7 sm:px-8 py-4 shrink-0">
            <Button type="button" variant="ghost" className="cursor-pointer" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" className="cursor-pointer gap-2" onClick={onSaveClick} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {report ? 'Save changes' : 'Create report'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmationModal
        isOpen={confirmTz}
        onClose={() => setConfirmTz(false)}
        onConfirm={() => {
          setConfirmTz(false);
          void save();
        }}
        title="Change the time zone?"
        message={`Months will be counted in ${form.timezone}. Past months will be recalculated in the new time zone when you open them. Emails already sent are kept on record.`}
        confirmText="Change time zone"
        variant="warning"
      />

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-3xl p-0 overflow-hidden gap-0">
          <DialogHeader className="p-5 border-b border-border">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Mail className="size-4 shrink-0" />
              Email preview
            </DialogTitle>
            <DialogDescription className="truncate">{preview?.subject ?? 'How the monthly email will look'}</DialogDescription>
          </DialogHeader>
          {preview && (
            <iframe
              title="SLA email preview"
              srcDoc={preview.html}
              sandbox=""
              className="block h-[70vh] w-full bg-white"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Allows about 43m 50s of downtime in a 30-day month." */
function allowedPerMonth(target: number): string {
  if (!Number.isFinite(target) || target < SLA_TARGET_MIN || target > SLA_TARGET_MAX) return '';
  const ms = (1 - target / 100) * 30 * 24 * 60 * 60 * 1000;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [h ? `${h}h` : '', m ? `${m}m` : '', !h && s ? `${s}s` : ''].filter(Boolean).join(' ') || '0s';
  return `Allows about ${parts} of downtime in a 30-day month, counted on measured time.`;
}
