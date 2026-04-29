import { useMemo, useState, type ComponentProps } from "react"
import {
  SignedIn,
  SignedOut,
  useOrganization,
  useUser,
} from "@clerk/clerk-react"
import {
  CheckoutButton,
  SubscriptionDetailsButton,
  usePaymentAttempts,
  usePaymentMethods,
  usePlans,
} from "@clerk/clerk-react/experimental"
import {
  CreditCard,
  RefreshCw,
  Sparkles,
  Receipt,
  FileText,
  CheckCircle2,
  AlertTriangle,
  LayoutDashboard,
  Building2,
} from "lucide-react"

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
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PageContainer, PageHeader, DocsLink } from "@/components/layout"
import { TierBadge } from "@/components/ui/TierBadge"
import { OrganizationBillingForm } from "@/components/billing/OrganizationBillingForm"
import { BillingPeriodToggle, PlanCard } from "@/components/billing/plan-matrix"
import {
  PLAN_MATRIX,
  TIER_BUTTON_OUTLINE,
  TIER_BUTTON_PRIMARY,
  TIER_RANK,
  findClerkPlan,
  type BillingPeriod,
  type ClerkPlan,
  type PlanFeatureRow,
  type PlanMatrixEntry,
} from "@/components/billing/plan-matrix-data"
import { usePlan, type Tier } from "@/hooks/usePlan"
import { getActivePaidSubscriptionItem } from "@/lib/subscription"
import { formatEmailBudget } from "@/lib/subscription"
import { downloadPaymentReceipt, buildOrganizationAddressLines } from "@/lib/pdf-receipt"
import type { BillingRecipient } from "@/lib/pdf-receipt"
import { parseOrganizationBillingProfile } from "@/lib/billing-profile"
import { TAB_TRIGGER_CLASS } from "@/lib/tab-styles"
import { cn } from "@/lib/utils"

