// Core website monitoring types

// Website data structure
export interface Website {
  id: string
  userId: string
  name: string
  url: string
  type?: 'website' | 'api' | 'rest' | 'rest_endpoint' | 'tcp' | 'udp' // Type of endpoint being monitored
  status?: 'online' | 'offline' | 'unknown'
  lastChecked?: number
  lastHistoryAt?: number
  checkFrequency?: number // in minutes
  userTier?: 'free' | 'nano' | 'premium' // user subscription tier (cached on the check doc)
  // Single owning region for where this check executes (nano can auto-pick)
  checkRegion?: 'us-central1' | 'europe-west1' | 'asia-southeast1'
  responseTime?: number
  responseTimeLimit?: number // Maximum acceptable response time in milliseconds
  lastStatusCode?: number
  consecutiveFailures: number
  consecutiveSuccesses: number
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN'

  // Best-effort target geo metadata (cached on check doc for UI usage)
  targetCountry?: string
  targetRegion?: string
  targetCity?: string
  targetLatitude?: number
  targetLongitude?: number
  targetHostname?: string
  targetIp?: string
  targetIpsJson?: string
  targetIpFamily?: number
  targetAsn?: string
  targetOrg?: string
  targetIsp?: string
  targetMetadataLastChecked?: number
  
  // Nano feature: user-defined grouping for large check lists
  folder?: string | null;
  
  // HTTP request configuration
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  expectedStatusCodes?: number[] // Expected HTTP status codes for success
  requestHeaders?: Record<string, string>; // Custom headers for REST requests
  requestBody?: string; // JSON string for POST/PUT requests
  cacheControlNoCache?: boolean;
  responseValidation?: {
    containsText?: string[]; // Text that should be present in response
    jsonPath?: string; // JSONPath expression to validate response
    expectedValue?: unknown; // Expected value for JSONPath validation
  };
  
  // NEW FIELDS for SSL certificate validation
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number; // timestamp
    validTo?: number; // timestamp
    daysUntilExpiry?: number;
    lastChecked?: number;
    error?: string;
  };
  
  // Ordering
  orderIndex?: number; // For custom ordering
  
  // Immediate re-check feature: when enabled, schedules a quick re-check (30s) for any non-UP status
  // to verify if it was a transient glitch before alerting. Defaults to true for new checks.
  immediateRecheckEnabled?: boolean;
  
  // Missing properties that are used in the functions code
  disabled?: boolean;
  disabledAt?: number;
  disabledReason?: string;
  downtimeCount?: number;
  lastDowntime?: number;
  lastFailureTime?: number | null;
  lastError?: string | null;
  uptimeCount?: number;
  lastUptime?: number;
  createdAt?: number;
  updatedAt?: number;
  nextCheckAt?: number;
  pendingDownEmail?: boolean;
  pendingDownSince?: number | null;
  pendingUpEmail?: boolean;
  pendingUpSince?: number | null;
}

// Check history data structure for 24-hour tracking
export interface CheckHistory {
  id: string
  websiteId: string
  userId: string
  timestamp: number
  status: 'online' | 'offline' | 'unknown' | 'disabled'
  responseTime?: number
  dnsMs?: number
  connectMs?: number
  tlsMs?: number
  ttfbMs?: number
  totalChecks?: number
  issueCount?: number
  statusCode?: number
  error?: string
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN'
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
}

// Webhook types
export interface WebhookSettings {
  id?: string;
  userId: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  checkFilter?: WebhookCheckFilter;
  enabled: boolean;
  secret?: string; // Optional secret for webhook signature
  headers?: Record<string, string>; // Optional custom headers
  webhookType?: 'slack' | 'discord' | 'generic'; // Webhook platform type
  createdAt: number;
  updatedAt: number;
}

export type WebhookEvent = 'website_down' | 'website_up' | 'website_error' | 'ssl_error' | 'ssl_warning';

export type WebhookCheckFilter = {
  mode: 'all' | 'include';
  checkIds?: string[];
};

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: number;
  website: {
    id: string;
    name: string;
    url: string;
    status: string;
    responseTime?: number;
    responseTimeLimit?: number;
    responseTimeExceeded?: boolean;
    lastError?: string | null;
    lastStatusCode?: number;
    detailedStatus?: string;
    statusCodeInfo?: string;
    explanation?: string;
    sslCertificate?: {
      valid: boolean;
      issuer?: string;
      subject?: string;
      validFrom?: number;
      validTo?: number;
      daysUntilExpiry?: number;
      error?: string;
    };
  };
  previousStatus?: string;
  userId: string;
} 

// Email notification settings
export interface EmailSettings {
  userId: string;
  enabled: boolean;
  recipient: string; // destination email address
  events: WebhookEvent[]; // events to notify about
  // Global flap suppression: require N consecutive checks before emailing (applies to all event types)
  minConsecutiveEvents?: number; // default 1
  perCheck?: {
    [checkId: string]: {
      enabled?: boolean;
      events?: WebhookEvent[];
    };
  };
  createdAt: number;
  updatedAt: number;
}

// SMS notification settings
export interface SmsSettings {
  userId: string;
  enabled: boolean;
  recipient: string; // destination phone number (E.164)
  events: WebhookEvent[]; // events to notify about
  // Global flap suppression: require N consecutive checks before texting (applies to all event types)
  minConsecutiveEvents?: number; // default 1
  perCheck?: {
    [checkId: string]: {
      enabled?: boolean;
      events?: WebhookEvent[];
    };
  };
  createdAt: number;
  updatedAt: number;
}

// API Key types
export interface ApiKeyDoc {
  userId: string;
  name?: string;
  hash: string;
  prefix: string;
  last4: string;
  enabled: boolean;
  scopes?: string[];
  createdAt: number;
  lastUsedAt?: number;
  lastUsedPath?: string;
}
