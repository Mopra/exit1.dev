import React, { useEffect, useState } from 'react';
import { Activity, Mail } from 'lucide-react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  CardContent,
  CardHeader,
  CardTitle,
  GlowCard,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Switch,
} from '@/components/ui';
import { apiClient } from '@/api/client';
import { useEmailProvider, DEFAULT_EMAIL_PROVIDER } from '@/hooks/useEmailProvider';
import type {
  EmailProviderCategory,
  EmailProviderName,
  EmailProviderSettingsInput,
} from '@/api/types';

/**
 * Admin control for `system_settings/email_provider` — which provider carries
 * transactional email.
 *
 * Categories are listed in migration order (safest first) rather than
 * alphabetically: that ordering *is* the recommended ramp, so the UI reads
 * top-to-bottom as the plan.
 */
const CATEGORIES: Array<{
  key: EmailProviderCategory;
  label: string;
  hint: string;
}> = [
  { key: 'internal', label: 'Internal', hint: 'Feedback, SMS forwards, operator alerts — nobody outside the team sees these' },
  { key: 'test', label: 'Test sends', hint: 'User-triggered "send me a test email" — visible failure, zero cost' },
  { key: 'account', label: 'Account', hint: 'Quota warnings, webhook failures, bounce notices' },
  { key: 'alerts', label: 'Alerts', hint: 'DOWN/UP, SSL, DNS, domain expiry. Highest volume and the one that matters' },
];

const PROVIDER_LABEL: Record<EmailProviderName, string> = {
  resend: 'Resend',
  day3: 'Day3',
};

export const EmailProviderControl: React.FC = () => {
  const { settings, loading } = useEmailProvider();
  const [draft, setDraft] = useState<EmailProviderSettingsInput>(DEFAULT_EMAIL_PROVIDER);
  const [pending, setPending] = useState(false);

  // Re-seed the form whenever the stored doc changes, so a change made in
  // another tab (or by another admin) doesn't get silently overwritten by a
  // stale draft sitting in this one.
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  const dirty = settings ? JSON.stringify(draft) !== JSON.stringify(settings) : false;

  const setCategory = (key: EmailProviderCategory, value: string) => {
    setDraft((prev) => {
      const categories = { ...(prev.categories ?? {}) };
      if (value === 'inherit') {
        delete categories[key];
      } else {
        categories[key] = value as EmailProviderName;
      }
      return { ...prev, categories };
    });
  };

  const handleSave = async () => {
    if (pending) return;
    setPending(true);
    const result = await apiClient.setEmailProvider(draft);
    if (result.success) {
      toast.success('Email provider updated — senders pick it up within ~30s');
    } else {
      toast.error(result.error || 'Update failed');
    }
    setPending(false);
  };

  const handleRevert = () => {
    if (settings) setDraft(settings);
  };

  const effective = (key: EmailProviderCategory): EmailProviderName =>
    draft.categories?.[key] ?? draft.provider;

  const anyDay3 =
    draft.provider === 'day3' ||
    Object.values(draft.categories ?? {}).includes('day3') ||
    (draft.canaryPercent ?? 0) > 0;

  return (
    <GlowCard className="p-0 lg:col-span-2">
      <div className="m-1">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Mail className="h-4 w-4 shrink-0" />
              Transactional email provider
            </CardTitle>
            <Badge variant={anyDay3 ? 'default' : 'secondary'} className="shrink-0">
              {loading ? 'Loading…' : anyDay3 ? 'Day3 in play' : 'All Resend'}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Writes <code className="px-1">system_settings/email_provider</code>. Cloud
            Functions and both VPS runners cache it for 30s — for an instant rollback,
            also POST <code className="px-1">/admin/refresh-flags</code> to each runner.
          </p>
        </CardHeader>

        <CardContent className="space-y-5 text-xs">
          <div className="space-y-2">
            <Label className="text-xs">Default provider</Label>
            <Select
              value={draft.provider}
              onValueChange={(value) =>
                setDraft((prev) => ({ ...prev, provider: value as EmailProviderName }))
              }
              disabled={loading || pending}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="resend">Resend</SelectItem>
                <SelectItem value="day3">Day3</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground">
              Applies to every category without its own override below.
            </p>
          </div>

          <div className="space-y-3">
            <Label className="text-xs">Per-category overrides</Label>
            {CATEGORIES.map((category) => (
              <div
                key={category.key}
                className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground font-medium">{category.label}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {PROVIDER_LABEL[effective(category.key)]}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground mt-1">{category.hint}</p>
                </div>
                <Select
                  value={draft.categories?.[category.key] ?? 'inherit'}
                  onValueChange={(value) => setCategory(category.key, value)}
                  disabled={loading || pending}
                >
                  <SelectTrigger className="h-8 w-32 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Default</SelectItem>
                    <SelectItem value="resend">Resend</SelectItem>
                    <SelectItem value="day3">Day3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-xs">Day3 canary</Label>
              <span className="text-foreground tabular-nums shrink-0">
                {draft.canaryPercent ?? 0}%
              </span>
            </div>
            <Slider
              value={[draft.canaryPercent ?? 0]}
              min={0}
              max={100}
              step={1}
              disabled={loading || pending}
              onValueChange={([value]) =>
                setDraft((prev) => ({ ...prev, canaryPercent: value }))
              }
            />
            <p className="text-muted-foreground">
              Routes this share of recipients to Day3 inside categories still set to
              Resend. Bucketed by a hash of the address, so a given person always gets
              the same provider — an alternating coin flip would make a deliverability
              problem impossible to attribute.
            </p>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3">
            <div className="min-w-0">
              <span className="text-foreground font-medium">Fall back to Resend</span>
              <p className="text-muted-foreground mt-1">
                Retry a failed Day3 send through Resend before giving up. Leave on
                during the migration: a duplicate alert is a nuisance, a missing one is
                the product failing. Turning it off measures Day3's true error rate.
              </p>
            </div>
            <Switch
              className="shrink-0"
              checked={draft.fallbackToResend !== false}
              disabled={loading || pending}
              onCheckedChange={(checked) =>
                setDraft((prev) => ({ ...prev, fallbackToResend: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            {settings?.updatedAt ? (
              <p className="flex items-center gap-2 text-foreground/80 min-w-0">
                <Activity className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  Last changed: {new Date(settings.updatedAt).toLocaleString()}
                  {settings.updatedBy ? ` by ${settings.updatedBy.slice(0, 12)}…` : ''}
                </span>
              </p>
            ) : (
              <span className="text-muted-foreground">Never configured — defaults apply</span>
            )}
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRevert}
                disabled={!dirty || pending}
              >
                Revert
              </Button>
              <Button size="sm" onClick={handleSave} disabled={!dirty || pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </CardContent>
      </div>
    </GlowCard>
  );
};
