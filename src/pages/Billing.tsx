import { useEffect } from "react"
import { SignedIn, PricingTable } from "@clerk/clerk-react"

import { Card } from "@/components/ui/card"

const Billing = () => {
  useEffect(() => {
    const body = document.body
    const checkOverlay = () => {
      const open = Boolean(
        document.querySelector(
          ".cl-portal, .cl-checkout, .cl-modal, .cl-modalBackdrop, .cl-modalOverlay, [class*='cl-portal'], [class*='cl-modal'], [class*='cl-overlay']"
        )
      )
      if (open) {
        body.classList.add("cl-overlay-open")
      } else {
        body.classList.remove("cl-overlay-open")
      }
    }

    checkOverlay()
    const observer = new MutationObserver(checkOverlay)
    observer.observe(body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      body.classList.remove("cl-overlay-open")
    }
  }, [])

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Billing</h1>
        <p className="text-muted-foreground">
          Manage your subscription. The nano plan is paid; more perks coming
          soon.
        </p>
      </div>

      <SignedIn>
        <Card className="border-sky-300/30 bg-sky-500/10 shadow-2xl backdrop-blur-xl">
          <div className="p-4 sm:p-8">
            <PricingTable />
          </div>
        </Card>
      </SignedIn>
    </div>
  )
}

export default Billing

