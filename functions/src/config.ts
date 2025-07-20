// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

// Configuration for cost optimization
export const CONFIG = {
  // Batching and concurrency - OPTIMIZED FOR PERFORMANCE
  BATCH_SIZE: 200, // Increased from 50 - larger batches are more efficient
  MAX_WEBSITES_PER_RUN: 5000, // Increased from 1000 - handle more sites per run
  
  // Timeouts and delays - AGGRESSIVE OPTIMIZATION
  HTTP_TIMEOUT_MS: 5000, // Reduced from 10000 - faster timeout for better throughput
  FAST_HTTP_TIMEOUT_MS: 2000, // New: even faster timeout for known-good sites
  BATCH_DELAY_MS: 50, // Reduced from 500 - minimal delay between batches
  CONCURRENT_BATCH_DELAY_MS: 0, // Reduced from 100 - remove delay for max speed
  
  // User agent for HTTP requests
  USER_AGENT: 'Exit1-Website-Monitor/1.0',
  
  // Check interval - 1 minute (fastest supported by Firebase Cloud Scheduler)
  CHECK_INTERVAL_MINUTES: 1,
  
  // NEW CONFIG for cost optimization - For when I want to implement a tier system
  FREE_TIER_CHECK_INTERVAL: 1, // TESTING: Changed from 10 to 1 minute for debugging
  PREMIUM_TIER_CHECK_INTERVAL: 1, // minutes
  MAX_CONSECUTIVE_FAILURES: 10, // skip after this many failures
  
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