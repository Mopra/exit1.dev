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
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PageContainer, PageHeader, DocsLink } from "@/components/layout"
import { TierBadge } from "@/components/ui/TierBadge"
import { ComingSoonBadge } from "@/components/ui/ComingSoonBadge"
import { OrganizationBillingForm } from "@/components/billing/OrganizationBillingForm"
import { usePlan, type Tier } from "@/hooks/usePlan"
import { getActivePaidSubscriptionItem } from "@/lib/subscription"
import { formatEmailBudget } from "@/lib/subscription"
import { downloadPaymentReceipt, buildOrganizationAddressLines } from "@/lib/pdf-receipt"
import type { BillingRecipient } from "@/lib/pdf-receipt"
import { parseOrganizationBillingProfile } from "@/lib/billing-profile"
import { TAB_TRIGGER_CLASS } from "@/lib/tab-styles"
import { getTierVisual } from "@/lib/tier-visual"
import { cn } from "@/lib/utils"

// ---- Plan matrix ----
//
// Mirrors `TIER_LIMITS` in functions/src/config.ts (§3 of the tier-restructure
// rollout plan). Keep numbers in sync with the backend — these values are
// display-only copy, but they describe what the backend actually enforces.
// Prices mirror the Clerk billing configuration.

type PlanKey = "free" | "nano" | "pro" | "agency"

type BillingPeriod = "month" | "annual"

interface PlanFeatureRow {
  label: string
  /** Rendered as a muted "Coming soon" badge next to the label. */
  comingSoon?: boolean
}

interface PlanMatrixEntry {
  key: PlanKey
  /** Tier value used for the TierBadge color. */
  tier: Tier
  name: string
  tagline: string
  /** Numeric dollars charged per month on the monthly plan. */
  priceMonthly: number
  /** Numeric dollars charged per year on the annual plan. */
  priceAnnual: number
  /** Clerk plan slug candidates (first match wins). Empty for the Free row. */
  clerkSlugs: string[]
  features: PlanFeatureRow[]
}

const PLAN_MATRIX: PlanMatrixEntry[] = [
  {
    key: "free",
    tier: "free",
    name: "Free",
    tagline: "Hobby projects & experiments",
    priceMonthly: 0,
    priceAnnual: 0,
    clerkSlugs: [],
    features: [
      { label: "10 monitors" },
      { label: "5-minute check intervals" },
      { label: "1 webhook integration" },
      { label: "10 emails / month" },
      { label: "1 public status page" },
      { label: "60-day data retention" },
    ],
  },
  {
    key: "nano",
    tier: "nano",
    name: "Nano",
    tagline: "Production monitoring for small teams",
    priceMonthly: 9,
    priceAnnual: 84,
    clerkSlugs: ["nanov2", "starter"],
    features: [
      { label: "50 monitors" },
      { label: "2-minute check intervals" },
      { label: "5 webhook integrations" },
      { label: "1,000 emails / month" },
      { label: "5 custom-branded status pages" },
      { label: "Domain intelligence & expiry alerts" },
      { label: "Maintenance mode" },
      { label: "60-day data retention" },
    ],
  },
  {
    key: "pro",
    tier: "pro",
    name: "Pro",
    tagline: "Serious uptime monitoring at scale",
    priceMonthly: 24,
    priceAnnual: 240,
    clerkSlugs: ["pro"],
    features: [
      { label: "500 monitors" },
      { label: "30-second check intervals" },
      { label: "25 webhook integrations" },
      { label: "10 API keys + MCP access" },
      { label: "SMS alerts (50 / month)" },
      { label: "10,000 emails / month" },
      { label: "25 custom-branded status pages" },
      { label: "CSV export" },
      { label: "365-day data retention" },
    ],
  },
  {
    key: "agency",
    tier: "agency",
    name: "Agency",
    tagline: "High-volume fleets & client work",
    priceMonthly: 49,
    priceAnnual: 444,
    clerkSlugs: ["agency"],
    features: [
      { label: "1,000 monitors" },
      { label: "15-second check intervals" },
      { label: "50 webhook integrations" },
      { label: "25 API keys + MCP access" },
      { label: "SMS alerts (100 / month)" },
      { label: "50,000 emails / month" },
      { label: "50 custom-branded status pages" },
      { label: "All alert channels" },
      { label: "3-year data retention" },
      { label: "Team members & roles", comingSoon: true },
      { label: "Custom status page domain", comingSoon: true },
      { label: "SLA reporting", comingSoon: true },
    ],
  },
]

