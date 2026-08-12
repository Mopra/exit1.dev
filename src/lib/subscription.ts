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
 * Always read caps and flags through the helpers below, and prefer the derived
 * booleans on `usePlan()` over ad-hoc tier comparisons. A `nano ? x : y` ternary
 * silently treats Indie as Free (and Pro as Nano), and a `paid ? x : y` gate
 * treats Free as having no API access — both are wrong under the current
 * lineup, and that class of bug is exactly what this mirror exists to prevent.
 */
export type TierKey = "free" | "indie" | "nano" | "pro"

export type TierLimitsRow = {
  emailsPerHour: number
  emailsPerMonth: number
  maxStatusPages: number
  minCheckIntervalSeconds: number
  maxChecks: number
  maxWebhooks: number
  maxApiKeys: number
  retentionDays: number
  /** API keys and MCP are one entitlement — there is no separate MCP flag. */
  apiAccess: boolean
  statusPageBuilder: boolean
  domainIntel: boolean
  maintenanceMode: boolean
  smsAlerts: boolean
  csvExport: boolean
  allAlertChannels: boolean
  regionChoice: boolean
}

const TIER_LIMITS_MIRROR: Record<TierKey, TierLimitsRow> = {
  free: {
    emailsPerHour: 50, emailsPerMonth: 300, maxStatusPages: 1,
    minCheckIntervalSeconds: 300, maxChecks: 50, maxWebhooks: 1, maxApiKeys: 1,
    retentionDays: 60,
    apiAccess: true, statusPageBuilder: false, domainIntel: false,
    maintenanceMode: false, smsAlerts: false, csvExport: false,
    allAlertChannels: false, regionChoice: false,
  },
  indie: {
    emailsPerHour: 100, emailsPerMonth: 800, maxStatusPages: 1,
    minCheckIntervalSeconds: 60, maxChecks: 100, maxWebhooks: 3, maxApiKeys: 3,
    retentionDays: 90,
    apiAccess: true, statusPageBuilder: true, domainIntel: false,
    maintenanceMode: false, smsAlerts: false, csvExport: false,
    allAlertChannels: false, regionChoice: false,
  },
  nano: {
    emailsPerHour: 250, emailsPerMonth: 2500, maxStatusPages: 5,
    minCheckIntervalSeconds: 30, maxChecks: 250, maxWebhooks: 10, maxApiKeys: 10,
    retentionDays: 365,
    apiAccess: true, statusPageBuilder: true, domainIntel: true,
    maintenanceMode: true, smsAlerts: false, csvExport: false,
    allAlertChannels: false, regionChoice: true,
  },
  pro: {
    emailsPerHour: 1000, emailsPerMonth: 10000, maxStatusPages: 50,
    minCheckIntervalSeconds: 15, maxChecks: 1000, maxWebhooks: 100, maxApiKeys: 100,
    retentionDays: 1095,
    apiAccess: true, statusPageBuilder: true, domainIntel: true,
    maintenanceMode: true, smsAlerts: true, csvExport: true,
    allAlertChannels: true, regionChoice: true,
  },
}

/** Full limit row for a tier. Prefer this when you need several values at once. */
export function getTierLimits(tier: TierKey): TierLimitsRow {
  return TIER_LIMITS_MIRROR[tier] ?? TIER_LIMITS_MIRROR.free
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

// The Free tier's `legacyFreeChecks` grandfathering (10 checks for pre-cutoff
// signups, back when Free allowed 5) was retired when Free moved to 50 — the
// new cap dominates it for every user in the set. See the note in
// `functions/src/config.ts`.

export function getMaxChecksForTier(tier: TierKey): number {
  return getTierLimits(tier).maxChecks
}

export function getMaxWebhooksForTier(tier: TierKey): number {
  return getTierLimits(tier).maxWebhooks
}

export function getMaxApiKeysForTier(tier: TierKey): number {
  return getTierLimits(tier).maxApiKeys
}

export function getRetentionDaysForTier(tier: TierKey): number {
  return getTierLimits(tier).retentionDays
}

/** Human-readable retention, e.g. "60 days" / "1 year" / "3 years". */
export function formatRetentionForTier(tier: TierKey): string {
  const days = getRetentionDaysForTier(tier)
  if (days < 365) return `${days} days`
  const years = Math.round(days / 365)
  return years === 1 ? "1 year" : `${years} years`
}

export const TIER_DISPLAY_NAME: Record<TierKey, string> = {
  free: "Free",
  indie: "Indie",
  nano: "Nano",
  pro: "Pro",
}

// Price order, which is also interval order and cap order — the ladder is
// monotonic on every dimension.
const TIER_LADDER: readonly TierKey[] = ["free", "indie", "nano", "pro"]

type CountableDimension =
  | "maxChecks"
  | "maxWebhooks"
  | "maxStatusPages"
  | "maxApiKeys"
  | "retentionDays"

type BooleanDimension = {
  [K in keyof TierLimitsRow]: TierLimitsRow[K] extends boolean ? K : never
}[keyof TierLimitsRow]

/**
 * Cheapest tier above `tier` whose cap for `dimension` is strictly larger, or
 * null when `tier` is already the highest. Upgrade copy should be built from
 * this rather than hardcoding "upgrade to Nano for 200" — that's how the UI
 * ended up advertising caps the backend never honoured.
 */
export function nextTierWithMore(
  tier: TierKey,
  dimension: CountableDimension,
  /**
   * Per-user cap that beats the flat tier row, when one exists. No entitlement
   * uses this today (the Free grandfathering that needed it is retired), but
   * the seam is cheap to keep and callers already pass their effective cap.
   */
  effectiveCurrent?: number,
): { tier: TierKey; name: string; max: number } | null {
  const current = effectiveCurrent ?? getTierLimits(tier)[dimension]
  const start = TIER_LADDER.indexOf(tier)
  for (const candidate of TIER_LADDER.slice(start + 1)) {
    const max = TIER_LIMITS_MIRROR[candidate][dimension]
    if (max > current) return { tier: candidate, name: TIER_DISPLAY_NAME[candidate], max }
  }
  return null
}

/**
 * Cheapest tier above `tier` that has `flag` enabled, or null when nothing
 * above it adds the feature. Use for "upgrade to X for Y" copy on flag-gated
 * features so it can't drift from TIER_LIMITS.
 */
export function nextTierWithFlag(
  tier: TierKey,
  flag: BooleanDimension,
): { tier: TierKey; name: string } | null {
  const start = TIER_LADDER.indexOf(tier)
  for (const candidate of TIER_LADDER.slice(start + 1)) {
    if (TIER_LIMITS_MIRROR[candidate][flag]) {
      return { tier: candidate, name: TIER_DISPLAY_NAME[candidate] }
    }
  }
  return null
}

/**
 * Minimum check interval in seconds. Founders are mapped to 'pro' upstream by
 * `usePlan()`, so this map covers them too.
 */
export function getMinCheckIntervalSecondsForTier(tier: TierKey): number {
  return getTierLimits(tier).minCheckIntervalSeconds
}
