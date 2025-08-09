import * as React from "react"

import { cn } from "@/lib/utils"
import { Card } from "./card"

type GlowAccent = "blue"

interface GlowCardProps extends React.ComponentProps<typeof Card> {
  accent?: GlowAccent
}

export const GlowCard = React.forwardRef<HTMLDivElement, GlowCardProps>(
  ({ className, accent = "blue", children, ...props }, ref) => {
    const accentClasses =
      accent === "blue"
        ? {
            container:
              "rounded-xl border-primary/10 bg-gradient-to-br from-primary/[0.02] via-transparent to-transparent",
            spot1: "bg-primary/[0.06]",
            spot2: "bg-primary/[0.04]",
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
          "relative overflow-hidden shadow-sm",
          accentClasses.container,
          className
        )}
        {...props}
      >
        <div className={cn("pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full blur-2xl", accentClasses.spot1)} />
        <div className={cn("pointer-events-none absolute -bottom-20 -left-20 h-48 w-48 rounded-full blur-2xl", accentClasses.spot2)} />
        {children}
      </Card>
    )
  }
)

GlowCard.displayName = "GlowCard"

export default GlowCard


