import type { ReactNode } from "react"
import { CheckCircle2, Sparkles } from "lucide-react"

import { Badge } from "@/components/ui/Badge"
import { ComingSoonBadge } from "@/components/ui/ComingSoonBadge"
import { getTierVisual } from "@/lib/tier-visual"
import { cn } from "@/lib/utils"
import {
  TIER_BUTTON_PRIMARY,
  TIER_CARD_BG,
  TIER_CARD_BORDER,
  TIER_CARD_GLOW,
  type BillingPeriod,
  type PlanMatrixEntry,
} from "./plan-matrix-data"

// ---- Billing period toggle ----

export function BillingPeriodToggle({
  value,
  onChange,
}: {
  value: BillingPeriod
  onChange: (next: BillingPeriod) => void
}) {
  return (
    <div className="flex items-center justify-center">
      <div
        role="tablist"
        aria-label="Billing period"
        className="inline-flex items-center rounded-full border bg-background/40 backdrop-blur p-1 text-sm"
      >
        <button
          type="button"
          role="tab"
          aria-selected={value === "month"}
          onClick={() => onChange("month")}
          className={cn(
            "cursor-pointer rounded-full px-4 py-1.5 font-medium transition-colors",
            value === "month"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Monthly
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={value === "annual"}
          onClick={() => onChange("annual")}
          className={cn(
            "cursor-pointer rounded-full px-4 py-1.5 font-medium transition-colors inline-flex items-center gap-2",
            value === "annual"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Annual
          <Badge
            variant={value === "annual" ? "secondary" : "outline"}
            className="text-[10px] px-1.5 py-0 font-semibold"
          >
            Save ~20%
          </Badge>
        </button>
      </div>
    </div>
  )
}

// ---- Price display ----

export function PlanPrice({
  entry,
  period,
}: {
  entry: PlanMatrixEntry
  period: BillingPeriod
}) {
  if (entry.priceMonthly === 0) {
    return (
      <div>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold">$0</span>
          <span className="text-sm text-muted-foreground">/mo</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">Always free</p>
      </div>
    )
  }

  const effectiveMonthly =
    period === "annual"
      ? Math.round(entry.priceAnnual / 12)
      : entry.priceMonthly

  return (
    <div>
      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-bold">${effectiveMonthly}</span>
        <span className="text-sm text-muted-foreground">/mo</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        {period === "annual"
          ? `Billed $${entry.priceAnnual}/year`
          : "Billed monthly"}
      </p>
    </div>
  )
}

// ---- Plan card ----
//
// Visual container for a single plan. The CTA is a slot so Billing (upgrade /
// downgrade via Clerk) and Onboarding (checkout for new subscriptions) can
// supply their own button logic without forking the styling.

interface PlanCardProps {
  entry: PlanMatrixEntry
  billingPeriod: BillingPeriod
  /** Adds a colored glow + "Most popular" badge in the top-right. */
  highlighted?: boolean
  /** Marks the card as the user's current plan (adds ring + inline badge). */
  isCurrent?: boolean
  cta: ReactNode
  /** Optional content rendered below the feature list (e.g. a testimonial). */
  footer?: ReactNode
}

export function PlanCard({
  entry,
  billingPeriod,
  highlighted = false,
  isCurrent = false,
  cta,
  footer,
}: PlanCardProps) {
  const tierVisual = getTierVisual(entry.tier)

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border backdrop-blur p-5 transition-shadow",
        TIER_CARD_BG[entry.tier],
        TIER_CARD_BORDER[entry.tier],
        highlighted && TIER_CARD_GLOW[entry.tier],
        isCurrent && "ring-2 ring-primary/50",
      )}
    >
      {highlighted && !isCurrent && (
        <Badge
          className={cn(
            "absolute -top-2.5 right-4 text-[10px] uppercase tracking-wide gap-1 border",
            TIER_BUTTON_PRIMARY[entry.tier],
          )}
        >
          <Sparkles className="h-3 w-3" />
          Most popular
        </Badge>
      )}

      <div className="flex items-center justify-between mb-1">
        <h4
          className={cn(
            "text-lg font-semibold flex items-center gap-2",
            tierVisual.palette?.text,
          )}
        >
          {tierVisual.palette && <tierVisual.Icon className="h-4 w-4" />}
          {entry.name}
        </h4>
        {isCurrent && (
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
            Current
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4 min-h-[2rem]">
        {entry.tagline}
      </p>

      <PlanPrice entry={entry} period={billingPeriod} />

      <div className="mt-4 mb-4">{cta}</div>

      <ul className="space-y-2 flex-1">
        {entry.features.map((f) => (
          <li key={f.label} className="flex items-start gap-2 text-sm">
            <CheckCircle2
              className={cn(
                "h-4 w-4 mt-0.5 shrink-0",
                f.comingSoon ? "text-muted-foreground/50" : "text-primary",
              )}
            />
            <span className="flex-1 flex flex-wrap items-center gap-1.5">
              <span className={cn(f.comingSoon && "text-muted-foreground")}>
                {f.label}
              </span>
              {f.comingSoon && <ComingSoonBadge />}
            </span>
          </li>
        ))}
      </ul>

      {footer && <div className="mt-4">{footer}</div>}
    </div>
  )
}
