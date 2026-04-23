import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { SignedIn, SignedOut } from '@clerk/clerk-react';
import { CheckoutButton, usePlans } from '@clerk/clerk-react/experimental';
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';

import { PageContainer, PageHeader } from '@/components/layout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { TierBadge } from '@/components/ui/TierBadge';
import { usePlan } from '@/hooks/usePlan';
import { cn } from '@/lib/utils';

const OFFER_ENDS_AT = new Date('2026-05-01T00:00:00Z').getTime();

// Clerk plan IDs for the legacy `nano` plan (grandfathered Founders pricing).
// The plan is hidden in the Clerk Dashboard, so `usePlans()` may not return it.
// Set VITE_CLERK_FOUNDERS_PLAN_ID to the plan's `cplan_...` ID as a fallback.
const FOUNDERS_PLAN_ID_ENV = import.meta.env.VITE_CLERK_FOUNDERS_PLAN_ID as
  | string
  | undefined;

type BillingPeriod = 'month' | 'annual';

const FOUNDERS_FEATURES: readonly string[] = [
  '500 monitors',
  '30-second check intervals',
  '25 webhook integrations',
  '10 API keys + MCP access',
  'SMS alerts (50 / month)',
  '10,000 emails / month',
  '25 custom-branded status pages',
  'Domain intelligence & expiry alerts',
  'Maintenance mode',
  'CSV export',
  'All alert channels (Slack / Discord / Teams)',
  '365-day data retention',
];

