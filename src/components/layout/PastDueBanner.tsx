import { useLocation } from "react-router-dom"
import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/Button"
import { usePlan } from "@/hooks/usePlan"
import { useOpenPaymentSettings } from "@/hooks/usePaymentSettings"

/**
 * App-wide warning when the last charge failed. Without it people only found
 * out when their plan lapsed and monitors were paused. Not dismissible: it
 * goes away once a card that works has been charged.
 *
 * Hidden on /billing, where the Overview tab shows the same warning.
 */
export function PastDueBanner() {
  const { subscription } = usePlan()
  const openPaymentSettings = useOpenPaymentSettings()
  const { pathname } = useLocation()

  if (subscription?.status !== "past_due" || pathname === "/billing") return null

  return (
    <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
      <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
      <p className="flex-1">
        <span className="font-medium">Your last payment failed.</span>{" "}
        <span className="text-muted-foreground">
          Your plan is still active while the charge is retried. Update your card to keep it.
        </span>
      </p>
      <Button
        variant="destructive"
        size="sm"
        className="cursor-pointer shrink-0 w-fit"
        onClick={openPaymentSettings}
      >
        Update card
      </Button>
    </div>
  )
}
