"use client"

import React, { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Button,
  Input,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormDescription,
  FormMessage,
  Textarea,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Checkbox,
  Label,
  Sheet,
  SheetContent,
  SheetTitle,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../ui';
import {
  Plus,
  Webhook,
  Check,
  FolderOpen,
  ChevronDown,
  Settings,
  Info,
  Zap,
} from 'lucide-react';

import { WEBHOOK_EVENTS } from '../../lib/webhook-events';
import type { Website } from '../../types';
import type { WebhookCheckFilter } from '../../api/types';
import type { IntegrationScope, WebhookPlatformType } from '../../lib/integration-scope';
import { defaultPlatformForScope, labelsForScope } from '../../lib/integration-scope';

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

// Built-in Pushover sound names (https://pushover.net/api#sounds).
const PUSHOVER_SOUNDS = [
  'pushover', 'bike', 'bugle', 'cashregister', 'classical', 'cosmic',
  'falling', 'gamelan', 'incoming', 'intermission', 'magic', 'mechanical',
  'pianobar', 'siren', 'spacealarm', 'tugboat', 'alien', 'climb',
  'persistent', 'echo', 'updown', 'vibrate', 'none',
];

const PUSHOVER_TOKEN_RE = /^[A-Za-z0-9]{30}$/;

const PUSHOVER_PRIORITY_VALUES = ['-2', '-1', '0', '1', '2'] as const;
type PushoverPriorityValue = (typeof PUSHOVER_PRIORITY_VALUES)[number];

// Pushover emergency-priority bounds (must mirror alert-pushover.ts).
const PUSHOVER_EMERGENCY_RETRY_MIN_SEC = 30;
const PUSHOVER_EMERGENCY_EXPIRE_MAX_SEC = 10800;
const PUSHOVER_EMERGENCY_RETRY_DEFAULT = 60;
const PUSHOVER_EMERGENCY_EXPIRE_DEFAULT = 3600;

type PushoverFields = {
  token: string;
  user: string;
  priority: PushoverPriorityValue;
  sound: string;
  device: string;
  // Emergency-only fields, kept as strings so the input stays editable while empty.
  retry: string;
  expire: string;
  // TTL applies for non-emergency priorities; kept as a string for the same reason.
  ttl: string;
};

const EMPTY_PUSHOVER_FIELDS: PushoverFields = {
  token: '',
  user: '',
  priority: '0',
  sound: '',
  device: '',
  retry: '',
  expire: '',
  ttl: '',
};

const parseOptionalPositiveInt = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
};

// Build the stored URL from form fields. Must mirror the backend
// extractPushoverCredentials parser in functions/src/alert-pushover.ts.
function buildPushoverUrl(fields: PushoverFields): string {
  const u = new URL(PUSHOVER_API_URL);
  u.searchParams.set('token', fields.token.trim());
  u.searchParams.set('user', fields.user.trim());
  // Only set priority when non-default to keep the URL tidy
  if (fields.priority && fields.priority !== '0') {
    u.searchParams.set('priority', fields.priority);
  }
  if (fields.sound.trim()) u.searchParams.set('sound', fields.sound.trim());
  if (fields.device.trim()) u.searchParams.set('device', fields.device.trim());

  if (fields.priority === '2') {
    const retry = parseOptionalPositiveInt(fields.retry) ?? PUSHOVER_EMERGENCY_RETRY_DEFAULT;
    const expire = parseOptionalPositiveInt(fields.expire) ?? PUSHOVER_EMERGENCY_EXPIRE_DEFAULT;
    u.searchParams.set('retry', String(retry));
    u.searchParams.set('expire', String(expire));
    // ttl is incompatible with priority=2 — Pushover rejects the combo.
  } else {
    const ttl = parseOptionalPositiveInt(fields.ttl);
    if (ttl !== undefined) u.searchParams.set('ttl', String(ttl));
  }
  return u.toString();
}

