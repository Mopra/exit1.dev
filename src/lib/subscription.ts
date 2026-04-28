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
 * (e.g. 'nano', 'nanov2', 'pro', 'agency', 'scale', 'starter'), or null if
 * the only active item is the free plan or the user has no subscription.
 *
 * Uses exact slug match — substring matching is unsafe because 'nanov2'
 * would also match 'nano'.
 */
export function resolvePlanKey(subscription: SubscriptionLike | null | undefined): string | null {
  const items = getActiveSubscriptionItems(subscription)
  // Paid plan keys in priority order — first match wins. Keep 'agency'/'scale' first
  // so if a user somehow has multiple active items, the higher tier wins.
  const PAID_KEYS = ["agency", "scale", "pro", "nanov2", "nano", "starter"]
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
 * @deprecated Use usePlan().agency instead. Remove in a follow-up.
 */
export function isScalePlan(subscription: SubscriptionLike | null | undefined) {
  const key = resolvePlanKey(subscription)
  return key === "scale" || key === "agency"
}

/**
 * @deprecated Use usePlan().paid instead. Remove in a follow-up.
 */
export function isNanoPlan(subscription: SubscriptionLike | null | undefined) {
  return resolvePlanKey(subscription) !== null
}

export const PLAN_LIMITS = {
  free: { emailsPerHour: 10, emailsPerMonth: 10 },
  nano: { emailsPerHour: 100, emailsPerMonth: 1000 },
} as const

export function formatEmailBudget(isPaid: boolean): string {
  const l = isPaid ? PLAN_LIMITS.nano : PLAN_LIMITS.free
  return `${l.emailsPerHour} emails/hour + ${l.emailsPerMonth}/month`
}

/**
 * Client-side mirror of `TIER_LIMITS.<tier>.maxStatusPages` from
 * `functions/src/config.ts`. Kept as a tiny local map to avoid importing
 * server code into the browser bundle. Keep in sync with the backend.
 */
type TierKey = "free" | "nano" | "pro" | "agency"
const MAX_STATUS_PAGES_BY_TIER: Record<TierKey, number> = {
  free: 1,
  nano: 5,
  pro: 25,
  agency: 50,
}

export function getMaxStatusPagesForTier(tier: TierKey): number {
  return MAX_STATUS_PAGES_BY_TIER[tier] ?? 1
}

/**
 * Client-side mirror of `TIER_LIMITS.<tier>.minCheckIntervalMinutes` from
 * `functions/src/config.ts`, expressed in seconds. Founders are mapped to
 * 'pro' upstream by `usePlan()`, so this map covers them too. Keep in sync
 * with the backend.
 */
const MIN_CHECK_INTERVAL_SECONDS_BY_TIER: Record<TierKey, number> = {
  free: 300,   // 5 min
  nano: 120,   // 2 min
  pro: 30,     // 30 sec
  agency: 15,  // 15 sec
}

export function getMinCheckIntervalSecondsForTier(tier: TierKey): number {
  return MIN_CHECK_INTERVAL_SECONDS_BY_TIER[tier] ?? 300
}
