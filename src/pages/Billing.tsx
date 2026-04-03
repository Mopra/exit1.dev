import { useMemo, type ComponentProps } from "react"
import {
  PricingTable,
  SignedIn,
  SignedOut,
  useOrganization,
  useUser,
} from "@clerk/clerk-react"
import {
  SubscriptionDetailsButton,
  usePaymentAttempts,
  usePaymentMethods,
} from "@clerk/clerk-react/experimental"
import { CreditCard, RefreshCw, Sparkles, Zap, Receipt, FileText, CheckCircle2 } from "lucide-react"

import { Badge } from "@/components/ui/Badge"
import { Button } from "@/components/ui/Button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { PageContainer, PageHeader, DocsLink } from "@/components/layout"
import { TierBadge } from "@/components/ui/TierBadge"
import { OrganizationBillingForm } from "@/components/billing/OrganizationBillingForm"
import { useNanoPlan } from "@/hooks/useNanoPlan"
import { formatEmailBudget } from "@/lib/subscription"
import { downloadPaymentReceipt, buildOrganizationAddressLines } from "@/lib/pdf-receipt"
import type { BillingRecipient } from "@/lib/pdf-receipt"
import { parseOrganizationBillingProfile } from "@/lib/billing-profile"
import { TAB_TRIGGER_CLASS } from "@/lib/tab-styles"

// ---- UI helpers ----

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
  status: string | null | undefined,
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

function getPaymentStatusVariant(
  status: string | null | undefined,
): ComponentProps<typeof Badge>["variant"] {
  switch (status) {
    case "paid":
      return "success"
    case "pending":
      return "warning"
    case "failed":
      return "error"
    default:
      return "secondary"
  }
}

function formatMoney(
  amount: { amountFormatted: string; currencySymbol?: string | null } | null | undefined,
) {
  if (!amount) return "N/A"
  const symbol = amount.currencySymbol ?? ""
  return symbol ? `${symbol}${amount.amountFormatted}` : amount.amountFormatted
}

function getCardExpiry(m: Record<string, unknown>): string {
  const month = (m.expiryMonth ?? m.expirationMonth ?? "") as string | number
  const year = (m.expiryYear ?? m.expirationYear ?? "") as string | number
  if (!month && !year) return "N/A"
  return `${String(month).padStart(2, "0")}/${year}`
}


// ---- Component ----

