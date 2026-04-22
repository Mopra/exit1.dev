import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";

type ComingSoonBadgeProps = {
  /** Override the default "Coming soon" label. */
  label?: string;
  className?: string;
};

/**
 * Subtle neutral "Coming soon" badge. Used on pricing rows and in-app
 * feature surfaces for capabilities that are listed in a plan but not
 * yet shipped (team members + roles, custom status domain, SLA reporting).
 *
 * NOTE: the explainer modal + "notify me" opt-in flow described in
 * `Docs/plans/tier-restructure-plan-1-rollout.md` §7 is deferred to a
 * later phase. For now this is a purely visual badge.
 */
export function ComingSoonBadge({ label = "Coming soon", className }: ComingSoonBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 text-[10px] font-medium uppercase tracking-wide",
        "text-muted-foreground border-border/60 bg-muted/30",
        className,
      )}
    >
      <Clock className="h-3 w-3" />
      {label}
    </Badge>
  );
}
