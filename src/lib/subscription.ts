export type SubscriptionPlanLike = {
  name?: string
  slug?: string
}

export type SubscriptionItemLike = {
  status?: string
  planPeriod?: "month" | "annual" | string
  plan?: SubscriptionPlanLike
}

export type SubscriptionLike = {
  subscriptionItems?: SubscriptionItemLike[]
}

export function getActiveSubscriptionItems(subscription: SubscriptionLike | null | undefined) {
  const items = subscription?.subscriptionItems ?? []
  return items.filter((item) => {
    const status = (item?.status ?? "").toLowerCase()
    return status === "active" || status === "upcoming" || status === "past_due"
  })
}

/**
 * Exact-key plan resolver. Returns the active paid item's raw plan slug
 * (e.g. 'indie', 'nanov2', 'pro', plus retired 'agency'/'scale'/'starter'), or
 * null if the only active item is the free plan or the user has no subscription.
 *
 * Uses exact slug match — substring matching is unsafe because 'nanov2'
 * would also match 'nano'.
 */
export function resolvePlanKey(subscription: SubscriptionLike | null | undefined): string | null {
  const items = getActiveSubscriptionItems(subscription)
  // Paid plan keys in priority order — first match wins. Highest-entitlement
  // keys first so a user with multiple active items resolves to the best one.
  // 'agency'/'scale' are retired but still map to Pro entitlements.
  const PAID_KEYS = ["agency", "scale", "pro", "nanov2", "nano", "starter", "indie"]
  for (const key of PAID_KEYS) {
    if (items.some((item) => item.plan?.slug === key)) return key
  }
  return null
}

/**
 * Returns the active paid subscription item for UI purposes (display plan
 * name, billing period, etc.). Falls back to null when only free is active.
 */
export function getActivePaidSubscriptionItem(subscription: SubscriptionLike | null | undefined) {
  const key = resolvePlanKey(subscription)
  if (!key) return null
  const items = getActiveSubscriptionItems(subscription)
  return items.find((item) => item.plan?.slug === key) ?? null
}

/**
 * @deprecated Use resolvePlanKey() / usePlan() instead. Remove in a follow-up.
 */
export function getScaleSubscriptionItem(subscription: SubscriptionLike | null | undefined) {
  const items = getActiveSubscriptionItems(subscription)
  return items.find((item) => item.plan?.slug === "scale" || item.plan?.slug === "agency") ?? null
}

/**
 * @deprecated Use resolvePlanKey() / usePlan() instead. Remove in a follow-up.
 */
export function getNanoSubscriptionItem(subscription: SubscriptionLike | null | undefined) {
  const key = resolvePlanKey(subscription)
  if (!key) return null
  const items = getActiveSubscriptionItems(subscription)
  return items.find((item) => item.plan?.slug === key) ?? null
}

/**
 * @deprecated Use usePlan().pro instead. Remove in a follow-up.
 */
export function isScalePlan(subscription: SubscriptionLike | null | undefined) {
  const key = resolvePlanKey(subscription)
  return key === "scale" || key === "agency" || key === "pro"
}

/**
 * @deprecated Use usePlan().paid instead. Remove in a follow-up.
 */
export function isNanoPlan(subscription: SubscriptionLike | null | undefined) {
  return resolvePlanKey(subscription) !== null
}

/**
 * Client-side mirror of `TIER_LIMITS` from `functions/src/config.ts`. Kept as a
 * tiny local map to avoid importing server code into the browser bundle.
 * Keep in sync with the backend — the backend is authoritative and re-validates
 * everything here.
 *
 * Note the interval column is NOT monotonic: Indie ($4) probes at 15s while
 * Nano ($9) probes at 2min. Indie is the "few sites, watched closely" tier.
 *
 * Always read caps through the helpers below. A `nano ? x : y` ternary silently
 * treats Indie as Free (and Pro as Nano) — that class of bug is what this mirror
 * exists to prevent.
 */
export type TierKey = "free" | "indie" | "nano" | "pro"

