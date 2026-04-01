import { useNavigate } from 'react-router-dom';
import { useNanoPlan } from '@/hooks/useNanoPlan';
import { useEffect, useMemo } from 'react';
import {
  Check,
  Sparkles,
  Clock,
  Mail,
  MessageSquare,
  Webhook,
  Shield,
  BarChart3,
  Key,
  Palette,
  ArrowRight,
  Lock,
  Users,
  Wrench,
  Headset,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CheckoutButton, usePlans } from '@clerk/clerk-react/experimental';

const ONBOARDING_COMPLETE_KEY = 'exit1_onboarding_complete';

export function markOnboardingComplete() {
  localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
}

export function isOnboardingComplete() {
  return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true';
}

interface PlanFeature {
  icon: React.ReactNode;
  label: string;
  detail?: string;
}

const personalFeatures: PlanFeature[] = [
  { icon: <Check className="h-4 w-4" />, label: '10 monitors' },
  { icon: <Clock className="h-4 w-4" />, label: '5-minute check intervals' },
  { icon: <Lock className="h-4 w-4" />, label: 'SSL certificate monitoring' },
  { icon: <Mail className="h-4 w-4" />, label: 'Email alerts', detail: '10/month' },
  { icon: <Webhook className="h-4 w-4" />, label: '1 webhook integration' },
  { icon: <Palette className="h-4 w-4" />, label: '1 public status page' },
  { icon: <BarChart3 className="h-4 w-4" />, label: 'Analytics & logs', detail: '30 days' },
];

