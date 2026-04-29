import type { ComponentType } from "react"
import { Crown, Gem, Sparkles, Zap, type LucideProps } from "lucide-react"

export type TierVisualTier = "free" | "nano" | "pro" | "agency"

export type TierVisual = {
  label: string
  /** One-color-per-tier palette. Free → null (no colored surfaces). */
  palette: {
    text: string
    bg: string
    border: string
    shadow: string
    /** Raw rgba for glow effects that build their own drop-shadow(). */
    glow: string
    hoverBg: string
    hoverBorder: string
    /** Avatar dot fill color — used for the tiny badge on user avatars. */
    dotBg: string
  } | null
  Icon: ComponentType<LucideProps>
}

// Per-tier accent colors come from --tier-* CSS tokens (see src/style.css).
// `glow` is consumed by drop-shadow effects that need a raw color value, so
// we expose the same token via var() for inline-style consumers.
const VISUALS: Record<TierVisualTier, TierVisual> = {
  free: {
    label: "Free",
    palette: null,
    Icon: Sparkles,
  },
  nano: {
    label: "Nano",
    palette: {
      text: "text-tier-nano/95",
      bg: "bg-tier-nano/10",
      border: "border-tier-nano/20",
      shadow: "drop-shadow-[0_0_8px_var(--tier-nano)]",
      glow: "var(--tier-nano)",
      hoverBg: "hover:bg-tier-nano/20",
      hoverBorder: "hover:border-tier-nano/30",
      dotBg: "bg-tier-nano text-tier-nano-foreground",
    },
    Icon: Zap,
  },
  pro: {
    label: "Pro",
    palette: {
      text: "text-tier-pro/95",
      bg: "bg-tier-pro/10",
      border: "border-tier-pro/20",
      shadow: "drop-shadow-[0_0_8px_var(--tier-pro)]",
      glow: "var(--tier-pro)",
      hoverBg: "hover:bg-tier-pro/20",
      hoverBorder: "hover:border-tier-pro/30",
      dotBg: "bg-tier-pro text-tier-pro-foreground",
    },
    Icon: Gem,
  },
  agency: {
    label: "Agency",
    palette: {
      text: "text-tier-agency/95",
      bg: "bg-tier-agency/10",
      border: "border-tier-agency/20",
      shadow: "drop-shadow-[0_0_8px_var(--tier-agency)]",
      glow: "var(--tier-agency)",
      hoverBg: "hover:bg-tier-agency/20",
      hoverBorder: "hover:border-tier-agency/30",
      dotBg: "bg-tier-agency text-tier-agency-foreground",
    },
    Icon: Crown,
  },
}

// Founders is a Pro variant — shares Pro's accent so long-standing screenshots
// and muscle memory stay intact. Re-skinning is automatic via --tier-pro.
const FOUNDERS_VISUAL: TierVisual = {
  label: "Founders",
  palette: {
    text: "text-tier-pro/95",
    bg: "bg-tier-pro/10",
    border: "border-tier-pro/20",
    shadow: "drop-shadow-[0_0_8px_var(--tier-pro)]",
    glow: "var(--tier-pro)",
    hoverBg: "hover:bg-tier-pro/20",
    hoverBorder: "hover:border-tier-pro/30",
    dotBg: "bg-tier-pro text-tier-pro-foreground",
  },
  Icon: Sparkles,
}

/**
 * Canonical per-tier visuals. `isFounders` returns the Founders variant only
 * when tier === 'pro'; at any other tier the flag is ignored.
 */
export function getTierVisual(
  tier: TierVisualTier,
  isFounders: boolean = false,
): TierVisual {
  if (isFounders && tier === "pro") return FOUNDERS_VISUAL
  return VISUALS[tier]
}