const TIER_LIMITS_MIRROR: Record<TierKey, {
  emailsPerHour: number
  emailsPerMonth: number
  maxStatusPages: number
  minCheckIntervalSeconds: number
  maxChecks: number
  maxWebhooks: number
}> = {
  free:  { emailsPerHour: 10,  emailsPerMonth: 10,    maxStatusPages: 1,  minCheckIntervalSeconds: 300, maxChecks: 5,    maxWebhooks: 1 },
  indie: { emailsPerHour: 50,  emailsPerMonth: 500,   maxStatusPages: 1,  minCheckIntervalSeconds: 15,  maxChecks: 10,   maxWebhooks: 3 },
  nano:  { emailsPerHour: 50,  emailsPerMonth: 1000,  maxStatusPages: 5,  minCheckIntervalSeconds: 120, maxChecks: 100,  maxWebhooks: 5 },
  pro:   { emailsPerHour: 500, emailsPerMonth: 10000, maxStatusPages: 50, minCheckIntervalSeconds: 15,  maxChecks: 1000, maxWebhooks: 50 },
}

/** @deprecated Use `TIER_LIMITS_MIRROR` — this only covered free/nano. */
export const PLAN_LIMITS = {
  free: { emailsPerHour: TIER_LIMITS_MIRROR.free.emailsPerHour, emailsPerMonth: TIER_LIMITS_MIRROR.free.emailsPerMonth },
  nano: { emailsPerHour: TIER_LIMITS_MIRROR.nano.emailsPerHour, emailsPerMonth: TIER_LIMITS_MIRROR.nano.emailsPerMonth },
} as const

export function formatEmailBudgetForTier(tier: TierKey): string {
  const l = TIER_LIMITS_MIRROR[tier] ?? TIER_LIMITS_MIRROR.free
  return `${l.emailsPerHour} emails/hour + ${l.emailsPerMonth}/month`
}

export function formatEmailBudget(isPaid: boolean): string {
  return formatEmailBudgetForTier(isPaid ? "nano" : "free")
}

export function getMaxStatusPagesForTier(tier: TierKey): number {
  return TIER_LIMITS_MIRROR[tier]?.maxStatusPages ?? 1
}

export function getMaxChecksForTier(tier: TierKey): number {
  return TIER_LIMITS_MIRROR[tier]?.maxChecks ?? TIER_LIMITS_MIRROR.free.maxChecks
}

export function getMaxWebhooksForTier(tier: TierKey): number {
  return TIER_LIMITS_MIRROR[tier]?.maxWebhooks ?? TIER_LIMITS_MIRROR.free.maxWebhooks
}

export const TIER_DISPLAY_NAME: Record<TierKey, string> = {
  free: "Free",
  indie: "Indie",
  nano: "Nano",
  pro: "Pro",
}

// Price order. Deliberately NOT interval order — see the note above.
const TIER_LADDER: readonly TierKey[] = ["free", "indie", "nano", "pro"]

type CountableDimension = "maxChecks" | "maxWebhooks" | "maxStatusPages"

/**
 * Cheapest tier above `tier` whose cap for `dimension` is strictly larger, or
 * null when `tier` is already the highest. Upgrade copy should be built from
 * this rather than hardcoding "upgrade to Nano for 200" — that's how the UI
 * ended up advertising caps the backend never honoured.
 */
export function nextTierWithMore(
  tier: TierKey,
  dimension: CountableDimension,
): { tier: TierKey; name: string; max: number } | null {
  const limits = TIER_LIMITS_MIRROR[tier] ?? TIER_LIMITS_MIRROR.free
  const current = limits[dimension]
  const start = TIER_LADDER.indexOf(tier)
  for (const candidate of TIER_LADDER.slice(start + 1)) {
    const max = TIER_LIMITS_MIRROR[candidate][dimension]
    if (max > current) return { tier: candidate, name: TIER_DISPLAY_NAME[candidate], max }
  }
  return null
}

/**
 * Minimum check interval in seconds. Founders are mapped to 'pro' upstream by
 * `usePlan()`, so this map covers them too.
 */
export function getMinCheckIntervalSecondsForTier(tier: TierKey): number {
  return TIER_LIMITS_MIRROR[tier]?.minCheckIntervalSeconds ?? 300
}
