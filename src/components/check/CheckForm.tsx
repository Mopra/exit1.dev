"use client"

import { useMemo, useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Button,
  Input,
  CheckIntervalSelector,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormDescription,
  FormMessage,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  ScrollArea,
  Checkbox,
  Sheet,
  SheetContent,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  glassClasses
} from '../ui';
import {
  Globe,
  Code,
  Plus,
  Zap,
  ArrowRight,
  Check,
  Copy
} from 'lucide-react';
import type { Website } from '../../types';
import { copyToClipboard } from '../../utils/clipboard';
import { toast } from 'sonner';
import { getDefaultExpectedStatusCodesValue, getDefaultHttpMethod } from '../../lib/check-defaults';
// NOTE: No tier-based enforcement. Keep form behavior tier-agnostic for now.

const RESPONSE_TIME_LIMIT_MAX_MS = 15000;

const formSchema = z.object({
  name: z.string().min(1, 'Display name is required'),
  url: z.string().min(1, 'URL is required'),
  type: z.enum(['website', 'rest_endpoint']),
  // Only allow supported values (in seconds): 60, 120, 300, 3600, 86400
  checkFrequency: z.union([
    z.literal(60),
    z.literal(120),
    z.literal(300),
    z.literal(600),
    z.literal(900),
    z.literal(1800),
    z.literal(3600),
    z.literal(86400),
  ]),
  responseTimeLimit: z
    .string()
    .optional()
    .refine((value) => {
      if (!value || !value.trim()) return true;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 && parsed <= RESPONSE_TIME_LIMIT_MAX_MS;
    }, { message: `Response time limit must be between 1 and ${RESPONSE_TIME_LIMIT_MAX_MS} ms` }),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
  expectedStatusCodes: z.string().optional(),
  requestHeaders: z.string().optional(),
  requestBody: z.string().optional(),
  containsText: z.string().optional(),
  immediateRecheckEnabled: z.boolean().optional(),
});

type FormData = z.infer<typeof formSchema>;

type UrlProtocol = 'https://' | 'http://';

const DEFAULT_URL_PROTOCOL: UrlProtocol = 'https://';

const splitUrlProtocol = (value?: string | null): { protocol: UrlProtocol; rest: string } => {
  const raw = (value ?? '').trim();
  if (!raw) {
    return { protocol: DEFAULT_URL_PROTOCOL, rest: '' };
  }
  const match = raw.match(/^(https?:\/\/)(.*)$/i);
  if (!match) {
    return { protocol: DEFAULT_URL_PROTOCOL, rest: raw };
  }
  const protocol = match[1].toLowerCase() === 'http://' ? 'http://' : 'https://';
  return { protocol, rest: match[2] };
};

const buildFullUrl = (value: string, protocol: UrlProtocol): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `${protocol}${trimmed}`;
};

interface CheckFormProps {
  mode?: 'create' | 'edit';
  initialCheck?: Website | null;
  onSubmit: (data: {
    id?: string;
    name: string;
    url: string;
    type: 'website' | 'rest_endpoint';
    checkFrequency?: number;
    responseTimeLimit?: number | null;
    httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    expectedStatusCodes?: number[];
    requestHeaders?: { [key: string]: string };
    requestBody?: string;
    responseValidation?: {
      containsText?: string[];
      jsonPath?: string;
      expectedValue?: unknown;
    };
    immediateRecheckEnabled?: boolean;
  }) => Promise<void>;
  loading?: boolean;
  isOpen: boolean;
  onClose: () => void;
  prefillWebsiteUrl?: string | null;
}