const TIER_RANK: Record<Tier, number> = { free: 0, nano: 1, pro: 2, agency: 3 }

// Per-tier styling for the plan cards. The shared `tier-visual.tsx` palette is
// tuned for small badges (very subtle opacity); here we need more saturated
// values so the color reads at card scale. Colors themselves mirror the
// canonical TierBadge hues — violet/amber/emerald — for cross-app consistency.
const TIER_CARD_BORDER: Record<Tier, string> = {
  free: "border-border",
  nano: "border-violet-400/40",
  pro: "border-amber-400/50",
  agency: "border-emerald-400/40",
}

const TIER_CARD_BG: Record<Tier, string> = {
  free: "bg-background/40",
  nano: "bg-violet-400/[0.04]",
  pro: "bg-amber-400/[0.05]",
  agency: "bg-emerald-400/[0.04]",
}

const TIER_CARD_GLOW: Record<Tier, string> = {
  free: "",
  nano: "shadow-lg shadow-violet-500/10",
  pro: "shadow-lg shadow-amber-500/15",
  agency: "shadow-lg shadow-emerald-500/10",
}

const TIER_BUTTON_PRIMARY: Record<Tier, string> = {
  free: "",
  nano: "bg-violet-400 text-black hover:bg-violet-300 border-transparent",
  pro: "bg-amber-400 text-black hover:bg-amber-300 border-transparent",
  agency: "bg-emerald-400 text-black hover:bg-emerald-300 border-transparent",
}

const TIER_BUTTON_OUTLINE: Record<Tier, string> = {
  free: "",
  nano: "border-violet-400/50 text-violet-300 hover:bg-violet-400/10 hover:text-violet-200",
  pro: "border-amber-400/50 text-amber-300 hover:bg-amber-400/10 hover:text-amber-200",
  agency: "border-emerald-400/50 text-emerald-300 hover:bg-emerald-400/10 hover:text-emerald-200",
}

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
                        <div className="flex items-start gap-3 rounded-lg border border-yellow-300/40 bg-yellow-400/5 p-4 text-sm">
                          <AlertTriangle className="h-4 w-4 text-yellow-300 shrink-0 mt-0.5" />
                          <div className="space-y-1">
                            <p className="font-medium text-yellow-100">
                              Founders pricing is one-way
                            </p>
                            <p className="text-yellow-100/80">
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
                  <AlertDialogAction asChild>
                    <SubscriptionDetailsButton>
                      <Button variant="default" className="cursor-pointer">
                        Continue in Clerk
                      </Button>
                    </SubscriptionDetailsButton>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  )
}

// ---- Billing period toggle ----