// Inverse of buildPushoverUrl — for prefilling the form in edit mode.
function parsePushoverUrl(url: string): PushoverFields {
  try {
    const u = new URL(url);
    const rawPriority = (u.searchParams.get('priority') || '0').trim();
    const priority: PushoverPriorityValue =
      (PUSHOVER_PRIORITY_VALUES as readonly string[]).includes(rawPriority)
        ? (rawPriority as PushoverPriorityValue)
        : '0';
    return {
      token: (u.searchParams.get('token') || '').trim(),
      user: (u.searchParams.get('user') || '').trim(),
      priority,
      sound: (u.searchParams.get('sound') || '').trim(),
      device: (u.searchParams.get('device') || '').trim(),
      retry: (u.searchParams.get('retry') || '').trim(),
      expire: (u.searchParams.get('expire') || '').trim(),
      ttl: (u.searchParams.get('ttl') || '').trim(),
    };
  } catch {
    return { ...EMPTY_PUSHOVER_FIELDS };
  }
}

const formSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  url: z.string().optional(),
  events: z.array(z.string()).min(1, 'Please select at least one event type'),
  checkFilterMode: z.enum(['all', 'include']),
  checkIds: z.array(z.string()).optional(),
  folderPaths: z.array(z.string()).optional(),
  secret: z.string().optional(),
  customHeaders: z.string().optional(),
  webhookType: z.enum(['slack', 'discord', 'teams', 'pumble', 'pagerduty', 'opsgenie', 'pushover', 'generic']),
  pushoverToken: z.string().optional(),
  pushoverUserKey: z.string().optional(),
  pushoverPriority: z.enum(PUSHOVER_PRIORITY_VALUES).optional(),
  pushoverSound: z.string().optional(),
  pushoverDevice: z.string().optional(),
  pushoverRetry: z.string().optional(),
  pushoverExpire: z.string().optional(),
  pushoverTtl: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.checkFilterMode === 'include' && (!data.checkIds || data.checkIds.length === 0) && (!data.folderPaths || data.folderPaths.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['checkIds'],
      message: 'Select at least one check or folder',
    });
  }

  if (data.webhookType === 'pushover') {
    if (!data.pushoverToken || !PUSHOVER_TOKEN_RE.test(data.pushoverToken.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pushoverToken'],
        message: 'App API token must be 30 letters and digits (no dashes)',
      });
    }
    if (!data.pushoverUserKey || !PUSHOVER_TOKEN_RE.test(data.pushoverUserKey.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pushoverUserKey'],
        message: 'User or group key must be 30 letters and digits (no dashes)',
      });
    }
    if (data.pushoverPriority === '2') {
      const retry = parseOptionalPositiveInt(data.pushoverRetry || '');
      if (retry !== undefined && retry < PUSHOVER_EMERGENCY_RETRY_MIN_SEC) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pushoverRetry'],
          message: `Retry interval must be at least ${PUSHOVER_EMERGENCY_RETRY_MIN_SEC} seconds`,
        });
      }
      const expire = parseOptionalPositiveInt(data.pushoverExpire || '');
      if (expire !== undefined) {
        if (expire < PUSHOVER_EMERGENCY_RETRY_MIN_SEC) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pushoverExpire'],
            message: `Retry expiration must be at least ${PUSHOVER_EMERGENCY_RETRY_MIN_SEC} seconds`,
          });
        } else if (expire > PUSHOVER_EMERGENCY_EXPIRE_MAX_SEC) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pushoverExpire'],
            message: `Retry expiration must be at most ${PUSHOVER_EMERGENCY_EXPIRE_MAX_SEC} seconds (3 hours)`,
          });
        }
      }
    } else if ((data.pushoverTtl || '').trim()) {
      const ttl = parseOptionalPositiveInt(data.pushoverTtl || '');
      if (ttl === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pushoverTtl'],
          message: 'Time to live must be a positive integer (seconds)',
        });
      }
    }
  } else {
    const url = (data.url || '').trim();
    if (!url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Please enter a valid HTTPS URL',
      });
    } else {
      try {
        new URL(url);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'Please enter a valid HTTPS URL',
        });
      }
    }
  }
});

type FormData = z.infer<typeof formSchema>;

