import type { Tier } from "@/hooks/usePlan"

// ---- Data ----
//
// Mirrors `TIER_LIMITS` in functions/src/config.ts. Keep numbers in sync with
// the backend — these values are display-only copy, but they describe what the
// backend actually enforces. Prices mirror the Clerk billing configuration.

export type PlanKey = "free" | "nano" | "pro" | "agency"

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
    tagline: "Try it",
    priceMonthly: 0,
    priceAnnual: 0,
    clerkSlugs: [],
    features: [
      { label: "10 monitors" },
      { label: "5-minute check intervals" },
      { label: "1 webhook integration" },
      { label: "10 emails / month" },
      { label: "1 public status page" },
      { label: "60-day data retention" },
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
      { label: "50 monitors" },
      { label: "2-minute check intervals" },
      { label: "5 webhook integrations" },
      { label: "1,000 emails / month" },
      { label: "5 custom-branded status pages" },
      { label: "Domain intelligence & expiry alerts" },
      { label: "Maintenance mode" },
      { label: "60-day data retention" },
    ],
  },
  {
    key: "pro",
    tier: "pro",
    name: "Pro",
    tagline: "Don't miss incidents",
    priceMonthly: 24,
    priceAnnual: 240,
    clerkSlugs: ["pro"],
    features: [
      { label: "500 monitors" },
      { label: "30-second check intervals" },
      { label: "25 webhook integrations" },
      { label: "10 API keys + MCP access" },
      { label: "SMS alerts (50 / month)" },
      { label: "10,000 emails / month" },
      { label: "25 custom-branded status pages" },
      { label: "CSV export" },
      { label: "Log comments" },
      { label: "Extra email recipients (per-check & per-folder)" },
      { label: "365-day data retention" },
    ],
  },
  {
    key: "agency",
    tier: "agency",
    name: "Agency",
    tagline: "Catch everything instantly",
    priceMonthly: 49,
    priceAnnual: 444,
    clerkSlugs: ["agency"],
    features: [
      { label: "1,000 monitors" },
      { label: "15-second check intervals" },
      { label: "50 webhook integrations" },
      { label: "25 API keys + MCP access" },
      { label: "SMS alerts (100 / month)" },
      { label: "50,000 emails / month" },
      { label: "50 custom-branded status pages" },
      { label: "All alert channels" },
      { label: "3-year data retention" },
      { label: "Team members & roles", comingSoon: true },
      { label: "Custom status page domain", comingSoon: true },
      { label: "SLA reporting", comingSoon: true },
    ],
  },
]

export const TIER_RANK: Record<Tier, number> = { free: 0, nano: 1, pro: 2, agency: 3 }

// Per-tier styling for the plan cards. The shared `tier-visual.tsx` palette is
// tuned for small badges (very subtle opacity); here we need more saturated
// values so the color reads at card scale. Colors themselves mirror the
// canonical TierBadge hues — violet/amber/emerald — for cross-app consistency.
export const TIER_CARD_BORDER: Record<Tier, string> = {
  free: "border-border",
  nano: "border-violet-400/40",
  pro: "border-amber-400/50",
  agency: "border-emerald-400/40",
}

export const TIER_CARD_BG: Record<Tier, string> = {
  free: "bg-background/40",
  nano: "bg-violet-400/[0.04]",
  pro: "bg-amber-400/[0.05]",
  agency: "bg-emerald-400/[0.04]",
}

export const TIER_CARD_GLOW: Record<Tier, string> = {
  free: "",
  nano: "shadow-lg shadow-violet-500/10",
  pro: "shadow-lg shadow-amber-500/15",
  agency: "shadow-lg shadow-emerald-500/10",
}

export const TIER_BUTTON_PRIMARY: Record<Tier, string> = {
  free: "",
  nano: "bg-violet-400 text-black hover:bg-violet-300 border-transparent",
  pro: "bg-amber-400 text-black hover:bg-amber-300 border-transparent",
  agency: "bg-emerald-400 text-black hover:bg-emerald-300 border-transparent",
}

export const TIER_BUTTON_OUTLINE: Record<Tier, string> = {
  free: "",
  nano: "border-violet-400/50 text-violet-300 hover:bg-violet-400/10 hover:text-violet-200",
  pro: "border-amber-400/50 text-amber-300 hover:bg-amber-400/10 hover:text-amber-200",
  agency: "border-emerald-400/50 text-emerald-300 hover:bg-emerald-400/10 hover:text-emerald-200",
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