function BillingPeriodToggle({
  value,
  onChange,
}: {
  value: BillingPeriod
  onChange: (next: BillingPeriod) => void
}) {
  return (
    <div className="flex items-center justify-center">
      <div
        role="tablist"
        aria-label="Billing period"
        className="inline-flex items-center rounded-full border bg-background/40 backdrop-blur p-1 text-sm"
      >
        <button
          type="button"
          role="tab"
          aria-selected={value === "month"}
          onClick={() => onChange("month")}
          className={cn(
            "cursor-pointer rounded-full px-4 py-1.5 font-medium transition-colors",
            value === "month"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Monthly
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={value === "annual"}
          onClick={() => onChange("annual")}
          className={cn(
            "cursor-pointer rounded-full px-4 py-1.5 font-medium transition-colors inline-flex items-center gap-2",
            value === "annual"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Annual
          <Badge
            variant={value === "annual" ? "secondary" : "outline"}
            className="text-[10px] px-1.5 py-0 font-semibold"
          >
            Save ~20%
          </Badge>
        </button>
      </div>
    </div>
  )
}

// ---- Plan matrix card grid ----

type ClerkPlan = { id: string; slug?: string | null }

interface PlanMatrixProps {
  realTier: Tier
  isFounders: boolean
  foundersPeriod: BillingPeriod
  billingPeriod: BillingPeriod
  clerkPlans: ClerkPlan[] | null | undefined
  onRequestDowngrade: () => void
}

function findClerkPlan(
  plans: ClerkPlan[] | null | undefined,
  slugs: string[],
): ClerkPlan | null {
  if (!plans || slugs.length === 0) return null
  const lowered = slugs.map((s) => s.toLowerCase())
  return plans.find((p) => lowered.includes((p.slug ?? "").toLowerCase())) ?? null
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

  const makeCard = (entry: PlanMatrixEntry, highlighted = false) => (
    <PlanCard
      key={entry.key}
      entry={entry}
      realTier={realTier}
      isFounders={isFounders}
      billingPeriod={billingPeriod}
      clerkPlans={clerkPlans}
      highlighted={highlighted}
      onRequestDowngrade={onRequestDowngrade}
    />
  )

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

interface PlanCardProps {
  entry: PlanMatrixEntry
  realTier: Tier
  isFounders: boolean
  billingPeriod: BillingPeriod
  clerkPlans: ClerkPlan[] | null | undefined
  highlighted?: boolean
  onRequestDowngrade: () => void
}

function PlanCard({
  entry,
  realTier,
  isFounders,
  billingPeriod,
  clerkPlans,
  highlighted = false,
  onRequestDowngrade,
}: PlanCardProps) {
  const isCurrent = !isFounders && realTier === entry.tier
  const clerkPlan = findClerkPlan(clerkPlans, entry.clerkSlugs)
  const tierVisual = getTierVisual(entry.tier)

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border backdrop-blur p-5 transition-shadow",
        TIER_CARD_BG[entry.tier],
        TIER_CARD_BORDER[entry.tier],
        highlighted && TIER_CARD_GLOW[entry.tier],
        isCurrent && "ring-2 ring-primary/50",
      )}
    >
      {highlighted && !isCurrent && (
        <Badge
          className={cn(
            "absolute -top-2.5 right-4 text-[10px] uppercase tracking-wide gap-1 border",
            TIER_BUTTON_PRIMARY[entry.tier],
          )}
        >
          <Sparkles className="h-3 w-3" />
          Most popular
        </Badge>
      )}

      <div className="flex items-center justify-between mb-1">
        <h4 className={cn("text-lg font-semibold flex items-center gap-2", tierVisual.palette?.text)}>
          {tierVisual.palette && <tierVisual.Icon className="h-4 w-4" />}
          {entry.name}
        </h4>
        {isCurrent && (
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
            Current
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4 min-h-[2rem]">{entry.tagline}</p>

      <PlanPrice entry={entry} period={billingPeriod} />

      <div className="mt-4 mb-4">
        <PlanCTA
          entry={entry}
          realTier={realTier}
          isFounders={isFounders}
          isCurrent={isCurrent}
          clerkPlan={clerkPlan}
          billingPeriod={billingPeriod}
          onRequestDowngrade={onRequestDowngrade}
        />
      </div>

      <ul className="space-y-2 flex-1">
        {entry.features.map((f) => (
          <li key={f.label} className="flex items-start gap-2 text-sm">
            <CheckCircle2
              className={cn(
                "h-4 w-4 mt-0.5 shrink-0",
                f.comingSoon ? "text-muted-foreground/50" : "text-primary",
              )}
            />
            <span className="flex-1 flex flex-wrap items-center gap-1.5">
              <span className={cn(f.comingSoon && "text-muted-foreground")}>
                {f.label}
              </span>
              {f.comingSoon && <ComingSoonBadge />}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PlanPrice({
  entry,
  period,
}: {
  entry: PlanMatrixEntry
  period: BillingPeriod
}) {
  if (entry.priceMonthly === 0) {
    return (
      <div>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold">$0</span>
          <span className="text-sm text-muted-foreground">/mo</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">Always free</p>
      </div>
    )
  }

  const effectiveMonthly =
    period === "annual"
      ? Math.round(entry.priceAnnual / 12)
      : entry.priceMonthly

  return (
    <div>
      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-bold">${effectiveMonthly}</span>
        <span className="text-sm text-muted-foreground">/mo</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        {period === "annual"
          ? `Billed $${entry.priceAnnual}/year`
          : "Billed monthly"}
      </p>
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
    <div className="relative flex flex-col rounded-xl border border-yellow-300/40 bg-yellow-400/[0.03] p-5 shadow-lg shadow-yellow-400/5 ring-2 ring-yellow-300/40">
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
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-yellow-300" />
            <span className="flex-1">{f.label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[11px] leading-relaxed text-yellow-100/70">
        If you cancel, new pricing applies if you re-subscribe. Your Founders
        pricing won't come back.
      </p>
    </div>
  )
}
