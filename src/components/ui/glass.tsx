"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "@/lib/utils"

// Reusable glassmorphism styles with color variants
const glassBase = "backdrop-blur-xl backdrop-saturate-150 shadow-2xl border"

const glassVariantMap = {
  primary: "bg-black/85 supports-[backdrop-filter]:bg-black/70 text-foreground border-border",
  destructive: "bg-destructive/15 text-destructive-foreground border-destructive/20",
  success: "bg-success/15 text-success-foreground border-success/20",
  warning: "bg-warning/15 text-warning-foreground border-warning/20",
  muted: "bg-muted/40 text-muted-foreground border-muted-foreground/15",
} as const

export type GlassVariant = keyof typeof glassVariantMap

export function glass(variant: GlassVariant = "primary") {
  return cn(glassBase, glassVariantMap[variant])
}

// Backward-compatible default (primary/sky)
export const glassClasses = glass("primary")

interface GlassProps extends React.HTMLAttributes<HTMLDivElement> {
  asChild?: boolean
}

export function Glass({ asChild, className, ...props }: GlassProps) {
  const Comp = asChild ? Slot : "div"
  return <Comp className={cn(glassClasses, className)} {...props} />
}

// Optional: Card-like container using glass style
export function GlassSection({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        glassClasses,
        "rounded-md p-3"
      )}
      {...props}
    />
  )
}

export default Glass


