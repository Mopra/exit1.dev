// Shared API types for all Exit1 clients
// This file should be kept in sync across all projects (web, CLI, native apps)

// Core website monitoring types
export interface Website {
  id: string;
  url: string;
  name: string;
  userId: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | 'disabled';
  lastChecked: number;
  lastStatusCode?: number;
  responseTime?: number;
  responseTimeLimit?: number; // Maximum acceptable response time in milliseconds
  lastError?: string;
  downtimeCount: number;
  lastDowntime?: number;
  createdAt: number;
  updatedAt: number;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  
  // Cost optimization fields
  checkFrequency: number; // minutes between checks
  consecutiveFailures: number; // track consecutive failures
  lastFailureTime?: number; // when to resume checking after failures
  userTier: 'free' | 'nano'; // user subscription tier
  
  // Dead site management
  disabled?: boolean; // permanently disabled due to extended downtime
  disabledAt?: number; // when the site was disabled
  disabledReason?: string; // reason for disabling (e.g., "Extended downtime")
  
  // Ordering
  orderIndex?: number; // For custom ordering
  
  // Nano feature: user-defined grouping for large check lists
  folder?: string | null;
  
  // NEW FIELDS for REST endpoint monitoring
  type?: 'website' | 'rest_endpoint' | 'tcp' | 'udp'; // Type of monitoring target
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; // HTTP method for REST endpoints
  expectedStatusCodes?: number[]; // Expected status codes (e.g., [200, 201] for success)
  requestHeaders?: { [key: string]: string }; // Custom headers for REST requests
  requestBody?: string; // JSON string for POST/PUT requests
  cacheControlNoCache?: boolean;
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
  
  // Per-check scheduling
  nextCheckAt?: number; // timestamp when this check should next run
}

// Check history data structure for 24-hour tracking
export interface CheckHistory {
  id: string;
  websiteId: string;
  userId: string;
  timestamp: number;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | 'disabled';
  responseTime?: number;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  totalChecks?: number;
  issueCount?: number;
  statusCode?: number;
  error?: string;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  createdAt: number;

  // Target metadata (best-effort)
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
}

export interface LogNote {
  id: string;
  logId: string;
  websiteId: string;
  message: string;
  createdAt: number;
  updatedAt: number;
}

