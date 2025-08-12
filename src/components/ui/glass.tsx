"use client"

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "@/lib/utils"

// Reusable glassmorphism styles with color variants
const glassBase = "backdrop-blur-md shadow-2xl border"

const glassVariantMap = {
  primary: "bg-sky-500/15 text-sky-50 border-sky-300/20",
  destructive: "bg-red-500/15 text-red-50 border-red-300/20",
  success: "bg-emerald-500/15 text-emerald-50 border-emerald-300/20",
  warning: "bg-amber-500/15 text-amber-50 border-amber-300/20",
  muted: "bg-slate-500/10 text-slate-50 border-slate-300/15",
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


