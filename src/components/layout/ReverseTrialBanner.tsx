import { Link, useLocation } from "react-router-dom"
import { Sparkles } from "lucide-react"

import { Button } from "@/components/ui/Button"
import { usePlan } from "@/hooks/usePlan"

/**
 * Slim app-wide line while a new account runs on the no-card Nano trial.
 * The button goes to the Nano card on Billing, annual selected, where the
 * normal Clerk checkout keeps the plan. Hidden on /billing itself.
 */
export function ReverseTrialBanner() {
  const { onReverseTrial, reverseTrial } = usePlan()
  const { pathname } = useLocation()

  if (!onReverseTrial || pathname === "/billing") return null

  const days = reverseTrial.daysLeft
  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-tier-nano/30 bg-tier-nano/5 px-3 py-1.5 text-sm">
      <Sparkles className="h-4 w-4 text-tier-nano shrink-0" />
      <p className="flex-1 min-w-0 truncate">
        <span className="font-medium">Nano trial: {days} day{days === 1 ? "" : "s"} left</span>
        <span className="hidden sm:inline text-muted-foreground"> · then your account moves to Free</span>
      </p>
      <Button asChild size="sm" variant="outline" className="h-7 shrink-0 cursor-pointer">
        <Link to="/billing?tab=plans&plan=nano&period=annual">Keep Nano</Link>
      </Button>
    </div>
  )
}
