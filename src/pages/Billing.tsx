import { useEffect, useMemo } from "react"
import { SignedIn, SignedOut, PricingTable } from "@clerk/clerk-react"
import {
  SubscriptionDetailsButton,
  usePaymentMethods,
  useSubscription,
} from "@clerk/clerk-react/experimental"
import { Sparkles } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { getNanoSubscriptionItem, isNanoPlan } from "@/lib/subscription"

function formatDate(date: Date | null | undefined) {
  if (!date) return "—"
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(date)
  } catch {
    return date.toLocaleDateString()
  }
}

function getStatusVariant(
  status: string | null | undefined
): React.ComponentProps<typeof Badge>["variant"] {
  switch (status) {
    case "active":
      return "success"
    case "past_due":
      return "warning"
    case "canceled":
    case "unpaid":
      return "error"
    default:
      return "secondary"
  }
}

export default function Billing() {
  const { data: subscription, isLoading, isFetching, error, revalidate } =
    useSubscription()
  const { data: paymentMethods, isLoading: isPaymentMethodsLoading } =
    usePaymentMethods({ for: "user" })

  const nanoItem = useMemo(() => getNanoSubscriptionItem(subscription ?? null), [subscription])
  const nano = useMemo(() => isNanoPlan(subscription ?? null), [subscription])

  // Fallback for browsers without :has() support. Keeps app chrome below Clerk overlays.
  useEffect(() => {
    const body = document.body
    const checkOverlay = () => {
      const open = Boolean(
        document.querySelector(
          ".cl-portal, .cl-checkout, .cl-modal, .cl-modalBackdrop, .cl-modalOverlay, [class*='cl-portal'], [class*='cl-modal'], [class*='cl-overlay'], [class*='cl-drawer']"
        )
      )
      if (open) body.classList.add("cl-overlay-open")
      else body.classList.remove("cl-overlay-open")
    }

    checkOverlay()
    const observer = new MutationObserver(checkOverlay)
    observer.observe(body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      body.classList.remove("cl-overlay-open")
    }
  }, [])

  const nextPayment = subscription?.nextPayment
  const paymentMethodSummary = useMemo(() => {
    if (isPaymentMethodsLoading) return "Loading…"
    if (!paymentMethods || paymentMethods.length === 0) return "None on file"
    const cards = paymentMethods
      .map((m) => `${m.cardType} •••• ${m.last4}`)
      .slice(0, 2)
      .join(", ")
    return paymentMethods.length > 2 ? `${cards} +${paymentMethods.length - 2}` : cards
  }, [isPaymentMethodsLoading, paymentMethods])

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Billing</h1>
        <p className="text-muted-foreground">
          Manage your subscription, payment methods, and invoices via Clerk.
        </p>
      </div>

      <SignedOut>
        <Card>
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>
              Please sign in to manage billing settings.
            </CardDescription>
          </CardHeader>
        </Card>
      </SignedOut>

      <SignedIn>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Card className="border-sky-300/30 bg-sky-500/10 shadow-2xl backdrop-blur-xl">
            <CardHeader className="gap-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-xl">Current plan</CardTitle>
                  {nano && (
                    <Badge variant="secondary" className="gap-1">
                      <Sparkles className="h-3.5 w-3.5" />
                      Nano
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {nanoItem?.plan?.name && (
                    <Badge variant="outline" className="hidden sm:inline-flex">
                      {nanoItem.plan.name}
                    </Badge>
                  )}
                  <Badge
                    variant={getStatusVariant(subscription?.status ?? null)}
                    className="capitalize"
                  >
                    {isLoading ? "Loading" : subscription?.status || "Free"}
                  </Badge>
                </div>
              </div>
              <CardDescription>
                {error
                  ? `Failed to load subscription: ${error.message}`
                  : isLoading
                    ? "Fetching your subscription details…"
                    : subscription
                      ? "Your subscription is managed by Clerk."
                      : "No active subscription found."}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="space-y-1">
                  <p className="text-muted-foreground">Plan</p>
                  <p className="font-medium">
                    {nanoItem?.plan?.name ?? (isLoading ? "Loading…" : subscription ? "—" : "Free")}
                    {nanoItem?.planPeriod ? ` (${nanoItem.planPeriod})` : ""}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Email budget</p>
                  <p className="font-medium">{nano ? "100 emails/hour" : "10 emails/hour"}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Active since</p>
                  <p className="font-medium">{formatDate(subscription?.activeAt)}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Next payment</p>
                  <p className="font-medium">
                    {nextPayment
                      ? `${nextPayment.amount.amountFormatted} on ${formatDate(
                          nextPayment.date
                        )}`
                      : "—"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Payment method</p>
                  <p className="font-medium">{paymentMethodSummary}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground">Refresh</p>
                  <p className="font-medium">{isFetching ? "Refreshing…" : "Up to date"}</p>
                </div>
              </div>

              <Separator />

              <div className="flex flex-wrap items-center gap-2">
                <SubscriptionDetailsButton>
                  <Button variant="default">Manage subscription</Button>
                </SubscriptionDetailsButton>
                <Button
                  variant="outline"
                  onClick={() => void revalidate()}
                  disabled={isLoading}
                >
                  Refresh
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Manage invoices, payment methods, and cancellation from the subscription
                drawer.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-xl">Payment methods</CardTitle>
              <CardDescription>
                Saved cards on your account (via Clerk).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {isPaymentMethodsLoading ? (
                <p className="text-sm text-muted-foreground">Loading payment methods…</p>
              ) : !paymentMethods || paymentMethods.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payment methods found.</p>
              ) : (
                <div className="space-y-2">
                  {paymentMethods.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded-md border bg-card/50 px-3 py-2"
                    >
                      <div className="flex flex-col">
                        <p className="text-sm font-medium capitalize">
                          {m.cardType} •••• {m.last4}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Expires{" "}
                          {String(((m as any).expiryMonth ?? (m as any).expirationMonth) ?? "")
                            .padStart(2, "0")}
                          /{(m as any).expiryYear ?? (m as any).expirationYear ?? ""}
                        </p>
                      </div>
                      {m.isDefault && <Badge variant="secondary">Default</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <SubscriptionDetailsButton>
                <Button variant="outline">Manage payment methods</Button>
              </SubscriptionDetailsButton>
            </CardFooter>
          </Card>
        </div>

        <Card className="border-sky-300/30 bg-sky-500/10 shadow-2xl backdrop-blur-xl">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-xl">Plans</CardTitle>
              {nano && (
                <Badge variant="secondary" className="gap-1">
                  <Sparkles className="h-3.5 w-3.5" />
                  Nano
                </Badge>
              )}
            </div>
            <CardDescription>
              Upgrade, downgrade, or start a subscription.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 sm:p-8">
            <PricingTable />
          </CardContent>
        </Card>
      </SignedIn>
    </div>
  )
}

