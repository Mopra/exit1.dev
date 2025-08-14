// Core website monitoring types

// Website data structure
export interface Website {
  id: string;
  url: string;
  name: string;
  userId: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  lastChecked: number;
  lastStatusCode?: number;
  responseTime?: number;
  lastError?: string | null;
  downtimeCount: number;
  lastDowntime?: number;
  createdAt: number;
  updatedAt: number;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  
  // NEW FIELDS for cost optimization
  checkFrequency: number; // minutes between checks
  consecutiveFailures: number; // track consecutive failures
  consecutiveSuccesses?: number; // track consecutive successes for flap suppression
  lastFailureTime?: number; // when to resume checking after failures
  userTier: 'free' | 'premium'; // user subscription tier
  
  // NEW FIELD for dead site management
  disabled?: boolean; // permanently disabled due to extended downtime
  disabledAt?: number; // when the site was disabled
  disabledReason?: string; // reason for disabling (e.g., "Extended downtime")
  
  // Per-check scheduling
  nextCheckAt?: number; // timestamp when this check should next run
  
  // Pending email notifications for flap suppression
  pendingDownEmail?: boolean;
  pendingDownSince?: number | null;
  pendingUpEmail?: boolean;
  pendingUpSince?: number | null;
  
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
  
  // Ordering
  orderIndex?: number; // For custom ordering
}

// Check history data structure for 24-hour tracking
export interface CheckHistory {
  id: string;
  websiteId: string;
  userId: string;
  timestamp: number;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  responseTime?: number;
  statusCode?: number;
  error?: string;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  createdAt: number;
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
    status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
    responseTime?: number;
    lastError?: string;
    detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
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