import type { WebhookEvent } from '../api/types';
import { AlertCircle, AlertTriangle, CheckCircle, Clock, RefreshCw } from 'lucide-react';

export const ALL_NOTIFICATION_EVENTS: { value: WebhookEvent; label: string; icon: typeof AlertCircle }[] = [
  { value: 'website_down', label: 'Down', icon: AlertTriangle },
  { value: 'website_up', label: 'Up', icon: CheckCircle },
  { value: 'ssl_error', label: 'SSL Error', icon: AlertCircle },
  { value: 'ssl_warning', label: 'SSL Warning', icon: AlertCircle },
  { value: 'domain_expiring', label: 'Domain Expiring', icon: Clock },
  { value: 'domain_expired', label: 'Domain Expired', icon: AlertTriangle },
  { value: 'domain_renewed', label: 'Domain Renewed', icon: RefreshCw },
];

export const DEFAULT_NOTIFICATION_EVENTS: WebhookEvent[] = [
  'website_down', 'website_up', 'ssl_error', 'ssl_warning',
  'domain_expiring', 'domain_expired', 'domain_renewed',
];

export type NotificationPendingOverride = {
  enabled?: boolean | null;
  events?: WebhookEvent[] | null;
  recipients?: string[] | null;
};

export type NotificationUsageWindow = {
  count: number;
  max: number;
  windowStart: number;
  windowEnd: number;
};

export type NotificationUsage = {
  hourly: NotificationUsageWindow;
  monthly: NotificationUsageWindow;
};