// Founders card copy. Founders users are on the legacy `nano` plan key and
// keep their original $4/$36 pricing while getting Pro-tier features.
const FOUNDERS_FEATURES: PlanFeatureRow[] = PLAN_MATRIX.find(
  (p) => p.key === "pro",
)!.features

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
  const { subscription, tier, realTier, isFounders, isLoading, isFetching, error, revalidate } =
    usePlan()
  // Legacy aliases so the existing billing UI (Phase B2 will redesign this) keeps compiling.
  const nano = tier !== "free"
  const realNano = realTier !== "free"
  const nanoItem = getActivePaidSubscriptionItem(subscription ?? null)
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
  const defaultTab = showPaidTabs ? "overview" : "plans"

  // Founders users keep their $4/mo or $36/yr price. `nanoItem.planPeriod` is
  // `"month" | "annual"` when resolved from Clerk.
  const foundersPeriod: BillingPeriod =
    nanoItem?.planPeriod === "annual" ? "annual" : "month"

  // Default the plan-grid toggle to the user's current billing cadence so the
  // displayed price matches what they're already paying. Fall back to annual
  // for free users since annual is the recommended/discounted option.
  const currentPeriod: BillingPeriod =
    nanoItem?.planPeriod === "month" ? "month" : "annual"
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(currentPeriod)

  // Clerk plan catalogue — used to resolve plan IDs for CheckoutButton.
  const { data: clerkPlans } = usePlans()

  // Downgrade-from-paid warning dialog. Triggered by "Cancel subscription"
  // buttons on plan cards. We surface the actual side-effects Phase A's
  // enforcement handlers apply (interval clamp, check pruning, etc.) in plain
  // English before bouncing the user to Clerk's cancel flow.
  const [downgradeOpen, setDowngradeOpen] = useState(false)

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
                  <TabsTrigger value="overview" className={TAB_TRIGGER_CLASS}>
                    <LayoutDashboard className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Overview</span>
                  </TabsTrigger>
                )}
                <TabsTrigger value="plans" className={TAB_TRIGGER_CLASS}>
                  <Sparkles className="w-4 h-4 flex-shrink-0" />
                  <span className="text-[10px] sm:text-sm leading-tight">Plans</span>
                </TabsTrigger>
                {showPaidTabs && (
                  <TabsTrigger value="payment-methods" className={TAB_TRIGGER_CLASS}>
                    <CreditCard className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Payment</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="history" className={TAB_TRIGGER_CLASS}>
                    <Receipt className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Invoices</span>
                  </TabsTrigger>
                )}
                {showPaidTabs && (
                  <TabsTrigger value="organization" className={TAB_TRIGGER_CLASS}>
                    <Building2 className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Org</span>
                  </TabsTrigger>
                )}
              </TabsList>

              {/* ---- Overview tab ---- */}
              {showPaidTabs && (
                <TabsContent value="overview" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-4 sm:p-6 lg:p-8">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                          <CardTitle className="text-xl">Subscription</CardTitle>
                          <TierBadge tier={realTier} isFounders={isFounders} />
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
                        {realNano && (
                          <Button
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => setDowngradeOpen(true)}
                          >
                            Cancel or downgrade
                          </Button>
                        )}
                      </div>

                      {isFounders && (
                        <div className="flex items-start gap-3 rounded-lg border border-tier-pro/40 bg-tier-pro/5 p-4 text-sm">
                          <AlertTriangle className="h-4 w-4 text-tier-pro shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            <p className="font-medium text-tier-pro">
                              Founders pricing is one-way
                            </p>
                            <p className="text-tier-pro/80">
                              If you cancel, new pricing applies if you re-subscribe.
                              Your Founders pricing won't come back.
                            </p>
                          </div>
                        </div>
                      )}
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
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <CardTitle className="text-xl">Plans & Pricing</CardTitle>
                        <CardDescription className="mt-2">
                          Choose the plan that's right for you. Secure checkout handled by Clerk — cancel anytime.
                        </CardDescription>
                      </div>
                      <TierBadge
                        tier={realTier}
                        isFounders={isFounders}
                        label={
                          isFounders
                            ? "Current: Founders"
                            : realTier === "agency"
                              ? "Current: Agency"
                              : realTier === "pro"
                                ? "Current: Pro"
                                : realTier === "nano"
                                  ? "Current: Nano"
                                  : "Current: Free"
                        }
                        className="self-start sm:self-auto"
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-2 sm:px-6 lg:px-8 space-y-6">
                    <BillingPeriodToggle value={billingPeriod} onChange={setBillingPeriod} />

                    <PlanMatrix
                      realTier={realTier}
                      isFounders={isFounders}
                      foundersPeriod={foundersPeriod}
                      billingPeriod={billingPeriod}
                      clerkPlans={clerkPlans}
                      onRequestDowngrade={() => setDowngradeOpen(true)}
                    />

                    <p className="text-center text-xs text-muted-foreground">
                      Prices in USD. Taxes calculated at checkout. Questions?{" "}
                      <a
                        href="mailto:connect@exit1.dev"
                        className="underline underline-offset-4 hover:text-foreground"
                      >
                        connect@exit1.dev
                      </a>
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>

            <AlertDialog open={downgradeOpen} onOpenChange={setDowngradeOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {isFounders
                      ? "Cancel Founders subscription?"
                      : "Downgrade your subscription?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {isFounders ? (
                      <>
                        Canceling your Founders plan forfeits your grandfathered
                        $4/mo pricing and Pro features. If you resubscribe, new
                        pricing applies — Nano at $9/mo, Pro at $24/mo, or Agency
                        at $49/mo. You'll keep access until the end of the billing
                        period, then drop to Free (10 monitors, 5-minute intervals,
                        60-day retention).
                      </>
                    ) : (
                      <>
                        Canceling or downgrading may prune monitors, widen your check
                        interval, disable SMS and API access, and reduce retention to
                        match your new plan's limits. Excess webhooks and status
                        pages are disabled (not deleted). You'll keep access until
                        the end of the current billing period.
                      </>
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep my plan</AlertDialogCancel>
                  <SubscriptionDetailsButton>
                    <Button
                      variant="default"
                      className="cursor-pointer"
                      onClick={() => setDowngradeOpen(false)}
                    >
                      Continue in Clerk
                    </Button>
                  </SubscriptionDetailsButton>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  )
}

// ---- Plan matrix card grid ----

interface PlanMatrixProps {
  realTier: Tier
  isFounders: boolean
  foundersPeriod: BillingPeriod
  billingPeriod: BillingPeriod
  clerkPlans: ClerkPlan[] | null | undefined
  onRequestDowngrade: () => void
}

function PlanMatrix({
  realTier,
  isFounders,
  foundersPeriod,
  billingPeriod,
  clerkPlans,
  onRequestDowngrade,
}: PlanMatrixProps) {
  // Founders users see the Founders card in place of the Nano card. The Pro
  // card is hidden for them (they already have Pro entitlements), but we keep
  // Agency visible so they can upgrade sideways.
  const cards: React.ReactNode[] = []

  const makeCard = (entry: PlanMatrixEntry, highlighted = false) => {
    const isCurrent = !isFounders && realTier === entry.tier
    const clerkPlan = findClerkPlan(clerkPlans, entry.clerkSlugs)
    return (
      <PlanCard
        key={entry.key}
        entry={entry}
        billingPeriod={billingPeriod}
        highlighted={highlighted}
        isCurrent={isCurrent}
        cta={
          <PlanCTA
            entry={entry}
            realTier={realTier}
            isFounders={isFounders}
            isCurrent={isCurrent}
            clerkPlan={clerkPlan}
            billingPeriod={billingPeriod}
            onRequestDowngrade={onRequestDowngrade}
          />
        }
      />
    )
  }

  cards.push(makeCard(PLAN_MATRIX[0]))

  if (isFounders) {
    // Founders get Pro entitlements at a grandfathered price, so the Pro card
    // itself is hidden (showing it would just be a more expensive Pro). Nano is
    // kept visible as a genuine downgrade option; Agency as a sideways upgrade.
    cards.push(makeCard(PLAN_MATRIX[1]))
    cards.push(<FoundersCard key="founders" period={foundersPeriod} />)
  } else {
    cards.push(makeCard(PLAN_MATRIX[1]))
    cards.push(makeCard(PLAN_MATRIX[2], true))
  }

  cards.push(makeCard(PLAN_MATRIX[3]))

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {cards}
    </div>
  )
}

