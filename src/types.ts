// Shared types for the application

export interface Website {
  id: string;
  name: string;
  url: string;
  status?: 'online' | 'offline' | 'unknown';
  lastChecked?: number;
  downtimeCount?: number;
  lastDowntime?: number;
  createdAt?: number;
  updatedAt?: number;
  orderIndex?: number; // For custom drag & drop ordering
  lastStatusCode?: number;
  responseTime?: number;
  lastError?: string;
  userId?: string;
  
  // Cost optimization fields
  checkFrequency?: number; // minutes between checks
  consecutiveFailures?: number; // track consecutive failures
  lastFailureTime?: number; // when to resume checking after failures
  userTier?: 'free' | 'premium'; // user subscription tier
  
  // Dead site management
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
    expectedValue?: any; // Expected value for JSONPath validation
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

// Webhook types
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

export type WebhookEvent = 'website_down' | 'website_up' | 'website_error';

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