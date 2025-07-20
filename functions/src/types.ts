// Core website monitoring types

// Website data structure
export interface Website {
  id: string;
  url: string;
  name: string;
  userId: string;
  status: 'online' | 'offline' | 'unknown';
  lastChecked: number;
  lastStatusCode?: number;
  responseTime?: number;
  lastError?: string;
  downtimeCount: number;
  lastDowntime?: number;
  createdAt: number;
  updatedAt: number;
  
  // NEW FIELDS for cost optimization
  checkFrequency: number; // minutes between checks
  consecutiveFailures: number; // track consecutive failures
  lastFailureTime?: number; // when to resume checking after failures
  userTier: 'free' | 'premium'; // user subscription tier
  
  // NEW FIELD for dead site management
  disabled?: boolean; // permanently disabled due to extended downtime
  disabledAt?: number; // when the site was disabled
  disabledReason?: string; // reason for disabling (e.g., "Extended downtime")
}

// User data structure
export interface User {
  uid: string;
  email: string;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
}

// Webhook notification settings
export interface WebhookSettings {
  id?: string;
  userId: string;
  url: string;
  name: string;
  enabled: boolean;
  events: WebhookEvent[];
  secret?: string;
  headers?: { [key: string]: string };
  createdAt: number;
  updatedAt: number;
}

// Webhook event types
export type WebhookEvent = 'website_down' | 'website_up' | 'website_error';

// Webhook payload structure
export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: number;
  website: {
    id: string;
    name: string;
    url: string;
    status: 'online' | 'offline' | 'unknown';
    responseTime?: number;
    lastError?: string;
  };
  previousStatus?: string;
  userId: string;
} 