export default function Billing() {
  const { subscription, nano, realNano, realScale, nanoItem, isLoading, isFetching, error, revalidate } =
    useNanoPlan()
  const { data: paymentMethods, isLoading: isPaymentMethodsLoading } =
    usePaymentMethods({ for: "user" })
  const {
    data: paymentAttempts,
    isLoading: isPaymentAttemptsLoading,
    isFetching: isPaymentAttemptsFetching,
    error: paymentAttemptsError,
    fetchNext: fetchNextPaymentAttempts,
    hasNextPage: hasNextPaymentAttempts,
  } = usePaymentAttempts({ for: "user", pageSize: 6 })
  const { user } = useUser()
  const { organization } = useOrganization()

  const showPaidTabs = realNano
  const defaultTab = showPaidTabs ? "subscription" : "plans"

  // Compute billing recipient from org metadata (source of truth) for PDF receipts.
  // Use stable primitive keys to avoid re-computing on every Clerk object re-creation.
  const userEmail = user?.primaryEmailAddress?.emailAddress
  const userName = user?.fullName
  const orgId = organization?.id
  const orgName = organization?.name
  const orgMetadataKey = organization?.publicMetadata
    ? JSON.stringify(organization.publicMetadata)
    : null

  const billingRecipient = useMemo<BillingRecipient>(() => {
    const email = userEmail ?? "N/A"
    const name = userName ?? (userEmail ? userEmail : "Customer")

    if (!realNano || !orgId) return { name, email }

    const metadata = organization?.publicMetadata as Record<string, unknown> | null
    const profile = parseOrganizationBillingProfile(metadata)
    const companyName = profile?.companyName || orgName || orgId
    return {
      isOrganization: true,
      name: companyName,
      legalName: profile?.legalName,
      email: profile?.email || email,
      phone: profile?.phone,
      addressLines: buildOrganizationAddressLines(profile?.address),
      taxId: profile?.taxId,
      customFields: profile?.customFields,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realNano, userEmail, userName, orgId, orgName, orgMetadataKey])

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

  const paymentAttemptItems = paymentAttempts ?? []

  return (
    <PageContainer>
      <PageHeader
        title="Billing"
        description="Manage your subscription, payment methods, and billing history"
        icon={CreditCard}
        actions={
          <div className="flex items-center gap-2">
            <DocsLink path="/billing" label="Billing docs" />
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
          </div>
        }
      />

      <div className="flex-1 w-full">
        <div className="w-full mx-auto max-w-7xl px-2 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8">
          <SignedOut>
            <Card className="bg-card border-0 shadow-lg">
              <CardHeader className="p-4 sm:p-6 lg:p-8">
                <CardTitle className="text-xl">Sign in required</CardTitle>
                <CardDescription>
                  Please sign in to manage billing settings.
                </CardDescription>
              </CardHeader>
            </Card>
          </SignedOut>

          <SignedIn>
            <Tabs key={showPaidTabs ? "paid" : "free"} defaultValue={defaultTab} className="w-full">
              <TabsList className="w-full sm:w-fit h-auto sm:h-10 mb-6">
                {showPaidTabs && (
                  <TabsTrigger value="subscription" className={TAB_TRIGGER_CLASS}>
                    <CreditCard className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Plan</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="payment-methods" className={TAB_TRIGGER_CLASS}>
                    <CreditCard className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Payment</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="history" className={TAB_TRIGGER_CLASS}>
                    <Receipt className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">History</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="organization" className={TAB_TRIGGER_CLASS}>
                    <Sparkles className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Org</span>
                  </TabsTrigger>
                )}
                <TabsTrigger value="plans" className={TAB_TRIGGER_CLASS}>
                  <Sparkles className="w-4 h-4 flex-shrink-0" />
                  <span className="text-[10px] sm:text-sm leading-tight">Plans</span>
                </TabsTrigger>
              </TabsList>

              {/* ---- Subscription tab ---- */}
              {showPaidTabs && (
                <TabsContent value="subscription" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-4 sm:p-6 lg:p-8">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                          <CardTitle className="text-xl">Subscription</CardTitle>
                          <TierBadge nano={realNano} scale={realScale} />
                          <Badge
                            variant={getStatusVariant(subscription?.status ?? null)}
                            className="capitalize"
                          >
                            {isLoading ? "Loading" : subscription?.status || "Free"}
                          </Badge>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void revalidate()}
                          disabled={isLoading || isFetching}
                          className="cursor-pointer gap-2"
                        >
                          <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                          <span className="hidden sm:inline">Refresh</span>
                        </Button>
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

                    <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-6">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">Plan</p>
                          <p className="text-base font-semibold">
                            {nanoItem?.plan?.name ??
                              (isLoading ? "Loading…" : subscription ? "—" : "Free")}
                            {nanoItem?.planPeriod ? ` (${nanoItem.planPeriod})` : ""}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">Email budget</p>
                          <p className="text-base font-semibold">{formatEmailBudget(nano)}</p>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">Active since</p>
                          <p className="text-base font-semibold">{formatDate(subscription?.activeAt)}</p>
                        </div>
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">Next payment</p>
                          <p className="text-base font-semibold">
                            {nextPayment
                              ? `${nextPayment.amount.amountFormatted} on ${formatDate(nextPayment.date)}`
                              : "—"}
                          </p>
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                          <p className="text-sm text-muted-foreground">Payment method</p>
                          <p className="text-base font-semibold">{paymentMethodSummary}</p>
                        </div>
                      </div>

                      <Separator />

                      <div className="flex flex-wrap items-center gap-2">
                        <SubscriptionDetailsButton>
                          <Button variant="default" className="cursor-pointer">
                            Manage subscription
                          </Button>
                        </SubscriptionDetailsButton>
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
              )}

              {/* ---- Payment methods tab ---- */}
              {showPaidTabs && (
                <TabsContent value="payment-methods" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-4 sm:p-6 lg:p-8">
                      <CardTitle className="text-xl">Payment Methods</CardTitle>
                      <CardDescription>
                        Manage your saved payment methods for subscriptions and purchases.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-4">
                      {isPaymentMethodsLoading ? (
                        <p className="text-sm text-muted-foreground">Loading payment methods…</p>
                      ) : !paymentMethods || paymentMethods.length === 0 ? (
                        <div className="rounded-lg border bg-background/40 backdrop-blur p-8 text-center">
                          <CreditCard className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                          <p className="text-sm font-medium mb-2">No payment methods</p>
                          <p className="text-sm text-muted-foreground mb-4">
                            Add a payment method to subscribe to a plan.
                          </p>
                          <SubscriptionDetailsButton>
                            <Button variant="default" className="cursor-pointer">
                              Add payment method
                            </Button>
                          </SubscriptionDetailsButton>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {paymentMethods.map((m) => (
                            <div
                              key={m.id}
                              className="flex items-center justify-between rounded-lg border bg-background/40 backdrop-blur px-4 py-3 hover:bg-background/60 transition-colors"
                            >
                              <div className="flex items-center gap-4 flex-1 min-w-0">
                                <div className="flex-shrink-0">
                                  <CreditCard className="h-5 w-5 text-muted-foreground" />
                                </div>
                                <div className="flex flex-col min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium capitalize truncate">
                                      {m.cardType} •••• {m.last4}
                                    </p>
                                    {m.isDefault && (
                                      <Badge variant="secondary" className="text-xs">Default</Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    Expires {getCardExpiry(m as unknown as Record<string, unknown>)}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                    {paymentMethods && paymentMethods.length > 0 && (
                      <CardFooter className="px-4 sm:px-6 lg:px-8 pt-0 pb-4 sm:pb-6 lg:pb-8">
                        <SubscriptionDetailsButton>
                          <Button variant="outline" className="cursor-pointer">
                            Manage payment methods
                          </Button>
                        </SubscriptionDetailsButton>
                      </CardFooter>
                    )}
                  </Card>
                </TabsContent>
              )}

              {/* ---- Billing history tab ---- */}
              {showPaidTabs && (
                <TabsContent value="history" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-4 sm:p-6 lg:p-8">
                      <CardTitle className="text-xl">Billing History</CardTitle>
                      <CardDescription>
                        Review your payment history and download receipts.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8">
                      {isPaymentAttemptsLoading ? (
                        <p className="text-sm text-muted-foreground">Loading payments...</p>
                      ) : paymentAttemptsError ? (
                        <p className="text-sm text-destructive">Failed to load payments.</p>
                      ) : paymentAttemptItems.length === 0 ? (
                        <div className="rounded-lg border bg-background/40 backdrop-blur p-8 text-center">
                          <Receipt className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                          <p className="text-sm font-medium mb-2">No payments yet</p>
                          <p className="text-sm text-muted-foreground">
                            Your payment history will appear here.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {paymentAttemptItems.map((payment) => {
                            const cardType = payment.paymentMethod?.cardType ?? "Card"
                            const last4 = payment.paymentMethod?.last4
                            const paymentMethodLabel = last4
                              ? `${cardType} **** ${last4}`
                              : "No payment method"
                            const chargeLabel =
                              payment.chargeType === "recurring"
                                ? "Recurring"
                                : payment.chargeType === "checkout"
                                  ? "Checkout"
                                  : "Payment"
                            const timestampLabel = payment.paidAt
                              ? `Paid ${formatDate(payment.paidAt)}`
                              : payment.failedAt
                                ? `Failed ${formatDate(payment.failedAt)}`
                                : `Updated ${formatDate(payment.updatedAt)}`
                            return (
                              <div
                                key={payment.id}
                                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border bg-background/40 backdrop-blur px-4 py-3 hover:bg-background/60 transition-colors"
                              >
                                <div className="flex items-center gap-4 flex-1 min-w-0">
                                  <div className="flex-shrink-0 hidden sm:block">
                                    <Receipt className="h-5 w-5 text-muted-foreground" />
                                  </div>
                                  <div className="flex flex-col min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium">{chargeLabel}</p>
                                      <Badge
                                        variant={getPaymentStatusVariant(payment.status)}
                                        className="capitalize text-xs"
                                      >
                                        {payment.status}
                                      </Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground truncate">
                                      {timestampLabel} • {paymentMethodLabel}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center justify-between sm:justify-end gap-3">
                                  <p className="text-sm font-semibold">
                                    {formatMoney(payment.amount)}
                                  </p>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => downloadPaymentReceipt(payment, billingRecipient)}
                                    className="cursor-pointer"
                                  >
                                    <FileText className="h-4 w-4 sm:mr-2" />
                                    <span className="hidden sm:inline">Receipt</span>
                                  </Button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {hasNextPaymentAttempts && (
                        <div className="mt-4 text-center">
                          <Button
                            variant="ghost"
                            onClick={fetchNextPaymentAttempts}
                            className="cursor-pointer"
                            disabled={isPaymentAttemptsFetching}
                          >
                            {isPaymentAttemptsFetching ? "Loading..." : "Load more"}
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>
              )}

              {/* ---- Organization tab ---- */}
              {showPaidTabs && (
                <TabsContent value="organization" className="space-y-6 mt-0">
                  <OrganizationBillingForm />
                </TabsContent>
              )}

              {/* ---- Plans tab ---- */}
              <TabsContent value="plans" className="space-y-6 mt-0">
                <Card className="bg-card border-0 shadow-lg">
                  <CardHeader className="p-4 sm:p-6 lg:p-8">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <CardTitle className="text-xl">Plans & Pricing</CardTitle>
                        <CardDescription className="mt-2">
                          Choose the plan that's right for you. All plans include core monitoring features.
                        </CardDescription>
                      </div>
                      <TierBadge
                        nano={realNano}
                        scale={realScale}
                        label={realScale ? "Current: Scale" : "Current: Nano"}
                        className="self-start sm:self-auto"
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-2 sm:px-6 lg:px-8">
                    {!nano && (
                      <div className="mb-6 rounded-lg border border-primary/20 bg-primary/5 backdrop-blur p-3 sm:p-6">
                        <div className="flex items-start gap-4">
                          <div className="flex-shrink-0 rounded-full bg-primary/10 p-2">
                            <Sparkles className="h-5 w-5 text-primary" />
                          </div>
                          <div className="space-y-2 flex-1">
                            <h4 className="font-semibold text-base">Recommended: Nano Plan</h4>
                            <p className="text-sm text-muted-foreground">
                              Unlock advanced features with the Nano plan:
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 mt-4">
                              {[
                                ["Unlimited Monitors", "No cap on monitors. Add every site, API, and service you manage."],
                                ["1-Minute Check Intervals", "Detect issues 5x faster than the free tier. Know in 60 seconds, not 5 minutes."],
                                ["Multi-Region Checks", "Monitor from multiple locations worldwide. Avoid false positives from regional outages."],
                                ["Instant SMS Alerts", "Your site goes down at 3am. Your phone buzzes. You fix it before customers notice."],
                                ["Team Alerts", "Add team members or others to SMS and email alerts. Everyone who needs to know, gets notified."],
                                ["Higher Alert Budgets", "1000 emails and 20 SMS per month. Because outages don't wait for billing cycles."],
                                ["Unlimited Webhooks", "Connect as many integrations as you need. Slack, Discord, PagerDuty, and more."],
                                ["Your Brand, Your Look", "Professional status pages with your logo, favicon, and brand colors."],
                                ["Unlimited Status Pages", "Custom drag & drop status page builder with unlimited pages."],
                                ["Domain Intelligence", "WHOIS lookups, DNS records, and full domain analysis at your fingertips."],
                                ["Domain Expiry Alerts", "Get notified before your domains expire. Never let a domain lapse again."],
                                ["1 Year Data Retention", "365 days of logs and analytics vs 30 days on Free. See the full picture."],
                                ["API Access", "Programmatic access to your monitoring data and configuration."],
                              ].map(([title, desc]) => (
                                <div key={title} className="flex items-start gap-2.5">
                                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                                  <div>
                                    <p className="text-sm font-medium">{title}</p>
                                    <p className="text-xs text-muted-foreground">{desc}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="rounded-xl border bg-background/40 backdrop-blur p-3 sm:p-6">
                      <PricingTable />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  )
}