export interface ManualLogEntry {
  id: string;
  websiteId: string;
  message: string;
  status: WebsiteStatus;
  timestamp: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReportIncidentInterval {
  startedAt: number;
  endedAt: number;
}

export interface ReportResponseTimeBucket {
  bucketStart: number;
  avgResponseTime: number;
  sampleCount: number;
}

export interface ReportMetrics {
  stats: {
    totalChecks: number;
    onlineChecks: number;
    offlineChecks: number;
    uptimePercentage: number;
    totalDurationMs: number;
    onlineDurationMs: number;
    offlineDurationMs: number;
    responseSampleCount: number;
    avgResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
  };
  incidents: ReportIncidentInterval[];
  responseTimeBuckets: ReportResponseTimeBucket[];
  bucketSizeMs: number;
}



// User data structure
export interface User {
  uid: string;
  email: string;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationBillingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface OrganizationBillingProfile {
  companyName?: string;
  legalName?: string;
  email?: string;
  phone?: string;
  taxId?: string;
  taxIdLabel?: string;
  address?: OrganizationBillingAddress;
  customFields?: Record<string, string>;
}

// Webhook notification settings
export interface WebhookSettings {
  id?: string;
  userId: string;
  url: string;
  name: string;
  enabled: boolean;
  events: WebhookEvent[];
  checkFilter?: WebhookCheckFilter;
  secret?: string;
  headers?: { [key: string]: string };
  webhookType?: 'slack' | 'discord' | 'generic';
  createdAt: number;
  updatedAt: number;
}

// Webhook event types
export type WebhookEvent = 'website_down' | 'website_up' | 'website_error' | 'ssl_error' | 'ssl_warning';

export type WebhookCheckFilter = {
  mode: 'all' | 'include';
  checkIds?: string[];
};

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
    responseTimeLimit?: number;
    responseTimeExceeded?: boolean;
    lastError?: string | null;
    lastStatusCode?: number;
    detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
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

// SMS notification settings
export interface SmsSettings {
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

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Website API types
export interface AddWebsiteRequest {
  url: string;
  name?: string;
  checkFrequency?: number; // in minutes, default 60 (1 hour)
  responseTimeLimit?: number | null;
  downConfirmationAttempts?: number;
  cacheControlNoCache?: boolean;
  type?: 'website' | 'rest_endpoint' | 'tcp' | 'udp';
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  expectedStatusCodes?: number[];
  requestHeaders?: { [key: string]: string };
  requestBody?: string;
  responseValidation?: {
    containsText?: string[];
    jsonPath?: string;
    expectedValue?: any;
  };
}

export interface UpdateWebsiteRequest {
  id: string;
  url: string;
  name: string;
  checkFrequency?: number;
  responseTimeLimit?: number | null;
  immediateRecheckEnabled?: boolean;
  downConfirmationAttempts?: number;
  type?: 'website' | 'rest_endpoint' | 'tcp' | 'udp';
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  expectedStatusCodes?: number[];
  requestHeaders?: { [key: string]: string };
  requestBody?: string;
  cacheControlNoCache?: boolean;
  responseValidation?: {
    containsText?: string[];
    jsonPath?: string;
    expectedValue?: any;
  };
}

export interface ToggleWebsiteStatusRequest {
  id: string;
  disabled: boolean;
  reason?: string;
}

export interface ManualCheckRequest {
  websiteId: string;
}

export interface ManualCheckResponse {
  status: string;
  lastChecked: number;
}

// Check History API types
export interface GetCheckHistoryRequest {
  websiteId: string;
}

// Webhook API types
export interface SaveWebhookRequest {
  url: string;
  name: string;
  events: WebhookEvent[];
  checkFilter?: WebhookCheckFilter;
  secret?: string;
  headers?: Record<string, string>;
}

export interface UpdateWebhookRequest {
  id: string;
  url?: string;
  name?: string;
  events?: WebhookEvent[];
  checkFilter?: WebhookCheckFilter;
  enabled?: boolean;
  secret?: string;
  headers?: Record<string, string>;
}

export interface TestWebhookResponse {
  status: number;
  statusText: string;
  message: string;
}

// System API types
export interface SystemStatus {
  recentErrors: Array<{
    id: string;
    website: string;
    error: string;
    timestamp: number;
    status: string;
  }>;
  systemInfo: {
    uptime: number;
    memory: NodeJS.MemoryUsage;
    timestamp: number;
    version: string;
    platform: string;
  };
  services: {
    firestore: boolean;
    functions: boolean;
  };
}





// User tier types
export type UserTier = 'free' | 'nano';

export interface UserLimits {
  maxWebsites: number;
  maxWebhooks: number;
  checkIntervalMinutes: number;
}

// Configuration types
export interface ApiConfig {
  projectId: string;
  region: string;
  apiVersion: string;
}

// Error types
export interface ApiError {
  code: string;
  message: string;
  details?: any;
}

// Common API error codes
export const API_ERROR_CODES = {
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  INVALID_URL: 'INVALID_URL',
  WEBSITE_NOT_FOUND: 'WEBSITE_NOT_FOUND',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = typeof API_ERROR_CODES[keyof typeof API_ERROR_CODES];

// Utility types
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type RequiredFields<T, K extends keyof T> = T & { [P in K]-?: T[P] };

// Status types
export type WebsiteStatus = 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | 'disabled';
export type CheckStatus = 'pending' | 'checking' | 'completed' | 'failed';

// Event types for real-time updates
export interface WebsiteStatusChangeEvent {
  websiteId: string;
  websiteName: string;
  oldStatus: WebsiteStatus;
  newStatus: WebsiteStatus;
  timestamp: number;
}

export interface WebsiteUpdateEvent {
  websiteId: string;
  changes: Partial<Website>;
  timestamp: number;
}

// Pagination types
export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Filter types
export interface WebsiteFilters {
  status?: WebsiteStatus;
  disabled?: boolean;
  search?: string;
  createdAfter?: number;
  createdBefore?: number;
}

export interface WebhookFilters {
  enabled?: boolean;
  events?: WebhookEvent[];
  search?: string;
}

// API Key types
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt?: number | null;
  scopes?: string[];
}

export interface CreateApiKeyResponse {
  id: string;
  key: string; // plaintext (shown once)
  name: string;
  prefix: string;
  last4: string;
  createdAt: number;
} 
