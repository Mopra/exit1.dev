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
  Server,
  Radio,
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

const formSchema = z.object({
  name: z.string().min(1, 'Display name is required'),
  url: z.string().min(1, 'URL is required'),
  type: z.enum(['website', 'rest_endpoint', 'tcp', 'udp']),
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
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
  expectedStatusCodes: z.string().optional(),
  requestHeaders: z.string().optional(),
  requestBody: z.string().optional(),
  containsText: z.string().optional(),
  immediateRecheckEnabled: z.boolean().optional(),
  downConfirmationAttempts: z.number().min(1).max(99).optional(),
  cacheControlNoCache: z.boolean().optional(),
});

type CheckFormData = z.infer<typeof formSchema>;

type UrlProtocol = 'https://' | 'http://' | 'tcp://' | 'udp://';

const DEFAULT_URL_PROTOCOL: UrlProtocol = 'https://';

const normalizeProtocol = (raw?: string | null): UrlProtocol | null => {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'http://') return 'http://';
  if (lower === 'https://') return 'https://';
  if (lower === 'tcp://') return 'tcp://';
  if (lower === 'udp://') return 'udp://';
  return null;
};

const splitUrlProtocol = (
  value?: string | null,
  fallbackProtocol: UrlProtocol = DEFAULT_URL_PROTOCOL
): { protocol: UrlProtocol; rest: string } => {
  const raw = (value ?? '').trim();
  if (!raw) {
    return { protocol: fallbackProtocol, rest: '' };
  }
  const match = raw.match(/^(https?:\/\/|tcp:\/\/|udp:\/\/)(.*)$/i);
  if (!match) {
    return { protocol: fallbackProtocol, rest: raw };
  }
  const protocol = normalizeProtocol(match[1]) ?? fallbackProtocol;
  return { protocol, rest: match[2] };
};

const buildFullUrl = (value: string, protocol: UrlProtocol): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^(https?:\/\/|tcp:\/\/|udp:\/\/)/i.test(trimmed)) {
    return trimmed;
  }
  return `${protocol}${trimmed}`;
};

