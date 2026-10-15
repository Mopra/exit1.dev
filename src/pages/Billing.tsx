import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react"
import { useSearchParams } from "react-router-dom"
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
  ExternalLink,
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
import { PageContainer, PageHeader } from "@/components/layout"
import { TierBadge } from "@/components/ui/TierBadge"
import { OrganizationBillingForm } from "@/components/billing/OrganizationBillingForm"
import { BillingPeriodToggle, PlanCard } from "@/components/billing/plan-matrix"
import {
  PLAN_MATRIX,
  TIER_BUTTON_OUTLINE,
  TIER_BUTTON_PRIMARY,
  TIER_RANK,
  findClerkPlan,
  planHasTrial,
  trialNote,
  TRIAL_CTA_LABEL,
  type BillingPeriod,
  type ClerkPlan,
  type PlanFeatureRow,
  type PlanMatrixEntry,
} from "@/components/billing/plan-matrix-data"
import { usePlan, type Tier } from "@/hooks/usePlan"
import { useOpenPaymentSettings } from "@/hooks/usePaymentSettings"
import { getActivePaidSubscriptionItem } from "@/lib/subscription"
import {
  formatEmailBudget,
  formatRetentionForTier,
  getMaxChecksForTier,
  getMinCheckIntervalSecondsForTier,
} from "@/lib/subscription"
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

// Tabs that exist for each audience. Used to validate `?tab=` before trusting
// it, so a stale link can never select a tab that isn't rendered.
const PAID_TABS = ["overview", "plans", "payment-methods", "history", "organization"]
// Free accounts that paid us before (or still have a card saved) keep the
// card, invoice and receipt tabs. Hiding them left churned customers with no
// way to fetch an old invoice or remove their card.
const FORMER_PAID_TABS = ["plans", "payment-methods", "history", "organization"]
const FREE_TABS = ["plans"]

/** `?plan=` values a deep link may preselect. */
const SELECTABLE_PLAN_KEYS: string[] = PLAN_MATRIX.filter((p) => p.priceMonthly > 0).map(
  (p) => p.key,
)

/**
 * A plan change that needs the user to confirm something Clerk's checkout
 * cannot tell them before we hand it over.
 *
 * - `cancel`: dropping to Free. Ends in Clerk's subscription drawer, which is
 *   the only surface that can cancel.
 * - `downgrade`: moving to a cheaper paid plan. Clerk explains the billing
 *   side; only we can explain that monitors get disabled and intervals widen.
 * - `founders`: any switch away from the grandfathered Founders price, which
 *   is one-way and cannot be restored by re-subscribing.
 *
 * Upgrades are deliberately absent: they go straight to checkout with no
 * interstitial, because nothing is lost and friction there costs conversions.
 */
