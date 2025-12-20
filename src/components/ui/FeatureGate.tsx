import React from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";

type FeatureGateProps = {
  enabled: boolean;
  title?: string;
  description?: string;
  ctaHref?: string;
  ctaLabel?: string;
  children: React.ReactNode;
  className?: string;
  blurClassName?: string;
};

export function FeatureGate({
  enabled,
  title = "Upgrade to Nano",
  description = "This view is available on the Nano plan. Upgrade to unlock it.",
  ctaHref = "/billing",
  ctaLabel = "Upgrade to Nano",
  children,
  className,
  blurClassName,
}: FeatureGateProps) {
  if (!enabled) return <>{children}</>;

  return (
    <div className={cn("relative h-full min-h-0", className)}>
      <div
        className={cn("h-full min-h-0 blur-sm select-none pointer-events-none", blurClassName)}
        aria-hidden="true"
      >
        {children}
      </div>

      <div className="absolute inset-0 grid place-items-center p-4">
        <Card className="w-full max-w-md bg-background/70 backdrop-blur border shadow-lg">
          <CardHeader className="space-y-2">
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4" />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Button asChild className="cursor-pointer">
              <Link to={ctaHref}>{ctaLabel}</Link>
            </Button>
            <Button asChild variant="outline" className="cursor-pointer">
              <Link to="/billing">See plans</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}