const parseSocketTarget = (value: string): { hostname: string; port: number } | null => {
  try {
    const urlObj = new URL(value);
    if (!urlObj.hostname || !urlObj.port) return null;
    const port = Number(urlObj.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { hostname: urlObj.hostname, port };
  } catch {
    return null;
  }
};

interface CheckFormProps {
  mode?: 'create' | 'edit';
  initialCheck?: Website | null;
  onSubmit: (data: {
    id?: string;
    name: string;
    url: string;
    type: 'website' | 'rest_endpoint' | 'tcp' | 'udp';
    checkFrequency?: number;
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
    downConfirmationAttempts?: number;
    cacheControlNoCache?: boolean;
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

  const form = useForm<CheckFormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      url: prefillWebsiteUrl ? splitUrlProtocol(prefillWebsiteUrl).rest : '',
      type: 'website',
      checkFrequency: 3600, // Default to 1 hour (seconds)
      httpMethod: getDefaultHttpMethod('website'),
      expectedStatusCodes: getDefaultExpectedStatusCodesValue('website'),
      requestHeaders: '',
      requestBody: '',
      containsText: '',
      immediateRecheckEnabled: true, // Default to enabled
      downConfirmationAttempts: 4, // Default to 4 (matching CONFIG.DOWN_CONFIRMATION_ATTEMPTS)
      cacheControlNoCache: false,
    },
  });

  const watchHttpMethod = form.watch('httpMethod');
  const watchType = form.watch('type');
  const isHttpType = watchType === 'website' || watchType === 'rest_endpoint';
  const isSocketType = watchType === 'tcp' || watchType === 'udp';

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

    const type: 'website' | 'rest_endpoint' | 'tcp' | 'udp' =
      effectiveCheck.type === 'rest_endpoint'
        ? 'rest_endpoint'
        : effectiveCheck.type === 'tcp'
          ? 'tcp'
          : effectiveCheck.type === 'udp'
            ? 'udp'
            : 'website';

    const fallbackProtocol: UrlProtocol =
      type === 'tcp' ? 'tcp://' : type === 'udp' ? 'udp://' : DEFAULT_URL_PROTOCOL;
    const { protocol, rest } = splitUrlProtocol(effectiveCheck.url, fallbackProtocol);
    const cleanUrl = rest;
    const seconds = (effectiveCheck.checkFrequency ?? 60) * 60; // stored as minutes
    const safeSeconds = [60, 120, 300, 600, 900, 1800, 3600, 86400].includes(seconds) ? seconds : 3600;

    const expectedStatusCodes =
      (type === 'website' || type === 'rest_endpoint') && effectiveCheck.expectedStatusCodes?.length
        ? effectiveCheck.expectedStatusCodes.join(',')
        : type === 'website' || type === 'rest_endpoint'
          ? getDefaultExpectedStatusCodesValue(type)
          : '';

    const requestHeaders =
      effectiveCheck.requestHeaders
        ? Object.entries(effectiveCheck.requestHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
        : '';

    const containsText = effectiveCheck.responseValidation?.containsText?.length
      ? effectiveCheck.responseValidation.containsText.join(',')
      : '';
    setUrlProtocol(protocol);

    form.reset({
      name: effectiveCheck.name ?? '',
      url: cleanUrl,
      type,
      checkFrequency: safeSeconds as any,
      httpMethod: (type === 'website' || type === 'rest_endpoint')
        ? (effectiveCheck.httpMethod as any) ?? getDefaultHttpMethod(type)
        : undefined,
      expectedStatusCodes,
      requestHeaders,
      requestBody: effectiveCheck.requestBody ?? '',
      containsText,
      immediateRecheckEnabled: effectiveCheck.immediateRecheckEnabled !== false,
      downConfirmationAttempts: effectiveCheck.downConfirmationAttempts ?? 4,
      cacheControlNoCache: effectiveCheck.cacheControlNoCache === true,
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
    const protocolMatch = rawUrl.match(/^(https?:\/\/|tcp:\/\/|udp:\/\/)(.*)$/i);
    const candidateProtocol = protocolMatch ? normalizeProtocol(protocolMatch[1]) : null;
    const isAllowedProtocol = Boolean(candidateProtocol) && (
      isHttpType
        ? candidateProtocol === 'http://' || candidateProtocol === 'https://'
        : candidateProtocol === 'tcp://' || candidateProtocol === 'udp://'
    );
    const nextProtocol = isAllowedProtocol && candidateProtocol ? candidateProtocol : urlProtocol;
    const nextUrl = protocolMatch ? (isAllowedProtocol ? protocolMatch[2] : rawUrl) : rawUrl;

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
        if (isSocketType) {
          const target = parseSocketTarget(fullUrl);
          if (target) {
            form.setValue('name', `${target.hostname}:${target.port}`);
          }
          return;
        }
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
  const handleTypeChange = (newType: 'website' | 'rest_endpoint' | 'tcp' | 'udp') => {
    form.setValue('type', newType);
    if (newType === 'tcp' || newType === 'udp') {
      const protocol = newType === 'tcp' ? 'tcp://' : 'udp://';
      setUrlProtocol(protocol);
      form.setValue('httpMethod', undefined);
      form.setValue('expectedStatusCodes', '');
    } else {
      if (urlProtocol === 'tcp://' || urlProtocol === 'udp://') {
        setUrlProtocol(DEFAULT_URL_PROTOCOL);
      }
      form.setValue('httpMethod', getDefaultHttpMethod(newType));
      form.setValue('expectedStatusCodes', getDefaultExpectedStatusCodesValue(newType));
    }
  };

  const onFormSubmit = async (data: CheckFormData) => {
    const isHttpCheck = data.type === 'website' || data.type === 'rest_endpoint';
    const isSocketCheck = data.type === 'tcp' || data.type === 'udp';
    const protocolOverride: UrlProtocol | null =
      data.type === 'tcp' ? 'tcp://' : data.type === 'udp' ? 'udp://' : null;
    const fullUrl = buildFullUrl(data.url, protocolOverride ?? urlProtocol);

    if (isSocketCheck) {
      const parsed = parseSocketTarget(fullUrl);
      if (!parsed) {
        form.setError('url', {
          type: 'manual',
          message: 'Enter a valid host and port, e.g. example.com:443'
        });
        return;
      }
    }

    const statusCodes = isHttpCheck && data.expectedStatusCodes
      ? data.expectedStatusCodes
        .split(',')
        .map((s: string) => parseInt(s.trim()))
        .filter((n: number) => !isNaN(n))
      : undefined;

    const headers: { [key: string]: string } = {};
    if (isHttpCheck && data.requestHeaders?.trim()) {
      data.requestHeaders.split('\n').forEach((line: string) => {
        const [key, value] = line.split(':').map((s: string) => s.trim());
        if (key && value) {
          headers[key] = value;
        }
      });
    }

    const validation: any = {};
    if (isHttpCheck && data.containsText?.trim()) {
      validation.containsText = data.containsText.split(',').map(s => s.trim()).filter(s => s);
    }

    const submitData = {
      id: effectiveCheck?.id,
      name: data.name,
      url: fullUrl,
      type: data.type,
      checkFrequency: Math.round(data.checkFrequency / 60), // Convert seconds to minutes
      ...(isHttpCheck
        ? {
          httpMethod: data.httpMethod,
          expectedStatusCodes: statusCodes,
          requestHeaders: headers,
          requestBody: data.requestBody,
          responseValidation: validation,
          cacheControlNoCache: data.cacheControlNoCache === true
        }
        : {}),
      immediateRecheckEnabled: data.immediateRecheckEnabled === true,
      downConfirmationAttempts: data.downConfirmationAttempts
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
        <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0">
          <ScrollArea className="h-full">
            <div className="p-7 sm:p-8 space-y-10">
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
                    className={`flex-1 h-0.5 rounded-full transition-colors ${step <= currentStep ? 'bg-primary' : 'bg-muted'
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
                  className="space-y-10"
                >
                  {/* Step 1: Check Type */}
                  {currentStep === 1 && (
                    <div className="space-y-8">
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
                          <FormItem className="space-y-5">
                            <FormControl>
                              <RadioGroup
                                onValueChange={(value) => {
                                  field.onChange(value);
                                  handleTypeChange(value as 'website' | 'rest_endpoint' | 'tcp' | 'udp');
                                }}
                                value={field.value}
                                className="space-y-4"
                              >
                                <div className="relative">
                                  <RadioGroupItem
                                    value="website"
                                    id="website"
                                    className="peer sr-only"
                                  />
                                  <label
                                    htmlFor="website"
                                    className={`flex items-center gap-3 rounded-md border px-3 py-2 transition-colors cursor-pointer ${field.value === 'website'
                                      ? 'border-primary/40 bg-primary/5'
                                      : 'border-border/60 hover:border-border'
                                      }`}
                                  >
                                    <div className={`flex items-center justify-center w-8 h-8 rounded-md ${field.value === 'website'
                                      ? 'bg-primary/10 text-primary'
                                      : 'bg-muted/60 text-muted-foreground'
                                      }`}>
                                      <Globe className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1">
                                      <div className="font-medium text-sm">Website</div>
                                      <div className="text-xs text-muted-foreground">Monitor website availability and performance</div>
                                    </div>
                                    <Check className={`w-4 h-4 transition-opacity ${field.value === 'website'
                                      ? 'text-primary opacity-100'
                                      : 'text-muted-foreground opacity-0'
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
                                    className={`flex items-center gap-3 rounded-md border px-3 py-2 transition-colors cursor-pointer ${field.value === 'rest_endpoint'
                                      ? 'border-primary/40 bg-primary/5'
                                      : 'border-border/60 hover:border-border'
                                      }`}
                                  >
                                    <div className={`flex items-center justify-center w-8 h-8 rounded-md ${field.value === 'rest_endpoint'
                                      ? 'bg-primary/10 text-primary'
                                      : 'bg-muted/60 text-muted-foreground'
                                      }`}>
                                      <Code className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1">
                                      <div className="font-medium text-sm">API Endpoint</div>
                                      <div className="text-xs text-muted-foreground">Monitor REST APIs and microservices</div>
                                    </div>
                                    <Check className={`w-4 h-4 transition-opacity ${field.value === 'rest_endpoint'
                                      ? 'text-primary opacity-100'
                                      : 'text-muted-foreground opacity-0'
                                      }`} />
                                  </label>
                                </div>

                                <div className="relative">
                                  <RadioGroupItem
                                    value="tcp"
                                    id="tcp"
                                    className="peer sr-only"
                                  />
                                  <label
                                    htmlFor="tcp"
                                    className={`flex items-center gap-3 rounded-md border px-3 py-2 transition-colors cursor-pointer ${field.value === 'tcp'
                                      ? 'border-primary/40 bg-primary/5'
                                      : 'border-border/60 hover:border-border'
                                      }`}
                                  >
                                    <div className={`flex items-center justify-center w-8 h-8 rounded-md ${field.value === 'tcp'
                                      ? 'bg-primary/10 text-primary'
                                      : 'bg-muted/60 text-muted-foreground'
                                      }`}>
                                      <Server className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1">
                                      <div className="font-medium text-sm flex items-center gap-2">
                                        TCP Port
                                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Beta</Badge>
                                      </div>
                                      <div className="text-xs text-muted-foreground">Check if a TCP port is reachable</div>
                                    </div>
                                    <Check className={`w-4 h-4 transition-opacity ${field.value === 'tcp'
                                      ? 'text-primary opacity-100'
                                      : 'text-muted-foreground opacity-0'
                                      }`} />
                                  </label>
                                </div>

                                <div className="relative">
                                  <RadioGroupItem
                                    value="udp"
                                    id="udp"
                                    className="peer sr-only"
                                  />
                                  <label
                                    htmlFor="udp"
                                    className={`flex items-center gap-3 rounded-md border px-3 py-2 transition-colors cursor-pointer ${field.value === 'udp'
                                      ? 'border-primary/40 bg-primary/5'
                                      : 'border-border/60 hover:border-border'
                                      }`}
                                  >
                                    <div className={`flex items-center justify-center w-8 h-8 rounded-md ${field.value === 'udp'
                                      ? 'bg-primary/10 text-primary'
                                      : 'bg-muted/60 text-muted-foreground'
                                      }`}>
                                      <Radio className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1">
                                      <div className="font-medium text-sm flex items-center gap-2">
                                        UDP Port
                                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Beta</Badge>
                                      </div>
                                      <div className="text-xs text-muted-foreground">Check if a UDP port is reachable</div>
                                    </div>
                                    <Check className={`w-4 h-4 transition-opacity ${field.value === 'udp'
                                      ? 'text-primary opacity-100'
                                      : 'text-muted-foreground opacity-0'
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
                    <div className="space-y-8">
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium">Basic Information</h3>
                        <p className="text-xs text-muted-foreground">
                          Tell us about the service you want to monitor
                        </p>
                      </div>

                      <div className="space-y-6">
                        <FormField
                          control={form.control}
                          name="url"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">
                                {isSocketType ? 'Host and port' : 'URL to monitor'}
                              </FormLabel>
                              <FormControl>
                                <div className="flex">
                                  {isHttpType ? (
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
                                  ) : (
                                    <div className="h-9 rounded-r-none border border-r-0 px-2 text-xs font-mono flex items-center text-muted-foreground bg-muted/50">
                                      {watchType === 'tcp' ? 'tcp://' : 'udp://'}
                                    </div>
                                  )}
                                  <Input
                                    {...field}
                                    onChange={handleUrlChange}
                                    placeholder={isSocketType ? 'example.com:443' : 'example.com'}
                                    className="h-9 rounded-l-none"
                                  />
                                </div>
                              </FormControl>
                              <FormDescription className="text-xs">
                                {isSocketType
                                  ? 'Enter a host and port, e.g. example.com:443'
                                  : 'Enter the domain or full URL to monitor'}
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
                                  label=""
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="immediateRecheckEnabled"
                          render={({ field }) => (
                            <FormItem className="rounded-md border border-primary/30 bg-primary/5 p-4">
                              <div className="flex items-start gap-3">
                                <FormControl>
                                  <Checkbox
                                    id="immediate-recheck"
                                    checked={field.value === true}
                                    onCheckedChange={(checked) => field.onChange(checked === true)}
                                    className="mt-0.5"
                                  />
                                </FormControl>
                                <div className="space-y-1 leading-none">
                                  <FormLabel htmlFor="immediate-recheck" className="text-sm font-semibold cursor-pointer">
                                    Enable immediate re-check
                                  </FormLabel>
                                  <FormDescription className="text-xs">
                                    We automatically re-check failed endpoints after 30 seconds to confirm it was a real outage.
                                  </FormDescription>
                                </div>
                              </div>
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="downConfirmationAttempts"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">Down confirmation attempts</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  min={1}
                                  max={99}
                                  placeholder="4"
                                  {...field}
                                  value={field.value ?? 4}
                                  onChange={(e) => {
                                    const value = e.target.value === '' ? undefined : parseInt(e.target.value, 10);
                                    if (value === undefined || (value >= 1 && value <= 99)) {
                                      field.onChange(value);
                                    }
                                  }}
                                  className="cursor-pointer"
                                />
                              </FormControl>
                              <FormDescription className="text-xs">
                                Number of consecutive failures required before marking as offline. Default: 4. Range: 1-99.
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  )}

                  {/* Step 3: Advanced Options */}
                  {currentStep === 3 && (
                    <div className="space-y-8">
                      <div className="space-y-3">
                        <h3 className="text-sm font-medium">Advanced Configuration</h3>
                        <p className="text-xs text-muted-foreground">
                          Configure advanced monitoring options. Skip this step if you are not sure what you are doing.
                        </p>
                        {isHttpType && (
                          <p className="text-xs text-muted-foreground">
                            Status handling: 2xx and 3xx responses are treated as up, and 401/403 count as up for protected endpoints.
                          </p>
                        )}
                      </div>

                      {isHttpType ? (
                        <div className="space-y-8">
                          <div className="space-y-5">
                            <FormField
                              control={form.control}
                              name="httpMethod"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium">HTTP Method</FormLabel>
                                  <Select value={field.value} onValueChange={field.onChange}>
                                    <FormControl>
                                      <SelectTrigger className="h-8 text-xs">
                                        <SelectValue placeholder="Method" />
                                      </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                      <SelectItem value="GET">GET</SelectItem>
                                      <SelectItem value="POST">POST</SelectItem>
                                      <SelectItem value="PUT">PUT</SelectItem>
                                      <SelectItem value="PATCH">PATCH</SelectItem>
                                      <SelectItem value="DELETE">DELETE</SelectItem>
                                      <SelectItem value="HEAD">HEAD</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <FormDescription className="text-xs">
                                    GET is recommended for online/offline checks since some hosts block HEAD.
                                  </FormDescription>
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
                                  Example: <span className="font-mono">Authorization: Bearer YOUR_TOKEN</span> on one line,
                                  and <span className="font-mono">Accept: application/json</span> on the next. Default
                                  User-Agent is Exit1-Website-Monitor/1.0.
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

                          <FormField
                            control={form.control}
                            name="cacheControlNoCache"
                            render={({ field }) => (
                              <FormItem className="rounded-md border border-primary/30 bg-primary/5 p-4">
                                <div className="flex items-start gap-3">
                                  <FormControl>
                                    <Checkbox
                                      id="cache-control-no-cache"
                                      checked={field.value === true}
                                      onCheckedChange={(checked) => field.onChange(checked === true)}
                                      className="mt-0.5 cursor-pointer"
                                    />
                                  </FormControl>
                                  <div className="space-y-1 leading-none">
                                    <FormLabel htmlFor="cache-control-no-cache" className="text-sm font-semibold cursor-pointer">
                                      Force no-cache
                                    </FormLabel>
                                    <FormDescription className="text-xs">
                                      Adds Cache-Control: no-cache to requests. Use this when your site is heavily cached.
                                    </FormDescription>
                                  </div>
                                </div>
                              </FormItem>
                            )}
                          />
                        </div>
                      ) : (
                        <div className="rounded-md border border-primary/30 bg-primary/5 p-4 text-xs text-muted-foreground">
                          TCP/UDP checks only verify that a port is reachable. No HTTP headers, bodies, or SSL settings apply.
                        </div>
                      )}
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
  if (type === 'tcp') return <Server className="w-4 h-4 text-primary" />;
  if (type === 'udp') return <Radio className="w-4 h-4 text-primary" />;
  return <Globe className="w-4 h-4 text-primary" />;
}

function SaveIcon() {
  return <Check className="w-3 h-3 mr-1" />;
}
