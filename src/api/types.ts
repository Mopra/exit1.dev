// Shared API types for all Exit1 clients
// This file should be kept in sync across all projects (web, CLI, native apps)

// Core website monitoring types
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
  
  // Cost optimization fields
  checkFrequency: number; // minutes between checks
  consecutiveFailures: number; // track consecutive failures
  lastFailureTime?: number; // when to resume checking after failures
  userTier: 'free' | 'premium'; // user subscription tier
  
  // Dead site management
  disabled?: boolean; // permanently disabled due to extended downtime
  disabledAt?: number; // when the site was disabled
  disabledReason?: string; // reason for disabling (e.g., "Extended downtime")
  
  // Ordering
  orderIndex?: number; // For custom ordering
  
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

// Check aggregation data structure for long-term tracking (hourly buckets)
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
}

export interface UpdateWebsiteRequest {
  id: string;
  url: string;
  name: string;
}

export interface ToggleWebsiteStatusRequest {
  id: string;
  disabled: boolean;
  reason?: string;
}

export interface ReorderWebsitesRequest {
  fromIndex: number;
  toIndex: number;
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

export interface GetCheckHistoryResponse {
  history: CheckHistory[];
  count: number;
}

// Check Aggregations API types
export interface GetCheckAggregationsRequest {
  websiteId: string;
  days?: number; // Number of days to fetch (default: 7)
}

export interface GetCheckAggregationsResponse {
  aggregations: CheckAggregation[];
  count: number;
}

// Webhook API types
export interface SaveWebhookRequest {
  url: string;
  name: string;
  events: WebhookEvent[];
  secret?: string;
  headers?: Record<string, string>;
}

export interface UpdateWebhookRequest {
  id: string;
  url?: string;
  name?: string;
  events?: WebhookEvent[];
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

// Discord API types
export interface DiscordAuthRequest {
  discordUserId: string;
  userEmail?: string;
  username?: string;
}

export interface DiscordAuthResponse {
  inviteUrl?: string;
  alreadyMember: boolean;
  message: string;
}

// Migration types
export interface MigrateWebsitesResponse {
  migratedCount: number;
  message: string;
}

// User tier types
export type UserTier = 'free' | 'premium';

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
export type WebsiteStatus = 'online' | 'offline' | 'unknown';
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