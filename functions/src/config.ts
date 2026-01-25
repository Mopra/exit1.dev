// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

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
  HTTP_TIMEOUT_MS: 20000, // Total time budget per check (DNS + connect + TLS + TTFB)
  RESPONSE_TIME_LIMIT_MAX_MS: 25000, // Max allowed per-check response time limit
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
  
  // Nano tier exists for feature limits (e.g., email budgets). We don't currently
  // differentiate check intervals by plan; defaults fall back to CHECK_INTERVAL_MINUTES.
  NANO_TIER_CHECK_INTERVAL: 2, // minutes (reserved for future use)
  TRANSIENT_ERROR_THRESHOLD: 4, // consecutive transient failures required before marking offline
  
  // SPAM PROTECTION CONFIGURATION
  MAX_CHECKS_PER_USER: 200, // Reasonable upper limit for most users
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
  },

  // Per-user email budget to prevent runaway sends
  EMAIL_USER_BUDGET_COLLECTION: 'emailBudgets',
  EMAIL_USER_BUDGET_WINDOW_MS: 60 * 60 * 1000, // 1 hour rolling window
  // Tier-based email budgets (per user, per window). Keep the legacy default as a safe fallback.
  EMAIL_USER_BUDGET_MAX_PER_WINDOW: 10, // fallback
  EMAIL_USER_BUDGET_MAX_PER_WINDOW_FREE: 10,
  EMAIL_USER_BUDGET_MAX_PER_WINDOW_NANO: 100,
  EMAIL_USER_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000, // Keep docs slightly past window for TTL cleanup

  // Per-user email monthly budget (all checks combined)
  EMAIL_USER_MONTHLY_BUDGET_COLLECTION: 'emailMonthlyBudgets',
  EMAIL_USER_MONTHLY_BUDGET_WINDOW_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  EMAIL_USER_MONTHLY_BUDGET_MAX_PER_WINDOW: 10, // fallback
  EMAIL_USER_MONTHLY_BUDGET_MAX_PER_WINDOW_FREE: 10,
  EMAIL_USER_MONTHLY_BUDGET_MAX_PER_WINDOW_NANO: 1000,
  EMAIL_USER_MONTHLY_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000,

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
  },

  // Per-user SMS budget to prevent runaway sends
  SMS_USER_BUDGET_COLLECTION: 'smsBudgets',
  SMS_USER_BUDGET_WINDOW_MS: 60 * 60 * 1000, // 1 hour rolling window
  SMS_USER_BUDGET_MAX_PER_WINDOW: 30, // fallback
  SMS_USER_BUDGET_MAX_PER_WINDOW_FREE: 0,
  SMS_USER_BUDGET_MAX_PER_WINDOW_NANO: 30,
  SMS_USER_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000,

  // Per-user SMS monthly budget (all checks combined)
  SMS_USER_MONTHLY_BUDGET_COLLECTION: 'smsMonthlyBudgets',
  SMS_USER_MONTHLY_BUDGET_WINDOW_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  SMS_USER_MONTHLY_BUDGET_MAX_PER_WINDOW: 20,
  SMS_USER_MONTHLY_BUDGET_TTL_BUFFER_MS: 10 * 60 * 1000,
  WEBHOOK_RETRY_COLLECTION: 'webhookRetryQueue',
  WEBHOOK_RETRY_MAX_ATTEMPTS: 8,
  WEBHOOK_RETRY_BATCH_SIZE: 25,
  WEBHOOK_RETRY_TTL_MS: 48 * 60 * 60 * 1000,
  WEBHOOK_RETRY_DRAIN_INTERVAL_MS: 30 * 1000,
  
  // URL VALIDATION
  MIN_URL_LENGTH: 10, // Minimum URL length to prevent spam
  MAX_URL_LENGTH: 2048, // Maximum URL length (standard limit)
  ALLOWED_PROTOCOLS_HTTP: ['http://', 'https://'], // HTTP/HTTPS checks
  ALLOWED_PROTOCOLS_TCP: ['tcp://'],
  ALLOWED_PROTOCOLS_UDP: ['udp://'],
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
  TARGET_METADATA_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  // Retry faster when geo is missing so region can converge quickly
  TARGET_METADATA_RETRY_MS: 60 * 60 * 1000, // 1 hour

  // SSL refresh cadence
  // After the first initial check, this is checked once a month instead of every 7 days
  SECURITY_METADATA_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days (1 month)
  
  // Immediate re-check configuration: when a non-UP status is detected, schedule a quick re-check
  // to verify if it was a transient glitch before alerting
  IMMEDIATE_RECHECK_DELAY_MS: 30 * 1000, // 30 seconds - quick verification for transient issues
  IMMEDIATE_RECHECK_WINDOW_MS: 5 * 60 * 1000, // 5 minutes - avoid repeated rechecks
  // Down confirmation: require multiple consecutive failures in a short window
  DOWN_CONFIRMATION_ATTEMPTS: 4, // 1 initial + 3 confirmation checks
  DOWN_CONFIRMATION_WINDOW_MS: 5 * 60 * 1000, // 5 minutes to confirm down
  
  get CHECK_INTERVAL_MS() {
    return this.CHECK_INTERVAL_MINUTES * 60 * 1000;
  },
  
  // Compute the next check time in ms with jitter applied to avoid consistently hitting the same minute offset
  getNextCheckAtMs(baseMinutes: number, now: number = Date.now()): number {
    const minutes = Math.max(this.CHECK_INTERVAL_MINUTES, Math.floor(baseMinutes || this.CHECK_INTERVAL_MINUTES));
    const baseMs = minutes * 60 * 1000;
    const jitterWindow = Math.floor(baseMs * this.NEXT_CHECK_JITTER_RATIO);
    const jitter = jitterWindow > 0 ? (Math.floor(Math.random() * (2 * jitterWindow + 1)) - jitterWindow) : 0;
    const candidate = now + baseMs + jitter;
    // Ensure we don't schedule too soon; enforce a small floor to prevent hot-looping
    const minDelay = Math.min(30 * 1000, Math.floor(baseMs * 0.1));
    return Math.max(candidate, now + minDelay);
  },
  
  get MAX_CONCURRENT_CHECKS() {
    return 75; // Lower concurrency to reduce burst CPU usage
  },
  
  // NEW: Performance optimization methods
  get OPTIMIZED_BATCH_SIZE() {
    return 250; // Smaller batches for cost efficiency
  },
  
  // OPTIMIZATION: Capped at 75 to reduce peak CPU spikes
  // Previously was 100, but 75 provides more predictable resource usage
  get HYPER_CONCURRENT_CHECKS() {
    return 75; // Capped same as MAX_CONCURRENT_CHECKS
  },
  
  // Fixed timeout to keep behavior predictable across sites.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAdaptiveTimeout(_website: { responseTime?: number; consecutiveFailures: number }): number {
    return this.HTTP_TIMEOUT_MS;
  },
  
  // Dynamic concurrency based on current load
  // OPTIMIZATION: All tiers now capped at 75 max for cost predictability
  getDynamicConcurrency(websiteCount: number): number {
    if (websiteCount > 1000) {
      return this.HYPER_CONCURRENT_CHECKS; // 75 for high volume (capped)
    } else if (websiteCount > 100) {
      return this.MAX_CONCURRENT_CHECKS; // 75 for medium volume
    } else {
      return 25; // 25 for small volume
    }
  },
  
  // SPAM PROTECTION HELPER FUNCTIONS
  
  // Validate URL for spam protection
  validateUrl(url: string, type?: 'website' | 'rest_endpoint' | 'rest' | 'api' | 'tcp' | 'udp'): { valid: boolean; reason?: string } {
    // Check URL length
    if (url.length < this.MIN_URL_LENGTH) {
      return { valid: false, reason: `URL too short (minimum ${this.MIN_URL_LENGTH} characters)` };
    }
    
    if (url.length > this.MAX_URL_LENGTH) {
      return { valid: false, reason: `URL too long (maximum ${this.MAX_URL_LENGTH} characters)` };
    }
    
    // Check protocol
    const normalizedType = type === 'tcp' || type === 'udp' ? type : 'http';
    const allowedProtocols =
      normalizedType === 'tcp'
        ? this.ALLOWED_PROTOCOLS_TCP
        : normalizedType === 'udp'
          ? this.ALLOWED_PROTOCOLS_UDP
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
  
  // NEW: Smart batch sizing based on website count
  getOptimalBatchSize(websiteCount: number): number {
    if (websiteCount > 2000) {
      return this.OPTIMIZED_BATCH_SIZE; // 250 for massive scale
    } else if (websiteCount > 500) {
      return this.BATCH_SIZE; // 150 for medium scale
    } else {
      return 75; // 75 for smaller scale
    }
  },
  
  // (Tier-based check interval helpers removed: we don't differentiate by tier right now.)

  getEmailBudgetMaxPerWindowForTier(tier: 'free' | 'nano'): number {
    if (tier === 'nano') return this.EMAIL_USER_BUDGET_MAX_PER_WINDOW_NANO;
    return this.EMAIL_USER_BUDGET_MAX_PER_WINDOW_FREE;
  },

  getEmailMonthlyBudgetMaxPerWindowForTier(tier: 'free' | 'nano'): number {
    if (tier === 'nano') return this.EMAIL_USER_MONTHLY_BUDGET_MAX_PER_WINDOW_NANO;
    return this.EMAIL_USER_MONTHLY_BUDGET_MAX_PER_WINDOW_FREE;
  },

  getSmsBudgetMaxPerWindowForTier(tier: 'free' | 'nano'): number {
    if (tier === 'nano') return this.SMS_USER_BUDGET_MAX_PER_WINDOW_NANO;
    return this.SMS_USER_BUDGET_MAX_PER_WINDOW_FREE;
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

 
