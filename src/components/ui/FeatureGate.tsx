import React from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./Button";

type Tier = "free" | "nano" | "pro" | "agency";
type RequiredTier = "nano" | "pro" | "agency";

const TIER_RANK: Record<Tier, number> = {
  free: 0,
  nano: 1,
  pro: 2,
  agency: 3,
};

const TIER_LABEL: Record<RequiredTier, string> = {
  nano: "Nano",
  pro: "Pro",
  agency: "Agency",
};

type FeatureGateProps = {
  /**
   * Legacy API: when true, gate content (show upgrade card). When false, render children.
   * Prefer `requiredTier` + `currentTier` for new code.
   */
  enabled?: boolean;
  /**
   * New API: minimum tier required to access the gated content. When provided
   * alongside `currentTier`, the gate shows unless `currentTier` meets or
   * exceeds `requiredTier`. Defaults to 'nano' for copy/label purposes.
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

  // Decide gating. If the caller provided `currentTier`, use tier comparison.
  // Otherwise fall back to the legacy `enabled` boolean (true = show gate).
  let gated: boolean;
  if (currentTier !== undefined) {
    gated = TIER_RANK[currentTier] < TIER_RANK[effectiveRequired];
  } else {
    gated = enabled === true;
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
            <Link to="/billing">See plans</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