type PlanAction =
  | { kind: "cancel" }
  | {
      kind: "downgrade" | "founders"
      entry: PlanMatrixEntry
      planId: string
      period: BillingPeriod
    }

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
  const {
    subscription, tier, realTier, isFounders, isLoading, isFetching, error, revalidate,
    onReverseTrial, reverseTrial,
  } = usePlan()
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
  const openPaymentSettings = useOpenPaymentSettings()

  const paymentAttemptItems = paymentAttempts ?? []
  const hasBillingHistory =
    (paymentMethods?.length ?? 0) > 0 || paymentAttemptItems.length > 0

  const showPaidTabs = realNano
  const showAccountTabs = realNano || hasBillingHistory
  const defaultTab = showPaidTabs ? "overview" : "plans"

  // Tab selection lives in the URL so every upgrade CTA in the app can deep
  // link straight to the plan grid (`/billing?tab=plans`). Without this a paid
  // user following an "Upgrade to Pro" prompt landed on Overview, which has no
  // plan picker, and had to discover the Plans tab on their own.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get("tab")
  const availableTabs = showPaidTabs
    ? PAID_TABS
    : showAccountTabs
      ? FORMER_PAID_TABS
      : FREE_TABS
  const activeTab =
    requestedTab && availableTabs.includes(requestedTab) ? requestedTab : defaultTab

  const handleTabChange = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set("tab", next)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Founders users keep their $4/mo or $36/yr price. `nanoItem.planPeriod` is
  // `"month" | "annual"` when resolved from Clerk.
  const foundersPeriod: BillingPeriod =
    nanoItem?.planPeriod === "annual" ? "annual" : "month"

  // The cadence the user is actually paying on, or null when they are on Free.
  // Drives the "Switch to annual" CTA on their own plan card: without it a
  // Nano-monthly subscriber who toggles to Annual sees their card greyed out
  // as "Current plan" and has no way to take the discount.
  const subscribedPeriod: BillingPeriod | null = !realNano
    ? null
    : nanoItem?.planPeriod === "annual"
      ? "annual"
      : "month"

  // Default the plan-grid toggle to the user's current billing cadence so the
  // displayed price matches what they're already paying. Fall back to annual
  // for free users since annual is the recommended/discounted option.
  // A `?period=` from the pricing page wins, so the price the visitor clicked
  // on is the price they see here.
  const requestedPeriod = searchParams.get("period")
  const currentPeriod: BillingPeriod =
    requestedPeriod === "monthly" || requestedPeriod === "month"
      ? "month"
      : requestedPeriod === "annual"
        ? "annual"
        : nanoItem?.planPeriod === "month"
          ? "month"
          : "annual"
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(currentPeriod)

  // `?plan=nano` marks the card the user came here for (from an upgrade prompt
  // or the pricing page) and scrolls it into view, so on a phone they don't
  // land on Free and have to hunt for it.
  const requestedPlan = searchParams.get("plan")
  const selectedPlanKey =
    requestedPlan && SELECTABLE_PLAN_KEYS.includes(requestedPlan) ? requestedPlan : null
  useEffect(() => {
    if (activeTab !== "plans" || !selectedPlanKey) return
    const timer = window.setTimeout(() => {
      document
        .getElementById(`plan-${selectedPlanKey}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [activeTab, selectedPlanKey])

  // Clerk plan catalogue — used to resolve plan IDs for CheckoutButton.
  const { data: clerkPlans } = usePlans()

  // Confirmation gate for the plan changes that lose something. See PlanAction.
  const [planAction, setPlanAction] = useState<PlanAction | null>(null)

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

  // Clerk grants a free trial only to accounts that have never paid, so a
  // churned user coming back to Free must not be shown trial wording. Any
  // settled payment on the account rules the trial out. `usePaymentAttempts`
  // above pages at 6, which is enough: a returning subscriber's recent history
  // carries their old charges. While it is still loading we assume they have
  // paid, so the CTA never over-promises on first paint.
  const hasEverPaid =
    isPaymentAttemptsLoading || paymentAttemptItems.some((p) => Boolean(p.paidAt))

  return (
    <PageContainer>
      <PageHeader
        title="Billing"
        description="Manage your subscription, payment methods, and billing history"
        icon={CreditCard}
        actions={
          <div className="flex items-center gap-2">
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
            <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
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
                {showAccountTabs && (
                  <TabsTrigger value="payment-methods" className={TAB_TRIGGER_CLASS}>
                    <CreditCard className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Payment</span>
                  </TabsTrigger>
                )}
                {showAccountTabs && (
                  <TabsTrigger value="history" className={TAB_TRIGGER_CLASS}>
                    <Receipt className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[10px] sm:text-sm leading-tight">Invoices</span>
                  </TabsTrigger>
                )}
                {showAccountTabs && (
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
                      {subscription?.status === "past_due" && (
                        <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
                          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                          <div className="flex-1 space-y-1">
                            <p className="font-medium">Your last payment failed</p>
                            <p className="text-muted-foreground">
                              Your plan is still active while the charge is retried.
                              Add a working card to keep it.
                            </p>
                          </div>
                          <Button
                            variant="destructive"
                            className="cursor-pointer shrink-0"
                            onClick={openPaymentSettings}
                          >
                            Update card
                          </Button>
                        </div>
                      )}

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

                      {/* "Change plan" is first and primary: upgrading is the
                          action most people arrive here wanting, and before
                          this existed the Overview tab offered no route to the
                          plan grid at all. Cancelling is demoted to ghost. */}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="default"
                          className="cursor-pointer"
                          onClick={() => handleTabChange("plans")}
                        >
                          Upgrade or change plan
                        </Button>
                        <Button
                          variant="outline"
                          className="cursor-pointer gap-2"
                          onClick={openPaymentSettings}
                        >
                          <CreditCard className="h-4 w-4" />
                          Update card
                        </Button>
                        <Button
                          variant="outline"
                          className="cursor-pointer gap-2"
                          onClick={() => handleTabChange("history")}
                        >
                          <Receipt className="h-4 w-4" />
                          Invoices
                        </Button>
                        {realNano && (
                          <Button
                            variant="ghost"
                            className="cursor-pointer text-muted-foreground hover:text-foreground"
                            onClick={() => setPlanAction({ kind: "cancel" })}
                          >
                            Cancel subscription
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
              {showAccountTabs && (
                <TabsContent value="payment-methods" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-4 sm:p-6 lg:p-8">
                      <CardTitle className="text-xl">Payment Methods</CardTitle>
                      <CardDescription>
                        The card we charge for your plan. Add a new card, make it the
                        default, or remove an old one.
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
                            You add a card when you pick a plan, or you can add one now.
                          </p>
                          <Button
                            variant="default"
                            className="cursor-pointer"
                            onClick={openPaymentSettings}
                          >
                            Add a card
                          </Button>
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
                        <Button
                          variant="default"
                          className="cursor-pointer gap-2"
                          onClick={openPaymentSettings}
                        >
                          <CreditCard className="h-4 w-4" />
                          Add or change card
                        </Button>
                      </CardFooter>
                    )}
                  </Card>
                </TabsContent>
              )}

              {/* ---- Billing history tab ---- */}
              {showAccountTabs && (
                <TabsContent value="history" className="space-y-6 mt-0">
                  <Card className="bg-card border-0 shadow-lg">
                    <CardHeader className="p-4 sm:p-6 lg:p-8">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle className="text-xl">Invoices & receipts</CardTitle>
                          <CardDescription className="mt-1.5">
                            Every charge, with a PDF receipt. Add your company name,
                            address and VAT number on the Org tab and they show on
                            the receipt.
                          </CardDescription>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="cursor-pointer gap-2"
                          onClick={openPaymentSettings}
                        >
                          <ExternalLink className="h-4 w-4" />
                          Monthly statements
                        </Button>
                      </div>
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
              {showAccountTabs && (
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
                          Choose the plan that's right for you. Pay by card in a secure checkout. Cancel any time.
                        </CardDescription>
                      </div>
                      <TierBadge
                        tier={realTier}
                        isFounders={isFounders}
                        label={
                          isFounders
                            ? "Current: Founders"
                            : realTier === "pro"
                              ? "Current: Pro"
                              : realTier === "nano"
                                ? "Current: Nano"
                                : realTier === "indie"
                                  ? "Current: Indie"
                                  : "Current: Free"
                        }
                        className="self-start sm:self-auto"
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-2 sm:px-6 lg:px-8 space-y-6">
                    {onReverseTrial && (
                      <p className="rounded-lg border border-tier-nano/30 bg-tier-nano/5 px-3 py-2 text-sm">
                        <span className="font-medium">
                          You are on a free Nano trial: {reverseTrial.daysLeft} day{reverseTrial.daysLeft === 1 ? "" : "s"} left.
                        </span>{" "}
                        <span className="text-muted-foreground">
                          Pick Nano below to keep it. Otherwise your account moves to Free when the trial ends; nothing is deleted.
                        </span>
                      </p>
                    )}
                    <BillingPeriodToggle value={billingPeriod} onChange={setBillingPeriod} />

                    <PlanMatrix
                      realTier={realTier}
                      isFounders={isFounders}
                      foundersPeriod={foundersPeriod}
                      billingPeriod={billingPeriod}
                      subscribedPeriod={subscribedPeriod}
                      clerkPlans={clerkPlans}
                      hasEverPaid={hasEverPaid}
                      selectedPlanKey={selectedPlanKey}
                      onRequestAction={setPlanAction}
                    />

                    <BillingHelp
                      isPaid={realNano}
                      onOpenPaymentSettings={openPaymentSettings}
                      onShowInvoices={showAccountTabs ? () => handleTabChange("history") : null}
                      onCancel={realNano ? () => setPlanAction({ kind: "cancel" }) : null}
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

            <PlanActionDialog
              action={planAction}
              isFounders={isFounders}
              onOpenChange={(open) => {
                if (!open) setPlanAction(null)
              }}
            />
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  )
}

// ---- Plan change confirmation ----

/** "15 seconds" / "1 minute" / "5 minutes" for a tier's interval floor. */
function formatIntervalForTier(tier: Tier): string {
  const seconds = getMinCheckIntervalSecondsForTier(tier)
  if (seconds < 60) return `${seconds}-second`
  const minutes = Math.round(seconds / 60)
  return `${minutes}-minute`
}

/**
 * Confirms the plan changes that cost the user something. Upgrades never reach
 * this: they go straight to Clerk checkout, which already shows the prorated
 * credit and the amount due.
 */
function PlanActionDialog({
  action,
  isFounders,
  onOpenChange,
}: {
  action: PlanAction | null
  isFounders: boolean
  onOpenChange: (open: boolean) => void
}) {
  const title =
    action?.kind === "cancel"
      ? isFounders
        ? "Cancel Founders subscription?"
        : "Cancel your subscription?"
      : action?.kind === "founders"
        ? `Give up Founders pricing for ${action.entry.name}?`
        : action
          ? `Downgrade to ${action.entry.name}?`
          : ""

  return (
    <AlertDialog open={action !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {action?.kind === "cancel" && isFounders && (
              <>
                Canceling your Founders plan forfeits your grandfathered $4/mo
                pricing and Pro features. If you resubscribe, new pricing
                applies: Indie at $4/mo, Nano at $9/mo, or Pro at $24/mo. You'll
                keep access until the end of the billing period, then drop to
                Free ({getMaxChecksForTier("free")} monitors,{" "}
                {formatIntervalForTier("free")} intervals,{" "}
                {formatRetentionForTier("free")} retention).
              </>
            )}
            {action?.kind === "cancel" && !isFounders && (
              <>
                You'll keep your current plan until the end of the billing
                period, then drop to Free: {getMaxChecksForTier("free")}{" "}
                monitors, {formatIntervalForTier("free")} intervals, and{" "}
                {formatRetentionForTier("free")} of history. Monitors beyond the
                Free cap are disabled, never deleted, and extra webhooks, API
                keys and status pages are switched off. Everything comes back if
                you resubscribe.
              </>
            )}
            {action?.kind === "founders" && (
              <>
                Switching to {action.entry.name} ends your grandfathered $4/mo
                Founders pricing permanently. It cannot be restored, even if you
                switch back. {action.entry.name} costs $
                {action.period === "annual"
                  ? `${action.entry.priceAnnual}/year`
                  : `${action.entry.priceMonthly}/month`}
                .
              </>
            )}
            {action?.kind === "downgrade" && (
              <>
                You'll keep your current plan until the end of the billing
                period, then move to {action.entry.name}:{" "}
                {getMaxChecksForTier(action.entry.tier)} monitors,{" "}
                {formatIntervalForTier(action.entry.tier)} intervals, and{" "}
                {formatRetentionForTier(action.entry.tier)} of history. Monitors
                beyond the new cap are disabled, never deleted, and extra
                webhooks, API keys and status pages are switched off. Everything
                comes back if you move up again.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep my plan</AlertDialogCancel>
          {action?.kind === "cancel" ? (
            // Cancelling is the one thing checkout cannot do, so this is the
            // only remaining hand-off to Clerk's subscription drawer.
            <SubscriptionDetailsButton>
              <Button
                variant="default"
                className="cursor-pointer"
                onClick={() => onOpenChange(false)}
              >
                Continue to cancel
              </Button>
            </SubscriptionDetailsButton>
          ) : action ? (
            <CheckoutButton planId={action.planId} planPeriod={action.period}>
              <Button
                variant="default"
                className="cursor-pointer"
                onClick={() => onOpenChange(false)}
              >
                Continue to {action.entry.name}
              </Button>
            </CheckoutButton>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---- Plan matrix card grid ----

interface PlanMatrixProps {
  realTier: Tier
  isFounders: boolean
  foundersPeriod: BillingPeriod
  billingPeriod: BillingPeriod
  /** The cadence the user pays on today, or null on Free. */
  subscribedPeriod: BillingPeriod | null
  clerkPlans: ClerkPlan[] | null | undefined
  /** Whether the account has any settled payment (blocks trial wording). */
  hasEverPaid: boolean
  /** Plan key from `?plan=`, marked and scrolled to. */
  selectedPlanKey: string | null
  onRequestAction: (action: PlanAction) => void
}

function PlanMatrix({
  realTier,
  isFounders,
  foundersPeriod,
  billingPeriod,
  subscribedPeriod,
  clerkPlans,
  hasEverPaid,
  selectedPlanKey,
  onRequestAction,
}: PlanMatrixProps) {
  const plansLoaded = Array.isArray(clerkPlans) && clerkPlans.length > 0

  // Founders users see the Founders card in place of the Pro card — they
  // already have Pro entitlements at a grandfathered price, so showing Pro
  // would just be a more expensive version of what they have.
  const cards: React.ReactNode[] = []

  const makeCard = (entry: PlanMatrixEntry, highlighted = false) => {
    // The badge and ring mark the tier the user is on, regardless of which
    // cadence the toggle is showing — it is still their plan. Whether the CTA
    // is inert is a separate question, answered in PlanCTA.
    const isCurrent = !isFounders && realTier === entry.tier
    const clerkPlan = findClerkPlan(clerkPlans, entry.clerkSlugs)
    // Only a free user starting their first paid subscription gets the trial.
    // See the note on TRIAL_DAYS in plan-matrix-data.ts.
    const isTrialCta = isTrialEligible(realTier, isFounders, hasEverPaid, entry)
    // The plan the user came here to buy takes the badge from "Most popular".
    const isSelected = selectedPlanKey === entry.key && !isCurrent
    return (
      <PlanCard
        key={entry.key}
        id={`plan-${entry.key}`}
        entry={entry}
        billingPeriod={billingPeriod}
        highlighted={selectedPlanKey && !isCurrent ? isSelected : highlighted}
        highlightLabel={isSelected ? "Your pick" : undefined}
        isCurrent={isCurrent}
        ctaNote={isTrialCta ? trialNote(entry, billingPeriod) : null}
        cta={
          <PlanCTA
            entry={entry}
            realTier={realTier}
            isFounders={isFounders}
            isCurrent={isCurrent}
            clerkPlan={clerkPlan}
            plansLoaded={plansLoaded}
            billingPeriod={billingPeriod}
            subscribedPeriod={subscribedPeriod}
            hasEverPaid={hasEverPaid}
            onRequestAction={onRequestAction}
          />
        }
      />
    )
  }

  // PLAN_MATRIX order: [0] Free, [1] Indie, [2] Nano, [3] Pro.
  cards.push(makeCard(PLAN_MATRIX[0]))
  cards.push(makeCard(PLAN_MATRIX[1]))
  cards.push(makeCard(PLAN_MATRIX[2]))

  if (isFounders) {
    cards.push(<FoundersCard key="founders" period={foundersPeriod} />)
  } else {
    cards.push(makeCard(PLAN_MATRIX[3], true))
  }

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
  plansLoaded,
  billingPeriod,
  subscribedPeriod,
  hasEverPaid,
  onRequestAction,
}: {
  entry: PlanMatrixEntry
  realTier: Tier
  isFounders: boolean
  isCurrent: boolean
  clerkPlan: ClerkPlan | null
  /** False until Clerk's plan catalogue has answered. */
  plansLoaded: boolean
  billingPeriod: BillingPeriod
  subscribedPeriod: BillingPeriod | null
  hasEverPaid: boolean
  onRequestAction: (action: PlanAction) => void
}) {
  const primaryClass = cn("w-full cursor-pointer", TIER_BUTTON_PRIMARY[entry.tier])
  const outlineClass = cn("w-full cursor-pointer", TIER_BUTTON_OUTLINE[entry.tier])

  // The Free row is never a checkout target: leaving a paid plan means
  // cancelling, which only Clerk's subscription drawer can do.
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
        onClick={() => onRequestAction({ kind: "cancel" })}
      >
        Cancel subscription
      </Button>
    )
  }

  // Without a resolved Clerk plan id there is nothing to check out into.
  // Normally that just means `usePlans` hasn't answered yet. If the catalogue
  // did load and still has no match, the slugs in PLAN_MATRIX have drifted from
  // the Clerk dashboard — say so instead of sitting on "Loading…" forever.
  if (!clerkPlan?.id) {
    if (!plansLoaded) {
      return (
        <Button variant="outline" className="w-full" disabled>
          Loading…
        </Button>
      )
    }
    return (
      <Button asChild variant="outline" className="w-full cursor-pointer">
        <a href={`mailto:connect@exit1.dev?subject=${encodeURIComponent(`${entry.name} plan`)}`}>
          Contact us
        </a>
      </Button>
    )
  }

  // The user's own tier. Same cadence means there is genuinely nothing to do;
  // the other cadence is a real, and previously unreachable, switch.
  if (isCurrent) {
    if (!subscribedPeriod || subscribedPeriod === billingPeriod) {
      return (
        <Button variant="outline" className="w-full cursor-not-allowed" disabled>
          Current plan
        </Button>
      )
    }
    return (
      <CheckoutButton planId={clerkPlan.id} planPeriod={billingPeriod}>
        <Button variant="default" className={primaryClass}>
          {billingPeriod === "annual" ? "Switch to annual" : "Switch to monthly"}
        </Button>
      </CheckoutButton>
    )
  }

  const isUpgrade = TIER_RANK[entry.tier] > TIER_RANK[realTier]
  const isPaidUser = realTier !== "free"

  // Founders are on a grandfathered price that cannot be recovered once they
  // leave it, so every switch away from it is confirmed first.
  if (isFounders) {
    return (
      <Button
        variant="outline"
        className={outlineClass}
        onClick={() =>
          onRequestAction({
            kind: "founders",
            entry,
            planId: clerkPlan.id,
            period: billingPeriod,
          })
        }
      >
        Switch to {entry.name}
      </Button>
    )
  }

  // Moving to a cheaper paid plan. Clerk's checkout explains the billing side
  // ("you keep your current plan until the end of the cycle"), but only we can
  // say which monitors stop running, so confirm before handing over.
  if (isPaidUser && !isUpgrade) {
    return (
      <Button
        variant="outline"
        className={outlineClass}
        onClick={() =>
          onRequestAction({
            kind: "downgrade",
            entry,
            planId: clerkPlan.id,
            period: billingPeriod,
          })
        }
      >
        Downgrade to {entry.name}
      </Button>
    )
  }

  // Everything left is revenue-positive: a free user subscribing or a paid user
  // moving up. Straight to checkout, no interstitial. Clerk prorates the
  // remainder of the current cycle and shows the credit on the way through.
  const label = isPaidUser
    ? `Upgrade to ${entry.name}`
    : isTrialEligible(realTier, isFounders, hasEverPaid, entry)
      ? TRIAL_CTA_LABEL
      : `Get ${entry.name}`

  return (
    <CheckoutButton planId={clerkPlan.id} planPeriod={billingPeriod}>
      <Button variant="default" className={primaryClass}>
        {label}
      </Button>
    </CheckoutButton>
  )
}

// Clerk grants a free trial only on a first paid subscription, so trial copy is
// limited to free (non-Founders) users looking at a paid plan who have never
// paid us before. Everyone else is switching or resuming a subscription and gets
// billed right away.
function isTrialEligible(
  realTier: Tier,
  isFounders: boolean,
  hasEverPaid: boolean,
  entry: PlanMatrixEntry,
): boolean {
  return (
    !isFounders
    && realTier === "free"
    && !hasEverPaid
    && entry.priceMonthly > 0
    // Clerk decides eligibility per user, but whether the plan has a trial at all
    // is a dashboard setting nothing here can read. TRIAL_PLAN_KEYS is the manual
    // mirror of it: drop a key there and this card stops claiming a trial rather
    // than promising one the customer will not get.
    && planHasTrial(entry.key)
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

// ---- Billing help ----

/**
 * The four questions support gets most, answered right under the plan grid,
 * each with the button that does the thing. Anyone unsure how upgrading or
 * paying works should never have to leave this page to find out.
 */
function BillingHelp({
  isPaid,
  onOpenPaymentSettings,
  onShowInvoices,
  onCancel,
}: {
  isPaid: boolean
  onOpenPaymentSettings: () => void
  /** Null when the account has no invoices to show yet. */
  onShowInvoices: (() => void) | null
  /** Null when there is no subscription to cancel. */
  onCancel: (() => void) | null
}) {
  const items: { q: string; a: string; action?: { label: string; onClick: () => void } }[] = [
    {
      q: "How do I upgrade?",
      a: isPaid
        ? "Click Upgrade on the plan you want. It switches on right away, and you only pay the difference for the rest of this billing period."
        : "Click the button on the plan you want and pay by card. Your new limits switch on right away.",
    },
    {
      q: "How do I change my card?",
      a: "Add a new card, make it the default, and remove the old one. The next charge goes to the default card.",
      action: { label: "Update card", onClick: onOpenPaymentSettings },
    },
    {
      q: "Where are my invoices?",
      a: onShowInvoices
        ? "Every charge has a PDF receipt on the Invoices tab. Add your company details on the Org tab first."
        : "After your first payment, every charge shows up here with a PDF receipt.",
      action: onShowInvoices ? { label: "Open invoices", onClick: onShowInvoices } : undefined,
    },
    {
      q: "How do I cancel?",
      a: "Cancel any time here. You keep your plan until the end of the period you paid for, then move to Free. Nothing is deleted.",
      action: onCancel ? { label: "Cancel subscription", onClick: onCancel } : undefined,
    },
  ]

  return (
    <div className="rounded-xl border bg-background/40 p-4 sm:p-6">
      <h4 className="text-sm font-semibold mb-4">Billing, in plain words</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
        {items.map((item) => (
          <div key={item.q} className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">{item.q}</p>
            <p className="text-sm text-muted-foreground flex-1">{item.a}</p>
            {item.action && (
              <Button
                variant="outline"
                size="sm"
                className="cursor-pointer w-fit mt-1"
                onClick={item.action.onClick}
              >
                {item.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
