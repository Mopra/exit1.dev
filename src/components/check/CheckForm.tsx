"use client"

import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
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
  Textarea,
  ScrollArea,
  Switch,
  Sheet,
  SheetContent,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../ui';
import {
  Globe,
  Code,
  Server,
  Radio,
  Activity,
  Plus,
  Zap,
  ArrowRight,
  Check,
  Copy,
  MapPin,
  Clock,
  Info,
  ChevronDown,
  Settings,
  Shield,
  Send,
} from 'lucide-react';
import type { Website } from '../../types';
import { copyToClipboard } from '../../utils/clipboard';
import { toast } from 'sonner';
import { getDefaultExpectedStatusCodesValue, getDefaultHttpMethod } from '../../lib/check-defaults';
import { useNanoPlan } from '../../hooks/useNanoPlan';

// Tier-based minimum check intervals (in minutes)
// Must match backend config in functions/src/config.ts
const MIN_CHECK_INTERVAL_MINUTES_FREE = 5;
const MIN_CHECK_INTERVAL_MINUTES_NANO = 2;
const MIN_CHECK_INTERVAL_MINUTES_SCALE = 0.25; // 15 seconds

// Common IANA timezones grouped by region for the notification timezone selector
const TIMEZONE_OPTIONS = [
  { value: '_utc', label: 'UTC (default)' },
  // Americas
  { value: 'America/New_York', label: 'Eastern Time (US)' },
  { value: 'America/Chicago', label: 'Central Time (US)' },
  { value: 'America/Denver', label: 'Mountain Time (US)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'America/Toronto', label: 'Toronto' },
  { value: 'America/Vancouver', label: 'Vancouver' },
  { value: 'America/Sao_Paulo', label: 'Sao Paulo' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires' },
  { value: 'America/Mexico_City', label: 'Mexico City' },
  // Europe
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam (CET)' },
  { value: 'Europe/Madrid', label: 'Madrid (CET)' },
  { value: 'Europe/Rome', label: 'Rome (CET)' },
  { value: 'Europe/Stockholm', label: 'Stockholm (CET)' },
  { value: 'Europe/Helsinki', label: 'Helsinki (EET)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Europe/Istanbul', label: 'Istanbul (TRT)' },
  // Asia
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Bangkok', label: 'Bangkok (ICT)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong (HKT)' },
  { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Seoul', label: 'Seoul (KST)' },
  // Oceania
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
  { value: 'Australia/Melbourne', label: 'Melbourne (AEST)' },
  { value: 'Australia/Perth', label: 'Perth (AWST)' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZST)' },
  // Africa
  { value: 'Africa/Johannesburg', label: 'Johannesburg (SAST)' },
  { value: 'Africa/Cairo', label: 'Cairo (EET)' },
  { value: 'Africa/Lagos', label: 'Lagos (WAT)' },
];

const formSchema = z.object({
  name: z.string().min(1, 'Display name is required'),
  url: z.string().min(1, 'URL is required'),
  type: z.enum(['website', 'rest_endpoint', 'tcp', 'udp', 'ping', 'websocket', 'redirect']),
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
  responseTimeLimit: z.union([z.number().min(1).max(25000), z.literal(''), z.undefined()]).optional(),
  cacheControlNoCache: z.boolean().optional(),
  redirectExpectedTarget: z.string().optional(),
  redirectMatchMode: z.enum(['contains', 'exact']).optional(),
  pingPackets: z.number().min(1).max(5).optional(),
  checkRegionOverride: z.enum(['auto', 'us-central1', 'europe-west1', 'asia-southeast1', 'vps-eu-1']).optional(),
  timezone: z.string().optional(),
});

type CheckFormData = z.infer<typeof formSchema>;

type UrlProtocol = 'https://' | 'http://' | 'tcp://' | 'udp://' | 'ping://' | 'ws://' | 'wss://';

const DEFAULT_URL_PROTOCOL: UrlProtocol = 'https://';

const normalizeProtocol = (raw?: string | null): UrlProtocol | null => {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'http://') return 'http://';
  if (lower === 'https://') return 'https://';
  if (lower === 'tcp://') return 'tcp://';
  if (lower === 'udp://') return 'udp://';
  if (lower === 'ping://') return 'ping://';
  if (lower === 'ws://') return 'ws://';
  if (lower === 'wss://') return 'wss://';
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
  const match = raw.match(/^(https?:\/\/|tcp:\/\/|udp:\/\/|ping:\/\/|wss?:\/\/)(.*)$/i);
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
  if (/^(https?:\/\/|tcp:\/\/|udp:\/\/|ping:\/\/|wss?:\/\/)/i.test(trimmed)) {
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

/**
 * Parses a status codes string that can contain individual codes and ranges.
 * Examples: "200", "200, 201, 204", "200-299", "200-299, 301-308, 400"
 */
const parseStatusCodes = (input: string): number[] => {
  const codes: number[] = [];
  const parts = input.split(',').map(s => s.trim()).filter(s => s);

  for (const part of parts) {
    // Check if it's a range (e.g., "200-299")
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (!isNaN(start) && !isNaN(end) && start <= end && start >= 100 && end <= 599) {
        for (let i = start; i <= end; i++) {
          if (!codes.includes(i)) {
            codes.push(i);
          }
        }
      }
    } else {
      // Single code
      const code = parseInt(part, 10);
      if (!isNaN(code) && code >= 100 && code <= 599 && !codes.includes(code)) {
        codes.push(code);
      }
    }
  }

  return codes.sort((a, b) => a - b);
};

const CHECK_TYPES = [
  { value: 'website', label: 'Web', icon: Globe },
  { value: 'rest_endpoint', label: 'API', icon: Code },
  { value: 'redirect', label: 'Redirect', icon: ArrowRight },
  { value: 'tcp', label: 'TCP', icon: Server },
  { value: 'udp', label: 'UDP', icon: Radio },
  { value: 'ping', label: 'Ping', icon: Activity },
  { value: 'websocket', label: 'WS', icon: Zap },
] as const;

interface CheckFormProps {
  mode?: 'create' | 'edit';
  initialCheck?: Website | null;
  duplicateFrom?: Website | null;
  onSubmit: (data: {
    id?: string;
    name: string;
    url: string;
    type: 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect';
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
    redirectValidation?: {
      expectedTarget: string;
      matchMode: 'contains' | 'exact';
    } | null;
    immediateRecheckEnabled?: boolean;
    downConfirmationAttempts?: number;
    cacheControlNoCache?: boolean;
    checkRegionOverride?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1' | null;
    timezone?: string | null;
  }) => Promise<void>;
  loading?: boolean;
  isOpen: boolean;
  onClose: () => void;
  prefillWebsiteUrl?: string | null;
}

export default function CheckForm({
  mode = 'create',
  initialCheck = null,
  duplicateFrom = null,
  onSubmit,
  loading = false,
  isOpen,
  onClose,
  prefillWebsiteUrl
}: CheckFormProps) {
  const [copiedCheckId, setCopiedCheckId] = useState(false);
  const [urlProtocol, setUrlProtocol] = useState<UrlProtocol>(DEFAULT_URL_PROTOCOL);
  const [settingsOpen, setSettingsOpen] = useState(mode === 'edit');
  const [httpConfigOpen, setHttpConfigOpen] = useState(false);
  // Track whether the user has manually edited the name field
  // so we don't overwrite custom names when the URL changes
  const userEditedName = useRef(false);

  // Get user's subscription tier for check interval limits
  const { nano, scale } = useNanoPlan();
  const minCheckIntervalMinutes = scale ? MIN_CHECK_INTERVAL_MINUTES_SCALE : nano ? MIN_CHECK_INTERVAL_MINUTES_NANO : MIN_CHECK_INTERVAL_MINUTES_FREE;
  const minCheckIntervalSeconds = minCheckIntervalMinutes * 60;
  // Free users are locked to vps-eu-1 region
  const freeRegionLocked = !nano;

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
      responseTimeLimit: '' as any, // Empty = disabled
      cacheControlNoCache: false,
      checkRegionOverride: freeRegionLocked ? 'vps-eu-1' : 'auto',
      timezone: '_utc',
    },
  });

  const watchHttpMethod = form.watch('httpMethod');
  const watchType = form.watch('type');
  const isHttpType = watchType === 'website' || watchType === 'rest_endpoint' || watchType === 'redirect';
  const isSocketType = watchType === 'tcp' || watchType === 'udp';
  const isPingType = watchType === 'ping';
  const isWebSocketType = watchType === 'websocket';
  const isRedirectType = watchType === 'redirect';

  const effectiveCheck = useMemo(() => {
    if (mode !== 'edit') return null;
    return initialCheck;
  }, [mode, initialCheck]);

  // Ensure form closes when isOpen becomes false
  useEffect(() => {
    if (!isOpen) {
      form.reset();
      setCopiedCheckId(false);
      setUrlProtocol(DEFAULT_URL_PROTOCOL);
      setSettingsOpen(false);
      setHttpConfigOpen(false);
    }
  }, [isOpen, form]);

  // Open settings by default in edit mode
  useEffect(() => {
    if (isOpen && mode === 'edit') {
      setSettingsOpen(true);
    }
  }, [isOpen, mode]);

  useEffect(() => {
    // Reset copied state when edit target changes
    setCopiedCheckId(false);
  }, [effectiveCheck?.id]);

  // Shared helper: convert a Website into form-ready values
  const prefillFromCheck = useCallback((source: Website, nameOverride?: string) => {
    const type: 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect' =
      source.type === 'rest_endpoint'
        ? 'rest_endpoint'
        : source.type === 'tcp'
          ? 'tcp'
          : source.type === 'udp'
            ? 'udp'
            : source.type === 'ping'
              ? 'ping'
              : source.type === 'websocket'
                ? 'websocket'
                : source.type === 'redirect'
                  ? 'redirect'
                  : 'website';

    const fallbackProtocol: UrlProtocol =
      type === 'tcp' ? 'tcp://' : type === 'udp' ? 'udp://' : type === 'ping' ? 'ping://' : type === 'websocket' ? 'wss://' : DEFAULT_URL_PROTOCOL;
    const { protocol, rest } = splitUrlProtocol(source.url, fallbackProtocol);
    const cleanUrl = rest;
    const seconds = Math.round((source.checkFrequency ?? 60) * 60); // stored as minutes (can be fractional)
    // Ensure the interval is valid and respects the user's tier minimum
    const validIntervals = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 86400];
    const isValidInterval = validIntervals.includes(seconds);
    // Clamp to tier minimum if needed (e.g., if check was created on nano but user is now on free)
    const clampedSeconds = Math.max(seconds, minCheckIntervalSeconds);
    const safeSeconds = isValidInterval && clampedSeconds === seconds ? seconds :
                        validIntervals.includes(clampedSeconds) ? clampedSeconds : 3600;

    const isHttpCheckType = type === 'website' || type === 'rest_endpoint' || type === 'redirect';
    const expectedStatusCodes =
      isHttpCheckType && source.expectedStatusCodes?.length
        ? source.expectedStatusCodes.join(',')
        : isHttpCheckType
          ? getDefaultExpectedStatusCodesValue(type)
          : '';

    const requestHeaders =
      source.requestHeaders
        ? Object.entries(source.requestHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
        : '';

    const containsText = source.responseValidation?.containsText?.length
      ? source.responseValidation.containsText.join(',')
      : '';
    setUrlProtocol(protocol);

    form.reset({
      name: nameOverride ?? (source.name ?? ''),
      url: cleanUrl,
      type,
      checkFrequency: safeSeconds as any,
      httpMethod: isHttpCheckType
        ? (source.httpMethod as any) ?? getDefaultHttpMethod(type)
        : undefined,
      expectedStatusCodes,
      requestHeaders,
      requestBody: source.requestBody ?? '',
      containsText,
      immediateRecheckEnabled: source.immediateRecheckEnabled !== false,
      downConfirmationAttempts: source.downConfirmationAttempts ?? 4,
      responseTimeLimit: source.responseTimeLimit || ('' as any),
      cacheControlNoCache: source.cacheControlNoCache === true,
      redirectExpectedTarget: source.redirectValidation?.expectedTarget ?? '',
      redirectMatchMode: source.redirectValidation?.matchMode ?? 'contains',
      pingPackets: source.pingPackets ?? 3,
      checkRegionOverride: freeRegionLocked ? 'vps-eu-1' : (source.checkRegionOverride ?? 'auto'),
      timezone: source.timezone || '_utc',
    });

    userEditedName.current = true;
  }, [form, freeRegionLocked, minCheckIntervalSeconds]);

  // Prefill the form when editing an existing check
  useEffect(() => {
    if (!isOpen) return;
    if (mode !== 'edit') return;
    if (!effectiveCheck) return;
    prefillFromCheck(effectiveCheck);
  }, [isOpen, mode, effectiveCheck, prefillFromCheck]);

  // Prefill form when duplicating an existing check (opens in create mode)
  useEffect(() => {
    if (!isOpen) return;
    if (mode !== 'create') return;
    if (!duplicateFrom) return;
    prefillFromCheck(duplicateFrom, `${duplicateFrom.name ?? ''} (copy)`);
  }, [isOpen, mode, duplicateFrom, prefillFromCheck]);

  // Reset userEditedName when form opens in create mode (but not when duplicating)
  useEffect(() => {
    if (isOpen && mode === 'create' && !duplicateFrom) {
      userEditedName.current = false;
    }
  }, [isOpen, mode, duplicateFrom]);

  // Handle prefill website URL when form opens (skip if duplicating)
  useEffect(() => {
    if (mode !== 'create') return;
    if (duplicateFrom) return;
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
        form.setValue('name', cleanUrl);
      }
    }
  }, [isOpen, prefillWebsiteUrl, form]);

  // Auto-generate name from URL when URL changes
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawUrl = e.target.value;
    const protocolMatch = rawUrl.match(/^(https?:\/\/|tcp:\/\/|udp:\/\/|ping:\/\/|wss?:\/\/)(.*)$/i);
    const candidateProtocol = protocolMatch ? normalizeProtocol(protocolMatch[1]) : null;
    const isAllowedProtocol = Boolean(candidateProtocol) && (
      isHttpType
        ? candidateProtocol === 'http://' || candidateProtocol === 'https://'
        : isPingType
          ? candidateProtocol === 'ping://'
          : isWebSocketType
            ? candidateProtocol === 'ws://' || candidateProtocol === 'wss://'
            : candidateProtocol === 'tcp://' || candidateProtocol === 'udp://'
    );
    const nextProtocol = isAllowedProtocol && candidateProtocol ? candidateProtocol : urlProtocol;
    const nextUrl = protocolMatch ? (isAllowedProtocol ? protocolMatch[2] : rawUrl) : rawUrl;

    if (nextProtocol !== urlProtocol) {
      setUrlProtocol(nextProtocol);
    }

    form.setValue('url', nextUrl);

    // Don't overwrite the name if the user has manually edited it
    if (userEditedName.current) return;

    if (!nextUrl.trim()) {
      form.setValue('name', '');
      return;
    }

    try {
      if (nextUrl.length > 0) {
        const fullUrl = buildFullUrl(nextUrl, nextProtocol);
        if (isPingType) {
          const pingHost = nextUrl.trim();
          if (pingHost) {
            form.setValue('name', `Ping ${pingHost}`);
          }
          return;
        }
        if (isWebSocketType) {
          try {
            const wsUrl = new URL(fullUrl);
            if (wsUrl.hostname) {
              form.setValue('name', `WS ${wsUrl.hostname}${wsUrl.port ? ':' + wsUrl.port : ''}`);
            }
          } catch { /* ignore */ }
          return;
        }
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
  const handleTypeChange = (newType: 'website' | 'rest_endpoint' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect') => {
    form.setValue('type', newType);
    if (newType === 'tcp' || newType === 'udp') {
      const protocol = newType === 'tcp' ? 'tcp://' : 'udp://';
      setUrlProtocol(protocol);
      form.setValue('httpMethod', undefined);
      form.setValue('expectedStatusCodes', '');
    } else if (newType === 'ping') {
      setUrlProtocol('ping://');
      form.setValue('httpMethod', undefined);
      form.setValue('expectedStatusCodes', '');
    } else if (newType === 'websocket') {
      setUrlProtocol('wss://');
      form.setValue('httpMethod', undefined);
      form.setValue('expectedStatusCodes', '');
    } else {
      if (urlProtocol === 'tcp://' || urlProtocol === 'udp://' || urlProtocol === 'ping://' || urlProtocol === 'ws://' || urlProtocol === 'wss://') {
        setUrlProtocol(DEFAULT_URL_PROTOCOL);
      }
      form.setValue('httpMethod', getDefaultHttpMethod(newType));
      form.setValue('expectedStatusCodes', getDefaultExpectedStatusCodesValue(newType));
    }
  };

  const onFormSubmit = async (data: CheckFormData) => {
    const isHttpCheck = data.type === 'website' || data.type === 'rest_endpoint' || data.type === 'redirect';
    const isSocketCheck = data.type === 'tcp' || data.type === 'udp';
    const isPingCheck = data.type === 'ping';
    const isWebSocketCheck = data.type === 'websocket';
    const protocolOverride: UrlProtocol | null =
      data.type === 'tcp' ? 'tcp://' : data.type === 'udp' ? 'udp://' : data.type === 'ping' ? 'ping://' : data.type === 'websocket' ? urlProtocol : null;
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

    if (isPingCheck) {
      const pingHost = data.url.trim();
      if (!pingHost || !/^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/.test(pingHost)) {
        form.setError('url', {
          type: 'manual',
          message: 'Enter a valid hostname or IP address, e.g. example.com or 1.2.3.4'
        });
        return;
      }
    }

    if (isWebSocketCheck) {
      try {
        const wsUrl = new URL(fullUrl);
        if (!wsUrl.hostname) {
          form.setError('url', {
            type: 'manual',
            message: 'Enter a valid WebSocket URL, e.g. example.com/ws'
          });
          return;
        }
      } catch {
        form.setError('url', {
          type: 'manual',
          message: 'Enter a valid WebSocket URL, e.g. example.com/ws'
        });
        return;
      }
    }

    const statusCodes = isHttpCheck && data.expectedStatusCodes
      ? parseStatusCodes(data.expectedStatusCodes)
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
      checkFrequency: data.checkFrequency / 60, // Convert seconds to minutes (fractional for sub-minute intervals)
      ...(isHttpCheck
        ? {
          httpMethod: data.httpMethod,
          expectedStatusCodes: statusCodes,
          requestHeaders: headers,
          requestBody: data.requestBody,
          responseValidation: validation,
          cacheControlNoCache: data.cacheControlNoCache === true,
          ...(data.type === 'redirect' && data.redirectExpectedTarget?.trim()
            ? {
              redirectValidation: {
                expectedTarget: data.redirectExpectedTarget.trim(),
                matchMode: data.redirectMatchMode || 'contains',
              }
            }
            : data.type === 'redirect' ? { redirectValidation: null } : {}),
        }
        : {}),
      immediateRecheckEnabled: data.immediateRecheckEnabled === true,
      downConfirmationAttempts: data.downConfirmationAttempts,
      responseTimeLimit: typeof data.responseTimeLimit === 'number' && data.responseTimeLimit > 0 ? data.responseTimeLimit : null,
      ...(isPingCheck && typeof data.pingPackets === 'number' ? { pingPackets: data.pingPackets } : {}),
      checkRegionOverride: 'vps-eu-1' as const,
      timezone: data.timezone && data.timezone !== '_utc' ? data.timezone : null,
    };

    try {
      await onSubmit(submitData);
      form.reset();
      onClose();
    } catch {
      // Parent shows error UI (e.g. ErrorModal). Keep the sheet open.
    }
  };

  const handleClose = () => {
    form.reset();
    setUrlProtocol(DEFAULT_URL_PROTOCOL);
    setSettingsOpen(false);
    setHttpConfigOpen(false);
    onClose();
  };

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0">
        <ScrollArea className="h-full">
          <div className="p-7 sm:p-8">
            {/* Header */}
            <div className="flex items-center gap-3 mb-8">
              <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
                {mode === 'edit' ? (
                  <TypeIcon type={form.getValues('type')} />
                ) : (
                  <Plus className="w-4 h-4 text-primary" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">{mode === 'edit' ? 'Edit Check' : 'New Check'}</h2>
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
                                ID: {effectiveCheck.id.slice(0, 8)}...
                              </span>
                            )}
                          </Badge>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        <span className="font-mono text-xs break-all">{effectiveCheck.id}</span>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {mode === 'edit' ? 'Update your check configuration' : 'Start monitoring in seconds'}
                </p>
              </div>
            </div>

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onFormSubmit)}
                className="space-y-6"
              >
                {/* ── Type Selector: Compact icon strip ── */}
                <FormField
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex gap-1.5">
                        {CHECK_TYPES.map(({ value, label, icon: Icon }) => (
                          <Tooltip key={value}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => {
                                  field.onChange(value);
                                  handleTypeChange(value as any);
                                }}
                                className={`flex-1 flex flex-col items-center gap-1 py-2.5 px-1 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                                  field.value === value
                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                                }`}
                              >
                                <Icon className="w-4 h-4" />
                                <span className="leading-none">{label}</span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="text-xs">
                              {value === 'website' && 'Monitor website availability'}
                              {value === 'rest_endpoint' && 'Monitor REST APIs'}
                              {value === 'redirect' && 'Monitor HTTP redirects'}
                              {value === 'tcp' && 'Check TCP port reachability'}
                              {value === 'udp' && 'Check UDP port reachability'}
                              {value === 'ping' && 'Monitor host via ICMP ping'}
                              {value === 'websocket' && 'Check WebSocket handshake'}
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </FormItem>
                  )}
                />

                {/* ── Essential Fields ── */}
                <div className="space-y-4">
                  {/* URL */}
                  <FormField
                    control={form.control}
                    name="url"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-muted-foreground">
                          {isPingType ? 'Hostname or IP' : isSocketType ? 'Host and port' : isWebSocketType ? 'WebSocket URL' : 'URL to monitor'}
                        </FormLabel>
                        <FormControl>
                          <div className="flex">
                            {(isHttpType || isWebSocketType) ? (
                              <Select
                                value={urlProtocol}
                                onValueChange={(value) => setUrlProtocol(value as UrlProtocol)}
                              >
                                <SelectTrigger className="h-10 rounded-r-none border-r-0 px-2.5 text-xs font-mono w-auto">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {isHttpType ? (
                                    <>
                                      <SelectItem value="https://">https://</SelectItem>
                                      <SelectItem value="http://">http://</SelectItem>
                                    </>
                                  ) : (
                                    <>
                                      <SelectItem value="wss://">wss://</SelectItem>
                                      <SelectItem value="ws://">ws://</SelectItem>
                                    </>
                                  )}
                                </SelectContent>
                              </Select>
                            ) : (
                              <div className="h-10 rounded-l-lg border border-r-0 px-2.5 text-xs font-mono flex items-center text-muted-foreground bg-muted/30">
                                {watchType === 'tcp' ? 'tcp://' : watchType === 'ping' ? 'ping://' : 'udp://'}
                              </div>
                            )}
                            <Input
                              {...field}
                              onChange={handleUrlChange}
                              placeholder={isPingType ? 'example.com or 1.2.3.4' : isSocketType ? 'example.com:443' : isWebSocketType ? 'example.com/ws' : 'example.com'}
                              className="h-10 rounded-l-none text-sm"
                              autoFocus
                            />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Display name */}
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-medium text-muted-foreground">Display name</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            onChange={(e) => {
                              field.onChange(e);
                              userEditedName.current = true;
                            }}
                            placeholder="Auto-generated from URL"
                            className="h-10 text-sm"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Redirect target (only for redirect type, essential for this type) */}
                  {isRedirectType && (
                    <div className="space-y-4">
                      <FormField
                        control={form.control}
                        name="redirectExpectedTarget"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-muted-foreground">Expected redirect target</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                placeholder="e.g., mydomain.com or https://mydomain.com/page"
                                className="h-10 text-sm"
                              />
                            </FormControl>
                            <FormDescription className="text-xs">
                              Leave empty to just verify a redirect occurs.
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="redirectMatchMode"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs font-medium text-muted-foreground">Match mode</FormLabel>
                            <Select value={field.value || 'contains'} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger className="h-10 text-sm">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="contains">Contains (default)</SelectItem>
                                <SelectItem value="exact">Exact match</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </div>

                {/* ── Submit Button (primary action, above the fold) ── */}
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 text-sm font-medium"
                >
                  {loading ? (
                    <>
                      <Zap className="w-4 h-4 mr-2 animate-pulse" />
                      {mode === 'edit' ? 'Saving...' : 'Adding...'}
                    </>
                  ) : (
                    <>
                      {mode === 'edit' ? <Check className="w-4 h-4 mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                      {mode === 'edit' ? 'Save Changes' : 'Add Check'}
                    </>
                  )}
                </Button>

                {/* ── Settings (collapsible) ── */}
                <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 w-full py-3 group cursor-pointer">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors px-2">
                      <Settings className="w-3.5 h-3.5" />
                      Settings
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} />
                    </span>
                    <div className="h-px flex-1 bg-border/60" />
                  </CollapsibleTrigger>

                  <CollapsibleContent className="space-y-5 pt-2">
                    {/* Schedule & Region */}
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <Clock className="w-3.5 h-3.5" />
                        Schedule
                      </div>

                      <FormField
                        control={form.control}
                        name="checkFrequency"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs font-medium flex items-center gap-1.5">
                                Check every
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[240px]">
                                    <p className="text-xs">Checks run on a shared schedule, so actual intervals are approximate. A 1-minute interval typically runs every 1-2 minutes.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </FormLabel>
                            </div>
                            <FormControl>
                              <CheckIntervalSelector
                                value={field.value}
                                onChange={field.onChange}
                                label=""
                                minSeconds={minCheckIntervalSeconds}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium flex items-center gap-1.5">
                            <MapPin className="w-3 h-3" />
                            Region
                          </span>
                          <span className="text-xs text-muted-foreground">
                            Europe Turbo — Frankfurt, DE
                          </span>
                        </div>
                      </div>

                      <FormField
                        control={form.control}
                        name="timezone"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between gap-4">
                              <FormLabel className="text-xs font-medium whitespace-nowrap">
                                Alert timezone
                              </FormLabel>
                              <Select value={field.value || '_utc'} onValueChange={field.onChange}>
                                <FormControl>
                                  <SelectTrigger className="h-8 text-xs w-auto min-w-[160px]">
                                    <SelectValue placeholder="UTC (default)" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {TIMEZONE_OPTIONS.map((tz) => (
                                    <SelectItem key={tz.value} value={tz.value}>
                                      {tz.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    {/* Alert Behavior */}
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <Shield className="w-3.5 h-3.5" />
                        Alert behavior
                      </div>

                      <FormField
                        control={form.control}
                        name="immediateRecheckEnabled"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs font-medium flex items-center gap-1.5 cursor-pointer">
                                Immediate recheck
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[220px]">
                                    <p className="text-xs">Automatically re-checks failed endpoints after 30 seconds to confirm it was a real outage.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </FormLabel>
                              <FormControl>
                                <Switch
                                  checked={field.value === true}
                                  onCheckedChange={(checked) => field.onChange(checked)}
                                />
                              </FormControl>
                            </div>
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="downConfirmationAttempts"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between gap-4">
                              <FormLabel className="text-xs font-medium flex items-center gap-1.5">
                                Confirm down after
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[220px]">
                                    <p className="text-xs">Number of consecutive failures required before marking as offline. Range: 1-99.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </FormLabel>
                              <div className="flex items-center gap-2">
                                <FormControl>
                                  <Input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    {...field}
                                    value={field.value ?? ''}
                                    onChange={(e) => {
                                      const raw = e.target.value.replace(/[^0-9]/g, '');
                                      if (raw === '') {
                                        field.onChange(undefined);
                                      } else {
                                        const num = parseInt(raw, 10);
                                        if (num >= 1 && num <= 99) {
                                          field.onChange(num);
                                        }
                                      }
                                    }}
                                    className="h-8 w-16 text-xs text-center"
                                  />
                                </FormControl>
                                <span className="text-xs text-muted-foreground">failures</span>
                              </div>
                            </div>
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="responseTimeLimit"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between gap-4">
                              <FormLabel className="text-xs font-medium flex items-center gap-1.5">
                                Max response time
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[220px]">
                                    <p className="text-xs">
                                      {isPingType
                                        ? 'If ping latency exceeds this, the check is marked as down.'
                                        : 'If response time exceeds this, the check is marked as down.'}
                                      {' '}Leave empty to disable.
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </FormLabel>
                              <div className="flex items-center gap-2">
                                <FormControl>
                                  <Input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    placeholder="Off"
                                    {...field}
                                    value={typeof field.value === 'number' ? field.value : ''}
                                    onChange={(e) => {
                                      const raw = e.target.value.replace(/[^0-9]/g, '');
                                      if (raw === '') {
                                        field.onChange('');
                                      } else {
                                        const num = parseInt(raw, 10);
                                        if (num >= 0 && num <= 25000) {
                                          field.onChange(num);
                                        }
                                      }
                                    }}
                                    className="h-8 w-20 text-xs text-center"
                                  />
                                </FormControl>
                                <span className="text-xs text-muted-foreground">ms</span>
                              </div>
                            </div>
                          </FormItem>
                        )}
                      />

                      {isPingType && (
                        <FormField
                          control={form.control}
                          name="pingPackets"
                          render={({ field }) => (
                            <FormItem>
                              <div className="flex items-center justify-between gap-4">
                                <FormLabel className="text-xs font-medium flex items-center gap-1.5">
                                  Ping packets
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[220px]">
                                      <p className="text-xs">ICMP packets per check (1-5). More packets reduce false alerts from transient packet loss.</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    {...field}
                                    value={field.value ?? ''}
                                    onChange={(e) => {
                                      const raw = e.target.value.replace(/[^0-9]/g, '');
                                      if (raw === '') {
                                        field.onChange(undefined);
                                      } else {
                                        const num = parseInt(raw, 10);
                                        if (num >= 1 && num <= 5) {
                                          field.onChange(num);
                                        }
                                      }
                                    }}
                                    className="h-8 w-16 text-xs text-center"
                                  />
                                </FormControl>
                              </div>
                            </FormItem>
                          )}
                        />
                      )}
                    </div>

                    {/* HTTP Configuration (only for HTTP types) */}
                    {isHttpType && (
                      <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          <Send className="w-3.5 h-3.5" />
                          HTTP configuration
                        </div>

                        {!isRedirectType && (
                          <FormField
                            control={form.control}
                            name="httpMethod"
                            render={({ field }) => (
                              <FormItem>
                                <div className="flex items-center justify-between gap-4">
                                  <FormLabel className="text-xs font-medium">Method</FormLabel>
                                  <Select value={field.value} onValueChange={field.onChange}>
                                    <FormControl>
                                      <SelectTrigger className="h-8 text-xs w-auto min-w-[100px]">
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
                                </div>
                              </FormItem>
                            )}
                          />
                        )}

                        <FormField
                          control={form.control}
                          name="expectedStatusCodes"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs font-medium">Expected status codes</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  placeholder="200, 201, 204, 301-308"
                                  className="h-8 text-xs font-mono"
                                />
                              </FormControl>
                              <FormDescription className="text-xs">
                                Commas separate codes, dashes for ranges
                              </FormDescription>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={form.control}
                          name="cacheControlNoCache"
                          render={({ field }) => (
                            <FormItem>
                              <div className="flex items-center justify-between">
                                <FormLabel className="text-xs font-medium flex items-center gap-1.5 cursor-pointer">
                                  Force no-cache
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-[220px]">
                                      <p className="text-xs">Adds Cache-Control: no-cache to requests. Use when your site is heavily cached.</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </FormLabel>
                                <FormControl>
                                  <Switch
                                    checked={field.value === true}
                                    onCheckedChange={(checked) => field.onChange(checked)}
                                  />
                                </FormControl>
                              </div>
                            </FormItem>
                          )}
                        />

                        {/* Sub-collapsibles for rarely-used fields */}
                        <Collapsible open={httpConfigOpen} onOpenChange={setHttpConfigOpen}>
                          <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1">
                            <ChevronDown className={`w-3 h-3 transition-transform ${httpConfigOpen ? 'rotate-180' : ''}`} />
                            Headers, body & validation
                          </CollapsibleTrigger>
                          <CollapsibleContent className="space-y-4 pt-3">
                            <FormField
                              control={form.control}
                              name="requestHeaders"
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel className="text-xs font-medium">Request headers</FormLabel>
                                  <FormControl>
                                    <Textarea
                                      {...field}
                                      placeholder={"Authorization: Bearer token\nContent-Type: application/json"}
                                      rows={2}
                                      className="text-xs font-mono"
                                    />
                                  </FormControl>
                                  <FormDescription className="text-xs">
                                    One header per line as <span className="font-mono">Key: value</span>
                                  </FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />

                            {!isRedirectType && ['POST', 'PUT', 'PATCH'].includes(watchHttpMethod || '') && (
                              <FormField
                                control={form.control}
                                name="requestBody"
                                render={({ field }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs font-medium">Request body</FormLabel>
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

                            {!isRedirectType && (
                              <FormField
                                control={form.control}
                                name="containsText"
                                render={({ field }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs font-medium">Response validation</FormLabel>
                                    <FormControl>
                                      <Input
                                        {...field}
                                        placeholder="success,online,healthy"
                                        className="h-8 text-xs"
                                      />
                                    </FormControl>
                                    <FormDescription className="text-xs">
                                      Comma-separated text that must appear in the response
                                    </FormDescription>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />
                            )}
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    )}
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

function TypeIcon({ type }: { type?: string }) {
  if (type === 'rest_endpoint') return <Code className="w-4 h-4 text-primary" />;
  if (type === 'tcp') return <Server className="w-4 h-4 text-primary" />;
  if (type === 'udp') return <Radio className="w-4 h-4 text-primary" />;
  if (type === 'ping') return <Activity className="w-4 h-4 text-primary" />;
  if (type === 'websocket') return <Zap className="w-4 h-4 text-primary" />;
  if (type === 'redirect') return <ArrowRight className="w-4 h-4 text-primary" />;
  return <Globe className="w-4 h-4 text-primary" />;
}
