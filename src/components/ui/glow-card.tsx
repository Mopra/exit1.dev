import * as React from "react"

import { cn } from "@/lib/utils"
import { Card } from "./card"

type GlowAccent = "blue"

interface GlowCardProps extends React.ComponentProps<typeof Card> {
  accent?: GlowAccent
  magic?: boolean
}

export const GlowCard = React.forwardRef<HTMLDivElement, GlowCardProps>(
  ({ className, accent = "blue", magic = false, children, ...props }, ref) => {
    const accentClasses =
      accent === "blue"
        ? {
          container:
            "rounded-xl border-primary/10 bg-gradient-to-br from-primary/[0.02] via-transparent to-transparent",
          spot1: "bg-primary/[0.03]",
          spot2: "bg-primary/[0.02]",
        }
        : {
          container: "",
          spot1: "",
          spot2: "",
        }

    return (
      <Card
        ref={ref}
        className={cn(
          "relative overflow-hidden shadow-sm aurora-tilt",
          magic && "group/aurora",
          accentClasses.container,
          className
        )}
        {...props}
      >
        {magic && (
          <div className="pointer-events-none absolute inset-0">
            {/* Soft inner glow and ring */}
            <div className="absolute inset-0 rounded-xl aurora-inner-glow" />
            <div className="absolute inset-0 rounded-xl aurora-inner-ring" />
          </div>
        )}
        <div className={cn("pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full blur-2xl", accentClasses.spot1)} />
        <div className={cn("pointer-events-none absolute -bottom-20 -left-20 h-48 w-48 rounded-full blur-2xl", accentClasses.spot2)} />
        {children}
      </Card>
    )
  }
)

GlowCard.displayName = "GlowCard"

export default GlowCard


