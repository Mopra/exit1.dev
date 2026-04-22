import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/Badge"
import { cn } from "@/lib/utils"
import { getTierVisual, type TierVisualTier } from "@/lib/tier-visual"

export type TierBadgeTier = TierVisualTier

type TierBadgePropsNew = {
  tier: TierBadgeTier
  /** When true (and tier === 'pro'), renders the gold Founders variant. */
  isFounders?: boolean
  /** Override the default label. */
  label?: string
  /** Wrap the badge in a Link to /billing. */
  asLink?: boolean
  className?: string
}

/** @deprecated legacy boolean shape — pass `tier` instead. */
type TierBadgePropsLegacy = {
  nano: boolean
  scale: boolean
  label?: string
  asLink?: boolean
  className?: string
}

type TierBadgeProps = TierBadgePropsNew | TierBadgePropsLegacy

function isLegacyProps(p: TierBadgeProps): p is TierBadgePropsLegacy {
  return "nano" in p || "scale" in p
}

function legacyToTier(p: TierBadgePropsLegacy): TierBadgeTier {
  if (p.scale) return "agency"
  if (p.nano) return "nano"
  return "free"
}

export function TierBadge(props: TierBadgeProps) {
  const { label, asLink = false, className } = props
  const tier: TierBadgeTier = isLegacyProps(props) ? legacyToTier(props) : props.tier
  const isFounders = !isLegacyProps(props) && props.isFounders === true && tier === "pro"

  const visual = getTierVisual(tier, isFounders)
  if (!visual.palette) return null

  const { palette, Icon, label: defaultLabel } = visual

  const badge = (
    <Badge
      variant="secondary"
      title={isFounders ? "Founders — includes Pro features" : undefined}
      className={cn(
        "gap-1",
        palette.shadow,
        palette.text,
        palette.bg,
        palette.border,
        asLink && cn("transition-colors", palette.hoverBg, palette.hoverBorder),
        className,
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", palette.shadow, palette.text)} />
      {label ?? defaultLabel}
    </Badge>
  )

  if (asLink) {
    return (
      <Link to="/billing" className="cursor-pointer">
        {badge}
      </Link>
    )
  }
  return badge
}