function formatCountdown(msLeft: number): string {
  if (msLeft <= 0) return 'offer ended';
  const totalMinutes = Math.floor(msLeft / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function FoundersUpgrade() {
  const { tier, isLoading } = usePlan();
  const { data: clerkPlans } = usePlans();
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('annual');
  const [msLeft, setMsLeft] = useState(() => OFFER_ENDS_AT - Date.now());

  useEffect(() => {
    const update = () => setMsLeft(OFFER_ENDS_AT - Date.now());
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Prefer resolving the plan via slug — works if Clerk still returns hidden
  // plans from usePlans(). Fall back to the env-configured plan ID otherwise.
  const foundersPlanId = useMemo<string | null>(() => {
    if (clerkPlans) {
      const match = clerkPlans.find(
        (p) => (p.slug ?? '').toLowerCase() === 'nano',
      );
      if (match?.id) return match.id;
    }
    return FOUNDERS_PLAN_ID_ENV ?? null;
  }, [clerkPlans]);

  // Already on Pro, Agency, or (real) Founders — tier resolves 'nano' plan key
  // to 'pro', so gating on effective tier catches Founders without needing the
  // real-subscription flag (which would also block admin previews).
  if (!isLoading && (tier === 'pro' || tier === 'agency')) {
    return <Navigate to="/billing" replace />;
  }

  const price = billingPeriod === 'annual' ? 36 : 4;
  const priceSuffix = billingPeriod === 'annual' ? '/yr' : '/mo';
  const effectiveMonthly =
    billingPeriod === 'annual' ? Math.round(36 / 12) : 4;

  const offerExpired = msLeft <= 0;

  return (
    <PageContainer>
      <PageHeader
        title="Founders upgrade"
        description="Limited-time grandfathered pricing — Pro features at the legacy Nano rate."
        icon={Sparkles}
      />

      <div className="flex-1 w-full">
        <div className="w-full mx-auto max-w-4xl px-2 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 space-y-6">
          <SignedOut>
            <Card className="bg-card border-0 shadow-lg">
              <CardHeader className="p-4 sm:p-6 lg:p-8">
                <CardTitle className="text-xl">Sign in required</CardTitle>
                <CardDescription>
                  Please sign in to claim your Founders pricing.
                </CardDescription>
              </CardHeader>
            </Card>
          </SignedOut>

          <SignedIn>
            <Card className="bg-card border-0 shadow-lg overflow-hidden">
              <div className="relative border-b border-yellow-300/30 bg-gradient-to-r from-yellow-400/10 via-amber-400/15 to-yellow-400/10 px-4 sm:px-6 lg:px-8 py-3">
                <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-yellow-100">
                  <Sparkles className="h-3.5 w-3.5 text-yellow-300" />
                  <span className="font-semibold">Offer ends 1 May 2026</span>
                  <span className="opacity-50">·</span>
                  <span className="font-semibold text-yellow-200">
                    {formatCountdown(msLeft)} remaining
                  </span>
                </div>
              </div>

              <CardHeader className="p-4 sm:p-6 lg:p-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-2xl">Become a Founder</CardTitle>
                    <TierBadge tier="pro" isFounders />
                  </div>
                  <Badge
                    variant="secondary"
                    className="bg-yellow-400/10 text-yellow-100 border border-yellow-300/30"
                  >
                    Legacy pricing
                  </Badge>
                </div>
                <CardDescription className="mt-2">
                  Get the full Pro feature set at the grandfathered Nano price,
                  locked in for as long as you stay subscribed.
                </CardDescription>
              </CardHeader>

              <CardContent className="pt-0 pb-4 sm:pb-6 lg:pb-8 px-4 sm:px-6 lg:px-8 space-y-6">
                <BillingPeriodToggle
                  value={billingPeriod}
                  onChange={setBillingPeriod}
                />

                <div className="rounded-xl border border-yellow-300/40 bg-yellow-400/[0.04] p-6 shadow-lg shadow-yellow-400/5 ring-2 ring-yellow-300/40">
                  <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-yellow-200/80 mb-1">
                        Founders
                      </p>
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-bold">${price}</span>
                        <span className="text-sm text-muted-foreground">
                          {priceSuffix}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {billingPeriod === 'annual'
                          ? `Billed $36/year (${`$${effectiveMonthly}/mo effective`})`
                          : 'Billed monthly'}
                      </p>
                    </div>
                    <div className="text-sm text-yellow-100/80">
                      <p className="line-through opacity-60">
                        Pro usually ${billingPeriod === 'annual' ? 240 : 24}
                        {priceSuffix}
                      </p>
                      <p className="font-semibold text-yellow-200">
                        You save ${billingPeriod === 'annual' ? 204 : 20}
                        {priceSuffix}
                      </p>
                    </div>
                  </div>

                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 mb-6">
                    {FOUNDERS_FEATURES.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-sm"
                      >
                        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-yellow-300" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {offerExpired ? (
                    <Button
                      disabled
                      size="lg"
                      className="w-full cursor-not-allowed"
                    >
                      Offer ended
                    </Button>
                  ) : foundersPlanId ? (
                    <CheckoutButton
                      planId={foundersPlanId}
                      planPeriod={billingPeriod}
                      newSubscriptionRedirectUrl="/billing"
                    >
                      <Button
                        size="lg"
                        className={cn(
                          'w-full cursor-pointer gap-2 font-semibold',
                          'bg-yellow-300 text-black hover:bg-yellow-200 border-transparent',
                        )}
                      >
                        Claim Founders pricing
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </CheckoutButton>
                  ) : (
                    <div className="space-y-2">
                      <Button
                        disabled
                        size="lg"
                        className="w-full cursor-not-allowed"
                      >
                        Plan unavailable
                      </Button>
                      <p className="text-xs text-muted-foreground text-center">
                        Set <code className="font-mono">VITE_CLERK_FOUNDERS_PLAN_ID</code>{' '}
                        with the hidden Clerk plan ID, or contact{' '}
                        <a
                          href="mailto:connect@exit1.dev"
                          className="underline underline-offset-4 hover:text-foreground"
                        >
                          connect@exit1.dev
                        </a>
                        .
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex items-start gap-3 rounded-lg border border-yellow-300/40 bg-yellow-400/5 p-4 text-sm">
                  <AlertTriangle className="h-4 w-4 text-yellow-300 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-medium text-yellow-100">
                      Founders pricing is one-way
                    </p>
                    <p className="text-yellow-100/80">
                      If you cancel, new pricing applies if you re-subscribe —
                      Nano at $9/mo, Pro at $24/mo, or Agency at $49/mo. Your
                      Founders pricing won't come back.
                    </p>
                  </div>
                </div>

                <p className="text-center text-xs text-muted-foreground">
                  Secure checkout handled by Clerk. Cancel anytime. Questions?{' '}
                  <a
                    href="mailto:connect@exit1.dev"
                    className="underline underline-offset-4 hover:text-foreground"
                  >
                    connect@exit1.dev
                  </a>
                </p>
              </CardContent>
            </Card>
          </SignedIn>
        </div>
      </div>
    </PageContainer>
  );
}

function BillingPeriodToggle({
  value,
  onChange,
}: {
  value: BillingPeriod;
  onChange: (next: BillingPeriod) => void;
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
          aria-selected={value === 'month'}
          onClick={() => onChange('month')}
          className={cn(
            'cursor-pointer rounded-full px-4 py-1.5 font-medium transition-colors',
            value === 'month'
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Monthly
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={value === 'annual'}
          onClick={() => onChange('annual')}
          className={cn(
            'cursor-pointer rounded-full px-4 py-1.5 font-medium transition-colors inline-flex items-center gap-2',
            value === 'annual'
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Annual
          <Badge
            variant={value === 'annual' ? 'secondary' : 'outline'}
            className="text-[10px] px-1.5 py-0 font-semibold"
          >
            Save 25%
          </Badge>
        </button>
      </div>
    </div>
  );
}
