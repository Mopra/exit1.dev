import type { Tier } from "@/hooks/usePlan"

// ---- Data ----
//
// Mirrors `TIER_LIMITS` in functions/src/config.ts. Keep numbers in sync with
// the backend — these values are display-only copy, but they describe what the
// backend actually enforces. Prices mirror the Clerk billing configuration.

export type PlanKey = "free" | "indie" | "nano" | "pro"

export type BillingPeriod = "month" | "annual"

export interface PlanFeatureRow {
  label: string
  /** Rendered as a muted "Coming soon" badge next to the label. */
  comingSoon?: boolean
}

export interface PlanMatrixEntry {
  key: PlanKey
  /** Tier value used for the TierBadge color. */
  tier: Tier
  name: string
  tagline: string
  /** Numeric dollars charged per month on the monthly plan. */
  priceMonthly: number
  /** Numeric dollars charged per year on the annual plan. */
  priceAnnual: number
  /** Clerk plan slug candidates (first match wins). Empty for the Free row. */
  clerkSlugs: string[]
  features: PlanFeatureRow[]
}

export const PLAN_MATRIX: PlanMatrixEntry[] = [
  {
    key: "free",
    tier: "free",
    name: "Free",
    tagline: "Genuinely usable",
    priceMonthly: 0,
    priceAnnual: 0,
    clerkSlugs: [],
    features: [
      { label: "50 monitors" },
      { label: "5-minute check intervals" },
      { label: "Live probe stream" },
      { label: "1 API key + MCP access" },
      { label: "1 webhook integration" },
      { label: "300 emails / month" },
      { label: "1 public status page" },
      { label: "60-day data retention" },
    ],
  },
  {
    key: "indie",
    tier: "indie",
    name: "Indie",
    tagline: "Watch it closely",
    priceMonthly: 4,
    priceAnnual: 36, // $3/mo billed annually
    clerkSlugs: ["indie"],
    features: [
      { label: "100 monitors" },
      { label: "1-minute check intervals" },
      { label: "Live probe stream" },
      { label: "3 API keys + MCP access" },
      { label: "3 webhook integrations" },
      { label: "800 emails / month" },
      { label: "1 custom-branded status page" },
      { label: "90-day data retention" },
    ],
  },
  {
    key: "nano",
    tier: "nano",
    name: "Nano",
    tagline: "Run something real",
    priceMonthly: 9,
    priceAnnual: 84,
    clerkSlugs: ["nanov2", "starter"],
    features: [
      { label: "250 monitors" },
      { label: "30-second check intervals" },
      { label: "Live probe stream" },
      { label: "10 API keys + MCP access" },
      { label: "10 webhook integrations" },
      { label: "2,500 emails / month" },
      { label: "5 custom-branded status pages" },
      { label: "Domain intelligence & expiry alerts" },
      { label: "Maintenance mode" },
      { label: "Region choice (US / EU / Asia)" },
      { label: "1-year data retention" },
    ],
  },
  {
    key: "pro",
    tier: "pro",
    name: "Pro",
    tagline: "Everything, for a team",
    priceMonthly: 24,
    priceAnnual: 240,
    clerkSlugs: ["pro", "agency"],
    features: [
      { label: "1,000 monitors" },
      { label: "15-second check intervals" },
      { label: "Live probe stream" },
      { label: "100 API keys + MCP access" },
      { label: "100 webhook integrations" },
      { label: "SMS alerts (50 / month)" },
      { label: "10,000 emails / month" },
      { label: "50 custom-branded status pages" },
      { label: "CSV export" },
      { label: "Log comments" },
      { label: "All alert channels (Slack/Discord/Teams)" },
      { label: "Extra email recipients (per-check & per-folder)" },
      { label: "Region choice (US / EU / Asia)" },
      { label: "3-year data retention" },
      { label: "Team members & roles", comingSoon: true },
      { label: "Custom status page domain", comingSoon: true },
      { label: "SLA reporting", comingSoon: true },
    ],
  },
]

export const TIER_RANK: Record<Tier, number> = { free: 0, indie: 1, nano: 2, pro: 3 }

