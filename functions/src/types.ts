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
  
  // NEW FIELDS for REST endpoint monitoring
  type?: 'website' | 'rest_endpoint'; // Type of monitoring target
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; // HTTP method for REST endpoints
  expectedStatusCodes?: number[]; // Expected status codes (e.g., [200, 201] for success)
  requestHeaders?: { [key: string]: string }; // Custom headers for REST requests
  requestBody?: string; // JSON string for POST/PUT requests
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
}

// Check history data structure for 24-hour tracking
export interface CheckHistory {
  id: string;
  websiteId: string;
  userId: string;
  timestamp: number;
  status: 'online' | 'offline' | 'unknown';
  responseTime?: number;
  statusCode?: number;
  error?: string;
  createdAt: number;
}

// Aggregated check data for long-term storage (hourly buckets)
export interface CheckAggregation {
  id: string;
  websiteId: string;
  userId: string;
  hourTimestamp: number; // Start of the hour (e.g., 2024-01-01 14:00:00)
  totalChecks: number;
  onlineChecks: number;
  offlineChecks: number;
  averageResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  uptimePercentage: number;
  lastStatus: 'online' | 'offline' | 'unknown';
  lastStatusCode?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
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