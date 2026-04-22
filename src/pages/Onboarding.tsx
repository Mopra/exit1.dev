import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePlan } from '@/hooks/usePlan';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Globe,
  Zap,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@clerk/clerk-react';
import { CheckoutButton, usePlans } from '@clerk/clerk-react/experimental';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '@/firebase';
import { apiClient } from '@/api/client';
import { generateFriendlyName } from '@/lib/check-utils';
import { getDefaultExpectedStatusCodes } from '@/lib/check-defaults';
import { cn } from '@/lib/utils';

const PREFILL_WEBSITE_URL_KEY = 'exit1_website_url';

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

const ALL_STEPS = [1, 2, 3, 4, 5] as const;
const STEPS_WHEN_USER_HAS_CHECKS = [1, 2, 3, 5] as const;

interface PlanFeature {
  icon: React.ReactNode;
  label: string;
  detail?: string;
}

type PlanChoiceKey = 'free' | 'nano' | 'pro' | 'agency';

interface PlanChoice {
  /** Stable id used by submitOnboardingResponse + CheckoutButton lookup. */
  key: PlanChoiceKey;
  name: string;
  tagline: string;
  priceLabel: string;
  priceSuffix: string;
  priceNote: string;
  /** Shown on the paid card as a gentle emphasis. */
  recommended?: boolean;
  features: PlanFeature[];
}

