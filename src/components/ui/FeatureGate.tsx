import React from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./Button";

type Tier = "free" | "indie" | "nano" | "pro";
type RequiredTier = "indie" | "nano" | "pro";

const TIER_RANK: Record<Tier, number> = {
  free: 0,
  indie: 1,
  nano: 2,
  pro: 3,
};

const TIER_LABEL: Record<RequiredTier, string> = {
  indie: "Indie",
  nano: "Nano",
  pro: "Pro",
};

type FeatureGateProps = {
  /**
   * Explicit entitlement check: when true, gate content (show upgrade card).
   * When false, render children. Takes precedence over the tier comparison, so
   * pass this whenever the entitlement is not a plain "tier X and up" rule
   * (Free has API access, for example).
   */
  enabled?: boolean;
  /**
   * Minimum tier required to access the gated content. When `enabled` is not
   * given and `currentTier` is, the gate shows unless `currentTier` meets or
   * exceeds `requiredTier`. Always used for the copy. Defaults to 'nano'.
   */
  requiredTier?: RequiredTier;
  /** User's current effective tier. Required when using `requiredTier`. */
  currentTier?: Tier;
  title?: string;
  description?: string;
  ctaHref?: string;
  ctaLabel?: string;
  children: React.ReactNode;
  className?: string;
};

export function FeatureGate({
  enabled,
  requiredTier,
  currentTier,
  title,
  description,
  ctaHref = "/billing",
  ctaLabel,
  children,
  className,
}: FeatureGateProps) {
  const effectiveRequired: RequiredTier = requiredTier ?? "nano";
  const tierLabel = TIER_LABEL[effectiveRequired];

  // Decide gating. An explicit `enabled` is the caller's own entitlement check
  // and wins outright; `currentTier` then only feeds the copy. Without it, fall
  // back to the tier comparison.
  //
  // The order matters. Until 2026-09-07 `currentTier` took precedence, so the
  // API Keys and MCP pages, which pass both, gated every Free user behind an
  // upgrade card even though Free has had API access since the 2026-08-12 tier
  // restructure. The page header still rendered its Create button outside the
  // gate, which made the bug look like a button that did nothing.
  let gated: boolean;
  if (enabled !== undefined) {
    gated = enabled;
  } else if (currentTier !== undefined) {
    gated = TIER_RANK[currentTier] < TIER_RANK[effectiveRequired];
  } else {
    gated = false;
  }

  if (!gated) return <>{children}</>;

  const resolvedTitle = title ?? `Upgrade to ${tierLabel}`;
  const resolvedDescription =
    description ??
    `This feature is available on the ${tierLabel} plan. Upgrade to unlock it.`;
  const resolvedCtaLabel = ctaLabel ?? `Upgrade to ${tierLabel}`;

  return (
    <div className={cn("relative h-full min-h-0 flex items-center justify-center p-6", className)}>
      <div className="w-full max-w-md rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent backdrop-blur-sm p-8 text-center space-y-5">
        <div className="flex justify-center">
          <div className="rounded-full bg-primary/10 p-3">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">{resolvedTitle}</h3>
          <p className="text-sm text-muted-foreground">{resolvedDescription}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild className="cursor-pointer">
            <Link to={ctaHref}>{resolvedCtaLabel}</Link>
          </Button>
          <Button asChild variant="outline" className="cursor-pointer">
            <Link to="/billing?tab=plans">See plans</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
