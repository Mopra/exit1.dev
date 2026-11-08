// Shared types for the application
import type { WebhookEvent } from './api/types';

// Response body assertions for HTTP checks. Mirrors functions/src/response-validation.ts.
// Legacy checks use the single jsonPath/jsonPathOperator/expectedValue; jsonAssertions,
// when non-empty, replaces it.
export type JsonPathOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'exists'
  | 'greater_than'
  | 'greater_or_equal'
  | 'less_than'
  | 'less_or_equal';

export type MatchMode = 'all' | 'any';

export interface JsonAssertion {
  path: string;
  operator?: JsonPathOperator;
  expectedValue?: unknown;
}

export interface ResponseValidation {
  containsText?: string[];
  containsTextMode?: MatchMode;
  notContainsText?: string[];
  jsonPath?: string;
  expectedValue?: unknown;
  jsonPathOperator?: JsonPathOperator;
  jsonAssertions?: JsonAssertion[];
  jsonAssertionsMode?: MatchMode;
}

export interface Website {
  id: string;
  userId: string;
  name: string;
  url: string;
  type?: 'website' | 'api' | 'rest' | 'rest_endpoint' | 'llm' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect' | 'dns' | 'heartbeat' | 'domain';
  status?: 'online' | 'offline' | 'degraded' | 'unknown';
  // Single owning region for where this check executes
  checkRegion?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1' | 'vps-us-1';
  // User-set region override; when set, auto-region detection is skipped
  checkRegionOverride?: 'us-central1' | 'europe-west1' | 'asia-southeast1' | 'vps-eu-1' | 'vps-us-1' | null;
  lastChecked?: number;
  lastHistoryAt?: number;
  checkFrequency?: number;
  responseTime?: number;
  responseTimeLimit?: number; // Maximum acceptable response time in milliseconds
  lastStatusCode?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  detailedStatus?: 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN';
  redirectLocation?: string | null;
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
  // User-assigned importance, P1 (critical) … P5 (minimal). Alert integrations
  // map it to notification priority (Pushover) and cap every alert the check
  // sends. Unset/null = "use default priority" (integration's own setting).
  severity?: 1 | 2 | 3 | 4 | 5 | null;
  // Admin-only: surface this check as a public uptime landing page (exit1.dev/status).
  public?: boolean;
  publicSlug?: string;
  createdAt?: number;
  updatedAt?: number;
  lastFailureTime?: number | null;
  downtimeCount?: number;
  lastDowntime?: number | null;
  // Current lineup. Older docs may carry retired values ('premium', 'scale',
  // 'agency') but those are normalized server-side.
  userTier?: 'free' | 'indie' | 'nano' | 'pro';
  disabledAt?: number | null;
  disabledReason?: string | null;
  
  // HTTP request configuration
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  expectedStatusCodes?: number[];
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  cacheControlNoCache?: boolean;
  ignoreSslErrors?: boolean;
  responseValidation?: ResponseValidation;

  // Redirect validation (for redirect check type)
  redirectValidation?: {
    expectedTarget: string;
    matchMode: 'contains' | 'exact';
  };
  maxRedirects?: number;

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

  // Number of ICMP packets to send per ping check (1-5). Default: 3.
  pingPackets?: number;

  // IANA timezone for this check (e.g. 'America/New_York', 'Europe/London').
  // Used to display local time in email/webhook notifications.
  timezone?: string;
  
  // Heartbeat check fields
  heartbeatToken?: string;
  lastPingAt?: number | null;
  lastPingMetadata?: {
    status?: string;
    duration?: number;
    message?: string;
  } | null;

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

