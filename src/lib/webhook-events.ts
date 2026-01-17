import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, CheckCircle, Shield, ShieldAlert } from 'lucide-react'
export type WebhookEventValue = 'website_down' | 'website_up' | 'ssl_error' | 'ssl_warning'

export interface WebhookEvent {
  value: WebhookEventValue
  label: string
  description: string
  badgeVariant: 'success' | 'warning' | 'error' | 'default'
  color: 'red' | 'green' | 'yellow'
  icon: LucideIcon
}

export const WEBHOOK_EVENTS: WebhookEvent[] = [
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
]

export function findWebhookEvent(value: string) {
  return WEBHOOK_EVENTS.find((e) => e.value === value)
}