// ---- Free trial ----
//
// Every paid plan starts with a free trial. The trial itself is configured per
// plan in the Clerk Dashboard (Subscription plans -> free trial); the constant
// below is display-only copy and changing it does not change what Clerk
// charges. Keep the two in step, and keep this in step with TRIAL_DAYS in the
// website repo (src/components/PricingCards.tsx).
//
// Clerk only grants a trial to users who have never paid and never trialed, so
// trial wording belongs on a first-checkout CTA only. Plan switches for
// existing subscribers are charged (prorated) straight away.
export const TRIAL_DAYS = 7

/**
 * Which plans genuinely have a trial configured in Clerk.
 *
 * The trial CTA used to promise a trial on every paid card unconditionally, which
 * is a promise this codebase cannot verify: the Clerk plan objects returned by
 * `usePlans()` carry no trial field, so nothing at runtime can tell whether the
 * dashboard toggle is actually on. If a plan's trial is off, the card lies and the
 * user is charged immediately.
 *
 * Remove a key here and that card falls back to plain "Upgrade to X" copy with no
 * trial claim. It is the one lever that makes the CTA honest without a deploy of
 * new logic.
 */
export const TRIAL_PLAN_KEYS: PlanKey[] = ["indie", "nano", "pro"]

export function planHasTrial(key: PlanKey): boolean {
  return TRIAL_PLAN_KEYS.includes(key)
}

export const TRIAL_CTA_LABEL = `Start ${TRIAL_DAYS}-day trial`

/** CTA label for a paid card, trial wording only when the plan actually has one. */
export function paidCtaLabel(entry: PlanMatrixEntry): string {
  return planHasTrial(entry.key) ? TRIAL_CTA_LABEL : `Upgrade to ${entry.name}`
}

/**
 * Reassurance line rendered under a trial CTA, e.g. "7 days free, then $20/mo".
 * Returns null for the Free row, which has nothing to trial. The price quoted
 * matches what `PlanPrice` shows for the same period.
 */
export function trialNote(
  entry: PlanMatrixEntry,
  period: BillingPeriod,
): string | null {
  if (entry.priceMonthly === 0) return null
  const effectiveMonthly = effectiveMonthlyPrice(entry, period)
  if (!planHasTrial(entry.key)) return `$${effectiveMonthly}/mo, cancel anytime`
  return `${TRIAL_DAYS} days free, then $${effectiveMonthly}/mo`
}

/** Monthly-equivalent price for a period, matching what `PlanPrice` renders. */
export function effectiveMonthlyPrice(
  entry: PlanMatrixEntry,
  period: BillingPeriod,
): number {
  return period === "annual" ? Math.round(entry.priceAnnual / 12) : entry.priceMonthly
}

/** What a purchase is worth over twelve months. Used as the GA4 `value`. */
export function annualisedPrice(entry: PlanMatrixEntry, period: BillingPeriod): number {
  return period === "annual" ? entry.priceAnnual : entry.priceMonthly * 12
}

// ---- Plan recommendation ----
//
// The onboarding survey asks team size and use case on the two screens directly
// before the plan picker, and the picker then showed all four cards identically to
// everyone. Measured against the first 259 users through the flow, those answers
// are the strongest conversion predictors available: teams of 6 to 20 converted at
// 45% and 2 to 5 at 22%, against 6% for solo; client-sites and SaaS use cases at
// 18% each, against 2% for personal or side projects.
//
// So the picker now leads with two cards chosen from the answers, with the full
// four behind a "compare all plans" toggle. Nothing is hidden, and nobody is
// pitched a team plan for a hobby project or shown Free first when they just said
// they run a twenty-person agency.

export interface PlanRecommendation {
  /** Highlighted first card. */
  primary: PlanKey
  /** Shown beside the primary. Always a genuine alternative, never a duplicate. */
  secondary: PlanKey
  /** One line under the heading explaining why these two. */
  reason: string
}

const TEAM_ANSWERS_MEANING_TEAM = new Set(["2_5", "6_20", "21_100", "100_plus"])
const USE_CASES_MEANING_BUSINESS = new Set(["client_sites", "saas", "agency", "ecommerce"])

/**
 * Pick the two plans to lead with. Falls back to Free plus Pro when the survey was
 * skipped, which is also the honest default: those are the two tiers with real
 * customers behind them.
 */
