// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

// Configuration for cost optimization
export const CONFIG = {
  // Batching and concurrency - OPTIMIZED FOR PERFORMANCE
  BATCH_SIZE: 200, // Increased from 50 - larger batches are more efficient
  MAX_WEBSITES_PER_RUN: 5000, // Increased from 1000 - handle more sites per run
  
  // Timeouts and delays - AGGRESSIVE OPTIMIZATION
  HTTP_TIMEOUT_MS: 10000, // Increased from 5000 - more reliable timeout
  FAST_HTTP_TIMEOUT_MS: 5000, // Increased from 2000 - more reliable timeout for known-good sites
  BATCH_DELAY_MS: 50, // Reduced from 500 - minimal delay between batches
  CONCURRENT_BATCH_DELAY_MS: 0, // Reduced from 100 - remove delay for max speed
  
  // User agent for HTTP requests
  USER_AGENT: 'Exit1-Website-Monitor/1.0',
  
  // Check interval - 1 minute (fastest supported by Firebase Cloud Scheduler)
  CHECK_INTERVAL_MINUTES: 1,
  
  // NEW CONFIG for cost optimization - For when I want to implement a tier system
  FREE_TIER_CHECK_INTERVAL: 3, // Increased from 1 to 3 minutes to reduce database usage
  PREMIUM_TIER_CHECK_INTERVAL: 2, // minutes
  MAX_CONSECUTIVE_FAILURES: 10, // skip after this many failures
  
  // SPAM PROTECTION CONFIGURATION
  MAX_CHECKS_PER_USER: 100, // Reasonable upper limit for most users
  RATE_LIMIT_CHECKS_PER_MINUTE: 10, // Max checks added per minute per user
  RATE_LIMIT_CHECKS_PER_HOUR: 100, // Max checks added per hour per user
  RATE_LIMIT_CHECKS_PER_DAY: 500, // Max checks added per day per user
  
  // URL VALIDATION
  MIN_URL_LENGTH: 10, // Minimum URL length to prevent spam
  MAX_URL_LENGTH: 2048, // Maximum URL length (standard limit)
  ALLOWED_PROTOCOLS: ['http://', 'https://'], // Only allow HTTP/HTTPS
  BLOCKED_DOMAINS: [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'example.com',
    'invalid.com'
  ],
  
  // SUSPICIOUS PATTERN DETECTION
  MAX_SIMILAR_URLS_PER_USER: 50, // Max URLs with same domain per user
  MAX_SIMILAR_NAMES_PER_USER: 100, // Max checks with similar names per user
  
  // Failure tracking (cooldown system replaced with disable/enable)
  // INITIAL_FAILURE_COOLDOWN_MINUTES: 30, // DEPRECATED: Now using disable/enable system
  // MAX_FAILURE_COOLDOWN_HOURS: 6, // DEPRECATED: Now using disable/enable system  
  // COOLDOWN_MULTIPLIER: 1.5, // DEPRECATED: Now using disable/enable system
  
  // Dead site disable system
  DISABLE_AFTER_DAYS: 7, // Disable after 7 days of consistent failures
  DISABLE_AFTER_FAILURES: 100, // Alternative: disable after 100 consecutive failures
  AUTO_DISABLE_ENABLED: true, // Whether to automatically disable dead sites
  
  get CHECK_INTERVAL_MS() {
    return this.CHECK_INTERVAL_MINUTES * 60 * 1000;
  },
  
  get MAX_CONCURRENT_CHECKS() {
    return 100; // Increased from 10 - MASSIVE concurrency boost
  },
  
  // NEW: Performance optimization methods
  get OPTIMIZED_BATCH_SIZE() {
    return 500; // Even larger batches for high-volume processing
  },
  
  get HYPER_CONCURRENT_CHECKS() {
    return 200; // Ultra-high concurrency for premium processing
  },
  
  // NEW: Adaptive timeout calculation based on website performance
  getAdaptiveTimeout(website: { responseTime?: number; consecutiveFailures: number }): number {
    // Fast sites get shorter timeouts, slow/failing sites get longer
    if (website.consecutiveFailures > 3) {
      return this.HTTP_TIMEOUT_MS; // Full timeout for problematic sites
    }
    
    if (website.responseTime && website.responseTime < 1000) {
      return this.FAST_HTTP_TIMEOUT_MS; // 2 seconds for fast sites
    }
    
    return this.HTTP_TIMEOUT_MS; // Default timeout
  },
  
  // NEW: Dynamic concurrency based on current load
  getDynamicConcurrency(websiteCount: number): number {
    if (websiteCount > 1000) {
      return this.HYPER_CONCURRENT_CHECKS; // 200 for high volume
    } else if (websiteCount > 100) {
      return this.MAX_CONCURRENT_CHECKS; // 100 for medium volume
    } else {
      return 50; // 50 for small volume
    }
  },
  
  // SPAM PROTECTION HELPER FUNCTIONS
  
  // Validate URL for spam protection
  validateUrl(url: string): { valid: boolean; reason?: string } {
    // Check URL length
    if (url.length < this.MIN_URL_LENGTH) {
      return { valid: false, reason: `URL too short (minimum ${this.MIN_URL_LENGTH} characters)` };
    }
    
    if (url.length > this.MAX_URL_LENGTH) {
      return { valid: false, reason: `URL too long (maximum ${this.MAX_URL_LENGTH} characters)` };
    }
    
    // Check protocol
    const hasValidProtocol = this.ALLOWED_PROTOCOLS.some(protocol => 
      url.toLowerCase().startsWith(protocol)
    );
    if (!hasValidProtocol) {
      return { valid: false, reason: 'Only HTTP and HTTPS protocols are allowed' };
    }
    
    // Check for blocked domains
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      
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
      return this.OPTIMIZED_BATCH_SIZE; // 500 for massive scale
    } else if (websiteCount > 500) {
      return this.BATCH_SIZE; // 200 for medium scale
    } else {
      return 100; // 100 for smaller scale
    }
  },
  
  // Helper methods for cost optimization
  getCheckIntervalForTier(tier: 'free' | 'premium'): number {
    return tier === 'premium' ? this.PREMIUM_TIER_CHECK_INTERVAL : this.FREE_TIER_CHECK_INTERVAL;
  },
  
  getCheckIntervalMsForTier(tier: 'free' | 'premium'): number {
    return this.getCheckIntervalForTier(tier) * 60 * 1000;
  },
  
  // DEPRECATED: Cooldown system replaced with disable/enable system
  // getFailureCooldownMs method removed - websites are now auto-disabled instead of put in cooldown
  
  // Check if a website should be disabled due to extended downtime
  shouldDisableWebsite(website: { consecutiveFailures: number; lastFailureTime?: number; disabled?: boolean }): boolean {
    if (!this.AUTO_DISABLE_ENABLED || website.disabled) {
      return false;
    }
    
    const now = Date.now();
    const daysSinceFirstFailure = website.lastFailureTime ? 
      (now - website.lastFailureTime) / (24 * 60 * 60 * 1000) : 0;
    
    // Disable if too many consecutive failures OR too many days of downtime
    return website.consecutiveFailures >= this.DISABLE_AFTER_FAILURES || 
           daysSinceFirstFailure >= this.DISABLE_AFTER_DAYS;
  }
};

// Discord Bot Configuration
export const DISCORD_CONFIG = {
  // These should be set as environment variables in Firebase Functions config
  // Use: firebase functions:config:set discord.bot_token="your_bot_token" discord.guild_id="your_server_id"
  BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '', // Discord bot token
  GUILD_ID: process.env.DISCORD_GUILD_ID || '', // Discord server ID
  WELCOME_CHANNEL_ID: process.env.DISCORD_WELCOME_CHANNEL_ID || '', // Optional: channel to send welcome message
  
  // Default invite settings
  INVITE_MAX_AGE: 0, // 0 means never expire
  INVITE_MAX_USES: 1, // Single use invite
  INVITE_UNIQUE: true, // Create unique invite for each user
  
  // Role to assign to new Discord OAuth users (optional)
  AUTO_ROLE_ID: process.env.DISCORD_AUTO_ROLE_ID || '', // Role ID to auto-assign
  
  // Welcome message template
  WELCOME_MESSAGE: (username: string) => `Welcome to the exit1.dev community, ${username}! 🎉\n\nYou've successfully connected your Discord account. Thanks for joining us!`,
}; 