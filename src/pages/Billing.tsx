import { useMemo, type ComponentProps } from "react"
import { SignedIn, SignedOut, PricingTable } from "@clerk/clerk-react"
import {
  SubscriptionDetailsButton,
  usePaymentMethods,
  useSubscription,
} from "@clerk/clerk-react/experimental"
import { CreditCard, RefreshCw, Sparkles } from "lucide-react"

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
import { PageContainer, PageHeader } from "@/components/layout"
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
): ComponentProps<typeof Badge>["variant"] {
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

  const nanoItem = useMemo(
    () => getNanoSubscriptionItem(subscription ?? null),
    [subscription]
  )
  const nano = useMemo(() => isNanoPlan(subscription ?? null), [subscription])

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
    <PageContainer>
      <PageHeader
        title="Billing"
        description="Manage your subscription, payment methods, and invoices"
        icon={CreditCard}
        actions={
          <SignedIn>
            <Button
              variant="outline"
              onClick={() => void revalidate()}
              disabled={isLoading}
              className="cursor-pointer gap-2"
              title="Refresh billing data"
            >
              <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </SignedIn>
        }
      />

      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto grid max-w-5xl gap-6 lg:gap-8">
          <SignedOut>
            <Card className="bg-card border-0 shadow-lg">
              <CardHeader className="p-6 lg:p-8">
                <CardTitle className="text-xl">Sign in required</CardTitle>
                <CardDescription>
                  Please sign in to manage billing settings.
                </CardDescription>
              </CardHeader>
            </Card>
          </SignedOut>

          <SignedIn>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-6 lg:p-8 gap-2">
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

                <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="space-y-1">
                      <p className="text-muted-foreground">Plan</p>
                      <p className="font-medium">
                        {nanoItem?.plan?.name ??
                          (isLoading ? "Loading…" : subscription ? "—" : "Free")}
                        {nanoItem?.planPeriod ? ` (${nanoItem.planPeriod})` : ""}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-muted-foreground">Email budget</p>
                      <p className="font-medium">
                        {nano ? "100 emails/hour" : "10 emails/hour"}
                      </p>
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
                      <p className="text-muted-foreground">Sync</p>
                      <p className="font-medium">{isFetching ? "Refreshing…" : "Up to date"}</p>
                    </div>
                  </div>

                  <Separator />

                  <div className="flex flex-wrap items-center gap-2">
                    <SubscriptionDetailsButton>
                      <Button variant="default" className="cursor-pointer">
                        Manage subscription
                      </Button>
                    </SubscriptionDetailsButton>
                    <Button
                      variant="outline"
                      onClick={() => void revalidate()}
                      disabled={isLoading}
                      className="cursor-pointer"
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

              <Card className="bg-card border-0 shadow-lg">
                <CardHeader className="p-6 lg:p-8">
                  <CardTitle className="text-xl">Payment methods</CardTitle>
                  <CardDescription>
                    Saved cards on your account (via Clerk).
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0 pb-6 lg:pb-8 px-6 lg:px-8 space-y-3">
                  {isPaymentMethodsLoading ? (
                    <p className="text-sm text-muted-foreground">
                      Loading payment methods…
                    </p>
                  ) : !paymentMethods || paymentMethods.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No payment methods found.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {paymentMethods.map((m) => (
                        <div
                          key={m.id}
                          className="flex items-center justify-between rounded-lg border bg-background/40 backdrop-blur px-3 py-2"
                        >
                          <div className="flex flex-col min-w-0">
                            <p className="text-sm font-medium capitalize truncate">
                              {m.cardType} •••• {m.last4}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Expires{" "}
                              {String(
                                ((m as any).expiryMonth ?? (m as any).expirationMonth) ?? ""
                              ).padStart(2, "0")}
                              /{(m as any).expiryYear ?? (m as any).expirationYear ?? ""}
                            </p>
                          </div>
                          {m.isDefault && <Badge variant="secondary">Default</Badge>}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
                <CardFooter className="px-6 lg:px-8 pt-0 pb-6 lg:pb-8">
                  <SubscriptionDetailsButton>
                    <Button variant="outline" className="cursor-pointer">
                      Manage payment methods
                    </Button>
                  </SubscriptionDetailsButton>
                </CardFooter>
              </Card>
            </div>

            <Card className="bg-card border-0 shadow-lg">
              <CardHeader className="p-6 lg:p-8">
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
              <CardContent className="pt-0 pb-6 lg:pb-8 px-2 sm:px-6 lg:px-8">
                <div className="rounded-xl border bg-background/40 backdrop-blur p-3 sm:p-6">
                  <PricingTable />
                </div>
              </CardContent>
            </Card>
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  )
}

