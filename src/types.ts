// Shared types for the application

export interface Website {
  id: string;
  userId: string;
  name: string;
  url: string;
  type?: 'website' | 'api' | 'rest' | 'rest_endpoint';
  status?: 'online' | 'offline' | 'unknown';
  // Single owning region for where this check executes (nano can auto-pick)
  checkRegion?: 'us-central1' | 'europe-west1' | 'asia-southeast1';
  lastChecked?: number;
  lastHistoryAt?: number;
  checkFrequency?: number;
  responseTime?: number;
  responseTimeLimit?: number; // Maximum acceptable response time in milliseconds
  lastStatusCode?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  disabled?: boolean;
  lastError?: string;
  orderIndex?: number;

  // Best-effort target geo metadata (cached on check doc by backend)
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  targetMetadataLastChecked?: number;
  // Nano feature: user-defined grouping for large check lists
  folder?: string | null;
  createdAt?: number;
  updatedAt?: number;
  lastFailureTime?: number | null;
  downtimeCount?: number;
  lastDowntime?: number | null;
  // Backend uses 'free' | 'nano' (older docs may have 'premium' but are normalized server-side).
  userTier?: 'free' | 'nano' | 'premium';
  disabledAt?: number | null;
  disabledReason?: string | null;
  
  // HTTP request configuration
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  expectedStatusCodes?: number[];
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseValidation?: {
    containsText?: string[];
    jsonPath?: string;
    expectedValue?: unknown;
  };
  
  // SSL certificate validation
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    lastChecked?: number;
    error?: string;
  };
  
  // Domain expiry validation
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
    daysUntilExpiry?: number;
    lastChecked?: number;
    error?: string;
    nameservers?: string[];
    hasDNSSEC?: boolean;
    status?: string[];
    events?: Array<{ action: string; date: string; actor?: string }>;
  };
  
  // Per-check scheduling
  nextCheckAt?: number;
  
  // Immediate re-check feature: when enabled, schedules a quick re-check (30s) for any non-UP status
  // to verify if it was a transient glitch before alerting. Defaults to true for new checks.
  immediateRecheckEnabled?: boolean;
}

// Webhook types
export interface WebhookSettings {
  id?: string;
  userId: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  secret?: string;
  headers?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type WebhookEvent = 'website_down' | 'website_up' | 'website_error' | 'ssl_error' | 'ssl_warning';

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
  recipient: string;
  events: WebhookEvent[];
  minConsecutiveEvents?: number;
  perCheck?: {
    [checkId: string]: {
      enabled?: boolean;
      events?: WebhookEvent[];
    };
  };
  createdAt: number;
  updatedAt: number;
}

// Check history data structure
export interface CheckHistory {
  id: string;
  websiteId: string;
  userId: string;
  timestamp: number;
  status: 'online' | 'offline' | 'unknown' | 'disabled';
  responseTime?: number;
  totalChecks?: number;
  issueCount?: number;
  statusCode?: number;
  error?: string;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
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
