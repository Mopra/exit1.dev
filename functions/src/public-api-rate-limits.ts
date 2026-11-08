// Read rate limits for the public API, per plan.
//
// Free keeps the original numbers: 1 request/minute per route was tuned so a
// script looping over checks can't burst. Paid plans got the same numbers,
// which made a 101-check account wait 61 seconds for page two of
// GET /checks. Paid plans now get more room, rising with the plan.
//
// All of these limiters are in memory. They cost no Firestore reads or
// writes. The only new cost is the tier lookup, cached per instance below.

export type RateLimitTier = 'free' | 'indie' | 'nano' | 'pro';

export interface ReadRateLimits {
  perKeyTotalPerMinute: number;
  perEndpointPerMinute: number;
  perKeyDaily: number;
  perUserDaily: number;
}

// Pre-auth guard per IP. It runs before we know the tier, so it has to fit
// the largest per-key profile below.
export const IP_GUARD_PER_MINUTE = 60;

export const TIER_READ_RATE_LIMITS: Record<RateLimitTier, ReadRateLimits> = {
  free: { perKeyTotalPerMinute: 5, perEndpointPerMinute: 1, perKeyDaily: 500, perUserDaily: 2000 },
  indie: { perKeyTotalPerMinute: 20, perEndpointPerMinute: 5, perKeyDaily: 2000, perUserDaily: 5000 },
  nano: { perKeyTotalPerMinute: 30, perEndpointPerMinute: 10, perKeyDaily: 3000, perUserDaily: 8000 },
  pro: { perKeyTotalPerMinute: 60, perEndpointPerMinute: 20, perKeyDaily: 5000, perUserDaily: 15000 },
};

// OAuth (agent) sessions. The burst matters mid-onboarding; see public-api.ts.
export const AGENT_READ_RATE_LIMITS: ReadRateLimits = {
  perKeyTotalPerMinute: 30,
  perEndpointPerMinute: 10,
  perKeyDaily: 1500,
  perUserDaily: 3000,
};

// Largest page GET /v1/public/checks returns. Pro caps at 1,000 checks, so
// every plan's checks fit in one call. Firestore reads are the same either
// way (one per check returned); bigger pages only mean fewer requests.
export const MAX_CHECKS_PAGE_SIZE = 1000;

export function resolveReadRateLimits(tier: RateLimitTier, isAgentSession: boolean): ReadRateLimits {
  const base = TIER_READ_RATE_LIMITS[tier] ?? TIER_READ_RATE_LIMITS.free;
  if (!isAgentSession) return base;
  // An agent session on a paid plan should never get less than the plan's key.
  return {
    perKeyTotalPerMinute: Math.max(base.perKeyTotalPerMinute, AGENT_READ_RATE_LIMITS.perKeyTotalPerMinute),
    perEndpointPerMinute: Math.max(base.perEndpointPerMinute, AGENT_READ_RATE_LIMITS.perEndpointPerMinute),
    perKeyDaily: Math.max(base.perKeyDaily, AGENT_READ_RATE_LIMITS.perKeyDaily),
    perUserDaily: Math.max(base.perUserDaily, AGENT_READ_RATE_LIMITS.perUserDaily),
  };
}

// Per-instance tier cache, so picking a profile costs one users-doc read per
// user per instance per 15 minutes, not one per request. An upgrade shows up
// within 15 minutes; a downgrade keeps the higher limits for at most as long.
const TIER_CACHE_TTL_MS = 15 * 60 * 1000;
const TIER_CACHE_MAX = 5000;

export class TierCache {
  private entries = new Map<string, { tier: RateLimitTier; expiresAt: number }>();

  constructor(
    private readonly load: (userId: string) => Promise<RateLimitTier>,
    private readonly ttlMs = TIER_CACHE_TTL_MS,
    private readonly maxEntries = TIER_CACHE_MAX,
  ) {}

  async get(userId: string, now = Date.now()): Promise<RateLimitTier> {
    const hit = this.entries.get(userId);
    if (hit && hit.expiresAt > now) return hit.tier;
    let tier: RateLimitTier;
    try {
      tier = await this.load(userId);
    } catch {
      // Fail to the stale answer if we have one, else to Free. Never cache a guess.
      return hit?.tier ?? 'free';
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(userId);
    this.entries.set(userId, { tier, expiresAt: now + this.ttlMs });
    return tier;
  }
}
