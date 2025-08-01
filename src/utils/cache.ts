// In-memory cache utility for frequently accessed data
interface CacheEntry<T> {
  data: T;
  lastUpdated: number;
  expiresAt: number;
  accessCount: number;
}

interface CacheConfig {
  maxSize: number;
  ttl: number; // Time to live in milliseconds
  cleanupInterval: number; // Cleanup interval in milliseconds
}

class MemoryCache<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private config: CacheConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = {
      maxSize: 1000,
      ttl: 5 * 60 * 1000, // 5 minutes default
      cleanupInterval: 60 * 1000, // 1 minute cleanup
      ...config
    };
    this.startCleanup();
  }

  set(key: string, data: T, ttl?: number): void {
    const now = Date.now();
    const expiresAt = now + (ttl || this.config.ttl);

    // If cache is full, remove least recently used entry
    if (this.cache.size >= this.config.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data,
      lastUpdated: now,
      expiresAt,
      accessCount: 0
    });
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Update access count and last updated time
    entry.accessCount++;
    entry.lastUpdated = now;
    return entry.data;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();
    let lowestAccessCount = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      // Prioritize by access count first, then by last updated time
      if (entry.accessCount < lowestAccessCount || 
          (entry.accessCount === lowestAccessCount && entry.lastUpdated < oldestTime)) {
        oldestKey = key;
        oldestTime = entry.lastUpdated;
        lowestAccessCount = entry.accessCount;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }
}

// Pre-configured caches for different data types
export const checksCache = new MemoryCache({
  maxSize: 100,
  ttl: 30 * 1000, // 30 seconds for checks
  cleanupInterval: 120 * 1000 // Increased to 2 minutes
});

export const webhooksCache = new MemoryCache({
  maxSize: 50,
  ttl: 60 * 1000, // 1 minute for webhooks
  cleanupInterval: 300 * 1000 // Increased to 5 minutes
});

export const statsCache = new MemoryCache({
  maxSize: 200,
  ttl: 2 * 60 * 1000, // 2 minutes for statistics
  cleanupInterval: 300 * 1000 // Increased to 5 minutes
});

export const historyCache = new MemoryCache({
  maxSize: 500,
  ttl: 5 * 60 * 1000, // 5 minutes for history
  cleanupInterval: 600 * 1000 // Increased to 10 minutes
});

// Cache key generators
export const cacheKeys = {
  checks: (userId: string) => `checks_${userId}`,
  webhooks: (userId: string) => `webhooks_${userId}`,
  stats: (websiteId: string, timeRange: string) => `stats_${websiteId}_${timeRange}`,
  history: (websiteId: string, page: number, limit: number, filters: string) => 
    `history_${websiteId}_${page}_${limit}_${filters}`,
  systemStatus: () => 'system_status'
};

// Utility functions for cache management
export const cacheUtils = {
  // Invalidate all caches for a user
  invalidateUserCaches: (userId: string) => {
    checksCache.delete(cacheKeys.checks(userId));
    webhooksCache.delete(cacheKeys.webhooks(userId));
  },

  // Invalidate cache for a specific website
  invalidateWebsiteCaches: (websiteId: string) => {
    // Clear all stats and history entries for this website
    const statsKeys = statsCache.keys().filter(key => key.includes(websiteId));
    const historyKeys = historyCache.keys().filter(key => key.includes(websiteId));
    
    statsKeys.forEach(key => statsCache.delete(key));
    historyKeys.forEach(key => historyCache.delete(key));
  },

  // Get cache statistics
  getStats: () => ({
    checks: checksCache.size(),
    webhooks: webhooksCache.size(),
    stats: statsCache.size(),
    history: historyCache.size()
  }),

  // Clear all caches
  clearAll: () => {
    checksCache.clear();
    webhooksCache.clear();
    statsCache.clear();
    historyCache.clear();
  }
};

export default MemoryCache; 