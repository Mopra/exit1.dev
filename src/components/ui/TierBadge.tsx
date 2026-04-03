import { Link } from "react-router-dom"
import { Sparkles, Zap } from "lucide-react"
import { Badge } from "@/components/ui/Badge"
import { cn } from "@/lib/utils"

type TierBadgeProps = {
  nano: boolean
  scale: boolean
  /** Override the default label ("Scale" / "Nano"). */
  label?: string
  /** Wrap the badge in a Link to /billing. */
  asLink?: boolean
  className?: string
}

export function TierBadge({ nano, scale, label, asLink = false, className }: TierBadgeProps) {
  if (!nano && !scale) return null

  const isScale = scale
  const badge = (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1",
        isScale
          ? "drop-shadow-[0_0_8px_rgba(56,189,248,0.45)] text-sky-300/95 bg-sky-400/10 border-sky-300/20"
          : "drop-shadow-[0_0_8px_rgba(252,211,77,0.45)] text-amber-300/95 bg-amber-400/10 border-amber-300/20",
        asLink &&
          (isScale
            ? "hover:bg-sky-400/20 hover:border-sky-300/30 transition-colors"
            : "hover:bg-amber-400/20 hover:border-amber-300/30 transition-colors"),
        className,
      )}
    >
      {isScale ? (
        <Zap className="h-3.5 w-3.5 drop-shadow-[0_0_8px_rgba(56,189,248,0.55)] text-sky-300/95" />
      ) : (
        <Sparkles className="h-3.5 w-3.5 drop-shadow-[0_0_8px_rgba(252,211,77,0.55)] text-amber-300/95" />
      )}
      {label ?? (isScale ? "Scale" : "Nano")}
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
