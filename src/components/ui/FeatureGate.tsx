import React from "react";
import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./Button";

type FeatureGateProps = {
  enabled: boolean;
  title?: string;
  description?: string;
  ctaHref?: string;
  ctaLabel?: string;
  children: React.ReactNode;
  className?: string;
};

export function FeatureGate({
  enabled,
  title = "Upgrade to Nano",
  description = "This view is available on the Nano plan. Upgrade to unlock it.",
  ctaHref = "/billing",
  ctaLabel = "Upgrade to Nano",
  children,
  className,
}: FeatureGateProps) {
  // If enabled=false, user has access - render children normally
  if (!enabled) return <>{children}</>;

  // If enabled=true, user does NOT have access - do NOT render children at all
  // This prevents data from being sent to the client, fixing the security vulnerability
  return (
    <div className={cn("relative h-full min-h-0 flex items-center justify-center p-6", className)}>
      <div className="w-full max-w-md rounded-xl border border-sky-500/20 bg-gradient-to-br from-sky-500/10 via-primary/5 to-transparent backdrop-blur-sm p-8 text-center space-y-5">
        <div className="flex justify-center">
          <div className="rounded-full bg-sky-500/10 p-3">
            <Sparkles className="h-6 w-6 text-sky-400" />
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild className="cursor-pointer">
            <Link to={ctaHref}>{ctaLabel}</Link>
          </Button>
          <Button asChild variant="outline" className="cursor-pointer">
            <Link to="/billing">See plans</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}


