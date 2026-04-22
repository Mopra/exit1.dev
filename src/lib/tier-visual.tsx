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

const VISUALS: Record<TierVisualTier, TierVisual> = {
  free: {
    label: "Free",
    palette: null,
    Icon: Sparkles,
  },
  nano: {
    label: "Nano",
    palette: {
      text: "text-violet-300/95",
      bg: "bg-violet-400/10",
      border: "border-violet-300/20",
      shadow: "drop-shadow-[0_0_8px_rgba(167,139,250,0.45)]",
      glow: "rgba(167,139,250,0.55)",
      hoverBg: "hover:bg-violet-400/20",
      hoverBorder: "hover:border-violet-300/30",
      dotBg: "bg-violet-400 text-black",
    },
    Icon: Zap,
  },
  pro: {
    label: "Pro",
    palette: {
      text: "text-amber-300/95",
      bg: "bg-amber-400/10",
      border: "border-amber-300/20",
      shadow: "drop-shadow-[0_0_8px_rgba(252,211,77,0.45)]",
      glow: "rgba(252,211,77,0.55)",
      hoverBg: "hover:bg-amber-400/20",
      hoverBorder: "hover:border-amber-300/30",
      dotBg: "bg-amber-400 text-black",
    },
    Icon: Gem,
  },
  agency: {
    label: "Agency",
    palette: {
      text: "text-emerald-300/95",
      bg: "bg-emerald-400/10",
      border: "border-emerald-300/20",
      shadow: "drop-shadow-[0_0_8px_rgba(52,211,153,0.45)]",
      glow: "rgba(52,211,153,0.55)",
      hoverBg: "hover:bg-emerald-400/20",
      hoverBorder: "hover:border-emerald-300/30",
      dotBg: "bg-emerald-400 text-black",
    },
    Icon: Crown,
  },
}

// Founders is a Pro variant sharing Pro's amber palette — matches the legacy
// Nano amber so long-standing screenshots and muscle memory stay intact.
const FOUNDERS_VISUAL: TierVisual = {
  label: "Founders",
  palette: {
    text: "text-amber-300/95",
    bg: "bg-amber-400/10",
    border: "border-amber-300/20",
    shadow: "drop-shadow-[0_0_8px_rgba(252,211,77,0.45)]",
    glow: "rgba(252,211,77,0.55)",
    hoverBg: "hover:bg-amber-400/20",
    hoverBorder: "hover:border-amber-300/30",
    dotBg: "bg-amber-400 text-black",
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
