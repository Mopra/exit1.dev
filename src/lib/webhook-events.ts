import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react'
export type WebhookEventValue = 'website_down' | 'website_up' | 'website_error'

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
    value: 'website_error',
    label: 'Website Error',
    description: 'Triggered when a website returns error codes or has performance issues',
    badgeVariant: 'warning',
    color: 'yellow',
    icon: AlertCircle,
  },
]

export function findWebhookEvent(value: string) {
  return WEBHOOK_EVENTS.find((e) => e.value === value)
}


