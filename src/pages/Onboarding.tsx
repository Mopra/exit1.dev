import { useNavigate } from 'react-router-dom';
import { useNanoPlan } from '@/hooks/useNanoPlan';
import { useEffect, useMemo, useState } from 'react';
import { markOnboardingCompleteLocally, useOnboardingStatus } from '@/hooks/useOnboardingStatus';
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
  ArrowLeft,
  Lock,
  Users,
  Search,
  MessageCircle,
  Bot,
  Twitter,
  Flame,
  Rocket,
  UserRound,
  FileText,
  MoreHorizontal,
  Server,
  ShoppingCart,
  Briefcase,
  Layers,
  Heart,
  Building2,
  User,
  Users2,
  UsersRound,
  Building,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CheckoutButton, usePlans } from '@clerk/clerk-react/experimental';
import { apiClient } from '@/api/client';
import { cn } from '@/lib/utils';

// Server is the source of truth (users/{uid}.onboardingCompletedAt, fetched via
// useOnboardingStatus). These helpers read/write the localStorage cache used
// for synchronous redirect decisions before hydration completes.
const ONBOARDING_COMPLETE_KEY = 'exit1_onboarding_complete_v2';

export function markOnboardingComplete() {
  markOnboardingCompleteLocally();
}

export function isOnboardingComplete() {
  return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true';
}

type Answers = {
  sources: string[];
  useCases: string[];
  teamSize: string | null;
};

const SOURCE_OPTIONS: { value: string; label: string; icon: React.ReactNode }[] = [
  { value: 'google', label: 'Google search', icon: <Search className="h-4 w-4" /> },
  { value: 'reddit', label: 'Reddit', icon: <MessageCircle className="h-4 w-4" /> },
  { value: 'ai_assistant', label: 'ChatGPT / Claude / AI', icon: <Bot className="h-4 w-4" /> },
  { value: 'twitter', label: 'X / Twitter', icon: <Twitter className="h-4 w-4" /> },
  { value: 'product_hunt', label: 'Product Hunt', icon: <Rocket className="h-4 w-4" /> },
  { value: 'hacker_news', label: 'Hacker News', icon: <Flame className="h-4 w-4" /> },
  { value: 'friend', label: 'Friend or colleague', icon: <UserRound className="h-4 w-4" /> },
  { value: 'blog', label: 'Blog or article', icon: <FileText className="h-4 w-4" /> },
  { value: 'other', label: 'Somewhere else', icon: <MoreHorizontal className="h-4 w-4" /> },
];

const USE_CASE_OPTIONS: { value: string; label: string; icon: React.ReactNode }[] = [
  { value: 'infrastructure', label: 'Infrastructure & APIs', icon: <Server className="h-4 w-4" /> },
  { value: 'ecommerce', label: 'E-commerce store', icon: <ShoppingCart className="h-4 w-4" /> },
  { value: 'client_sites', label: 'Customer / client sites', icon: <Briefcase className="h-4 w-4" /> },
  { value: 'saas', label: 'SaaS product', icon: <Layers className="h-4 w-4" /> },
  { value: 'personal', label: 'Personal / side projects', icon: <Heart className="h-4 w-4" /> },
  { value: 'agency', label: 'Agency / consultancy', icon: <Building2 className="h-4 w-4" /> },
  { value: 'other', label: 'Something else', icon: <MoreHorizontal className="h-4 w-4" /> },
];

const TEAM_SIZE_OPTIONS: { value: string; label: string; detail: string; icon: React.ReactNode }[] = [
  { value: 'solo', label: 'Just me', detail: 'Solo developer', icon: <User className="h-4 w-4" /> },
  { value: '2_5', label: '2–5 people', detail: 'Small team', icon: <Users2 className="h-4 w-4" /> },
  { value: '6_20', label: '6–20 people', detail: 'Growing team', icon: <UsersRound className="h-4 w-4" /> },
  { value: '21_100', label: '21–100 people', detail: 'Mid-sized company', icon: <Users className="h-4 w-4" /> },
  { value: '100_plus', label: '100+ people', detail: 'Large organization', icon: <Building className="h-4 w-4" /> },
];

