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

const formSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  url: z.string().url('Please enter a valid HTTPS URL'),
  events: z.array(z.string()).min(1, 'Please select at least one event type'),
  checkFilterMode: z.enum(['all', 'include']),
  checkIds: z.array(z.string()).optional(),
  folderPaths: z.array(z.string()).optional(),
  secret: z.string().optional(),
  customHeaders: z.string().optional(),
  webhookType: z.enum(['slack', 'discord', 'teams', 'generic']),
}).superRefine((data, ctx) => {
  if (data.checkFilterMode === 'include' && (!data.checkIds || data.checkIds.length === 0) && (!data.folderPaths || data.folderPaths.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['checkIds'],
      message: 'Select at least one check or folder',
    });
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
    webhookType?: 'slack' | 'discord' | 'teams' | 'generic';
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
    webhookType?: 'slack' | 'discord' | 'teams' | 'generic';
  } | null;
  checks: Website[];
}

export default function WebhookForm({ onSubmit, loading = false, isOpen, onClose, editingWebhook, checks }: WebhookFormProps) {
  const [checkSearch, setCheckSearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(!!editingWebhook);
  const [targetOpen, setTargetOpen] = useState(false);

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
      webhookType: 'generic',
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
        webhookType: 'generic',
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

      onSubmit({
        name: data.name,
        url: data.url,
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

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0">
        <SheetTitle className="sr-only">{editingWebhook ? 'Edit Webhook' : 'New Webhook'}</SheetTitle>
        <ScrollArea className="h-full">
          <div className="p-7 sm:p-8">
            {/* Header */}
            <div className="flex items-center gap-3 mb-8">
              <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
                <Webhook className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">
                  {editingWebhook ? 'Edit Webhook' : 'New Webhook'}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {editingWebhook ? 'Update your webhook configuration' : 'Send alerts to any endpoint'}
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
                    name="url"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-muted-foreground">Endpoint URL</FormLabel>
                        <FormControl>
                          <Input
                            type="url"
                            placeholder="https://hooks.slack.com/services/..."
                            className="h-10 text-sm font-mono"
                            {...field}
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
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
                        </FormDescription>
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
                            <SelectItem value="generic">Generic Webhook</SelectItem>
                            <SelectItem value="slack">Slack</SelectItem>
                            <SelectItem value="discord">Discord</SelectItem>
                            <SelectItem value="teams">Microsoft Teams</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
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
                                    ? 'bg-amber-500/15 text-amber-500'
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
                      {editingWebhook ? 'Update Webhook' : 'Create Webhook'}
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
