// Shared types for the application

export interface Website {
  id: string;
  userId: string;
  name: string;
  url: string;
  type?: 'website' | 'api' | 'rest' | 'rest_endpoint' | 'tcp' | 'udp';
  status?: 'online' | 'offline' | 'unknown';
  // Single owning region for where this check executes
  checkRegion?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1';
  // User-set region override; when set, auto-region detection is skipped
  checkRegionOverride?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1' | null;
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
  cacheControlNoCache?: boolean;
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
  
  // Immediate re-check feature: when enabled, schedules a quick re-check (30s) for any non-UP status
  // to verify if it was a transient glitch before alerting. Defaults to true for new checks.
  immediateRecheckEnabled?: boolean;
  
  // Down confirmation attempts: number of consecutive failures required before marking as offline.
  // Defaults to 4 if not set. Range: 1-99.
  downConfirmationAttempts?: number;

  // IANA timezone for this check (e.g. 'America/New_York', 'Europe/London').
  // Used to display local time in email/webhook notifications.
  timezone?: string;
  
  // Maintenance mode
  maintenanceMode?: boolean;
  maintenanceStartedAt?: number;
  maintenanceExpiresAt?: number;
  maintenanceDuration?: number;
  maintenanceReason?: string;

  // Scheduled maintenance (one-time future window)
  maintenanceScheduledStart?: number | null;
  maintenanceScheduledDuration?: number | null;
  maintenanceScheduledReason?: string | null;

  // Recurring maintenance
  maintenanceRecurring?: {
    daysOfWeek: number[];      // 0=Sun, 1=Mon, ..., 6=Sat
    startTimeMinutes: number;  // 0-1439, minutes from midnight in user's TZ
    durationMinutes: number;   // 5, 15, 30, 60, 120, or 240
    timezone: string;          // IANA e.g. "America/New_York"
    reason?: string | null;
    createdAt: number;
  } | null;
  maintenanceRecurringActiveUntil?: number | null;

  // Domain Intelligence (DI) - Domain Expiry Monitoring
  domainExpiry?: DomainExpiry;
}

// Domain Intelligence types
export type DomainExpiryStatus = 'active' | 'expiring_soon' | 'expired' | 'unknown' | 'error';

export interface DomainExpiry {
  enabled: boolean;
  domain: string;
  
  // Registration Data (from RDAP)
  registrar?: string;
  registrarUrl?: string;
  createdDate?: number;
  updatedDate?: number;
  expiryDate?: number;
  nameservers?: string[];
  registryStatus?: string[];
  
  // Status Tracking
  status: DomainExpiryStatus;
  daysUntilExpiry?: number;
  lastCheckedAt?: number;
  nextCheckAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  
  // Alert Configuration
  alertThresholds: number[];
  alertsSent: number[];
}

// Domain Intelligence view data (check + domain expiry combined)
export interface DomainIntelligenceItem {
  checkId: string;
  checkName: string;
  checkUrl: string;
  folder?: string | null;
  enabled: boolean;
  domain: string;
  registrar?: string;
  registrarUrl?: string;
  createdDate?: number;
  updatedDate?: number;
  expiryDate?: number;
  nameservers?: string[];
  registryStatus?: string[];
  status: DomainExpiryStatus;
  daysUntilExpiry?: number;
  lastCheckedAt?: number;
  nextCheckAt?: number;
  lastError?: string;
  consecutiveErrors: number;
  alertThresholds: number[];
  alertsSent: number[];
}

export type StatusPageVisibility = 'public' | 'private';

export type StatusPageLayout = 'grid-2' | 'grid-3' | 'single-5xl' | 'custom';

export type StatusPageBranding = {
  logoUrl?: string | null;
  faviconUrl?: string | null;
  brandColor?: string | null;
};

// Custom layout widget types
export type WidgetType = 'timeline' | 'text' | 'uptime' | 'incidents' | 'downtime' | 'map' | 'status';

export type DowntimeMode = 'total' | 'average';

export interface WidgetGridPosition {
  col: number;      // 1-12 column start
  row: number;      // 1-N row start
  colSpan: number;  // 1-12 columns wide
  rowSpan: number;  // 1-N rows tall
}

export type TextWidgetSize = 'small' | 'medium' | 'large';

export type IncidentsMode = 'total' | 'average';

export interface CustomLayoutWidget {
  id: string;
  type: WidgetType;
  checkId?: string;  // Optional for text widgets, single check for timeline
  checkIds?: string[];  // Multiple checks for uptime widget average
  gridPosition: WidgetGridPosition;
  // Text widget specific
  textContent?: string;
  textSize?: TextWidgetSize;
  // Uptime widget specific
  showCheckName?: boolean;  // Default: true (auto-disabled when multiple checks selected)
  // Timeline widget specific
  showCheckCount?: boolean;  // Default: true — show "N checks" label in multi-check timeline
  showStatus?: boolean;      // Default: true — show aggregated status badge in timeline header
  // Incidents widget specific
  incidentsMode?: IncidentsMode;  // Default: 'total'
  // Downtime widget specific
  downtimeMode?: DowntimeMode;  // Default: 'total'
}

export interface CustomLayoutConfig {
  widgets: CustomLayoutWidget[];
  gridColumns: number;  // default 12
  rowHeight: number;    // pixels, default 120
}

export interface StatusPage {
  id: string;
  userId: string;
  name: string;
  visibility: StatusPageVisibility;
  checkIds: string[];
  /** @deprecated Folder selections are now resolved to explicit checkIds at save time */
  folderPaths?: string[];
  layout?: StatusPageLayout;
  groupByFolder?: boolean;
  branding?: StatusPageBranding | null;
  customLayout?: CustomLayoutConfig | null;
  createdAt: number;
  updatedAt: number;
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
  secret?: string;
  headers?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  // Health tracking
  lastDeliveryStatus?: 'success' | 'failed' | 'permanent_failure';
  lastDeliveryAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  permanentFailureNotifiedAt?: number; // Track when we last sent an email about permanent failure
}

export type WebhookEvent = 'website_down' | 'website_up' | 'website_error' | 'ssl_error' | 'ssl_warning' | 'domain_expiring' | 'domain_expired' | 'domain_renewed';

export type WebhookCheckFilter = {
  mode: 'all' | 'include';
  checkIds?: string[];
  folderPaths?: string[];
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
  recipient?: string; // @deprecated - use recipients array instead
  recipients?: string[]; // destination email addresses
  events: WebhookEvent[];
  minConsecutiveEvents?: number;
  perCheck?: {
    [checkId: string]: {
      enabled?: boolean;
      events?: WebhookEvent[];
    };
  };
  perFolder?: {
    [folderPath: string]: {
      enabled?: boolean;
      events?: WebhookEvent[];
      recipients?: string[];
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
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
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

// User preferences stored in Firestore
export interface UserPreferences {
  userId: string;
  sorting?: {
    checks?: string; // SortOption from CheckTable
    emails?: string;
    sms?: string;
    webhooks?: string;
    logs?: string;
    domainIntelligence?: string;
  };
  createdAt?: number;
  updatedAt?: number;
}