// Onboarding shows the four live plans — Founders (legacy `nano` plan key) is
// intentionally hidden. New users can only pick from plans currently for sale.
const PLAN_CHOICES: PlanChoice[] = [
  {
    key: 'free',
    name: 'Free',
    tagline: 'Hobby projects & side projects',
    priceLabel: '$0',
    priceSuffix: '',
    priceNote: 'Always free',
    features: [
      { icon: <Check className="h-4 w-4" />, label: '10 monitors' },
      { icon: <Clock className="h-4 w-4" />, label: '5-minute check intervals' },
      { icon: <Lock className="h-4 w-4" />, label: 'SSL certificate monitoring' },
      { icon: <Mail className="h-4 w-4" />, label: 'Email alerts', detail: '10/month' },
      { icon: <Webhook className="h-4 w-4" />, label: '1 webhook integration' },
      { icon: <Palette className="h-4 w-4" />, label: '1 public status page' },
      { icon: <BarChart3 className="h-4 w-4" />, label: 'Analytics & logs', detail: '60 days' },
    ],
  },
  {
    key: 'nano',
    name: 'Nano',
    tagline: 'Production monitoring for small teams',
    priceLabel: '$9',
    priceSuffix: '/mo',
    priceNote: 'or $84/year',
    features: [
      { icon: <Check className="h-4 w-4" />, label: '50 monitors' },
      { icon: <Clock className="h-4 w-4" />, label: '2-minute check intervals' },
      { icon: <Webhook className="h-4 w-4" />, label: '5 webhook integrations' },
      { icon: <Mail className="h-4 w-4" />, label: 'Email alerts', detail: '1,000/month' },
      { icon: <Palette className="h-4 w-4" />, label: '5 branded status pages' },
      { icon: <Shield className="h-4 w-4" />, label: 'Domain intelligence & expiry alerts' },
      { icon: <BarChart3 className="h-4 w-4" />, label: 'Data retention', detail: '60 days' },
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    tagline: 'Serious uptime monitoring at scale',
    priceLabel: '$24',
    priceSuffix: '/mo',
    priceNote: 'or $240/year',
    recommended: true,
    features: [
      { icon: <Check className="h-4 w-4" />, label: '500 monitors' },
      { icon: <Clock className="h-4 w-4" />, label: '30-second check intervals' },
      { icon: <MessageSquare className="h-4 w-4" />, label: 'SMS alerts', detail: '50/month' },
      { icon: <Webhook className="h-4 w-4" />, label: '25 webhook integrations' },
      { icon: <Key className="h-4 w-4" />, label: 'API access + MCP', detail: '10 keys' },
      { icon: <Palette className="h-4 w-4" />, label: '25 branded status pages' },
      { icon: <BarChart3 className="h-4 w-4" />, label: 'Data retention', detail: '365 days' },
    ],
  },
  {
    key: 'agency',
    name: 'Agency',
    tagline: 'High-volume fleets & client work',
    priceLabel: '$49',
    priceSuffix: '/mo',
    priceNote: 'or $444/year',
    features: [
      { icon: <Check className="h-4 w-4" />, label: '1,000 monitors' },
      { icon: <Clock className="h-4 w-4" />, label: '15-second check intervals' },
      { icon: <MessageSquare className="h-4 w-4" />, label: 'SMS alerts', detail: '100/month' },
      { icon: <Users className="h-4 w-4" />, label: 'Team members & roles (coming soon)' },
      { icon: <Key className="h-4 w-4" />, label: 'API access + MCP', detail: '25 keys' },
      { icon: <Palette className="h-4 w-4" />, label: '50 branded status pages' },
      { icon: <BarChart3 className="h-4 w-4" />, label: 'Data retention', detail: '3 years' },
    ],
  },
];

function ProgressIndicator({ currentIndex, total }: { currentIndex: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {Array.from({ length: total }).map((_, i) => {
        const active = i === currentIndex;
        const done = i < currentIndex;
        return (
          <div
            key={i}
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
  const [searchParams] = useSearchParams();
  const { userId } = useAuth();
  const { nano, isLoading } = usePlan();
  const { data: plans } = usePlans();
  const onboardingStatus = useOnboardingStatus();

  // Skip the "add your first check" step for users who already have checks
  // (returning users in force=1 preview, or users who signed up, bounced, and
  // came back after adding a check elsewhere). Null = still probing.
  const [hasExistingChecks, setHasExistingChecks] = useState<boolean | null>(null);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(
          query(collection(db, 'checks'), where('userId', '==', userId), limit(1))
        );
        if (!cancelled) setHasExistingChecks(!snap.empty);
      } catch {
        if (!cancelled) setHasExistingChecks(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const steps = useMemo<readonly number[]>(
    () => (hasExistingChecks ? STEPS_WHEN_USER_HAS_CHECKS : ALL_STEPS),
    [hasExistingChecks]
  );

  // Preview mode for manual testing — lets an already-completed user re-view the
  // onboarding flow via `/onboarding?force=1` without Firestore redirecting them.
  const forcePreview = searchParams.get('force') === '1';

  // Auth handlers redirect through /onboarding and stash the intended
  // destination in `?next`. Honor it here once we know the user is already
  // onboarded, and again when they finish the flow below.
  const nextDestination = useMemo(() => {
    const raw = searchParams.get('next');
    if (!raw) return '/checks';
    // Only trust same-origin paths to prevent open-redirect abuse.
    return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/checks';
  }, [searchParams]);

  useEffect(() => {
    if (forcePreview) return;
    if (onboardingStatus.hydrated && onboardingStatus.completed) {
      navigate(nextDestination, { replace: true });
    }
  }, [forcePreview, onboardingStatus.hydrated, onboardingStatus.completed, navigate, nextDestination]);

  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<Answers>({
    sources: [],
    useCases: [],
    teamSize: null,
  });

  // First-check step state
  const [firstCheckUrl, setFirstCheckUrl] = useState('');
  const [firstCheckLoading, setFirstCheckLoading] = useState(false);
  const [firstCheckPhase, setFirstCheckPhase] = useState<'adding' | 'running'>('adding');
  const [firstCheckError, setFirstCheckError] = useState<string | null>(null);
  const [firstCheckResult, setFirstCheckResult] = useState<
    | { status: string; url: string; responseTime?: number; detailedStatus?: string }
    | null
  >(null);
  const firstCheckPrefillLoadedRef = useRef(false);
  const firstCheckAutoFiredRef = useRef(false);
  const firstCheckInputRef = useRef<HTMLInputElement>(null);

  const handleFirstCheckUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;

    if (value && !/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
      const newCaret = caret + 8;
      // Restore cursor after React's re-render so the user keeps typing in place.
      requestAnimationFrame(() => {
        firstCheckInputRef.current?.setSelectionRange(newCaret, newCaret);
      });
    }

    setFirstCheckUrl(value);
    if (firstCheckError) setFirstCheckError(null);
  };

  // When first-check step becomes visible, consume any prefilled URL from the
  // marketing-site handoff (stored in localStorage by App.tsx on sign-up).
  useEffect(() => {
    if (step !== 4 || firstCheckPrefillLoadedRef.current) return;
    firstCheckPrefillLoadedRef.current = true;
    try {
      const stored = localStorage.getItem(PREFILL_WEBSITE_URL_KEY);
      if (stored) {
        setFirstCheckUrl(stored);
        localStorage.removeItem(PREFILL_WEBSITE_URL_KEY);
      } else {
        // No prefill → nothing to auto-fire. Mark as already fired so typing in
        // the input doesn't kick off the check on the first keystroke.
        firstCheckAutoFiredRef.current = true;
      }
    } catch {
      firstCheckAutoFiredRef.current = true;
    }
  }, [step]);

  const runFirstCheck = useCallback(async () => {
    let url = firstCheckUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    setFirstCheckLoading(true);
    setFirstCheckPhase('adding');
    setFirstCheckError(null);

    // Progressive feedback: the server does "create → live-check" in one
    // callable, but from the user's side we show that as two phases so it
    // doesn't feel like a dead spinner.
    const phaseTimer = window.setTimeout(() => setFirstCheckPhase('running'), 600);

    try {
      const friendlyName = generateFriendlyName(url);
      const addRes = await apiClient.addWebsite({
        url,
        name: friendlyName,
        type: 'website',
        checkFrequency: 60,
        httpMethod: 'GET',
        expectedStatusCodes: getDefaultExpectedStatusCodes('website'),
        requestHeaders: {},
        runImmediately: true,
      });

      if (!addRes.success || !addRes.data?.id) {
        setFirstCheckError(addRes.error || 'Failed to add check');
        return;
      }

      setFirstCheckResult({
        status: addRes.data.status ?? 'unknown',
        url,
        responseTime: addRes.data.responseTime,
        detailedStatus: addRes.data.detailedStatus,
      });
    } catch (err: any) {
      setFirstCheckError(err?.message || 'Failed to run check');
    } finally {
      window.clearTimeout(phaseTimer);
      setFirstCheckLoading(false);
    }
  }, [firstCheckUrl]);

  // Auto-fire the check when the step loads with a prefilled URL from the
  // marketing site — the whole point is instant gratification.
  useEffect(() => {
    if (
      step !== 4 ||
      !firstCheckPrefillLoadedRef.current ||
      firstCheckAutoFiredRef.current ||
      firstCheckLoading ||
      firstCheckResult ||
      firstCheckError ||
      !firstCheckUrl
    ) {
      return;
    }
    firstCheckAutoFiredRef.current = true;
    void runFirstCheck();
  }, [step, firstCheckUrl, firstCheckLoading, firstCheckResult, firstCheckError, runFirstCheck]);

  // Match an onboarding plan choice to a Clerk plan by slug. Clerk slugs map
  // 1:1 with our internal plan keys for the new 4-plan lineup (nanov2 for
  // Nano, pro for Pro, agency for Agency). Keep 'starter' as a legacy fallback
  // for Nano only.
  const findClerkPlan = useCallback(
    (choiceKey: PlanChoiceKey) => {
      if (!plans || choiceKey === 'free') return null;
      const slugCandidates: Record<Exclude<PlanChoiceKey, 'free'>, string[]> = {
        nano: ['nanov2', 'starter'],
        pro: ['pro'],
        agency: ['agency'],
      };
      const candidates = slugCandidates[choiceKey];
      return (
        plans.find((p: any) => candidates.includes((p.slug ?? '').toLowerCase())) ?? null
      );
    },
    [plans],
  );

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

  const submitResponse = (choice: PlanChoiceKey) => {
    // The backend `submitOnboardingResponse` callable still uses the legacy
    // 'personal' | 'nano' enum — collapse nano/pro/agency down to 'nano' so
    // any paid choice still counts as "paid" without needing a Phase A api
    // contract bump.
    const planChoice: 'personal' | 'nano' = choice === 'free' ? 'personal' : 'nano';
    void apiClient.submitOnboardingResponse({
      sources: answers.sources,
      useCases: answers.useCases,
      teamSize: answers.teamSize ?? '',
      planChoice,
    });
  };

  const finishOnboarding = (destination: string) => {
    if (userId) markOnboardingCompleteLocally(userId);
    navigate(destination, { replace: true });
  };

  const handleContinueFree = () => {
    submitResponse('free');
    finishOnboarding(nextDestination);
  };

  const handlePaidCheckoutComplete = (choice: Exclude<PlanChoiceKey, 'free'>) => {
    submitResponse(choice);
    finishOnboarding(nextDestination);
  };

  const handlePaidFallback = (choice: Exclude<PlanChoiceKey, 'free'>) => {
    submitResponse(choice);
    finishOnboarding('/billing');
  };

  const canAdvance =
    (step === 1 && answers.sources.length > 0) ||
    (step === 2 && answers.useCases.length > 0) ||
    (step === 3 && answers.teamSize !== null);

  const goBack = () =>
    setStep((s) => {
      const i = steps.indexOf(s);
      return i > 0 ? steps[i - 1] : s;
    });
  const goNext = () =>
    setStep((s) => {
      const i = steps.indexOf(s);
      return i >= 0 && i < steps.length - 1 ? steps[i + 1] : s;
    });

  // If we're sitting on a step that's no longer part of the active list (e.g.,
  // the probe resolves and it turns out the user has checks while we were on
  // step 4), jump forward to the next valid step.
  useEffect(() => {
    if (!steps.includes(step)) {
      const next = steps.find((s) => s > step) ?? steps[steps.length - 1];
      setStep(next);
    }
  }, [steps, step]);

  // Before the server status has hydrated, returning-onboarded users would
  // briefly see step 1 before the redirect effect fires. Gate on hydration
  // (unless we're in force-preview mode) so they see a spinner instead.
  const awaitingHydration = !forcePreview && !onboardingStatus.hydrated;

  if (isLoading || awaitingHydration) {
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
          <ProgressIndicator
            currentIndex={Math.max(0, steps.indexOf(step))}
            total={steps.length}
          />
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

        {step === 4 && (
          <div>
            {!firstCheckResult && (
              <div className="text-center mb-6 sm:mb-8">
                <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Zap className="h-5 w-5" />
                </div>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
                  Add your first check
                </h1>
                <p className="text-muted-foreground text-base">
                  Paste a URL — we'll monitor it and run a live check right now.
                </p>
              </div>
            )}

            {!firstCheckResult ? (
              <div className="space-y-3">
                <div className="relative">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    ref={firstCheckInputRef}
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="https://example.com"
                    value={firstCheckUrl}
                    onChange={handleFirstCheckUrlChange}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && firstCheckUrl.trim() && !firstCheckLoading) {
                        e.preventDefault();
                        void runFirstCheck();
                      }
                    }}
                    disabled={firstCheckLoading}
                    className="h-12 pl-10 text-base"
                    autoFocus
                  />
                </div>

                {firstCheckError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{firstCheckError}</span>
                  </div>
                )}

                <Button
                  type="button"
                  size="lg"
                  onClick={runFirstCheck}
                  disabled={!firstCheckUrl.trim() || firstCheckLoading}
                  className="w-full cursor-pointer gap-2 font-semibold disabled:cursor-not-allowed"
                >
                  {firstCheckLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {firstCheckPhase === 'adding' ? 'Adding check…' : 'Running live check…'}
                    </>
                  ) : (
                    <>
                      Run check
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {(() => {
                  const isUp =
                    firstCheckResult.status === 'online' || firstCheckResult.status === 'up';
                  const hasMetric =
                    isUp && typeof firstCheckResult.responseTime === 'number' && firstCheckResult.responseTime > 0;
                  return (
                    <div
                      className={cn(
                        'relative overflow-hidden rounded-2xl border p-6 sm:p-7',
                        'animate-in fade-in zoom-in-95 duration-500 ease-out',
                        isUp
                          ? 'border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.09] via-emerald-500/[0.04] to-transparent'
                          : 'border-red-500/30 bg-gradient-to-br from-red-500/[0.09] via-red-500/[0.04] to-transparent'
                      )}
                    >
                      {/* Top row: live indicator + detailed status chip */}
                      <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2.5">
                          <span className="relative flex size-2.5">
                            <span
                              className={cn(
                                'absolute inline-flex size-full animate-ping rounded-full opacity-75',
                                isUp ? 'bg-emerald-500' : 'bg-red-500'
                              )}
                            />
                            <span
                              className={cn(
                                'relative inline-flex size-full rounded-full',
                                isUp ? 'bg-emerald-500' : 'bg-red-500'
                              )}
                            />
                          </span>
                          <span
                            className={cn(
                              'text-[11px] font-medium uppercase tracking-[0.14em]',
                              isUp ? 'text-emerald-400' : 'text-red-400'
                            )}
                          >
                            {isUp ? 'Live · Monitoring' : 'Live · Watching'}
                          </span>
                        </div>
                      </div>

                      {/* Headline + metric */}
                      <div className="flex items-end justify-between gap-4 mb-5">
                        <div className="flex-1 min-w-0">
                          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-1">
                            {isUp ? "It's up" : "It's down"}
                          </h2>
                          <p className="text-sm text-muted-foreground">
                            {isUp
                              ? "We'll alert you the moment anything changes."
                              : "We've got you — we'll alert you the moment it's back."}
                          </p>
                        </div>
                        {hasMetric && (
                          <div className="text-right shrink-0 tabular-nums">
                            <div className="text-3xl sm:text-4xl font-bold tracking-tight text-emerald-400 leading-none">
                              {firstCheckResult.responseTime}
                              <span className="text-sm font-semibold text-emerald-400/70 ml-0.5">
                                ms
                              </span>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 rounded-lg bg-black/30 border border-border/40 px-3 py-2 font-mono text-xs sm:text-sm">
                        <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="truncate text-foreground/80">{firstCheckResult.url}</span>
                      </div>
                    </div>
                  );
                })()}

                <Button
                  type="button"
                  size="lg"
                  onClick={goNext}
                  className="w-full cursor-pointer gap-2 font-semibold"
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}

        {step === 5 && nano && (
          <div>
            <div className="text-center mb-8">
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="h-6 w-6" />
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
                You're already subscribed
              </h1>
              <p className="text-muted-foreground text-base max-w-md mx-auto">
                Thanks for your support. We've got everything we need — let's get you back to your checks.
              </p>
            </div>

            <div className="flex justify-center">
              <Button
                size="lg"
                onClick={() => handlePaidCheckoutComplete('nano')}
                className="cursor-pointer gap-2 font-semibold"
              >
                Finish
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {step === 5 && !nano && (
          <div>
            <div className="text-center mb-6">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
                Choose your plan
              </h1>
              <p className="text-muted-foreground text-base">
                You can change this anytime from the billing page.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 w-full">
              {PLAN_CHOICES.map((plan) => {
                const isFree = plan.key === 'free';
                const clerkPlan = isFree ? null : findClerkPlan(plan.key);
                return (
                  <div
                    key={plan.key}
                    className={cn(
                      'relative rounded-xl border bg-card/50 p-5 flex flex-col',
                      plan.recommended
                        ? 'border-primary/40 shadow-lg shadow-primary/5'
                        : 'border-border/50',
                    )}
                  >
                    {plan.recommended && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-md">
                          <Sparkles className="h-3 w-3" />
                          Recommended
                        </span>
                      </div>
                    )}

                    <div className="mb-4 mt-1">
                      <h2
                        className={cn(
                          'text-lg font-semibold',
                          isFree ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      >
                        {plan.name}
                      </h2>
                      <p className="text-xs text-muted-foreground mt-1">{plan.tagline}</p>
                    </div>

                    <div className="mb-4">
                      <div className="flex items-baseline gap-1">
                        <span
                          className={cn(
                            'text-2xl font-bold',
                            isFree ? 'text-muted-foreground' : 'text-foreground',
                          )}
                        >
                          {plan.priceLabel}
                        </span>
                        {plan.priceSuffix && (
                          <span className="text-sm text-muted-foreground">{plan.priceSuffix}</span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground/70 mt-1">
                        {plan.priceNote}
                      </p>
                    </div>

                    <ul className="space-y-2 mb-5 flex-1">
                      {plan.features.map((f) => (
                        <li
                          key={f.label}
                          className={cn(
                            'flex items-center gap-2 text-sm',
                            isFree ? 'text-muted-foreground' : 'text-foreground',
                          )}
                        >
                          <span
                            className={cn(
                              'shrink-0',
                              isFree ? 'text-muted-foreground/60' : 'text-primary',
                            )}
                          >
                            {f.icon}
                          </span>
                          <span className="flex-1">{f.label}</span>
                          {f.detail && (
                            <span className="text-[11px] text-muted-foreground/70 ml-auto">
                              {f.detail}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>

                    {isFree ? (
                      <button
                        onClick={handleContinueFree}
                        className="text-sm text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer py-2 text-center underline underline-offset-4 decoration-border/50 hover:decoration-foreground/30"
                      >
                        Continue with Free
                      </button>
                    ) : clerkPlan?.id ? (
                      <CheckoutButton
                        planId={clerkPlan.id}
                        planPeriod="annual"
                        onSubscriptionComplete={() =>
                          handlePaidCheckoutComplete(plan.key as Exclude<PlanChoiceKey, 'free'>)
                        }
                        newSubscriptionRedirectUrl="/checks"
                      >
                        <Button
                          size="lg"
                          variant={plan.recommended ? 'default' : 'outline'}
                          className="w-full cursor-pointer gap-2 font-semibold"
                        >
                          Choose {plan.name}
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </CheckoutButton>
                    ) : (
                      <Button
                        onClick={() =>
                          handlePaidFallback(plan.key as Exclude<PlanChoiceKey, 'free'>)
                        }
                        size="lg"
                        variant={plan.recommended ? 'default' : 'outline'}
                        className="w-full cursor-pointer gap-2 font-semibold"
                      >
                        Choose {plan.name}
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Nav controls — steps 4 and 5 use their own CTAs */}
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
          <div className="flex items-center justify-between mt-6">
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              className="gap-2 cursor-pointer text-muted-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            {!firstCheckResult && !firstCheckLoading && (
              <Button
                type="button"
                variant="ghost"
                onClick={goNext}
                className="cursor-pointer text-muted-foreground"
              >
                Add later
              </Button>
            )}
          </div>
        )}

        {step === 5 && (
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
