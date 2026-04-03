import type { LucideIcon } from 'lucide-react'
import type { WebhookEvent } from '../api/types'
import { AlertTriangle, CheckCircle, Clock, RefreshCw, Shield, ShieldAlert } from 'lucide-react'

export interface WebhookEventConfig {
  value: WebhookEvent
  label: string
  description: string
  badgeVariant: 'success' | 'warning' | 'error' | 'default'
  color: 'red' | 'green' | 'yellow'
  icon: LucideIcon
}

export const WEBHOOK_EVENTS: WebhookEventConfig[] = [
  {
    value: 'website_down',
    label: 'Website Down',
    description: 'Triggered when a website becomes unavailable or returns error codes',
    badgeVariant: 'error',
    color: 'red',
    icon: AlertTriangle,
  },
  {
    value: 'website_up',
    label: 'Website Up',
    description: 'Triggered when a website becomes available again after being down',
    badgeVariant: 'success',
    color: 'green',
    icon: CheckCircle,
  },
  {
    value: 'ssl_error',
    label: 'SSL Error',
    description: 'Triggered when an SSL certificate is invalid, expired, or has connection issues',
    badgeVariant: 'error',
    color: 'red',
    icon: ShieldAlert,
  },
  {
    value: 'ssl_warning',
    label: 'SSL Warning',
    description: 'Triggered when an SSL certificate is expiring soon (within 30 days)',
    badgeVariant: 'warning',
    color: 'yellow',
    icon: Shield,
  },
  {
    value: 'domain_expiring',
    label: 'Domain Expiring',
    description: 'Triggered when a domain is expiring soon (at configured thresholds)',
    badgeVariant: 'warning',
    color: 'yellow',
    icon: Clock,
  },
  {
    value: 'domain_expired',
    label: 'Domain Expired',
    description: 'Triggered when a domain has expired',
    badgeVariant: 'error',
    color: 'red',
    icon: AlertTriangle,
  },
  {
    value: 'domain_renewed',
    label: 'Domain Renewed',
    description: 'Triggered when a domain has been renewed',
    badgeVariant: 'success',
    color: 'green',
    icon: RefreshCw,
  },
]