  // DNS Record Monitoring
  dnsMonitoring?: {
    recordTypes: ('A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SOA')[];
    baseline: Record<string, { values: string[]; capturedAt: number }>;
    lastResult: Record<string, { values: string[]; queriedAt: number; responseTimeMs: number }>;
    changes: {
      recordType: string;
      changeType: 'changed' | 'missing' | 'added';
      previousValues: string[];
      newValues: string[];
      detectedAt: number;
    }[];
    autoAccept: boolean;
    autoAcceptConsecutiveCount?: number;
  };

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

export type StatusPageFont = 'system' | 'serif' | 'mono';

export type StatusPageBranding = {
  logoUrl?: string | null;
  faviconUrl?: string | null;
  brandColor?: string | null;
  /** Optional secondary/accent color — CSS var `--status-accent` in PublicStatus. */
  accentColor?: string | null;
  /** Optional font family for the public status page root. */
  font?: StatusPageFont | null;
};

/**
 * Per-page display toggles for the standard (non-custom) public status page.
 * Every flag defaults to ON — treat `undefined`/`null` as enabled in the
 * renderer so existing pages keep all metrics visible without migration.
 */
export type StatusPageDisplay = {
  /** Overall "All systems operational" summary banner. */
  showOverallStatus?: boolean;
  /** Aggregate uptime % + "days since last incident" in the banner. */
  showUptimeStats?: boolean;
  /** Per-check 90-day uptime history bars. */
  showHistory?: boolean;
  /** Per-check response time + last-checked metadata. */
  showResponseTime?: boolean;
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
  folderPaths?: string[];  // Folder paths for dynamic check inclusion
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
  /** Folder paths selected for dynamic inclusion — new checks in these folders are auto-included */
  folderPaths?: string[];
  layout?: StatusPageLayout;
  groupByFolder?: boolean;
  branding?: StatusPageBranding | null;
  customLayout?: CustomLayoutConfig | null;
  /** Display toggles for the standard layout — all default ON. */
  display?: StatusPageDisplay | null;
  showPoweredBy?: boolean;
  enabled?: boolean;
  disabledReason?: string | null;
  /**
   * Public projection of this page's incidents (open ones plus 90 days of
   * resolved ones). Written only by the manageStatusPageIncident callable.
   */
  incidents?: StatusPageIncident[];
  incidentsUpdatedAt?: number;
  /**
   * Custom hostname mirror (Pro). Written only by the custom domain callables
   * and the reconciler (functions/src/custom-domains.ts); firestore.rules
   * forbids client writes.
   */
  customDomain?: StatusPageCustomDomain | null;
  createdAt: number;
  updatedAt: number;
}

export type CustomDomainStatus = 'pending' | 'verifying' | 'active' | 'failed' | 'disabled';

/** Public mirror of custom_domains/{hostname} on status_pages/{id}.customDomain. */
export interface StatusPageCustomDomain {
  hostname: string;
  status: CustomDomainStatus;
  /** TXT ownership record, e.g. _exit1-verify.status.acme.com = exit1-verify=<token> */
  verifyRecord: { name: string; value: string };
  /** CNAME target, domains.exit1.dev */
  cnameTarget: string;
  lastError: string | null;
  /** Present on disabled domains: why it was switched off. */
  disabledReason?: 'plan_downgrade' | 'owner' | null;
  statusChangedAt: number;
  lastCheckedAt: number;
}

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface IncidentUpdate {
  id: string;
  status: IncidentStatus;
  message: string;
  createdAt: number;
}

export interface LinkedDowntime {
  checkId: string;
  startedAt: number;
  endedAt: number | null;
}

/** Incident as the public page sees it. Updates are newest first. */
export interface StatusPageIncident {
  id: string;
  title: string;
  status: IncidentStatus;
  affectedCheckIds: string[];
  linkedDowntime: LinkedDowntime | null;
  startedAt: number;
  resolvedAt: number | null;
  updates: IncidentUpdate[];
}

/** Full incident doc (status_page_incidents), read by the account in the app. Updates are oldest first. */
export interface StatusPageIncidentDoc extends Omit<StatusPageIncident, 'id'> {
  userId: string;
  statusPageId: string;
  createdAt: number;
  updatedAt: number;
}

// Webhook types — canonical definitions live in api/types.ts.
// `WebhookPayload` deliberately absent: the outbound alert body is a backend wire
// contract (functions/src/types.ts) that the browser never receives. The unused
// frontend copy had silently drifted out of sync with it.
export type { WebhookSettings, WebhookEvent, WebhookCheckFilter } from './api/types';

// Email notification settings
export interface EmailSettings {
  userId: string;
  enabled: boolean;
  recipient?: string; // @deprecated - use recipients array instead
  recipients?: string[]; // destination email addresses
  events: WebhookEvent[];
  /** @deprecated No longer used — flap suppression is handled per-check by the Down-confirmation gate. */
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
  status: 'online' | 'offline' | 'degraded' | 'unknown' | 'disabled';
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
  redirectLocation?: string;
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

// ---------------------------------------------------------------------------
// SLA reporting (Pro). Mirrors functions/src/sla-types.ts and sla-math.ts.
// See docs/plans/sla-reporting.md, section 3.1.
// ---------------------------------------------------------------------------

export type SlaStatus = 'met' | 'breached' | 'at_risk' | 'on_track' | 'no_data';
export type SlaExclusionState = 'maintenance' | 'blocked' | 'no_data';

export interface SlaBranding {
  companyName?: string | null;
  logoUrl?: string | null;
  brandColor?: string | null;
}

export interface SlaReport {
  id: string;
  /** Account owner uid. */
  userId: string;
  name: string;
  targetPercent: number;
  checkIds: string[];
  folderPaths: string[];
  /** IANA zone the report's months are counted in. */
  timezone: string;
  countBlockedAsDown: boolean;
  schedule: { enabled: boolean; recipients: string[] };
  branding?: SlaBranding | null;
  unsubscribed?: string[];
  nextSendAfter?: number | null;
  lastSentPeriod?: string | null;
  lastSentAt?: number | null;
  lastSendError?: string | null;
  lastFinalPeriod?: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
}

export interface SlaTotals {
  upMs: number;
  downMs: number;
  maintenanceMs: number;
  blockedMs: number;
  noDataMs: number;
}

export interface SlaOverall extends SlaTotals {
  availability: number | null;
  coverage: number;
  budgetMs: number;
  budgetUsed: number;
  /** Allowed down time for the whole month (projected while the month is open). */
  projectedBudgetMs: number;
  status: SlaStatus;
  insufficientData: boolean;
}

export interface SlaCheckResult extends SlaTotals {
  checkId: string;
  name: string;
  url: string;
  deleted?: boolean;
  availability: number | null;
  coverage: number;
  incidents: number;
  longestIncidentMs: number;
  status: SlaStatus;
  insufficientData: boolean;
}

export interface SlaIncident {
  checkId: string;
  startMs: number;
  /** null while still ongoing at dataThrough. */
  endMs: number | null;
  durationMs: number;
}

export interface SlaExclusion {
  checkId: string;
  state: SlaExclusionState;
  startMs: number;
  endMs: number;
}

export interface SlaDailyEntry {
  /** Local day, 'YYYY-MM-DD'. */
  day: string;
  upMs: number;
  downMs: number;
  excludedMs: number;
}

export interface SlaPeriod {
  /** 'YYYY-MM' in `timezone`. */
  period: string;
  timezone: string;
  status: 'open' | 'final';
  periodStart: number;
  periodEnd: number;
  dataThrough: number;
  rollupVersion: number;
  targetPercent: number;
  countBlockedAsDown: boolean;
  overall: SlaOverall;
  daily: SlaDailyEntry[];
  checks: SlaCheckResult[];
  incidents: SlaIncident[];
  incidentsTotal: number;
  exclusions: SlaExclusion[];
  exclusionsTotal?: number;
  userId: string;
  reportId: string;
  computedAt: number;
  sentRecord?: {
    sentAt: number;
    timezone: string;
    availability: number | null;
    status: SlaStatus;
    recipients?: number;
  } | null;
  previousTimezone?: string | null;
}

/** Payload for the upsertSlaReport callable. */
export interface SlaReportInput {
  name: string;
  targetPercent: number;
  checkIds: string[];
  folderPaths: string[];
  timezone: string;
  countBlockedAsDown: boolean;
  schedule: { enabled: boolean; recipients: string[] };
  branding: SlaBranding | null;
}