function PlanCTA({
  entry,
  realTier,
  isFounders,
  isCurrent,
  clerkPlan,
  billingPeriod,
  onRequestDowngrade,
}: {
  entry: PlanMatrixEntry
  realTier: Tier
  isFounders: boolean
  isCurrent: boolean
  clerkPlan: ClerkPlan | null
  billingPeriod: BillingPeriod
  onRequestDowngrade: () => void
}) {
  if (isCurrent) {
    return (
      <Button variant="outline" className="w-full cursor-not-allowed" disabled>
        Current plan
      </Button>
    )
  }

  // The Free row for paid users is a downgrade entry-point.
  if (entry.key === "free") {
    if (realTier === "free" && !isFounders) {
      return (
        <Button variant="outline" className="w-full cursor-not-allowed" disabled>
          Current plan
        </Button>
      )
    }
    return (
      <Button
        variant="outline"
        className="w-full cursor-pointer"
        onClick={onRequestDowngrade}
      >
        Cancel subscription
      </Button>
    )
  }

  // Paid plans. For paid users, plan switches go through Clerk's subscription
  // management flow (handles proration + confirmation correctly). For free
  // users signing up, use CheckoutButton for a direct checkout experience.
  const targetRank = TIER_RANK[entry.tier]
  const currentRank = TIER_RANK[realTier]
  const isUpgrade = targetRank > currentRank
  const label = isUpgrade ? `Upgrade to ${entry.name}` : `Switch to ${entry.name}`

  const isPaidUser = realTier !== "free"
  const primaryClass = cn("w-full cursor-pointer", TIER_BUTTON_PRIMARY[entry.tier])
  const outlineClass = cn("w-full cursor-pointer", TIER_BUTTON_OUTLINE[entry.tier])

  if (isPaidUser || isFounders) {
    return (
      <SubscriptionDetailsButton>
        <Button
          variant={isUpgrade ? "default" : "outline"}
          className={isUpgrade ? primaryClass : outlineClass}
        >
          {label}
        </Button>
      </SubscriptionDetailsButton>
    )
  }

  // Free user — direct checkout.
  if (clerkPlan?.id) {
    return (
      <CheckoutButton planId={clerkPlan.id} planPeriod={billingPeriod}>
        <Button variant="default" className={primaryClass}>
          Get {entry.name}
        </Button>
      </CheckoutButton>
    )
  }

  // Plan catalogue hasn't loaded yet — fall back to subscription management.
  return (
    <SubscriptionDetailsButton>
      <Button variant="default" className={primaryClass}>
        Get {entry.name}
      </Button>
    </SubscriptionDetailsButton>
  )
}

function FoundersCard({ period }: { period: BillingPeriod }) {
  const price = period === "annual" ? 36 : 4
  const priceSuffix = period === "annual" ? "/yr" : "/mo"
  return (
    <div className="relative flex flex-col rounded-xl border border-tier-pro/40 bg-tier-pro/[0.03] p-5 shadow-lg shadow-tier-pro/5 ring-2 ring-tier-pro/40">
      <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
        <h4 className="text-lg font-semibold">Founders</h4>
        <TierBadge tier="pro" isFounders />
      </div>
      <p className="text-xs text-muted-foreground mb-4 min-h-[2rem]">
        Pro-tier entitlements at your grandfathered price.
      </p>
      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-bold">${price}</span>
        <span className="text-sm text-muted-foreground">{priceSuffix}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Locked in while subscribed
      </p>

      <div className="mb-4">
        <SubscriptionDetailsButton>
          <Button variant="outline" className="w-full cursor-pointer">
            Manage subscription
          </Button>
        </SubscriptionDetailsButton>
      </div>

      <ul className="space-y-2 flex-1">
        {FOUNDERS_FEATURES.map((f) => (
          <li key={f.label} className="flex items-start gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-tier-pro" />
            <span className="flex-1">{f.label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[11px] leading-relaxed text-tier-pro/70">
        If you cancel, new pricing applies if you re-subscribe. Your Founders
        pricing won't come back.
      </p>
    </div>
  )
}