const TOTAL_STEPS = 4;

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
  { icon: <MessageSquare className="h-4 w-4" />, label: 'SMS alerts' },
  { icon: <Users className="h-4 w-4" />, label: 'Team alerts' },
  { icon: <Webhook className="h-4 w-4" />, label: 'Unlimited webhooks & status pages' },
  { icon: <Palette className="h-4 w-4" />, label: 'Custom status page branding' },
  { icon: <Shield className="h-4 w-4" />, label: 'Domain intelligence & expiry alerts' },
  { icon: <Key className="h-4 w-4" />, label: 'MCP integration (AI assistants)' },
  { icon: <BarChart3 className="h-4 w-4" />, label: '1-year data retention' },
];

function ProgressIndicator({ step }: { step: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <div
            key={n}
            className={cn(
              'h-1.5 rounded-full transition-all',
              active ? 'w-8 bg-primary' : done ? 'w-6 bg-primary/60' : 'w-6 bg-border/60'
            )}
          />
        );
      })}
    </div>
  );
}

interface OptionGridProps {
  options: { value: string; label: string; detail?: string; icon: React.ReactNode }[];
  selected: string[];
  onToggle: (value: string) => void;
  columns?: 2 | 3;
}

function OptionGrid({ options, selected, onToggle, columns = 2 }: OptionGridProps) {
  return (
    <div
      className={cn(
        'grid gap-2.5 w-full',
        columns === 3 ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'
      )}
    >
      {options.map((opt) => {
        const isSelected = selected.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onToggle(opt.value)}
            aria-pressed={isSelected}
            className={cn(
              'group relative flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-all cursor-pointer',
              isSelected
                ? 'border-primary/60 bg-primary/5 shadow-sm shadow-primary/10'
                : 'border-border/50 bg-card/40 hover:border-border hover:bg-card/70'
            )}
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                isSelected ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground'
              )}
            >
              {opt.icon}
            </span>
            <span className="flex-1 min-w-0">
              <span
                className={cn(
                  'block text-sm font-medium',
                  isSelected ? 'text-foreground' : 'text-foreground/90'
                )}
              >
                {opt.label}
              </span>
              {opt.detail && (
                <span className="block text-xs text-muted-foreground mt-0.5">{opt.detail}</span>
              )}
            </span>
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border transition-all',
                isSelected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border/60 bg-transparent'
              )}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function Onboarding() {
  const navigate = useNavigate();
  const { nano, isLoading } = useNanoPlan();
  const { data: plans } = usePlans();
  const onboardingStatus = useOnboardingStatus();

  useEffect(() => {
    if (onboardingStatus.hydrated && onboardingStatus.completed) {
      navigate('/checks', { replace: true });
    }
  }, [onboardingStatus.hydrated, onboardingStatus.completed, navigate]);

  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<Answers>({
    sources: [],
    useCases: [],
    teamSize: null,
  });

  const nanoPlan = useMemo(() => {
    if (!plans) return null;
    return (
      plans.find((p: any) => {
        const text = `${p.slug ?? ''} ${p.name ?? ''}`.toLowerCase();
        return text.includes('nano') || text.includes('starter');
      }) ?? null
    );
  }, [plans]);

  const toggleMulti = (key: 'sources' | 'useCases', value: string) => {
    setAnswers((prev) => {
      const current = prev[key];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, [key]: next };
    });
  };

  const selectTeamSize = (value: string) => {
    setAnswers((prev) => ({ ...prev, teamSize: value }));
  };

  const submitResponse = (planChoice: 'personal' | 'nano') => {
    void apiClient.submitOnboardingResponse({
      sources: answers.sources,
      useCases: answers.useCases,
      teamSize: answers.teamSize ?? '',
      planChoice,
    });
  };

  const handleContinueFree = () => {
    submitResponse('personal');
    markOnboardingComplete();
    navigate('/checks', { replace: true });
  };

  const handleNanoCheckoutComplete = () => {
    submitResponse('nano');
    markOnboardingComplete();
    navigate('/checks', { replace: true });
  };

  const handleStartNanoFallback = () => {
    submitResponse('nano');
    markOnboardingComplete();
    navigate('/billing', { replace: true });
  };

  const canAdvance =
    (step === 1 && answers.sources.length > 0) ||
    (step === 2 && answers.useCases.length > 0) ||
    (step === 3 && answers.teamSize !== null) ||
    step === 4;

  const goBack = () => setStep((s) => Math.max(1, s - 1));
  const goNext = () => setStep((s) => Math.min(TOTAL_STEPS, s + 1));

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
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-6 sm:mb-8">
          <div className="flex items-center justify-center gap-2 mb-3">
            <img src="/e_.svg" alt="Exit1" className="size-8" />
          </div>
          <ProgressIndicator step={step} />
        </div>

        {step === 1 && (
          <StepShell
            title="Where did you find us?"
            subtitle="Pick any that apply — it helps us know which channels actually work."
          >
            <OptionGrid
              options={SOURCE_OPTIONS}
              selected={answers.sources}
              onToggle={(v) => toggleMulti('sources', v)}
              columns={3}
            />
          </StepShell>
        )}

        {step === 2 && (
          <StepShell
            title="What will you be using this for?"
            subtitle="Select everything that fits — we'll tune the defaults accordingly."
          >
            <OptionGrid
              options={USE_CASE_OPTIONS}
              selected={answers.useCases}
              onToggle={(v) => toggleMulti('useCases', v)}
              columns={2}
            />
          </StepShell>
        )}

        {step === 3 && (
          <StepShell
            title="Are you an individual or a team?"
            subtitle="This stays between us — it helps us build the right things next."
          >
            <OptionGrid
              options={TEAM_SIZE_OPTIONS}
              selected={answers.teamSize ? [answers.teamSize] : []}
              onToggle={(v) => selectTeamSize(v)}
              columns={2}
            />
          </StepShell>
        )}

        {step === 4 && nano && (
          <div>
            <div className="text-center mb-8">
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="h-6 w-6" />
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
                You're already on Nano
              </h1>
              <p className="text-muted-foreground text-base max-w-md mx-auto">
                Thanks for your support. We've got everything we need — let's get you back to your checks.
              </p>
            </div>

            <div className="flex justify-center">
              <Button
                size="lg"
                onClick={handleNanoCheckoutComplete}
                className="cursor-pointer gap-2 font-semibold"
              >
                Finish
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {step === 4 && !nano && (
          <div>
            <div className="text-center mb-6">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
                Choose your plan
              </h1>
              <p className="text-muted-foreground text-base">
                You can change this anytime from the billing page.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5 w-full">
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

              {/* Nano (Paid) Card */}
              <div className="relative rounded-xl border-2 border-primary/40 bg-card p-5 sm:p-6 flex flex-col shadow-lg shadow-primary/5">
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
                    <span className="text-2xl font-bold text-foreground">$5</span>
                    <span className="text-sm text-muted-foreground">/month</span>
                  </div>
                  <p className="text-xs text-muted-foreground/70 mt-1">Billed annually</p>
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

                <figure className="rounded-lg border border-amber-300/25 bg-amber-400/[0.04] px-4 py-3 mb-4 overflow-hidden">
                  <blockquote className="text-xs leading-relaxed text-foreground italic">
                    &ldquo;No-nonsense pricing, lightning fast alerts, and friendly support. There&rsquo;s not really a better choice.&rdquo;
                  </blockquote>
                  <figcaption className="mt-2.5 flex items-center gap-2.5 min-w-0">
                    <img
                      src="/testimonials/4u Entertainment Kai Randles.jpg"
                      alt="Kai Randles"
                      width={28}
                      height={28}
                      className="size-9 rounded-full object-cover shrink-0"
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs font-medium text-foreground">Kai Randles</span>
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60 min-w-0">
                        <img
                          src="/testimonials/4u Entertainment Logo.png"
                          alt=""
                          width={48}
                          height={12}
                          className="h-1 w-4 rounded-[2px] object-contain object-left shrink-0"
                        />
                        <span className="truncate">4u Entertainment</span>
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
                    <Button size="lg" className="w-full cursor-pointer gap-2 font-semibold">
                      Run Production Monitoring
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </CheckoutButton>
                ) : (
                  <Button
                    onClick={handleStartNanoFallback}
                    size="lg"
                    className="w-full cursor-pointer gap-2 font-semibold"
                  >
                    Run Production Monitoring
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Nav controls — only for question steps; step 4 uses its own CTAs */}
        {step < 4 && (
          <div className="flex items-center justify-between mt-6 sm:mt-8">
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              disabled={step === 1}
              className="gap-2 cursor-pointer disabled:cursor-not-allowed"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button
              type="button"
              onClick={goNext}
              disabled={!canAdvance}
              size="lg"
              className="gap-2 cursor-pointer disabled:cursor-not-allowed font-semibold"
            >
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        )}

        {step === 4 && (
          <div className="flex items-center justify-center mt-6">
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              className="gap-2 cursor-pointer text-muted-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function StepShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-center mb-6 sm:mb-8">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">{title}</h1>
        <p className="text-muted-foreground text-base">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