const nanoFeatures: PlanFeature[] = [
  { icon: <Check className="h-4 w-4" />, label: 'Unlimited monitors' },
  { icon: <Clock className="h-4 w-4" />, label: '1-minute check intervals' },
  { icon: <MessageSquare className="h-4 w-4" />, label: 'Instant SMS alerts', detail: '20/month' },
  { icon: <Users className="h-4 w-4" />, label: 'Team alerts' },
  { icon: <Mail className="h-4 w-4" />, label: 'Higher alert budgets', detail: '1,000 emails' },
  { icon: <Webhook className="h-4 w-4" />, label: 'Unlimited webhooks' },
  { icon: <Palette className="h-4 w-4" />, label: 'Unlimited status pages' },
  { icon: <Shield className="h-4 w-4" />, label: 'Domain intelligence & expiry alerts' },
  { icon: <Wrench className="h-4 w-4" />, label: 'Maintenance mode' },
  { icon: <BarChart3 className="h-4 w-4" />, label: '1-year data retention' },
  { icon: <Key className="h-4 w-4" />, label: 'API access' },
  { icon: <Headset className="h-4 w-4" />, label: 'Priority support' },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const { nano, isLoading } = useNanoPlan();
  const { data: plans } = usePlans();

  // Find the Nano plan ID dynamically from Clerk's plan list
  const nanoPlan = useMemo(() => {
    if (!plans) return null;
    return plans.find((p: any) => {
      const text = `${p.slug ?? ''} ${p.name ?? ''}`.toLowerCase();
      return text.includes('nano') || text.includes('starter');
    }) ?? null;
  }, [plans]);

  // If already on Nano, mark onboarding complete and skip
  useEffect(() => {
    if (!isLoading && nano) {
      markOnboardingComplete();
      navigate('/checks', { replace: true });
    }
  }, [nano, isLoading, navigate]);

  const handleContinueFree = () => {
    markOnboardingComplete();
    navigate('/checks', { replace: true });
  };

  const handleNanoCheckoutComplete = () => {
    markOnboardingComplete();
    navigate('/checks', { replace: true });
  };

  // Fallback if plan ID can't be resolved — navigate to billing page
  const handleStartNanoFallback = () => {
    markOnboardingComplete();
    navigate('/billing', { replace: true });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="font-mono text-foreground text-center">
          <div className="text-xl tracking-widest uppercase mb-2">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center px-4 py-6 sm:py-10 overflow-y-auto">
      {/* Header */}
      <div className="text-center mb-6 sm:mb-10 max-w-xl">
        <div className="flex items-center justify-center gap-2 mb-3">
          <img src="/e_.svg" alt="Exit1" className="size-8" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-3">
          Welcome to Exit1
        </h1>
        <p className="text-muted-foreground text-base sm:text-lg">
          Choose the plan that fits your monitoring needs
        </p>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5 w-full max-w-3xl">
        {/* Personal (Free) Card */}
        <div className="relative rounded-xl border border-border/50 bg-card/50 p-5 sm:p-6 flex flex-col">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-muted-foreground">Personal</h2>
            <p className="text-sm text-muted-foreground/70 mt-1">
              For hobby projects &amp; side projects
            </p>
          </div>

          <div className="mb-4">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-muted-foreground">$0</span>
            </div>
            <p className="text-xs text-muted-foreground/50 mt-1">Always free</p>
          </div>

          <ul className="space-y-2.5 mb-5 flex-1">
            {personalFeatures.map((f) => (
              <li key={f.label} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <span className="text-muted-foreground/60 shrink-0">{f.icon}</span>
                <span>{f.label}</span>
                {f.detail && (
                  <span className="text-xs text-muted-foreground/60 ml-auto">{f.detail}</span>
                )}
              </li>
            ))}
          </ul>

          <button
            onClick={handleContinueFree}
            className="text-sm text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer py-2 text-center underline underline-offset-4 decoration-border/50 hover:decoration-foreground/30"
          >
            Continue with Personal
          </button>
        </div>

        {/* Nano (Paid) Card - Highlighted */}
        <div className="relative rounded-xl border-2 border-primary/40 bg-card p-5 sm:p-6 flex flex-col shadow-lg shadow-primary/5">
          {/* Recommended badge */}
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-md">
              <Sparkles className="h-3 w-3" />
              Recommended
            </span>
          </div>

          <div className="mb-4 mt-1">
            <h2 className="text-lg font-semibold text-foreground">Nano</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Professional uptime monitoring
            </p>
          </div>

          <div className="mb-4">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-foreground">$3</span>
              <span className="text-sm text-muted-foreground">/month</span>
            </div>
            <p className="text-xs text-muted-foreground/70 mt-1">Billed annually &middot; 14-day free trial</p>
          </div>

          <p className="text-xs font-medium text-muted-foreground mb-2">Everything in Free, plus:</p>
          <ul className="space-y-2.5 mb-5 flex-1">
            {nanoFeatures.map((f) => (
              <li key={f.label} className="flex items-center gap-2.5 text-sm">
                <span className="text-primary shrink-0">{f.icon}</span>
                <span className="text-foreground">{f.label}</span>
                {f.detail && (
                  <span className="text-xs text-muted-foreground ml-auto">{f.detail}</span>
                )}
              </li>
            ))}
          </ul>

          {/* Testimonial — social proof right before CTA */}
          <figure className="rounded-lg border border-amber-300/25 bg-amber-400/[0.04] px-4 py-3 mb-4">
            <blockquote className="text-xs leading-relaxed text-foreground italic">
              &ldquo;No-nonsense pricing, lightning fast alerts, and friendly support. There&rsquo;s not really a better choice.&rdquo;
            </blockquote>
            <figcaption className="mt-2.5 flex items-center gap-2.5">
              <img
                src="/testimonials/4u Entertainment Kai Randles.jpg"
                alt="Kai Randles"
                className="size-7 rounded-full object-cover shrink-0"
              />
              <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">Kai Randles</span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                  <img
                    src="/testimonials/4u Entertainment Logo.png"
                    alt=""
                    className="h-3 max-w-[48px] rounded-[2px] object-contain"
                  />
                  4u Entertainment
                </span>
              </div>
            </figcaption>
          </figure>

          {nanoPlan?.id ? (
            <CheckoutButton
              planId={nanoPlan.id}
              planPeriod="annual"
              onSubscriptionComplete={handleNanoCheckoutComplete}
              newSubscriptionRedirectUrl="/checks"
            >
              <Button
                size="lg"
                className="w-full cursor-pointer gap-2 font-semibold"
              >
                Start 14-day free trial
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CheckoutButton>
          ) : (
            <Button
              onClick={handleStartNanoFallback}
              size="lg"
              className="w-full cursor-pointer gap-2 font-semibold"
            >
              Start 14-day free trial
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Footer note */}
      <p className="text-xs text-muted-foreground/50 mt-6 text-center max-w-md">
        You can change your plan at any time from the billing page. No commitment required.
      </p>
    </div>
  );
}