export default function CheckForm({
  mode = 'create',
  initialCheck = null,
  onSubmit,
  loading = false,
  isOpen,
  onClose,
  prefillWebsiteUrl
}: CheckFormProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [copiedCheckId, setCopiedCheckId] = useState(false);
  const [urlProtocol, setUrlProtocol] = useState<UrlProtocol>(DEFAULT_URL_PROTOCOL);

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      url: prefillWebsiteUrl ? splitUrlProtocol(prefillWebsiteUrl).rest : '',
      type: 'website',
      checkFrequency: 3600, // Default to 1 hour (seconds)
      responseTimeLimit: '',
      httpMethod: getDefaultHttpMethod('website'),
      expectedStatusCodes: getDefaultExpectedStatusCodesValue('website'),
      requestHeaders: '',
      requestBody: '',
      containsText: '',
      immediateRecheckEnabled: true, // Default to enabled
    },
  });

  const watchHttpMethod = form.watch('httpMethod');

  const effectiveCheck = useMemo(() => {
    if (mode !== 'edit') return null;
    return initialCheck;
  }, [mode, initialCheck]);

  // Ensure form closes when isOpen becomes false
  useEffect(() => {
    if (!isOpen) {
      form.reset();
      setCurrentStep(1);
      setCopiedCheckId(false);
      setUrlProtocol(DEFAULT_URL_PROTOCOL);
    }
  }, [isOpen, form]);

  useEffect(() => {
    // Reset copied state when edit target changes
    setCopiedCheckId(false);
  }, [effectiveCheck?.id]);

  // Prefill the form when editing an existing check
  useEffect(() => {
    if (!isOpen) return;
    if (mode !== 'edit') return;
    if (!effectiveCheck) return;

    const { protocol, rest } = splitUrlProtocol(effectiveCheck.url);
    const cleanUrl = rest;
    const seconds = (effectiveCheck.checkFrequency ?? 60) * 60; // stored as minutes
    const safeSeconds = [60, 120, 300, 600, 900, 1800, 3600, 86400].includes(seconds) ? seconds : 3600;

    const type: 'website' | 'rest_endpoint' =
      effectiveCheck.type === 'rest_endpoint' ? 'rest_endpoint' : 'website';

    const expectedStatusCodes =
      effectiveCheck.expectedStatusCodes?.length
        ? effectiveCheck.expectedStatusCodes.join(',')
        : getDefaultExpectedStatusCodesValue(type);

    const requestHeaders =
      effectiveCheck.requestHeaders
        ? Object.entries(effectiveCheck.requestHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
        : '';

    const containsText = effectiveCheck.responseValidation?.containsText?.length
      ? effectiveCheck.responseValidation.containsText.join(',')
      : '';
    const responseTimeLimit =
      typeof effectiveCheck.responseTimeLimit === 'number'
        ? String(effectiveCheck.responseTimeLimit)
        : '';

    setUrlProtocol(protocol);

    form.reset({
      name: effectiveCheck.name ?? '',
      url: cleanUrl,
      type,
      checkFrequency: safeSeconds as any,
      responseTimeLimit,
      httpMethod: (effectiveCheck.httpMethod as any) ?? getDefaultHttpMethod(type),
      expectedStatusCodes,
      requestHeaders,
      requestBody: effectiveCheck.requestBody ?? '',
      containsText,
      immediateRecheckEnabled: effectiveCheck.immediateRecheckEnabled !== false,
    });

    setCurrentStep(1);
  }, [isOpen, mode, effectiveCheck, form]);

  // Handle prefill website URL when form opens
  useEffect(() => {
    if (mode !== 'create') return;
    if (isOpen && prefillWebsiteUrl) {
      const { protocol, rest } = splitUrlProtocol(prefillWebsiteUrl);
      const cleanUrl = rest;
      setUrlProtocol(protocol);
      form.setValue('url', cleanUrl);

      // Auto-generate name from the pre-filled URL
      try {
        const fullUrl = buildFullUrl(cleanUrl, protocol);
        const url = new URL(fullUrl);
        const hostname = url.hostname;

        if (hostname && hostname.length > 0) {
          let friendlyName = hostname
            .replace(/^www\./, '')
            .split('.')
            .slice(0, -1)
            .join('.')
            .replace(/[-_.]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

          if (!friendlyName || friendlyName.length < 2) {
            const domainWithoutExtension = hostname
              .replace(/^www\./, '')
              .split('.')
              .slice(0, -1)
              .join('.');
            friendlyName = domainWithoutExtension || hostname.replace(/^www\./, '');
          }

          form.setValue('name', friendlyName);
        }
      } catch (error) {
        console.error('Error generating name from URL:', error);
        // If URL parsing fails, just set the name to the domain
        form.setValue('name', cleanUrl);
      }
    }
  }, [isOpen, prefillWebsiteUrl, form]);

  // Auto-generate name from URL when URL changes
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawUrl = e.target.value;
    const protocolMatch = rawUrl.match(/^(https?:\/\/)(.*)$/i);
    const nextProtocol = protocolMatch
      ? (protocolMatch[1].toLowerCase() === 'http://' ? 'http://' : 'https://')
      : urlProtocol;
    const nextUrl = protocolMatch ? protocolMatch[2] : rawUrl;

    if (nextProtocol !== urlProtocol) {
      setUrlProtocol(nextProtocol);
    }

    form.setValue('url', nextUrl);

    if (!nextUrl.trim()) {
      form.setValue('name', '');
      return;
    }

    try {
      if (nextUrl.length > 0) {
        const fullUrl = buildFullUrl(nextUrl, nextProtocol);
        const url = new URL(fullUrl);
        const hostname = url.hostname;

        if (hostname && hostname.length > 0) {
          let friendlyName = hostname
            .replace(/^www\./, '')
            .split('.')
            .slice(0, -1)
            .join('.')
            .replace(/[-_.]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

          if (!friendlyName || friendlyName.length < 2) {
            const domainWithoutExtension = hostname
              .replace(/^www\./, '')
              .split('.')
              .slice(0, -1)
              .join('.');
            friendlyName = domainWithoutExtension || hostname.replace(/^www\./, '');
          }

          form.setValue('name', friendlyName);
        }
      } else {
        form.setValue('name', '');
      }
    } catch {
      form.setValue('name', '');
    }
  };

  // Reset HTTP method and status codes when type changes
  const handleTypeChange = (newType: 'website' | 'rest_endpoint') => {
    form.setValue('type', newType);
    form.setValue('httpMethod', getDefaultHttpMethod(newType));
    form.setValue('expectedStatusCodes', getDefaultExpectedStatusCodesValue(newType));
  };

  const onFormSubmit = async (data: FormData) => {
    const fullUrl = buildFullUrl(data.url, urlProtocol);

    const statusCodes = data.expectedStatusCodes
      ? data.expectedStatusCodes
        .split(',')
        .map((s: string) => parseInt(s.trim()))
        .filter((n: number) => !isNaN(n))
      : undefined;

    const headers: { [key: string]: string } = {};
    if (data.requestHeaders?.trim()) {
      data.requestHeaders.split('\n').forEach((line: string) => {
        const [key, value] = line.split(':').map((s: string) => s.trim());
        if (key && value) {
          headers[key] = value;
        }
      });
    }

    const validation: any = {};
    if (data.containsText?.trim()) {
      validation.containsText = data.containsText.split(',').map(s => s.trim()).filter(s => s);
    }

    const responseTimeLimitInput = data.responseTimeLimit?.trim();
    const responseTimeLimit = responseTimeLimitInput ? Number(responseTimeLimitInput) : null;

    const submitData = {
      id: effectiveCheck?.id,
      name: data.name,
      url: fullUrl,
      type: data.type,
      checkFrequency: Math.round(data.checkFrequency / 60), // Convert seconds to minutes
      responseTimeLimit,
      httpMethod: data.httpMethod,
      expectedStatusCodes: statusCodes,
      requestHeaders: headers,
      requestBody: data.requestBody,
      responseValidation: validation,
      immediateRecheckEnabled: data.immediateRecheckEnabled === true
    };

    try {
      await onSubmit(submitData);
      form.reset();
      setCurrentStep(1);
      onClose();
    } catch {
      // Parent shows error UI (e.g. ErrorModal). Keep the sheet open.
    }
  };

  const handleClose = () => {
    form.reset();
    setCurrentStep(1);
    setUrlProtocol(DEFAULT_URL_PROTOCOL);
    onClose();
  };

  const nextStep = () => {
    if (currentStep < 3) {
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  return (
    <>
      <Sheet
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) handleClose();
        }}
      >
        <SheetContent side="right" className="w-full max-w-md p-0">
          <ScrollArea className="h-full">
            <div className="p-6 space-y-6">
              {/* Header */}
              <div className="flex items-center">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                    {mode === 'edit' ? (
                      <EditIcon type={form.getValues('type')} />
                    ) : (
                      <Plus className="w-4 h-4 text-primary" />
                    )}
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold">{mode === 'edit' ? 'Edit Check' : 'New Check'}</h2>
                      {mode === 'edit' && effectiveCheck?.id && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={async () => {
                                const ok = await copyToClipboard(effectiveCheck.id);
                                if (ok) {
                                  setCopiedCheckId(true);
                                  toast.success('Check ID copied to clipboard');
                                  window.setTimeout(() => setCopiedCheckId(false), 2000);
                                } else {
                                  toast.error('Failed to copy Check ID');
                                }
                              }}
                              className="cursor-pointer transition-all hover:scale-105 active:scale-95 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded"
                              aria-label="Copy Check ID"
                            >
                              <Badge 
                                variant="secondary" 
                                className={`font-mono text-[10px] px-2 py-0.5 transition-colors ${
                                  copiedCheckId 
                                    ? 'bg-primary/20 text-primary border-primary/30' 
                                    : 'hover:bg-primary/10 hover:border-primary/20'
                                }`}
                              >
                                {copiedCheckId ? (
                                  <span className="flex items-center gap-1">
                                    <Check className="w-3 h-3" />
                                    Copied
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    <Copy className="w-3 h-3" />
                                    ID: {effectiveCheck.id.slice(0, 8)}…
                                  </span>
                                )}
                              </Badge>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className={`max-w-xs ${glassClasses}`}>
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center gap-2">
                                {copiedCheckId ? (
                                  <Check className="w-4 h-4 text-emerald-400" />
                                ) : (
                                  <Copy className="w-4 h-4 text-sky-300" />
                                )}
                                <span className={`font-medium text-sm ${copiedCheckId ? 'text-emerald-300' : 'text-sky-50'}`}>
                                  {copiedCheckId ? 'Copied!' : 'Click to copy Check ID'}
                                </span>
                              </div>
                              <span className="font-mono text-xs text-sky-100/80 break-all pl-6">
                                {effectiveCheck.id}
                              </span>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">Step {currentStep} of 3</p>
                  </div>
                </div>
              </div>

              {/* Progress Steps */}
              <div className="flex items-center gap-2">
                {[1, 2, 3].map((step) => (
                  <div
                    key={step}
                    className={`flex-1 h-1 rounded-full transition-colors ${step <= currentStep ? 'bg-primary' : 'bg-muted'
                      }`}
                  />
                ))}
              </div>

              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onFormSubmit)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    if (currentStep >= 3) return;
                    const target = e.target as HTMLElement | null;
                    // Allow Enter in textareas (new line) and any contenteditable.
                    if (target && (target.tagName === 'TEXTAREA' || (target as any).isContentEditable)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    nextStep();
                  }}
                  className="space-y-6"
                >
                  {/* Step 1: Check Type */}
                  {currentStep === 1 && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium">What are you monitoring?</h3>
                        <p className="text-xs text-muted-foreground">
                          Choose the type of service you want to monitor
                        </p>
                      </div>

                      <FormField
                        control={form.control}
                        name="type"
                        render={({ field }) => (
                          <FormItem className="space-y-3">
                            <FormControl>
                              <RadioGroup
                                onValueChange={(value) => {
                                  field.onChange(value);
                                  handleTypeChange(value as 'website' | 'rest_endpoint');
                                }}
                                value={field.value}
                                className="space-y-3"
                              >
                                <div className="relative">
                                  <RadioGroupItem
                                    value="website"
                                    id="website"
                                    className="peer sr-only"
                                  />
                                  <label
                                    htmlFor="website"
                                    className={`flex items-center gap-4 p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer hover:bg-primary/10 group ${field.value === 'website'
                                      ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                                      : 'border-border hover:border-primary'
                                      }`}
                                  >
                                    <div className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${field.value === 'website'
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-primary/10 text-primary'
                                      }`}>
                                      <Globe className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1">
                                      <div className="font-medium text-sm">Website</div>
                                      <div className="text-xs text-muted-foreground">Monitor website availability and performance</div>
                                    </div>
                                    <Check className={`w-5 h-5 transition-all ${field.value === 'website'
                                      ? 'text-primary opacity-100 scale-100'
                                      : 'text-muted-foreground opacity-0 scale-90'
                                      }`} />
                                  </label>
                                </div>

                                <div className="relative">
                                  <RadioGroupItem
                                    value="rest_endpoint"
                                    id="rest_endpoint"
                                    className="peer sr-only"
                                  />
                                  <label
                                    htmlFor="rest_endpoint"
                                    className={`flex items-center gap-4 p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer hover:bg-primary/10 dark:hover:bg-primary/10 group ${field.value === 'rest_endpoint'
                                      ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                                      : 'border-border hover:border-primary dark:hover:border-primary'
                                      }`}
                                  >
                                    <div className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors ${field.value === 'rest_endpoint'
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-primary/10 text-primary'
                                      }`}>
                                      <Code className="w-5 h-5" />
                                    </div>
                                    <div className="flex-1">
                                      <div className="font-medium text-sm">API Endpoint</div>
                                      <div className="text-xs text-muted-foreground">Monitor REST APIs and microservices</div>
                                    </div>
                                    <Check className={`w-5 h-5 transition-all ${field.value === 'rest_endpoint'
                                      ? 'text-primary opacity-100 scale-100'
                                      : 'text-muted-foreground opacity-0 scale-90'
                                      }`} />
                                  </label>
                                </div>
                              </RadioGroup>
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  )}

                  {/* Step 2: Basic Information */}
                  {currentStep === 2 && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium">Basic Information</h3>
                        <p className="text-xs text-muted-foreground">
                          Tell us about the service you want to monitor
                        </p>
                      </div>

                      <div className="space-y-4">
                        <FormField
                          control={form.control}
                          name="url"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">URL to monitor</FormLabel>
                              <FormControl>
                                <div className="flex">
                                  <Select
                                    value={urlProtocol}
                                    onValueChange={(value) => setUrlProtocol(value as UrlProtocol)}
                                  >
                                    <SelectTrigger className="h-9 rounded-r-none border-r-0 px-2 text-xs font-mono">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="https://">https://</SelectItem>
                                      <SelectItem value="http://">http://</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <Input
                                    {...field}
                                    onChange={handleUrlChange}
                                    placeholder="example.com"
                                    className="h-9 rounded-l-none"
                                  />
                                </div>
                              </FormControl>
                              <FormDescription className="text-xs">
                                Enter the domain or full URL to monitor
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="name"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">Display name</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  placeholder="My Website"
                                  className="h-9"
                                />
                              </FormControl>
                              <FormDescription className="text-xs">
                                A friendly name to identify this check
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="checkFrequency"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">Check frequency</FormLabel>
                              <FormControl>
                                <CheckIntervalSelector
                                  value={field.value}
                                  onChange={field.onChange}
                                  helperText="How often should we check this endpoint?"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="responseTimeLimit"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">Response time limit (ms)</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  type="number"
                                  min={1}
                                  max={RESPONSE_TIME_LIMIT_MAX_MS}
                                  step={100}
                                  placeholder="10000"
                                  className="h-9"
                                />
                              </FormControl>
                              <FormDescription className="text-xs">
                                Send a warning if responses exceed this limit while still up. Max {RESPONSE_TIME_LIMIT_MAX_MS}ms.
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="immediateRecheckEnabled"
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                              <FormControl>
                                <Checkbox
                                  checked={field.value === true}
                                  onCheckedChange={(checked) => field.onChange(checked === true)}
                                />
                              </FormControl>
                              <div className="space-y-1 leading-none">
                                <FormLabel className="text-xs font-medium cursor-pointer">
                                  Enable immediate re-check
                                </FormLabel>
                                <FormDescription className="text-xs">
                                  Automatically re-check failed endpoints after 30 seconds to verify transient errors
                                </FormDescription>
                              </div>
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  )}

                  {/* Step 3: Advanced Options */}
                  {currentStep === 3 && (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium">Advanced Configuration</h3>
                        <p className="text-xs text-muted-foreground">
                          Configure advanced monitoring options
                        </p>
                      </div>

                      <div className="space-y-4 p-4 rounded-lg border bg-muted/30">
                        <div className="grid grid-cols-2 gap-3">
                          <FormField
                            control={form.control}
                            name="httpMethod"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium">HTTP Method</FormLabel>
                                <Select onValueChange={field.onChange} defaultValue={field.value}>
                                  <FormControl>
                                    <SelectTrigger className="h-8 text-xs">
                                      <SelectValue placeholder="Method" />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    <SelectItem value="HEAD">HEAD</SelectItem>
                                    <SelectItem value="GET">GET</SelectItem>
                                    <SelectItem value="POST">POST</SelectItem>
                                    <SelectItem value="PUT">PUT</SelectItem>
                                    <SelectItem value="PATCH">PATCH</SelectItem>
                                    <SelectItem value="DELETE">DELETE</SelectItem>
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name="expectedStatusCodes"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium">Status Codes</FormLabel>
                                <FormControl>
                                  <Input
                                    {...field}
                                    placeholder="200,201,202"
                                    className="h-8 text-xs"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>

                        <FormField
                          control={form.control}
                          name="requestHeaders"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">Request Headers</FormLabel>
                              <FormControl>
                                <Textarea
                                  {...field}
                                  placeholder="Authorization: Bearer token&#10;Content-Type: application/json"
                                  rows={2}
                                  className="text-xs"
                                />
                              </FormControl>
                              <FormDescription className="text-xs">
                                Default User-Agent: Exit1-Website-Monitor/1.0. Set a User-Agent header here to override.
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        {['POST', 'PUT', 'PATCH'].includes(watchHttpMethod || '') && (
                          <FormField
                            control={form.control}
                            name="requestBody"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel className="text-xs font-medium">Request Body</FormLabel>
                                <FormControl>
                                  <Textarea
                                    {...field}
                                    placeholder='{"key": "value"}'
                                    rows={3}
                                    className="text-xs font-mono"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        )}

                        <FormField
                          control={form.control}
                          name="containsText"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">Response Validation</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  placeholder="success,online,healthy"
                                  className="h-8 text-xs"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  )}

                  {/* Navigation */}
                  <div className="flex items-center justify-between pt-6 border-t">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        prevStep();
                      }}
                      disabled={currentStep === 1}
                      className="h-8 px-3 text-muted-foreground hover:text-foreground hover:bg-muted"
                    >
                      Back
                    </Button>

                    {currentStep < 3 ? (
                      <Button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          nextStep();
                        }}
                        className="h-8 px-4"
                      >
                        Next
                        <ArrowRight className="w-3 h-3 ml-1" />
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        disabled={loading}
                        className="h-8 px-4"
                      >
                        {loading ? (
                          <>
                            <Zap className="w-3 h-3 mr-1 animate-pulse" />
                            {mode === 'edit' ? 'Saving...' : 'Adding...'}
                          </>
                        ) : (
                          <>
                            {mode === 'edit' ? <SaveIcon /> : <Plus className="w-3 h-3 mr-1" />}
                            {mode === 'edit' ? 'Save Changes' : 'Add Check'}
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </form>
              </Form>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
}

function EditIcon({ type }: { type?: string }) {
  if (type === 'rest_endpoint') return <Code className="w-4 h-4 text-primary" />;
  return <Globe className="w-4 h-4 text-primary" />;
}

function SaveIcon() {
  return <Check className="w-3 h-3 mr-1" />;
}