export function recommendPlans(answers: {
  useCases: string[]
  teamSize: string | null
}): PlanRecommendation {
  const isTeam = answers.teamSize !== null && TEAM_ANSWERS_MEANING_TEAM.has(answers.teamSize)
  const isBusiness = answers.useCases.some((u) => USE_CASES_MEANING_BUSINESS.has(u))
  const isPersonalOnly =
    answers.useCases.length > 0 && answers.useCases.every((u) => u === "personal")

  // A team running customer-facing work is the segment that actually buys Pro, and
  // the one that needs the things only Pro has: extra recipients, SMS, all channels.
  if (isTeam && isBusiness) {
    return {
      primary: "pro",
      secondary: "nano",
      reason: "Built for teams watching customer-facing services.",
    }
  }
  if (isTeam) {
    return {
      primary: "pro",
      secondary: "free",
      reason: "Shared alerting and faster checks for a team.",
    }
  }
  // Solo, but running something real for someone else. Nano is the destination
  // tier: 30-second checks, domain intelligence, region pinning.
  if (isBusiness) {
    return {
      primary: "nano",
      secondary: "free",
      reason: "Faster checks and domain alerts for work that has customers.",
    }
  }
  // Explicitly a hobby. Pitching Pro here converted 2% of 95 people; lead with the
  // free tier and offer the cheap step up rather than the team plan.
  if (isPersonalOnly) {
    return {
      primary: "free",
      secondary: "indie",
      reason: "Free covers side projects properly. Indie just makes them faster.",
    }
  }
  return {
    primary: "free",
    secondary: "pro",
    reason: "Start free, or go straight to everything.",
  }
}

export function findPlanEntry(key: PlanKey): PlanMatrixEntry {
  const found = PLAN_MATRIX.find((p) => p.key === key)
  if (!found) throw new Error(`Unknown plan key: ${key}`)
  return found
}

// Per-tier styling for the plan cards. Colors flow from the --tier-* CSS
// tokens (see src/style.css) so the entire tier palette can be re-skinned in
// one place. The shared `tier-visual.tsx` palette is tuned for small badges
// (very subtle opacity); here we use higher opacity so the color reads at
// card scale.
export const TIER_CARD_BORDER: Record<Tier, string> = {
  free: "border-border",
  indie: "border-tier-indie/40",
  nano: "border-tier-nano/40",
  pro: "border-tier-pro/50",
}

export const TIER_CARD_BG: Record<Tier, string> = {
  free: "bg-background/40",
  indie: "bg-tier-indie/[0.04]",
  nano: "bg-tier-nano/[0.04]",
  pro: "bg-tier-pro/[0.05]",
}

export const TIER_CARD_GLOW: Record<Tier, string> = {
  free: "",
  indie: "shadow-lg shadow-tier-indie/10",
  nano: "shadow-lg shadow-tier-nano/10",
  pro: "shadow-lg shadow-tier-pro/15",
}

export const TIER_BUTTON_PRIMARY: Record<Tier, string> = {
  free: "",
  indie: "bg-tier-indie text-tier-indie-foreground hover:bg-tier-indie/90 border-transparent",
  nano: "bg-tier-nano text-tier-nano-foreground hover:bg-tier-nano/90 border-transparent",
  pro: "bg-tier-pro text-tier-pro-foreground hover:bg-tier-pro/90 border-transparent",
}

export const TIER_BUTTON_OUTLINE: Record<Tier, string> = {
  free: "",
  indie: "border-tier-indie/50 text-tier-indie hover:bg-tier-indie/10 hover:text-tier-indie",
  nano: "border-tier-nano/50 text-tier-nano hover:bg-tier-nano/10 hover:text-tier-nano",
  pro: "border-tier-pro/50 text-tier-pro hover:bg-tier-pro/10 hover:text-tier-pro",
}

// ---- Clerk plan lookup ----

export type ClerkPlan = { id: string; slug?: string | null }

export function findClerkPlan(
  plans: ClerkPlan[] | null | undefined,
  slugs: string[],
): ClerkPlan | null {
  if (!plans || slugs.length === 0) return null
  const lowered = slugs.map((s) => s.toLowerCase())
  return plans.find((p) => lowered.includes((p.slug ?? "").toLowerCase())) ?? null
}