interface WebhookFormProps {
  onSubmit: (data: {
    name: string;
    url: string;
    events: string[];
    checkFilter?: WebhookCheckFilter;
    secret?: string;
    headers?: { [key: string]: string };
    webhookType?: WebhookPlatformType;
  }) => void;
  loading?: boolean;
  isOpen: boolean;
  onClose: () => void;
  editingWebhook?: {
    id: string;
    name: string;
    url: string;
    events: string[];
    checkFilter?: WebhookCheckFilter;
    secret?: string;
    headers?: { [key: string]: string };
    webhookType?: WebhookPlatformType;
  } | null;
  checks: Website[];
  // Which page this form is rendered on. Drives labels and default platform.
  scope?: IntegrationScope;
  // Restricts the Platform dropdown so users can't create a Pushover from
  // the Webhooks page, etc.
  allowedPlatformTypes?: readonly WebhookPlatformType[];
}

// Display labels for each platform — used to label dropdown options.
const PLATFORM_LABEL: Record<WebhookPlatformType, string> = {
  generic: 'Generic Webhook',
  slack: 'Slack',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  pumble: 'Pumble',
  pagerduty: 'PagerDuty',
  opsgenie: 'Opsgenie',
  pushover: 'Pushover',
};

export default function WebhookForm({
  onSubmit,
  loading = false,
  isOpen,
  onClose,
  editingWebhook,
  checks,
  scope = 'webhook',
  allowedPlatformTypes,
}: WebhookFormProps) {
  const [checkSearch, setCheckSearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(!!editingWebhook);
  const [targetOpen, setTargetOpen] = useState(false);

  const labels = labelsForScope(scope);
  // When editing, allow the platform dropdown to surface whatever type the
  // existing webhook actually uses, even if it's outside this scope's list —
  // otherwise the form would silently mutate the type on save.
  const platformOptions = useMemo(() => {
    const base = allowedPlatformTypes ?? [];
    if (editingWebhook?.webhookType && !base.includes(editingWebhook.webhookType)) {
      return [...base, editingWebhook.webhookType];
    }
    return base;
  }, [allowedPlatformTypes, editingWebhook?.webhookType]);
  const defaultPlatform = defaultPlatformForScope(scope);

  // Derive unique folders from checks
  const availableFolders = useMemo(() => {
    const folders = new Set<string>();
    for (const check of checks) {
      const folder = (check.folder ?? '').trim();
      if (folder) folders.add(folder);
    }
    return Array.from(folders).sort();
  }, [checks]);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      url: '',
      events: [],
      checkFilterMode: 'all',
      checkIds: [],
      secret: '',
      customHeaders: '',
      webhookType: defaultPlatform,
      pushoverToken: '',
      pushoverUserKey: '',
      pushoverPriority: '0',
      pushoverSound: '',
      pushoverDevice: '',
      pushoverRetry: '',
      pushoverExpire: '',
      pushoverTtl: '',
    },
  });

  // Reset when opening
  React.useEffect(() => {
    if (isOpen) {
      setCheckSearch('');
    }
  }, [isOpen]);

  // Reset form when panel closes
  React.useEffect(() => {
    if (!isOpen) {
      setSettingsOpen(false);
      setTargetOpen(false);
    }
  }, [isOpen]);

  // Open settings by default in edit mode
  React.useEffect(() => {
    if (isOpen && editingWebhook) {
      setSettingsOpen(true);
      // Open target section if webhook uses include filter
      if (editingWebhook.checkFilter?.mode === 'include') {
        setTargetOpen(true);
      }
    }
  }, [isOpen, editingWebhook]);

  // Reset form when editing webhook changes
  React.useEffect(() => {
    if (isOpen && editingWebhook) {
      const mode = editingWebhook.checkFilter?.mode === 'include' ? 'include' : 'all';
      const ids = editingWebhook.checkFilter?.checkIds ?? [];
      const folders = editingWebhook.checkFilter?.folderPaths ?? [];
      const pushover = editingWebhook.webhookType === 'pushover'
        ? parsePushoverUrl(editingWebhook.url)
        : EMPTY_PUSHOVER_FIELDS;
      form.reset({
        name: editingWebhook.name,
        url: editingWebhook.url,
        events: editingWebhook.events,
        checkFilterMode: mode,
        checkIds: mode === 'include' ? ids : [],
        folderPaths: mode === 'include' ? folders : [],
        secret: editingWebhook.secret || '',
        customHeaders: editingWebhook.headers ? JSON.stringify(editingWebhook.headers, null, 2) : '',
        webhookType: editingWebhook.webhookType || 'generic',
        pushoverToken: pushover.token,
        pushoverUserKey: pushover.user,
        pushoverPriority: pushover.priority,
        pushoverSound: pushover.sound,
        pushoverDevice: pushover.device,
        pushoverRetry: pushover.retry,
        pushoverExpire: pushover.expire,
        pushoverTtl: pushover.ttl,
      });
    } else if (isOpen && !editingWebhook) {
      form.reset({
        name: '',
        url: '',
        events: [],
        checkFilterMode: 'all',
        checkIds: [],
        folderPaths: [],
        secret: '',
        customHeaders: '',
        webhookType: defaultPlatform,
        pushoverToken: '',
        pushoverUserKey: '',
        pushoverPriority: '0',
        pushoverSound: '',
        pushoverDevice: '',
        pushoverRetry: '',
        pushoverExpire: '',
        pushoverTtl: '',
      });
    }
  }, [editingWebhook?.id]); // Only depend on the ID, not the entire object

  React.useEffect(() => {
    if (!isOpen || !editingWebhook) return;
    const mode = form.getValues('checkFilterMode');
    const ids = form.getValues('checkIds') || [];
    if (mode !== 'include' || ids.length > 0) return;
    if (checks.length === 0) return;
    if (editingWebhook.checkFilter?.mode === 'include') return;
    form.setValue(
      'checkIds',
      checks.map((check) => check.id),
      { shouldDirty: false }
    );
  }, [isOpen, editingWebhook?.id, checks, form]);

  const handleClose = () => {
    form.reset();
    setCheckSearch('');
    setSettingsOpen(false);
    setTargetOpen(false);
    onClose();
  };

  const handleSubmit = (data: FormData) => {
    try {
      let headers = {};
      if (data.customHeaders?.trim()) {
        headers = JSON.parse(data.customHeaders);
      }

      const checkFilter: WebhookCheckFilter =
        data.checkFilterMode === 'include'
          ? { mode: 'include', checkIds: data.checkIds || [], folderPaths: data.folderPaths || [] }
          : { mode: 'all' };

      // For Pushover we build the storage URL from the dedicated form fields;
      // for every other platform the user pasted a URL directly.
      const finalUrl = data.webhookType === 'pushover'
        ? buildPushoverUrl({
            token: (data.pushoverToken || '').trim(),
            user: (data.pushoverUserKey || '').trim(),
            priority: (data.pushoverPriority || '0') as PushoverFields['priority'],
            sound: data.pushoverSound || '',
            device: data.pushoverDevice || '',
            retry: data.pushoverRetry || '',
            expire: data.pushoverExpire || '',
            ttl: data.pushoverTtl || '',
          })
        : (data.url || '').trim();

      onSubmit({
        name: data.name,
        url: finalUrl,
        events: data.events,
        checkFilter,
        secret: data.secret || undefined,
        headers,
        webhookType: data.webhookType,
      });

      handleClose();
    } catch (error) {
      form.setError('customHeaders', {
        type: 'manual',
        message: 'Invalid JSON format'
      });
    }
  };

  const watchFilterMode = form.watch('checkFilterMode');
  const watchWebhookType = form.watch('webhookType');
  const watchPushoverPriority = form.watch('pushoverPriority');

  const urlHint: { placeholder: string; description: React.ReactNode } = (() => {
    switch (watchWebhookType) {
      case 'pagerduty':
        return {
          placeholder: 'https://events.pagerduty.com/v2/enqueue?routing_key=YOUR_KEY',
          description: (
            <>
              Paste the Events API v2 URL with your <code>routing_key</code> appended as a query
              parameter. Down/up events auto-resolve via dedup_key.
            </>
          ),
        };
      case 'opsgenie':
        return {
          placeholder: 'https://api.opsgenie.com/v2/alerts',
          description: (
            <>
              Use the Alert API URL above. Add an <code>Authorization: GenieKey YOUR_KEY</code>{' '}
              header under Advanced. Down/up events auto-close via alias.
            </>
          ),
        };
      case 'slack':
        return {
          placeholder: 'https://hooks.slack.com/services/...',
          description: (
            <>
              HTTPS only. Try{' '}
              <a
                href="https://webhook.site"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                webhook.site
              </a>
              {' '}for testing.
            </>
          ),
        };
      case 'pumble':
        return {
          placeholder: 'https://api.pumble.com/workspaces/.../incomingWebhooks/postMessage/...',
          description: (
            <>
              HTTPS only. Paste the incoming webhook URL from Pumble (Apps → Incoming Webhooks).
            </>
          ),
        };
      case 'discord':
        return {
          placeholder: 'https://discord.com/api/webhooks/...',
          description: (
            <>
              HTTPS only. Try{' '}
              <a
                href="https://webhook.site"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                webhook.site
              </a>
              {' '}for testing.
            </>
          ),
        };
      case 'teams':
        return {
          placeholder: 'https://YOUR_TENANT.webhook.office.com/...',
          description: (
            <>
              HTTPS only. Try{' '}
              <a
                href="https://webhook.site"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                webhook.site
              </a>
              {' '}for testing.
            </>
          ),
        };
      default:
        return {
          placeholder: 'https://example.com/hooks/exit1',
          description: (
            <>
              HTTPS only. Try{' '}
              <a
                href="https://webhook.site"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                webhook.site
              </a>
              {' '}for testing.
            </>
          ),
        };
    }
  })();

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0">
        <SheetTitle className="sr-only">{editingWebhook ? labels.formEditTitle : labels.formNewTitle}</SheetTitle>
        <ScrollArea className="h-full">
          <div className="p-7 sm:p-8">
            {/* Header */}
            <div className="flex items-center gap-3 mb-8">
              <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
                <Webhook className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">
                  {editingWebhook ? labels.formEditTitle : labels.formNewTitle}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {editingWebhook ? labels.formEditSubtitle : labels.formNewSubtitle}
                </p>
              </div>
            </div>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(handleSubmit)}
                className="space-y-6"
              >
                {/* ── Essential Fields ── */}
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-muted-foreground">Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Slack Alerts"
                            className="h-10 text-sm"
                            autoFocus
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="webhookType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-muted-foreground">Platform</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="h-10 text-sm">
                              <SelectValue placeholder="Select platform" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {platformOptions.map((type) => (
                              <SelectItem key={type} value={type}>
                                {PLATFORM_LABEL[type]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {watchWebhookType !== 'pushover' ? (
                    <FormField
                      control={form.control}
                      name="url"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-medium text-muted-foreground">Endpoint URL</FormLabel>
                          <FormControl>
                            <Input
                              type="url"
                              placeholder={urlHint.placeholder}
                              className="h-10 text-sm font-mono"
                              {...field}
                            />
                          </FormControl>
                          <FormDescription className="text-xs">
                            {urlHint.description}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ) : (
                    <div className="space-y-4 rounded-xl border border-border/30 bg-muted/10 p-4">
                      <p className="text-xs text-muted-foreground">
                        Pushover credentials live on the device. Create an application at{' '}
                        <a
                          href="https://pushover.net/apps/build"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          pushover.net/apps/build
                        </a>
                        {' '}to get your API token. Your user key is on the{' '}
                        <a
                          href="https://pushover.net"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          dashboard
                        </a>
                        .
                      </p>

                      <FormField
                        control={form.control}
                        name="pushoverToken"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-muted-foreground">App API Token</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi"
                                className="h-10 text-sm font-mono"
                                autoComplete="off"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              30 characters, letters and digits only.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="pushoverUserKey"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-muted-foreground">User or Group Key</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="uQiRzpo4DXghDmr9QzzfQu27cmVRsG"
                                className="h-10 text-sm font-mono"
                                autoComplete="off"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              30 characters. Find it on your Pushover dashboard.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="pushoverPriority"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-muted-foreground">Default priority</FormLabel>
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger className="h-10 text-sm">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="-2">Lowest — no notification, badge only</SelectItem>
                                <SelectItem value="-1">Low — quiet, no sound</SelectItem>
                                <SelectItem value="0">Normal — default device behavior</SelectItem>
                                <SelectItem value="1">High — always alerts, bypasses quiet hours</SelectItem>
                                <SelectItem value="2">Emergency — repeats until acknowledged</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormDescription className="text-xs">
                              Critical events (down, errors, SSL/domain expired, DNS failed) are always sent at least at <strong>High</strong> so you don&apos;t sleep through outages. Non-critical events (recoveries, warnings) follow your default but are capped at <strong>High</strong> — so picking Emergency only pages you for outages, not recoveries. A check&apos;s <strong>severity</strong> (P1–P5, in its settings) overrides this default: P1 outages page at Emergency until acknowledged, P4–P5 stay quiet.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {watchPushoverPriority === '2' && (
                        <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                          <p className="text-xs text-amber-200/90">
                            <strong>Emergency priority</strong> requires both fields below. Pushover will keep re-sending until you tap acknowledge in the app.
                          </p>
                          <FormField
                            control={form.control}
                            name="pushoverRetry"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-muted-foreground">Retry Interval (seconds)</FormLabel>
                                <FormControl>
                                  <Input
                                    type="number"
                                    inputMode="numeric"
                                    placeholder={String(PUSHOVER_EMERGENCY_RETRY_DEFAULT)}
                                    min={PUSHOVER_EMERGENCY_RETRY_MIN_SEC}
                                    className="h-10 text-sm font-mono"
                                    {...field}
                                  />
                                </FormControl>
                                <FormDescription className="text-xs">
                                  How often Pushover retries the notification. Minimum {PUSHOVER_EMERGENCY_RETRY_MIN_SEC}s. Leave blank for {PUSHOVER_EMERGENCY_RETRY_DEFAULT}s default.
                                </FormDescription>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={form.control}
                            name="pushoverExpire"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium text-muted-foreground">Retry Expiration (seconds)</FormLabel>
                                <FormControl>
                                  <Input
                                    type="number"
                                    inputMode="numeric"
                                    placeholder={String(PUSHOVER_EMERGENCY_EXPIRE_DEFAULT)}
                                    min={PUSHOVER_EMERGENCY_RETRY_MIN_SEC}
                                    max={PUSHOVER_EMERGENCY_EXPIRE_MAX_SEC}
                                    className="h-10 text-sm font-mono"
                                    {...field}
                                  />
                                </FormControl>
                                <FormDescription className="text-xs">
                                  Pushover stops retrying after this many seconds. Max {PUSHOVER_EMERGENCY_EXPIRE_MAX_SEC}s (3 hours). Leave blank for {PUSHOVER_EMERGENCY_EXPIRE_DEFAULT}s default.
                                </FormDescription>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      )}

                      {watchPushoverPriority !== '2' && (
                        <FormField
                          control={form.control}
                          name="pushoverTtl"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium text-muted-foreground">Time to live (optional, seconds)</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  placeholder="e.g. 600"
                                  min={1}
                                  className="h-10 text-sm font-mono"
                                  {...field}
                                />
                              </FormControl>
                              <FormDescription className="text-xs">
                                Pushover auto-deletes the notification after this many seconds. Leave blank to keep it indefinitely. Incompatible with Emergency priority.
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}

                      <FormField
                        control={form.control}
                        name="pushoverSound"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-muted-foreground">Sound (optional)</FormLabel>
                            <Select
                              value={field.value || 'default'}
                              onValueChange={(v) => field.onChange(v === 'default' ? '' : v)}
                            >
                              <FormControl>
                                <SelectTrigger className="h-10 text-sm">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="default">Device default</SelectItem>
                                {PUSHOVER_SOUNDS.map((s) => (
                                  <SelectItem key={s} value={s}>{s}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="pushoverDevice"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-muted-foreground">Device (optional)</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="phone,tablet"
                                className="h-10 text-sm font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              Leave blank to send to all your devices. Comma-separated for multiple specific devices.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>

                {/* ── Event Types ── */}
                <FormField
                  control={form.control}
                  name="events"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="text-xs font-medium text-muted-foreground">Events</FormLabel>
                        <span className="text-xs text-muted-foreground">
                          {(field.value || []).length} selected
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {WEBHOOK_EVENTS.map((evt) => {
                          const selected = (field.value || []).includes(evt.value);
                          const Icon = evt.icon;
                          const toggle = () => {
                            const next = selected
                              ? (field.value || []).filter((v: string) => v !== evt.value)
                              : [...(field.value || []), evt.value];
                            field.onChange(next);
                          };
                          return (
                            <button
                              key={evt.value}
                              type="button"
                              onClick={toggle}
                              className={`flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all cursor-pointer ${
                                selected
                                  ? 'border-primary/40 bg-primary/5'
                                  : 'border-border/30 hover:border-border/60 bg-muted/10'
                              }`}
                            >
                              <div className={`flex items-center justify-center w-7 h-7 rounded-lg shrink-0 ${
                                selected
                                  ? evt.color === 'red'
                                    ? 'bg-destructive/15 text-destructive'
                                    : evt.color === 'yellow'
                                    ? 'bg-warning/15 text-warning'
                                    : 'bg-primary/15 text-primary'
                                  : 'bg-muted/60 text-muted-foreground'
                              }`}>
                                <Icon className="w-3.5 h-3.5" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium leading-tight truncate">{evt.label}</div>
                              </div>
                              {selected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* ── Submit Button ── */}
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 text-sm font-medium"
                >
                  {loading ? (
                    <>
                      <Zap className="w-4 h-4 mr-2 animate-pulse" />
                      {editingWebhook ? 'Updating...' : 'Creating...'}
                    </>
                  ) : (
                    <>
                      {editingWebhook ? <Check className="w-4 h-4 mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                      {editingWebhook ? `Update ${labels.formIconLabel}` : `Create ${labels.formIconLabel}`}
                    </>
                  )}
                </Button>

                {/* ── Target Checks (collapsible) ── */}
                <Collapsible open={targetOpen} onOpenChange={setTargetOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 w-full py-3 group cursor-pointer">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors px-2">
                      <FolderOpen className="w-3.5 h-3.5" />
                      Target checks
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${targetOpen ? 'rotate-180' : ''}`} />
                    </span>
                    <div className="h-px flex-1 bg-border/60" />
                  </CollapsibleTrigger>

                  <CollapsibleContent className="space-y-4 pt-2">
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                      <FormField
                        control={form.control}
                        name="checkFilterMode"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs font-medium">Apply to</FormLabel>
                              <Select value={field.value} onValueChange={field.onChange}>
                                <FormControl>
                                  <SelectTrigger className="h-8 text-xs w-auto min-w-[150px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="all">All checks</SelectItem>
                                  <SelectItem value="include">Selected checks</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </FormItem>
                        )}
                      />

                      {watchFilterMode === 'include' && availableFolders.length > 0 && (
                        <FormField
                          control={form.control}
                          name="folderPaths"
                          render={({ field }) => {
                            const value = field.value || [];
                            return (
                              <FormItem>
                                <div className="flex items-center justify-between">
                                  <FormLabel className="text-xs font-medium">Folders</FormLabel>
                                  <span className="text-xs text-muted-foreground">
                                    {value.length} selected
                                  </span>
                                </div>
                                <FormDescription className="text-xs">
                                  New checks added to selected folders are auto-included.
                                </FormDescription>
                                <FormControl>
                                  <div className="space-y-1 rounded-lg border border-border/30 p-2 max-h-40 overflow-y-auto">
                                    {availableFolders.map((folder) => {
                                      const checked = value.includes(folder);
                                      const count = checks.filter(c => {
                                        const f = (c.folder ?? '').trim();
                                        return f === folder || f.startsWith(folder + '/');
                                      }).length;
                                      return (
                                        <Label
                                          key={folder}
                                          htmlFor={`folder-${folder}`}
                                          className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 cursor-pointer"
                                        >
                                          <Checkbox
                                            id={`folder-${folder}`}
                                            checked={checked}
                                            onCheckedChange={(next) => {
                                              const isChecked = Boolean(next);
                                              const nextValue = isChecked
                                                ? [...value, folder]
                                                : value.filter((f: string) => f !== folder);
                                              field.onChange(nextValue);
                                            }}
                                            className="cursor-pointer"
                                          />
                                          <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
                                          <span className="text-xs font-medium">{folder}</span>
                                          <span className="text-[10px] text-muted-foreground ml-auto">{count}</span>
                                        </Label>
                                      );
                                    })}
                                  </div>
                                </FormControl>
                              </FormItem>
                            );
                          }}
                        />
                      )}

                      {watchFilterMode === 'include' && (
                        <FormField
                          control={form.control}
                          name="checkIds"
                          render={({ field }) => {
                            const value = field.value || [];
                            const term = checkSearch.trim().toLowerCase();
                            const filteredChecks = term
                              ? checks.filter((check) =>
                                  (check.name || '').toLowerCase().includes(term) ||
                                  (check.url || '').toLowerCase().includes(term)
                                )
                              : checks;
                            return (
                              <FormItem>
                                <div className="flex items-center justify-between">
                                  <FormLabel className="text-xs font-medium">
                                    {availableFolders.length > 0 ? 'Individual checks' : 'Checks'}
                                  </FormLabel>
                                  <span className="text-xs text-muted-foreground">
                                    {value.length} selected
                                  </span>
                                </div>
                                <FormControl>
                                  <div className="space-y-2">
                                    <Input
                                      placeholder="Search checks..."
                                      value={checkSearch}
                                      onChange={(event) => setCheckSearch(event.target.value)}
                                      className="h-8 text-xs"
                                    />
                                    <ScrollArea className="h-56 rounded-lg border border-border/30">
                                      {filteredChecks.length === 0 ? (
                                        <div className="p-3 text-xs text-muted-foreground">
                                          {checks.length === 0 ? 'No checks found yet.' : 'No checks match your search.'}
                                        </div>
                                      ) : (
                                        <div className="p-2 space-y-0.5">
                                          {filteredChecks.map((check) => {
                                            const checked = value.includes(check.id);
                                            return (
                                              <Label
                                                key={check.id}
                                                htmlFor={`check-${check.id}`}
                                                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 cursor-pointer"
                                              >
                                                <Checkbox
                                                  id={`check-${check.id}`}
                                                  checked={checked}
                                                  onCheckedChange={(next) => {
                                                    const isChecked = Boolean(next);
                                                    const nextValue = isChecked
                                                      ? [...value, check.id]
                                                      : value.filter((id: string) => id !== check.id);
                                                    field.onChange(nextValue);
                                                  }}
                                                  className="cursor-pointer"
                                                />
                                                <div className="flex flex-col min-w-0">
                                                  <span className="text-xs font-medium truncate">{check.name || check.url}</span>
                                                  <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[260px]">
                                                    {check.url}
                                                  </span>
                                                </div>
                                              </Label>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </ScrollArea>
                                  </div>
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            );
                          }}
                        />
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                {/* ── Advanced Settings (collapsible) ── */}
                <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 w-full py-3 group cursor-pointer">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors px-2">
                      <Settings className="w-3.5 h-3.5" />
                      Advanced
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} />
                    </span>
                    <div className="h-px flex-1 bg-border/60" />
                  </CollapsibleTrigger>

                  <CollapsibleContent className="space-y-4 pt-2">
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                      <FormField
                        control={form.control}
                        name="secret"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium flex items-center gap-1.5">
                              Signing secret
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[240px]">
                                  <p className="text-xs">Adds an X-Exit1-Signature header with HMAC-SHA256 hash so you can verify the payload authenticity.</p>
                                </TooltipContent>
                              </Tooltip>
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="password"
                                placeholder="Optional"
                                className="h-8 text-xs"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="customHeaders"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium">Custom headers</FormLabel>
                            <FormControl>
                              <Textarea
                                placeholder={'{\n  "Authorization": "Bearer your-token"\n}'}
                                className="font-mono text-xs resize-y min-h-[80px]"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              JSON format
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </form>
            </Form>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
