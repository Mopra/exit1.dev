// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

// Canonical user tier union. Kept here so config/helpers are self-contained;
// `init.ts` re-uses the same string literal union under the `UserTier` alias.
export type Tier = 'free' | 'nano' | 'pro' | 'agency';

// Single source of truth for per-tier feature limits + flags.
// Shape is locked in by Docs/plans/tier-restructure-plan-1-rollout.md §3.
export const TIER_LIMITS = {
  free: {
    maxChecks: 10,
    minCheckIntervalMinutes: 5,
    maxWebhooks: 1,
    maxApiKeys: 0,
    emailHourly: 10,
    emailMonthly: 10,
    smsHourly: 0,
    smsMonthly: 0,
    retentionDays: 60,
    maxStatusPages: 1,
    statusPageBuilder: false,
    domainIntel: false,
    maintenanceMode: false,
    smsAlerts: false,
    apiAccess: false,
    csvExport: false,
    teamSeats: 0,
    slaReporting: false,
    customStatusDomain: false,
    allAlertChannels: false,
    regionChoice: false,
  },
  nano: {
    maxChecks: 50,
    minCheckIntervalMinutes: 2,
    maxWebhooks: 5,
    maxApiKeys: 0,
    emailHourly: 50,
    emailMonthly: 1000,
    smsHourly: 0,
    smsMonthly: 0,
    retentionDays: 60,
    maxStatusPages: 5,
    statusPageBuilder: true,
    domainIntel: true,
    maintenanceMode: true,
    smsAlerts: false,
    apiAccess: false,
    csvExport: false,
    teamSeats: 0,
    slaReporting: false,
    customStatusDomain: false,
    allAlertChannels: false,
    regionChoice: false,
  },
  pro: {
    maxChecks: 500,
    minCheckIntervalMinutes: 0.5, // 30 sec
    maxWebhooks: 25,
    maxApiKeys: 10,
    emailHourly: 500,
    emailMonthly: 10000,
    smsHourly: 25,
    smsMonthly: 50,
    retentionDays: 365,
    maxStatusPages: 25,
    statusPageBuilder: true,
    domainIntel: true,
    maintenanceMode: true,
    smsAlerts: true,
    apiAccess: true, // MCP access follows apiAccess — no separate flag
    csvExport: true,
    teamSeats: 0,
    slaReporting: false,
    customStatusDomain: false,
    allAlertChannels: true,
    regionChoice: true,
  },
  agency: {
    maxChecks: 1000,
    minCheckIntervalMinutes: 0.25, // 15 sec
    maxWebhooks: 50,
    maxApiKeys: 25,
    emailHourly: 1000,
    emailMonthly: 50000,
    smsHourly: 50,
    smsMonthly: 100,
    retentionDays: 1095, // 3 years
    maxStatusPages: 50,
    statusPageBuilder: true,
    domainIntel: true,
    maintenanceMode: true,
    smsAlerts: true,
    apiAccess: true, // MCP access follows apiAccess — no separate flag
    csvExport: true,
    teamSeats: 10, // revisit — see Plan 2
    slaReporting: true,
    customStatusDomain: true,
    allAlertChannels: true,
    regionChoice: true,
  },
} as const satisfies Record<Tier, {
  maxChecks: number;
  minCheckIntervalMinutes: number;
  maxWebhooks: number;
  maxApiKeys: number;
  emailHourly: number;
  emailMonthly: number;
  smsHourly: number;
  smsMonthly: number;
  retentionDays: number;
  maxStatusPages: number;
  statusPageBuilder: boolean;
  domainIntel: boolean;
  maintenanceMode: boolean;
  smsAlerts: boolean;
  apiAccess: boolean;
  csvExport: boolean;
  teamSeats: number;
  slaReporting: boolean;
  customStatusDomain: boolean;
  allAlertChannels: boolean;
  regionChoice: boolean;
}>;

// Hard floor for check intervals — matches the fastest tier (Agency, 15s).
// Centralised so `getNextCheckAtMs` doesn't need to reach into TIER_LIMITS.
const MIN_INTERVAL_FLOOR_MINUTES = 0.25;

