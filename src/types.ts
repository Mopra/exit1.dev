// Shared types for the application

export interface Website {
  id: string;
  userId: string;
  name: string;
  url: string;
  type?: 'website' | 'api' | 'rest' | 'rest_endpoint';
  status?: 'online' | 'offline' | 'unknown';
  lastChecked?: number;
  checkFrequency?: number;
  responseTime?: number;
  lastStatusCode?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  disabled?: boolean;
  lastError?: string;
  orderIndex?: number;
  createdAt?: number;
  updatedAt?: number;
  lastFailureTime?: number | null;
  downtimeCount?: number;
  lastDowntime?: number | null;
  userTier?: 'free' | 'pro' | 'enterprise';
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
  
  // Per-check scheduling
  nextCheckAt?: number;
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
    lastError?: string;
    detailedStatus?: string;
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
  status: 'online' | 'offline' | 'unknown';
  responseTime?: number;
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