// Configuration for cost optimization
export const CONFIG = {
  // Scheduler function resource configuration
  // With ~2,000 checks at 2-minute intervals, actual usage is ~95MiB peak
  // Valid options: "128MiB" | "256MiB" | "512MiB" | "1GiB" | "2GiB" | "4GiB" | "8GiB" | "16GiB" | "32GiB"
  SCHEDULER_MEMORY: "256MiB" as const, // ~2.5x headroom above observed 95MiB peak
  SCHEDULER_TIMEOUT_SECONDS: 540, // 9 minutes max (Cloud Functions gen2 limit)
  SCHEDULER_MAX_INSTANCES: 1, // Prevent concurrent runs per region (lock handles this too)
  SCHEDULER_MIN_INSTANCES: 0, // Scale to zero when idle
  
  // Batching and concurrency - COST OPTIMIZATION
  BATCH_SIZE: 150, // Reduced for lower per-run CPU/memory pressure
  MAX_WEBSITES_PER_RUN: 2000, // Lower cap to limit per-run work
  
  // Timeouts and delays - COST OPTIMIZATION
  HTTP_TIMEOUT_MS: 30000, // Total time budget per check (DNS + connect + TLS + TTFB)
  RESPONSE_TIME_LIMIT_MAX_MS: 30000, // Max allowed per-check response time limit
  BATCH_DELAY_MS: 200, // Add delay between batches to reduce sustained CPU
  CONCURRENT_BATCH_DELAY_MS: 100, // Stagger concurrent batches to smooth load
  
  // User agent for HTTP requests
  USER_AGENT: 'Exit1-Website-Monitor/1.0',
  
  // Check interval - 2 minutes minimum (scheduler cadence)
  CHECK_INTERVAL_MINUTES: 2,
  
  // Default check frequency for new checks (1 hour)
  DEFAULT_CHECK_FREQUENCY_MINUTES: 60,

  // History sampling for response-time trends (keeps data while reducing BigQuery writes)
  HISTORY_SAMPLE_INTERVAL_MS: 60 * 60 * 1000, // 1 hour
  
  // Per-tier limits live in TIER_LIMITS (see top of file). Look up via the
  // *ForTier helpers below (e.g. getMinCheckIntervalMinutesForTier, getMaxChecksForTier).

  // DNS Record Monitoring intervals
  // Pro/Agency get 1-minute DNS intervals; Nano gets 5-minute; Free cannot create DNS checks.
  // These are DNS-specific and intentionally tighter than the tier's general check interval.
  MIN_DNS_CHECK_INTERVAL_MINUTES_PAID_FAST: 1,
  MIN_DNS_CHECK_INTERVAL_MINUTES_NANO: 5,
  DNS_QUERY_TIMEOUT_MS: 10_000,       // 10s timeout per record type query
  DNS_MAX_CHANGES_HISTORY: 50,         // FIFO cap on changes array
  DNS_AUTO_ACCEPT_THRESHOLD: 3,        // Consecutive stable checks before auto-accept

  TRANSIENT_ERROR_THRESHOLD: 4, // consecutive transient failures required before marking offline

  // SPAM PROTECTION CONFIGURATION
  MAX_CHECKS_PER_USER: 1000, // Hard ceiling (legacy fallback — use getMaxChecksForTier)
  RATE_LIMIT_CHECKS_PER_MINUTE: 10, // Max checks added per minute per user
  RATE_LIMIT_CHECKS_PER_HOUR: 100, // Max checks added per hour per user
  RATE_LIMIT_CHECKS_PER_DAY: 500, // Max checks added per day per user
  
  // Email alert throttling (per check, per event type)
  EMAIL_THROTTLE_WINDOW_MS: 60 * 60 * 1000, // 1 hour window (default/fallback)
  EMAIL_THROTTLE_COLLECTION: 'emailRateLimits',
  
  // Event-specific throttle windows to prevent spam while ensuring important alerts get through
  EMAIL_THROTTLE_WINDOWS: {
    website_down: 60 * 1000,              // 1 minute - allow state change emails
    website_up: 60 * 1000,                // 1 minute - allow state change emails
    website_error: 1 * 60 * 60 * 1000,    // 1 hour - errors can be transient
    ssl_error: 24 * 60 * 60 * 1000,       // 24 hours - SSL errors are urgent but don't spam
    ssl_warning: 7 * 24 * 60 * 60 * 1000, // 7 days - SSL warnings don't need frequent reminders
    ssl_expiring: 7 * 24 * 60 * 60 * 1000, // 7 days - SSL warnings don't need frequent reminders
    ssl_expired: 24 * 60 * 60 * 1000,     // 24 hours - SSL expired is urgent but don't spam
    // Domain Intelligence events
    domain_expiring: 24 * 60 * 60 * 1000, // 24 hours - domain expiring warnings per threshold
    domain_expired: 24 * 60 * 60 * 1000,  // 24 hours - domain expired is urgent
    domain_renewed: 24 * 60 * 60 * 1000,  // 24 hours - renewal confirmation
    // DNS Record Monitoring events
    dns_record_changed: 60 * 1000,        // 1 minute - immediate notification on change
    dns_record_missing: 1 * 60 * 60 * 1000, // 1 hour - missing records can be transient
    dns_resolution_failed: 1 * 60 * 60 * 1000, // 1 hour - resolution failures can be transient
  },

  // Per-user email budget to prevent runaway sends. Per-tier quotas live in TIER_LIMITS.
  EMAIL_USER_BUDGET_COLLECTION: 'emailBudgets',
  EMAIL_USER_BUDGET_WINDOW_MS: 60 * 60 * 1000, // 1 hour rolling window
  EMAIL_USER_BUDGET_MAX_PER_WINDOW: 10, // fallback when tier is unknown
  EMAIL_USER_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000, // Keep docs slightly past window for TTL cleanup

  // Per-user email monthly budget (all checks combined). Per-tier quotas live in TIER_LIMITS.
  EMAIL_USER_MONTHLY_BUDGET_COLLECTION: 'emailMonthlyBudgets',
  EMAIL_USER_MONTHLY_BUDGET_WINDOW_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  EMAIL_USER_MONTHLY_BUDGET_MAX_PER_WINDOW: 10, // fallback when tier is unknown
  EMAIL_USER_MONTHLY_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000,

  // System-level health gate — detects infrastructure-wide failures
  // Tracks unique checks that flip UP→DOWN in a rolling window. If the count
  // exceeds THRESHOLD, ALL alerting is suppressed for COOLDOWN to prevent
  // mass false-alert spam during VPS outages or network issues.
  // Monitors keep running and recording data; only notifications are paused.
  SYSTEM_HEALTH_GATE_WINDOW_MS: 3 * 60 * 1000,         // 3-minute rolling window
  SYSTEM_HEALTH_GATE_THRESHOLD: 50,                      // Unique checks flipping DOWN before trip
  SYSTEM_HEALTH_GATE_COOLDOWN_MS: 10 * 60 * 1000,       // 10-minute suppression after trip
  SYSTEM_HEALTH_GATE_STARTUP_GRACE_MS: 5 * 60 * 1000,   // 5-minute grace period after process start
  SYSTEM_HEALTH_GATE_POST_GRACE_MS: 3 * 60 * 1000,      // 3-minute post-grace confirmation window — status changes are recorded but alerts deferred until next check confirms
  SYSTEM_HEALTH_GATE_OPERATOR_EMAIL: 'mortenprads@gmail.com', // Operator notification recipient

  // Webhook alert throttling (in-memory, per check, per event type)
  // Prevents alert storms from flapping checks — webhooks previously had no throttle at all.
  WEBHOOK_THROTTLE_WINDOWS: {
    website_down: 5 * 60 * 1000,            // 5 minutes - prevent flap storms
    website_up: 5 * 60 * 1000,              // 5 minutes - prevent flap storms
    website_error: 5 * 60 * 1000,           // 5 minutes
    ssl_error: 60 * 60 * 1000,              // 1 hour
    ssl_warning: 24 * 60 * 60 * 1000,       // 24 hours
    ssl_expiring: 24 * 60 * 60 * 1000,      // 24 hours
    ssl_expired: 24 * 60 * 60 * 1000,       // 24 hours
    domain_expiring: 24 * 60 * 60 * 1000,   // 24 hours
    domain_expired: 24 * 60 * 60 * 1000,    // 24 hours
    domain_renewed: 24 * 60 * 60 * 1000,    // 24 hours
    dns_record_changed: 5 * 60 * 1000,      // 5 minutes
    dns_record_missing: 60 * 60 * 1000,     // 1 hour
    dns_resolution_failed: 60 * 60 * 1000,  // 1 hour
  } as Record<string, number>,
  WEBHOOK_THROTTLE_DEFAULT_MS: 5 * 60 * 1000, // 5 minutes fallback

  // SMS alert throttling (per check, per event type)
  SMS_THROTTLE_WINDOW_MS: 60 * 60 * 1000, // 1 hour window (default/fallback)
  SMS_THROTTLE_COLLECTION: 'smsRateLimits',
  SMS_THROTTLE_WINDOWS: {
    website_down: 60 * 1000,              // 1 minute - allow state change texts
    website_up: 60 * 1000,                // 1 minute - allow state change texts
    website_error: 1 * 60 * 60 * 1000,    // 1 hour - errors can be transient
    ssl_error: 24 * 60 * 60 * 1000,       // 24 hours - SSL errors are urgent but don't spam
    ssl_warning: 7 * 24 * 60 * 60 * 1000, // 7 days - SSL warnings don't need frequent reminders
    ssl_expiring: 7 * 24 * 60 * 60 * 1000,
    ssl_expired: 24 * 60 * 60 * 1000,
    // Domain Intelligence events
    domain_expiring: 24 * 60 * 60 * 1000, // 24 hours - domain expiring warnings per threshold
    domain_expired: 24 * 60 * 60 * 1000,  // 24 hours - domain expired is urgent
    domain_renewed: 24 * 60 * 60 * 1000,  // 24 hours - renewal confirmation
    // DNS Record Monitoring events
    dns_record_changed: 60 * 1000,        // 1 minute - immediate notification on change
    dns_record_missing: 1 * 60 * 60 * 1000, // 1 hour - missing records can be transient
    dns_resolution_failed: 1 * 60 * 60 * 1000, // 1 hour - resolution failures can be transient
  },

  // Per-user SMS budget to prevent runaway sends. Per-tier quotas live in TIER_LIMITS.
  SMS_USER_BUDGET_COLLECTION: 'smsBudgets',
  SMS_USER_BUDGET_WINDOW_MS: 60 * 60 * 1000, // 1 hour rolling window
  SMS_USER_BUDGET_MAX_PER_WINDOW: 30, // fallback when tier is unknown
  SMS_USER_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000,

  // Per-user SMS monthly budget (all checks combined). Per-tier quotas live in TIER_LIMITS.
  SMS_USER_MONTHLY_BUDGET_COLLECTION: 'smsMonthlyBudgets',
  SMS_USER_MONTHLY_BUDGET_WINDOW_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  SMS_USER_MONTHLY_BUDGET_MAX_PER_WINDOW: 20, // fallback when tier is unknown
  SMS_USER_MONTHLY_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000,
  WEBHOOK_RETRY_COLLECTION: 'webhookRetryQueue',
  WEBHOOK_RETRY_MAX_ATTEMPTS: 8,
  WEBHOOK_RETRY_BATCH_SIZE: 25,
  WEBHOOK_RETRY_TTL_MS: 48 * 60 * 60 * 1000,
  WEBHOOK_RETRY_DRAIN_INTERVAL_MS: 30 * 1000,
  WEBHOOK_CIRCUIT_BREAKER_THRESHOLD: 3, // Mark webhook as permanent_failure after this many deliveries exhaust all retries
  
  // URL VALIDATION
  MIN_URL_LENGTH: 10, // Minimum URL length to prevent spam
  MAX_URL_LENGTH: 2048, // Maximum URL length (standard limit)
  ALLOWED_PROTOCOLS_HTTP: ['http://', 'https://'], // HTTP/HTTPS checks
  ALLOWED_PROTOCOLS_TCP: ['tcp://'],
  ALLOWED_PROTOCOLS_UDP: ['udp://'],
  ALLOWED_PROTOCOLS_PING: ['ping://'],
  ALLOWED_PROTOCOLS_WEBSOCKET: ['ws://', 'wss://'],
  BLOCKED_DOMAINS: [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'example.com',
    'invalid.com'
  ],

  // Feature flags / guardrails
  ENABLE_SECURITY_LOOKUPS: process.env.ENABLE_SECURITY_LOOKUPS !== 'false',

  // VPS manual check proxy — route manual checks through the VPS static IP
  VPS_MANUAL_CHECK_URL: process.env.VPS_MANUAL_CHECK_URL || 'http://187.77.85.132:3100',
  VPS_MANUAL_CHECK_TIMEOUT_MS: 35_000, // Must exceed max adaptive timeout (20s) + overhead
  
  // SUSPICIOUS PATTERN DETECTION
  MAX_SIMILAR_URLS_PER_USER: 50, // Max URLs with same domain per user
  MAX_SIMILAR_NAMES_PER_USER: 100, // Max checks with similar names per user
  
  // Failure tracking (cooldown system replaced with disable/enable)
  // INITIAL_FAILURE_COOLDOWN_MINUTES: 30, // DEPRECATED: Now using disable/enable system
  // MAX_FAILURE_COOLDOWN_HOURS: 6, // DEPRECATED: Now using disable/enable system  
  // COOLDOWN_MULTIPLIER: 1.5, // DEPRECATED: Now using disable/enable system
  
  // Dead site disable system
  DISABLE_AFTER_DAYS: 30, // Disable after 7 days of consistent failures
  AUTO_DISABLE_ENABLED: true, // Whether to automatically disable dead sites
  
  // Jitter to prevent phase locking with periodic failures (e.g., 2 up/2 down test endpoints)
  NEXT_CHECK_JITTER_RATIO: 0.2, // +/-20% jitter

  // Best-effort target metadata refresh cadence (DNS + GeoIP)
  // Geo data rarely changes; refresh monthly once a check has been enriched.
  // Checks whose last enrichment failed leave targetMetadataLastChecked unset,
  // so they retry on each scheduled run (daily).
  TARGET_METADATA_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days

  // SSL refresh cadence
  // After the first initial check, this is checked once a month instead of every 7 days
  SECURITY_METADATA_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days (1 month)
  
  // Immediate re-check configuration: when a non-UP status is detected, schedule a quick re-check
  // to verify if it was a transient glitch before alerting
  IMMEDIATE_RECHECK_DELAY_MS: 30 * 1000, // 30 seconds - quick verification for transient issues
  IMMEDIATE_RECHECK_WINDOW_MS: 5 * 60 * 1000, // 5 minutes - avoid repeated rechecks
  // Down confirmation: require multiple consecutive failures in a short window
  DOWN_CONFIRMATION_ATTEMPTS: 3, // 1 initial + 2 confirmation checks
  DOWN_CONFIRMATION_WINDOW_MS: 5 * 60 * 1000, // 5 minutes to confirm down

  // Post-deploy DNS grace: after deploy_mode lifts, the dispatcher resumes
  // and saturates the local DNS resolver (250 concurrent checks all hitting
  // DNS at once → c-ares queue overflow → 30s timeouts on healthy targets).
  // Within this window, "DNS timeout" / "DNS query failed" errors do not
  // count toward consecutiveFailures — the probe is treated as if it never
  // happened. Real DNS issues with the user's domain still alert after the
  // window expires.
  DNS_GRACE_AFTER_DEPLOY_MS: 5 * 60 * 1000, // 5 minutes

  // TCP light-check configuration (Step 9: Alternating TCP Light Checks)
  // Free-tier only: every Nth consecutive success does a full HTTP check; others are TCP-only.
  // TCP light-check is disabled for all vps- regions.
  // Set to 1 to disable (every check is full). Set to 2 for every-other, 3 for every-third.
  FULL_CHECK_EVERY_N: 2,
  TCP_LIGHT_CHECK_TIMEOUT_MS: 5_000,

  get CHECK_INTERVAL_MS() {
    return this.CHECK_INTERVAL_MINUTES * 60 * 1000;
  },
  
  // Compute the next check time in ms with jitter applied to avoid consistently hitting the same minute offset
  getNextCheckAtMs(baseMinutes: number, now: number = Date.now()): number {
    // Support fractional minutes (e.g. 0.25 = 15 seconds for Agency tier)
    const minutes = Math.max(MIN_INTERVAL_FLOOR_MINUTES, baseMinutes || this.CHECK_INTERVAL_MINUTES);
    const baseMs = Math.round(minutes * 60 * 1000);
    // Sub-minute checks: cap jitter at ±1s to keep timing tight
    const jitterWindow = baseMs < 60_000
      ? Math.min(1000, Math.floor(baseMs * 0.05))
      : Math.floor(baseMs * this.NEXT_CHECK_JITTER_RATIO);
    const jitter = jitterWindow > 0 ? (Math.floor(Math.random() * (2 * jitterWindow + 1)) - jitterWindow) : 0;
    const candidate = now + baseMs + jitter;
    // Ensure we don't schedule too soon; enforce a small floor to prevent hot-looping
    const minDelay = Math.min(30 * 1000, Math.floor(baseMs * 0.1));
    return Math.max(candidate, now + minDelay);
  },
  
  // Concurrency defaults (Cloud Functions). The VPS overrides these via
  // MAX_CONCURRENT_CHECKS_OVERRIDE in its .env to use the full hardware.
  get MAX_CONCURRENT_CHECKS() {
    const override = Number(process.env.MAX_CONCURRENT_CHECKS_OVERRIDE);
    return override > 0 ? override : 75;
  },

  // NEW: Performance optimization methods
  get OPTIMIZED_BATCH_SIZE() {
    const override = Number(process.env.BATCH_SIZE_OVERRIDE);
    return override > 0 ? override : 250;
  },

  get HYPER_CONCURRENT_CHECKS() {
    const override = Number(process.env.MAX_CONCURRENT_CHECKS_OVERRIDE);
    return override > 0 ? override : 75;
  },

  // Per-check timeout. Sub-minute checks (Pro 30s, Agency 15s intervals) are
  // clamped to 70% of the interval so a check finishes before the next is due.
  getCheckTimeout(website: { checkFrequency?: number }): number {
    if (typeof website.checkFrequency === 'number' && website.checkFrequency < 1) {
      const intervalMs = Math.round(website.checkFrequency * 60 * 1000);
      return Math.min(this.HTTP_TIMEOUT_MS, Math.floor(intervalMs * 0.7));
    }
    return this.HTTP_TIMEOUT_MS;
  },

  // Dynamic concurrency based on current load.
  // Cloud Functions default: 25 / 75 / 75 tiers.
  // VPS override: scales up to MAX_CONCURRENT_CHECKS (set via env).
  getDynamicConcurrency(websiteCount: number): number {
    const max = this.MAX_CONCURRENT_CHECKS;
    if (websiteCount > 1000) {
      return max;
    } else if (websiteCount > 100) {
      return Math.min(max, 75);
    } else {
      return Math.min(max, 25);
    }
  },
  
  // SPAM PROTECTION HELPER FUNCTIONS
  
  // Validate URL for spam protection
  validateUrl(url: string, type?: 'website' | 'rest_endpoint' | 'rest' | 'api' | 'tcp' | 'udp' | 'ping' | 'websocket' | 'redirect' | 'dns' | 'heartbeat'): { valid: boolean; reason?: string } {
    // Heartbeat checks don't have user-provided URLs
    if (type === 'heartbeat') {
      return { valid: true };
    }

    // DNS checks use bare domains, not URLs
    if (type === 'dns') {
      if (url.length < 3) {
        return { valid: false, reason: 'Domain too short' };
      }
      if (url.length > 253) {
        return { valid: false, reason: 'Domain too long (max 253 characters)' };
      }
      if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(url)) {
        const hostname = url.toLowerCase();
        const isBlocked = this.BLOCKED_DOMAINS.some(blocked =>
          hostname === blocked || hostname.endsWith(`.${blocked}`)
        );
        if (isBlocked) return { valid: false, reason: 'Domain is blocked' };
        return { valid: true };
      }
      return { valid: false, reason: 'Invalid domain format. Use a bare domain like "example.com" (no protocol)' };
    }

    // Ping and WebSocket checks have relaxed length requirements
    const minLength = type === 'ping' || type === 'websocket' ? 8 : this.MIN_URL_LENGTH;
    if (url.length < minLength) {
      return { valid: false, reason: `URL too short (minimum ${minLength} characters)` };
    }

    if (url.length > this.MAX_URL_LENGTH) {
      return { valid: false, reason: `URL too long (maximum ${this.MAX_URL_LENGTH} characters)` };
    }

    // Check protocol
    const normalizedType = type === 'tcp' || type === 'udp' || type === 'ping' || type === 'websocket' ? type : 'http';
    const allowedProtocols =
      normalizedType === 'tcp'
        ? this.ALLOWED_PROTOCOLS_TCP
        : normalizedType === 'udp'
          ? this.ALLOWED_PROTOCOLS_UDP
          : normalizedType === 'ping'
            ? this.ALLOWED_PROTOCOLS_PING
            : normalizedType === 'websocket'
              ? this.ALLOWED_PROTOCOLS_WEBSOCKET
              : this.ALLOWED_PROTOCOLS_HTTP;
    const hasValidProtocol = allowedProtocols.some(protocol =>
      url.toLowerCase().startsWith(protocol)
    );
    if (!hasValidProtocol) {
      const allowedLabel =
        normalizedType === 'tcp'
          ? 'Only TCP (tcp://) endpoints are allowed'
          : normalizedType === 'udp'
            ? 'Only UDP (udp://) endpoints are allowed'
            : normalizedType === 'ping'
              ? 'Only ICMP Ping (ping://) targets are allowed'
              : normalizedType === 'websocket'
                ? 'Only WebSocket (ws:// or wss://) endpoints are allowed'
                : 'Only HTTP and HTTPS protocols are allowed';
      return { valid: false, reason: allowedLabel };
    }

    // Check for blocked domains
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();

      if ((type === 'tcp' || type === 'udp') && !urlObj.port) {
        return { valid: false, reason: 'TCP/UDP checks require an explicit port' };
      }
      
      const isBlocked = this.BLOCKED_DOMAINS.some(blocked => 
        hostname === blocked || hostname.endsWith(`.${blocked}`)
      );
      
      if (isBlocked) {
        return { valid: false, reason: 'This domain is not allowed for monitoring' };
      }
      
      // Check for suspicious patterns
      if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
        return { valid: false, reason: 'Local addresses are not allowed' };
      }
      
      // Check for IP addresses (allow only public IPs)
      const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (ipRegex.test(hostname)) {
        const parts = hostname.split('.').map(Number);
        const isPrivateIP = parts[0] === 10 || 
                           (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                           (parts[0] === 192 && parts[1] === 168);
        
        if (isPrivateIP) {
          return { valid: false, reason: 'Private IP addresses are not allowed' };
        }
      }
      
    } catch {
      return { valid: false, reason: 'Invalid URL format' };
    }
    
    return { valid: true };
  },
  
  // Check for suspicious patterns in user's checks
  detectSuspiciousPatterns(checks: Array<{ url: string; name: string }>, newUrl: string, newName: string): { suspicious: boolean; reason?: string } {
    try {
      const newUrlObj = new URL(newUrl);
      const newDomain = newUrlObj.hostname.toLowerCase();
      
      // Count checks with same domain
      const sameDomainCount = checks.filter(check => {
        try {
          const checkUrlObj = new URL(check.url);
          return checkUrlObj.hostname.toLowerCase() === newDomain;
        } catch {
          return false;
        }
      }).length;
      
      if (sameDomainCount >= this.MAX_SIMILAR_URLS_PER_USER) {
        return { 
          suspicious: true, 
          reason: `Too many checks for the same domain (${sameDomainCount}/${this.MAX_SIMILAR_URLS_PER_USER})` 
        };
      }
      
      // Check for similar names (basic similarity check)
      const similarNameCount = checks.filter(check => {
        const similarity = this.calculateNameSimilarity(check.name, newName);
        return similarity > 0.8; // 80% similarity threshold
      }).length;
      
      if (similarNameCount >= this.MAX_SIMILAR_NAMES_PER_USER) {
        return { 
          suspicious: true, 
          reason: `Too many checks with similar names (${similarNameCount}/${this.MAX_SIMILAR_NAMES_PER_USER})` 
        };
      }
      
      return { suspicious: false };
    } catch {
      return { suspicious: false };
    }
  },
  
  // Calculate similarity between two strings (simple implementation)
  calculateNameSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (s1 === s2) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;
    
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return 1 - (distance / longer.length);
  },
  
  // Levenshtein distance calculation
  levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  },
  
  // Smart batch sizing based on website count.
  // VPS can override via BATCH_SIZE_OVERRIDE env var.
  getOptimalBatchSize(websiteCount: number): number {
    const maxBatch = this.OPTIMIZED_BATCH_SIZE;
    if (websiteCount > 2000) {
      return maxBatch;
    } else if (websiteCount > 500) {
      return Math.min(maxBatch, this.BATCH_SIZE);
    } else {
      return Math.min(maxBatch, 75);
    }
  },
  
  // ---------------------------------------------------------------------------
  // Tier-based helpers — all read from TIER_LIMITS (see top of file).
  // ---------------------------------------------------------------------------

  getEmailBudgetMaxPerWindowForTier(tier: Tier): number {
    return TIER_LIMITS[tier].emailHourly;
  },

  getEmailMonthlyBudgetMaxPerWindowForTier(tier: Tier): number {
    return TIER_LIMITS[tier].emailMonthly;
  },

  getSmsBudgetMaxPerWindowForTier(tier: Tier): number {
    return TIER_LIMITS[tier].smsHourly;
  },

  getSmsMonthlyBudgetMaxPerWindowForTier(tier: Tier): number {
    return TIER_LIMITS[tier].smsMonthly;
  },

  // Get max checks allowed for a given tier
  getMaxChecksForTier(tier: Tier): number {
    return TIER_LIMITS[tier].maxChecks;
  },

  // Get max webhooks allowed for a given tier
  getMaxWebhooksForTier(tier: Tier): number {
    return TIER_LIMITS[tier].maxWebhooks;
  },

  // Get max API keys allowed for a given tier
  getMaxApiKeysForTier(tier: Tier): number {
    return TIER_LIMITS[tier].maxApiKeys;
  },

  // Get data retention in days for a given tier
  getHistoryRetentionDaysForTier(tier: Tier): number {
    return TIER_LIMITS[tier].retentionDays;
  },

  // Get minimum check interval in minutes for a given tier
  getMinCheckIntervalMinutesForTier(tier: Tier): number {
    return TIER_LIMITS[tier].minCheckIntervalMinutes;
  },

  // DNS monitoring availability + minimum interval.
  // Free: 0 (not allowed). Nano: 5 min. Pro/Agency: 1 min.
  getMinDnsCheckIntervalMinutesForTier(tier: Tier): number {
    if (tier === 'free') return 0;
    if (tier === 'nano') return this.MIN_DNS_CHECK_INTERVAL_MINUTES_NANO;
    return this.MIN_DNS_CHECK_INTERVAL_MINUTES_PAID_FAST;
  },

  // Get minimum check interval in seconds for a given tier (for frontend compatibility)
  getMinCheckIntervalSecondsForTier(tier: Tier): number {
    return this.getMinCheckIntervalMinutesForTier(tier) * 60;
  },

  // Validate check frequency (in minutes) against tier limits
  validateCheckFrequencyForTier(frequencyMinutes: number, tier: Tier): { valid: boolean; reason?: string; minAllowed?: number } {
    const minMinutes = this.getMinCheckIntervalMinutesForTier(tier);
    if (frequencyMinutes < minMinutes) {
      const minLabel = minMinutes < 1 ? `${minMinutes * 60} seconds` : `${minMinutes} minutes`;
      return {
        valid: false,
        reason: `Check interval too short for your plan. Minimum allowed: ${minLabel}`,
        minAllowed: minMinutes
      };
    }
    return { valid: true };
  },
  
  // DEPRECATED: Cooldown system replaced with disable/enable system
  // getFailureCooldownMs method removed - websites are now auto-disabled instead of put in cooldown
  
  // Check if a website should be disabled due to extended downtime
  shouldDisableWebsite(website: { consecutiveFailures: number; lastFailureTime?: number | null; disabled?: boolean }): boolean {
    if (!this.AUTO_DISABLE_ENABLED || website.disabled) {
      return false;
    }
    
    const now = Date.now();
    const consecutiveFailures = Number(website.consecutiveFailures || 0);
    const hasFailureStreak = consecutiveFailures > 0;
    const daysSinceFirstFailure = hasFailureStreak && website.lastFailureTime
      ? (now - website.lastFailureTime) / (24 * 60 * 60 * 1000)
      : 0;
    
    // Disable if downtime persists long enough
    return hasFailureStreak && daysSinceFirstFailure >= this.DISABLE_AFTER_DAYS;
  }
};

 
