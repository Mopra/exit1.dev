import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePlan } from '@/hooks/usePlan';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { markOnboardingCompleteLocally, useOnboardingStatus } from '@/hooks/useOnboardingStatus';
import {
  Check,
  Sparkles,
  ArrowRight,
  ArrowLeft,
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
  BellRing,
  Mail,
  ChevronDown,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth, useUser } from '@clerk/clerk-react';
import { CheckoutButton, usePlans } from '@clerk/clerk-react/experimental';
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '@/firebase';
import { apiClient } from '@/api/client';
import { generateFriendlyName } from '@/lib/check-utils';
import { getDefaultExpectedStatusCodes } from '@/lib/check-defaults';
import { BillingPeriodToggle, PlanCard } from '@/components/billing/plan-matrix';
import {
  PLAN_MATRIX,
  TIER_BUTTON_PRIMARY,
  annualisedPrice,
  findClerkPlan,
  findPlanEntry,
  paidCtaLabel,
  recommendPlans,
  trialNote,
  type BillingPeriod,
  type PlanKey,
  type PlanMatrixEntry,
} from '@/components/billing/plan-matrix-data';
import { DEFAULT_NOTIFICATION_EVENTS } from '@/lib/notification-shared';
import { getMinCheckIntervalSecondsForTier } from '@/lib/subscription';
import { cn } from '@/lib/utils';
import {
  trackBeginCheckout,
  trackOnboardingAlertsEnabled,
  trackOnboardingComplete,
  trackOnboardingSkip,
  trackOnboardingStep,
  trackPurchase,
  trackSignUp,
  type OnboardingStepName,
  type SignUpMethod,
} from '@/lib/analytics';

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
  { value: '2_5', label: '2 to 5 people', detail: 'Small team', icon: <Users2 className="h-4 w-4" /> },
  { value: '6_20', label: '6 to 20 people', detail: 'Growing team', icon: <UsersRound className="h-4 w-4" /> },
  { value: '21_100', label: '21 to 100 people', detail: 'Mid-sized company', icon: <Users className="h-4 w-4" /> },
  { value: '100_plus', label: '100+ people', detail: 'Large organization', icon: <Building className="h-4 w-4" /> },
];

// Steps 1-3 are the survey, 4 adds the first check, 5 turns on alerts, 6 picks a
// plan.
//
// Step 5 is the important one and it did not used to exist. The flow got a monitor
// running, printed "we'll alert you the moment anything changes" on step 4, and
// then never wired up a channel. An audit of production found 380 of 588 users
// holding a live check with no reachable channel at all: no email settings, no
// webhook, no SMS. Free users who went through this flow were covered 19.6% of the
// time against 38.6% for users who predate it, because the one-click first check
// removed the fumbling that used to make people find the Emails page.
const STEP_SOURCES = 1;
const STEP_USE_CASES = 2;
const STEP_TEAM_SIZE = 3;
const STEP_FIRST_CHECK = 4;
const STEP_ALERTS = 5;
const STEP_PLAN = 6;

const ALL_STEPS = [
  STEP_SOURCES, STEP_USE_CASES, STEP_TEAM_SIZE, STEP_FIRST_CHECK, STEP_ALERTS, STEP_PLAN,
] as const;

const SURVEY_STEPS: readonly number[] = [STEP_SOURCES, STEP_USE_CASES, STEP_TEAM_SIZE];

/** Stable analytics slugs. Keyed by step id so a reorder cannot mislabel a step. */
const STEP_NAMES: Record<number, OnboardingStepName> = {
  [STEP_SOURCES]: 'sources',
  [STEP_USE_CASES]: 'use_cases',
  [STEP_TEAM_SIZE]: 'team_size',
  [STEP_FIRST_CHECK]: 'first_check',
  [STEP_ALERTS]: 'alerts',
  [STEP_PLAN]: 'plan',
};

// Onboarding shows the four live plans. Founders (legacy `nano` plan key) is
// intentionally hidden: new users can only pick from plans currently for sale.
// Plan data lives in `plan-matrix.tsx` so Billing and Onboarding stay in sync.

// Answers and current step survive a reload and a re-login, per user. Before this,
// state lived in component `useState` alone, so anyone who dropped at step 3 and
// came back landed on step 1 with everything gone, facing the same three screens
// again with no way past them.
const PROGRESS_KEY_PREFIX = 'exit1_onboarding_progress:';

type StoredProgress = { step: number; answers: Answers };

function readProgress(userId: string | null | undefined): StoredProgress | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${PROGRESS_KEY_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredProgress>;
    const a = parsed.answers;
    if (!a || !Array.isArray(a.sources) || !Array.isArray(a.useCases)) return null;
    return {
      step: typeof parsed.step === 'number' && ALL_STEPS.includes(parsed.step as 1) ? parsed.step : 1,
      answers: {
        sources: a.sources.filter((s): s is string => typeof s === 'string'),
        useCases: a.useCases.filter((s): s is string => typeof s === 'string'),
        teamSize: typeof a.teamSize === 'string' ? a.teamSize : null,
      },
    };
  } catch {
    return null;
  }
}

function writeProgress(userId: string | null | undefined, value: StoredProgress): void {
  if (!userId) return;
  try {
    localStorage.setItem(`${PROGRESS_KEY_PREFIX}${userId}`, JSON.stringify(value));
  } catch {
    // Private mode or quota. Losing resume is survivable; failing the flow is not.
  }
}

function clearProgress(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(`${PROGRESS_KEY_PREFIX}${userId}`);
  } catch {
    /* ignore */
  }
}

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
  const { user } = useUser();
  // `paid`, not `nano`: an Indie subscriber is already paying and must get the
  // "already subscribed" confirmation, not the plan picker again.
  const { tier, paid, isLoading } = usePlan();
  const { data: plans } = usePlans();
  const onboardingStatus = useOnboardingStatus();

  // GA4 `sign_up` conversion — the app end of the marketing→signup funnel.
  useSignUpAnalytics({ userId, user });

  // A URL handed off from the marketing site (app.exit1.dev/?website=…), stashed
  // in localStorage by App.tsx. When present we create the check in the
  // background and skip the manual first-check step entirely — the visitor
  // already told us what to monitor on the website, so asking again is friction.
  const [prefilledWebsiteUrl] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(PREFILL_WEBSITE_URL_KEY);
      return stored && stored.trim() ? stored.trim() : null;
    } catch {
      return null;
    }
  });

  // Skip the "add your first check" step for users who already have checks
  // (returning users in force=1 preview, or users who signed up, bounced, and
  // came back after adding a check elsewhere). Null = still probing.
  const [hasExistingChecks, setHasExistingChecks] = useState<boolean | null>(null);
  // Same idea for the alert step: someone who already put an address on the Emails
  // page does not need to be asked again. Read direct from Firestore rather than
  // through a callable so the probe finishes inside the survey, before the step
  // could render. Null = still probing.
  const [hasExistingAlertChannel, setHasExistingAlertChannel] = useState<boolean | null>(null);

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
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'emailSettings', userId));
        const data = snap.exists() ? (snap.data() as {
          enabled?: boolean;
          recipient?: string;
          recipients?: string[];
        }) : null;
        const recipientCount = data?.recipients?.length ?? (data?.recipient ? 1 : 0);
        if (!cancelled) setHasExistingAlertChannel(Boolean(data) && data?.enabled !== false && recipientCount > 0);
      } catch {
        // Fail open: showing the alert step to someone who already set it up is a
        // wasted click. Skipping it for someone who has not is a silent monitor.
        if (!cancelled) setHasExistingAlertChannel(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const steps = useMemo<readonly number[]>(
    () => ALL_STEPS.filter((s) => {
      if (s === STEP_FIRST_CHECK) return hasExistingChecks !== true;
      if (s === STEP_ALERTS) return hasExistingAlertChannel !== true;
      return true;
    }),
    [hasExistingChecks, hasExistingAlertChannel]
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

  // Resume where they left off. Runs once per user id: `userId` is null on the
  // first render while Clerk resolves, so this cannot go in the initialiser.
  const progressRestoredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || progressRestoredRef.current === userId) return;
    progressRestoredRef.current = userId;
    // `?force=1` exists to re-view the flow from the top; restoring saved progress
    // there would defeat the point of the preview.
    if (forcePreview) return;
    const stored = readProgress(userId);
    if (!stored) return;
    setAnswers(stored.answers);
    setStep(stored.step);
  }, [userId, forcePreview]);

  // Persist on every change. Cheap, and the alternative is losing the answers on a
  // refresh in the middle of a mandatory survey.
  useEffect(() => {
    if (!userId || progressRestoredRef.current !== userId) return;
    writeProgress(userId, { step, answers });
  }, [userId, step, answers]);

  // First-check step state. Seed the input with the prefilled URL right away so
  // it's already showing the moment the step renders: no empty-then-fill flash.
  const [firstCheckUrl, setFirstCheckUrl] = useState(prefilledWebsiteUrl ?? '');
  const [firstCheckLoading, setFirstCheckLoading] = useState(false);
  const [firstCheckPhase, setFirstCheckPhase] = useState<'adding' | 'running'>('adding');
  const [firstCheckError, setFirstCheckError] = useState<string | null>(null);
  const [firstCheckResult, setFirstCheckResult] = useState<
    | { id: string; status: string; url: string; responseTime?: number; detailedStatus?: string }
    | null
  >(null);
  const prefillHandledRef = useRef(false);
  const firstCheckInputRef = useRef<HTMLInputElement>(null);

  // Alert step state. The recipient is seeded from the Clerk primary email, which
  // is the address they just verified to get here, so the common path is one click
  // with nothing to type.
  const clerkEmail = user?.primaryEmailAddress?.emailAddress ?? '';
  const [alertEmail, setAlertEmail] = useState('');
  const [alertEmailTouched, setAlertEmailTouched] = useState(false);
  const [alertsSaving, setAlertsSaving] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);

  // Seed once Clerk has the user, without stomping on anything typed since.
  useEffect(() => {
    if (!clerkEmail || alertEmailTouched) return;
    setAlertEmail((prev) => (prev ? prev : clerkEmail));
  }, [clerkEmail, alertEmailTouched]);

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

  const runFirstCheck = useCallback(async (overrideUrl?: string) => {
    let url = (overrideUrl ?? firstCheckUrl).trim();
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
        checkFrequency: 5, // 5 min — the best interval the free tier allows
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
        id: addRes.data.id,
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

  // Marketing-site handoff: the prefilled URL is already in the input above. As
  // soon as we've confirmed the account is empty, kick the live check off in the
  // background — the user then spends the survey steps "paying" for the wait, so
  // by the time they reach the first-check step (second to last) the result is
  // already on screen instead of spinning. Gated on an empty account so a stale
  // prefill can never duplicate a check the user already has.
  useEffect(() => {
    if (!prefilledWebsiteUrl || prefillHandledRef.current) return;
    if (hasExistingChecks === null) return; // still probing — wait for the answer
    prefillHandledRef.current = true;
    try {
      localStorage.removeItem(PREFILL_WEBSITE_URL_KEY);
    } catch {
      /* ignore */
    }
    if (hasExistingChecks === false) {
      void runFirstCheck(prefilledWebsiteUrl);
    }
  }, [prefilledWebsiteUrl, hasExistingChecks, runFirstCheck]);

  // Turn on email alerts for every check, now and in future.
  //
  // `mode: 'all'` is the whole point. The app's own default is `'include'`, which
  // only delivers for checks the user has individually ticked, so saving a
  // recipient without also flipping the filter produces a settings page that looks
  // configured and sends nothing. 386 of the 404 existing settings documents are in
  // include mode, which is why so many users with an address on file still get no
  // alerts.
  const enableAlerts = useCallback(async () => {
    const email = alertEmail.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAlertsError('That does not look like an email address.');
      return;
    }
    setAlertsSaving(true);
    setAlertsError(null);
    try {
      const res = await apiClient.enableEmailAlertsForAllChecks([email], DEFAULT_NOTIFICATION_EVENTS);
      if (!res.success) {
        setAlertsError(res.error || 'Could not turn on alerts. Please try again.');
        return;
      }
      setAlertsEnabled(true);
      trackOnboardingAlertsEnabled('button');
    } catch (err) {
      setAlertsError(err instanceof Error ? err.message : 'Could not turn on alerts.');
    } finally {
      setAlertsSaving(false);
    }
  }, [alertEmail]);

  // Onboarding always shows annual by default (matches the best per-month
  // price), but users can switch to monthly before checkout.
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('annual');
  // The picker leads with two recommended cards; this reveals all four.
  const [showAllPlans, setShowAllPlans] = useState(false);

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

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The submit must complete server-side BEFORE we navigate, otherwise a failed
  // network call leaves the user marked complete only in localStorage, and they'll
  // be re-shown the flow on their next device or browser. One retry covers
  // transient cold-start timeouts; on hard failure we surface the error and stay on
  // the page so the user can retry.
  const submitResponse = useCallback(
    async (choice: PlanKey): Promise<boolean> => {
      // The backend `submitOnboardingResponse` callable still uses the legacy
      // 'personal' | 'nano' enum, so collapse indie/nano/pro down to 'nano': any
      // paid choice still counts as "paid" without needing an api contract bump.
      const planChoice: 'personal' | 'nano' = choice === 'free' ? 'personal' : 'nano';
      const payload = {
        sources: answers.sources,
        useCases: answers.useCases,
        teamSize: answers.teamSize ?? '',
        planChoice,
      };

      const attempt = () => apiClient.submitOnboardingResponse(payload);
      let res = await attempt();
      if (!res.success) {
        res = await attempt();
      }
      return res.success;
    },
    [answers.sources, answers.useCases, answers.teamSize],
  );

  const finishOnboarding = (destination: string) => {
    if (userId) {
      markOnboardingCompleteLocally(userId);
      clearProgress(userId);
    }
    navigate(destination, { replace: true });
  };

  /**
   * Speed the onboarding check up to what the new plan actually allows.
   *
   * Step 4 creates the check at 5 minutes, the best the free tier permits, and
   * `enforceTierCeiling` on the backend only ever clamps intervals DOWN on a tier
   * change. Correct in general, wrong here: someone who buys Pro for 15-second
   * checks otherwise walks away with a single monitor still polling every five
   * minutes and nothing telling them to change it. Best-effort, and deliberately
   * not blocking: a failure here must never strand a user who has just paid.
   */
  const upgradeFirstCheckInterval = useCallback(
    async (choice: Exclude<PlanKey, 'free'>) => {
      const check = firstCheckResult;
      if (!check) return;
      const minSeconds = getMinCheckIntervalSecondsForTier(choice);
      if (minSeconds >= 300) return; // no improvement over what step 4 created
      try {
        // `updateCheck` re-validates and rewrites url and name, so both have to be
        // sent. generateFriendlyName is the same call step 4 made on the same url,
        // so the name cannot drift.
        //
        // The callable re-reads the tier live and clamps to that tier's floor. If
        // Clerk has not finished propagating the new subscription this is refused
        // or clamped, and the check simply stays at 5 minutes. That is why this is
        // best-effort and swallowed: a failure here must not strand someone who
        // has just paid.
        await apiClient.updateWebsite({
          id: check.id,
          url: check.url,
          name: generateFriendlyName(check.url),
          checkFrequency: minSeconds / 60,
        });
      } catch {
        // Check keeps running at 5 minutes; they can change it on the check itself.
      }
    },
    [firstCheckResult],
  );

  const runSubmitAndFinish = useCallback(
    async (choice: PlanKey, destination: string) => {
      setSubmitError(null);
      setSubmitting(true);
      try {
        const ok = await submitResponse(choice);
        if (!ok) {
          setSubmitError(
            "We couldn't save your answers. Please check your connection and try again.",
          );
          return;
        }
        if (choice !== 'free') {
          await upgradeFirstCheckInterval(choice);
        }
        trackOnboardingComplete(choice, Boolean(firstCheckResult), alertsEnabled);
        finishOnboarding(destination);
      } finally {
        setSubmitting(false);
      }
    },
    // finishOnboarding closes over `userId` and `navigate`; both are stable enough
    // that re-creating this callback per change is fine.
    [submitResponse, upgradeFirstCheckInterval, firstCheckResult, alertsEnabled, userId, navigate],
  );

  const handleContinueFree = () => {
    void runSubmitAndFinish('free', nextDestination);
  };

  const handlePaidCheckoutComplete = (choice: Exclude<PlanKey, 'free'>) => {
    const entry = findPlanEntry(choice);
    trackPurchase(choice, billingPeriod, annualisedPrice(entry, billingPeriod));
    void runSubmitAndFinish(choice, nextDestination);
  };

  const handlePaidFallback = (choice: Exclude<PlanKey, 'free'>) => {
    void runSubmitAndFinish(choice, '/billing');
  };

  const handleBeginCheckout = (choice: Exclude<PlanKey, 'free'>) => {
    const entry = findPlanEntry(choice);
    trackBeginCheckout(choice, billingPeriod, annualisedPrice(entry, billingPeriod));
  };

  // The survey is no longer a gate: every one of its steps has a Skip. The three
  // questions are analytics, and putting three mandatory your-benefit screens
  // between signup and any value bought drop-off for nothing. Continue stays
  // primary while an answer is selected so the intended path still reads as the
  // obvious one.
  const canAdvance =
    (step === STEP_SOURCES && answers.sources.length > 0) ||
    (step === STEP_USE_CASES && answers.useCases.length > 0) ||
    (step === STEP_TEAM_SIZE && answers.teamSize !== null);

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

  const skipStep = () => {
    const name = STEP_NAMES[step];
    if (name) trackOnboardingSkip(name);
    goNext();
  };

  // If we're sitting on a step that's no longer part of the active list (e.g.,
  // the probe resolves and it turns out the user has checks while we were on
  // step 4), jump forward to the next valid step.
  useEffect(() => {
    if (!steps.includes(step)) {
      const next = steps.find((s) => s > step) ?? steps[steps.length - 1];
      setStep(next);
    }
  }, [steps, step]);

  // One view event per step, per arrival. Without this the funnel had a signal at
  // the start and a signal at the end and nothing in between, so a drop-off could
  // be counted but never located.
  const lastTrackedStepRef = useRef<number | null>(null);
  useEffect(() => {
    if (!steps.includes(step)) return;
    if (lastTrackedStepRef.current === step) return;
    const name = STEP_NAMES[step];
    if (!name) return;
    lastTrackedStepRef.current = step;
    trackOnboardingStep(name, steps.indexOf(step), steps.length);
  }, [step, steps]);

  // Someone arriving at the alert step who is already covered should not be asked;
  // record that they were covered so the funnel can tell "enabled here" from
  // "already had it".
  const alreadyCoveredTrackedRef = useRef(false);
  useEffect(() => {
    if (hasExistingAlertChannel !== true || alreadyCoveredTrackedRef.current) return;
    alreadyCoveredTrackedRef.current = true;
    trackOnboardingAlertsEnabled('already_configured');
  }, [hasExistingAlertChannel]);

  // Before the server status has hydrated, returning-onboarded users would
  // briefly see step 1 before the redirect effect fires. Gate on hydration
  // (unless we're in force-preview mode) so they see a spinner instead.
  const awaitingHydration = !forcePreview && !onboardingStatus.hydrated;

  // Same form-flash guard, post-hydration: once we know the user is onboarded,
  // the redirect useEffect is queued but hasn't fired yet — render a spinner
  // for that one frame instead of step 1's form.
  const awaitingRedirect =
    !forcePreview && onboardingStatus.hydrated && onboardingStatus.completed;

  // The hydration retry budget is ~16s, so a slow recovery can sit on the
  // spinner long enough to feel broken. Surface a secondary line after 5s
  // so the user knows we're still working, not stuck.
  const [showStillLoading, setShowStillLoading] = useState(false);
  useEffect(() => {
    if (!isLoading && !awaitingHydration) {
      setShowStillLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowStillLoading(true), 5000);
    return () => window.clearTimeout(timer);
  }, [isLoading, awaitingHydration]);

  if (isLoading || awaitingHydration || awaitingRedirect) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="font-mono text-foreground text-center">
          <div className="text-xl tracking-widest uppercase mb-2">Loading...</div>
          {showStillLoading && (
            <div className="text-sm text-muted-foreground mt-3 normal-case tracking-normal">
              This is taking longer than usual — hang tight.
            </div>
          )}
        </div>
      </div>
    );
  }

  // The plan grid needs more room than the narrative steps above. Two recommended
  // cards fit max-w-4xl comfortably; all four need the full width. Paid users never
  // reach either layout (they see the short "already subscribed" confirmation), so
  // only widen when we're actually rendering the grid.
  const isPlanGridVisible = step === STEP_PLAN && !paid;
  const planWidthClass = !isPlanGridVisible
    ? 'max-w-2xl'
    : showAllPlans ? 'max-w-7xl' : 'max-w-4xl';

  // Which two cards to lead with, from the answers given two screens earlier.
  const recommendation = recommendPlans({
    useCases: answers.useCases,
    teamSize: answers.teamSize,
  });
  const visiblePlans = showAllPlans
    ? PLAN_MATRIX
    : [findPlanEntry(recommendation.primary), findPlanEntry(recommendation.secondary)];

  return (
    <div className="flex flex-col items-center px-4 py-6 sm:py-10 overflow-y-auto">
      <div className={cn('w-full transition-[max-width] duration-300', planWidthClass)}>
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

        {step === STEP_SOURCES && (
          <StepShell
            title="Where did you find us?"
            subtitle="Pick any that apply. It helps us know which channels actually work."
          >
            <OptionGrid
              options={SOURCE_OPTIONS}
              selected={answers.sources}
              onToggle={(v) => toggleMulti('sources', v)}
              columns={3}
            />
          </StepShell>
        )}

        {step === STEP_USE_CASES && (
          <StepShell
            title="What will you be using this for?"
            subtitle="Select everything that fits. We use this to pick the right plan for you next."
          >
            <OptionGrid
              options={USE_CASE_OPTIONS}
              selected={answers.useCases}
              onToggle={(v) => toggleMulti('useCases', v)}
              columns={2}
            />
          </StepShell>
        )}

        {step === STEP_TEAM_SIZE && (
          <StepShell
            title="Are you an individual or a team?"
            subtitle="This stays between us. It decides which plan we recommend on the last step."
          >
            <OptionGrid
              options={TEAM_SIZE_OPTIONS}
              selected={answers.teamSize ? [answers.teamSize] : []}
              onToggle={(v) => selectTeamSize(v)}
              columns={2}
            />
          </StepShell>
        )}

        {step === STEP_FIRST_CHECK && (
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
                  onClick={() => void runFirstCheck()}
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
                          ? 'border-success/30 bg-gradient-to-br from-success/[0.09] via-success/[0.04] to-transparent'
                          : 'border-destructive/30 bg-gradient-to-br from-destructive/[0.09] via-destructive/[0.04] to-transparent'
                      )}
                    >
                      {/* Top row: live indicator + detailed status chip */}
                      <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2.5">
                          <span className="relative flex size-2.5">
                            <span
                              className={cn(
                                'absolute inline-flex size-full animate-ping rounded-full opacity-75',
                                isUp ? 'bg-success' : 'bg-destructive'
                              )}
                            />
                            <span
                              className={cn(
                                'relative inline-flex size-full rounded-full',
                                isUp ? 'bg-success' : 'bg-destructive'
                              )}
                            />
                          </span>
                          <span
                            className={cn(
                              'text-[11px] font-medium uppercase tracking-[0.14em]',
                              isUp ? 'text-success' : 'text-destructive'
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
                          {/*
                            This line used to promise "we'll alert you the moment
                            anything changes" unconditionally, before any channel
                            existed, which made it false for most people who read
                            it. Now it only claims what is true: the alert promise
                            belongs to the next step, unless the user already has a
                            channel and that step is being skipped.
                          */}
                          <p className="text-sm text-muted-foreground">
                            {steps.includes(STEP_ALERTS)
                              ? isUp
                                ? "We're checking it every 5 minutes. Alerts are the next step."
                                : "We're on it. Set up alerts next and we'll tell you when it's back."
                              : isUp
                                ? "We'll alert you the moment anything changes."
                                : "We've got you. We'll alert you the moment it's back."}
                          </p>
                        </div>
                        {hasMetric && (
                          <div className="text-right shrink-0 tabular-nums">
                            <div className="text-3xl sm:text-4xl font-bold tracking-tight text-success leading-none">
                              {firstCheckResult.responseTime}
                              <span className="text-sm font-semibold text-success/70 ml-0.5">
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

        {step === STEP_ALERTS && (
          <div>
            {!alertsEnabled ? (
              <>
                <div className="text-center mb-6 sm:mb-8">
                  <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <BellRing className="h-5 w-5" />
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
                    Where should we reach you?
                  </h1>
                  <p className="text-muted-foreground text-base">
                    Monitoring without alerts is just a graph. We'll email this address the
                    moment something goes down, and again when it recovers.
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="you@example.com"
                      value={alertEmail}
                      onChange={(e) => {
                        setAlertEmailTouched(true);
                        setAlertEmail(e.target.value);
                        if (alertsError) setAlertsError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && alertEmail.trim() && !alertsSaving) {
                          e.preventDefault();
                          void enableAlerts();
                        }
                      }}
                      disabled={alertsSaving}
                      className="h-12 pl-10 text-base"
                    />
                  </div>

                  {alertsError && (
                    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>{alertsError}</span>
                    </div>
                  )}

                  <Button
                    type="button"
                    size="lg"
                    onClick={() => void enableAlerts()}
                    disabled={!alertEmail.trim() || alertsSaving}
                    className="w-full cursor-pointer gap-2 font-semibold disabled:cursor-not-allowed"
                  >
                    {alertsSaving ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Turning on alerts…
                      </>
                    ) : (
                      <>
                        Email me when something breaks
                        <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </Button>

                  <p className="text-center text-xs text-muted-foreground">
                    Down and recovery alerts, plus SSL and domain expiry. Change any of it
                    later on the Emails page.
                  </p>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div className="relative overflow-hidden rounded-2xl border border-success/30 bg-gradient-to-br from-success/[0.09] via-success/[0.04] to-transparent p-6 sm:p-7 animate-in fade-in zoom-in-95 duration-500 ease-out">
                  <div className="flex items-center gap-2.5 mb-5">
                    <ShieldCheck className="h-4 w-4 text-success" />
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-success">
                      Alerts on
                    </span>
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-1">
                    You're covered
                  </h2>
                  <p className="text-sm text-muted-foreground mb-5">
                    Every check on your account, including ones you add later, will email
                    you when it goes down and when it recovers.
                  </p>
                  <div className="flex items-center gap-2 rounded-lg bg-black/30 border border-border/40 px-3 py-2 font-mono text-xs sm:text-sm">
                    <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate text-foreground/80">{alertEmail.trim()}</span>
                  </div>
                </div>

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

        {step === STEP_PLAN && paid && (
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

            {submitError && (
              <div className="mb-4 mx-auto max-w-md flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            <div className="flex justify-center">
              <Button
                size="lg"
                onClick={() =>
                  // Record the tier they actually hold. This block only renders
                  // when `paid`, so `tier` is never 'free'.
                  handlePaidCheckoutComplete(tier as Exclude<PlanKey, 'free'>)
                }
                disabled={submitting}
                className="cursor-pointer gap-2 font-semibold disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    Finish
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {step === STEP_PLAN && !paid && (
          <div>
            <div className="text-center mb-6">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
                {showAllPlans ? 'Choose your plan' : 'Our pick for you'}
              </h1>
              <p className="text-muted-foreground text-base">
                {showAllPlans
                  ? 'You can change this anytime from the billing page.'
                  : recommendation.reason}
              </p>
            </div>

            <div className="mb-6">
              <BillingPeriodToggle value={billingPeriod} onChange={setBillingPeriod} />
            </div>

            {submitError && (
              <div className="mb-4 mx-auto max-w-md flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            <div
              className={cn(
                'grid grid-cols-1 gap-4 w-full',
                showAllPlans ? 'md:grid-cols-2 xl:grid-cols-4' : 'md:grid-cols-2',
              )}
            >
              {visiblePlans.map((entry) => (
                <PlanCard
                  key={entry.key}
                  entry={entry}
                  billingPeriod={billingPeriod}
                  highlighted={
                    showAllPlans ? entry.key === 'pro' : entry.key === recommendation.primary
                  }
                  ctaNote={trialNote(entry, billingPeriod)}
                  cta={renderOnboardingCta({
                    entry,
                    billingPeriod,
                    clerkPlans: plans,
                    submitting,
                    onContinueFree: handleContinueFree,
                    onBeginCheckout: handleBeginCheckout,
                    onCheckoutComplete: handlePaidCheckoutComplete,
                    onFallback: handlePaidFallback,
                  })}
                  footer={entry.key === 'pro' ? <ProTestimonial /> : undefined}
                />
              ))}
            </div>

            {/*
              Nothing is hidden, it is just not all shown at once. Four
              near-identical cards is four times the reading for a decision that in
              practice resolves to Free or Pro: on the current lineup Indie has one
              customer and Nano has four.
            */}
            {!showAllPlans && (
              <div className="flex justify-center mt-5">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowAllPlans(true)}
                  className="gap-1.5 cursor-pointer text-muted-foreground"
                >
                  Compare all {PLAN_MATRIX.length} plans
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Nav controls. The check, alert and plan steps use their own CTAs. */}
        {SURVEY_STEPS.includes(step) && (
          <div className="flex items-center justify-between gap-3 mt-6 sm:mt-8">
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              disabled={steps.indexOf(step) === 0}
              className="gap-2 cursor-pointer disabled:cursor-not-allowed"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <div className="flex items-center gap-1 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={skipStep}
                className="cursor-pointer text-muted-foreground"
              >
                Skip
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
          </div>
        )}

        {step === STEP_FIRST_CHECK && (
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
                onClick={skipStep}
                className="cursor-pointer text-muted-foreground"
              >
                Add later
              </Button>
            )}
          </div>
        )}

        {step === STEP_ALERTS && !alertsEnabled && (
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
            <Button
              type="button"
              variant="ghost"
              onClick={skipStep}
              className="cursor-pointer text-muted-foreground"
            >
              Not now
            </Button>
          </div>
        )}

        {step === STEP_PLAN && (
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

// Customer testimonial shown on the Pro card — tuned to match the amber/Pro
// tier palette so it reads as part of the card rather than a generic quote.
function ProTestimonial() {
  return (
    <figure className="rounded-lg border border-tier-pro/25 bg-tier-pro/[0.04] px-4 py-3 overflow-hidden">
      <blockquote className="text-xs leading-relaxed text-foreground italic">
        &ldquo;No-nonsense pricing, lightning fast alerts, and friendly support.
        There&rsquo;s not really a better choice.&rdquo;
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
          <a
            href="https://4umediagroup.co.uk/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground/60 min-w-0 hover:text-foreground transition-colors"
          >
            <img
              src="/testimonials/4u Entertainment Logo.png"
              alt=""
              width={48}
              height={12}
              className="h-3 w-auto max-w-12 rounded-[2px] object-contain object-left shrink-0"
            />
            <span className="truncate mt-[2px]">4u Entertainment</span>
          </a>
        </div>
      </figcaption>
    </figure>
  );
}

// Render the CTA for a plan card in the onboarding step-5 grid. Free: inline
// "Continue with Free" button (submits + bounces to the default next page).
// Paid plans: CheckoutButton wired up with onboarding-completion handlers.
// Step 5 only runs for users with no active subscription, and in practice only
// once per account, so every paid card here is a free-trial entry point and
// carries the trial label. (Billing does the stricter check against payment
// history, which matters there because churned users come back to that page.)
function renderOnboardingCta({
  entry,
  billingPeriod,
  clerkPlans,
  submitting,
  onContinueFree,
  onBeginCheckout,
  onCheckoutComplete,
  onFallback,
}: {
  entry: PlanMatrixEntry;
  billingPeriod: BillingPeriod;
  clerkPlans: ReturnType<typeof usePlans>['data'];
  submitting: boolean;
  onContinueFree: () => void;
  onBeginCheckout: (choice: Exclude<PlanKey, 'free'>) => void;
  onCheckoutComplete: (choice: Exclude<PlanKey, 'free'>) => void;
  onFallback: (choice: Exclude<PlanKey, 'free'>) => void;
}) {
  if (entry.key === 'free') {
    return (
      <Button
        variant="outline"
        className="w-full cursor-pointer disabled:cursor-not-allowed"
        onClick={onContinueFree}
        disabled={submitting}
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Saving…
          </>
        ) : (
          'Continue with Free'
        )}
      </Button>
    );
  }

  const paidKey = entry.key as Exclude<PlanKey, 'free'>;
  const primaryClass = cn(
    'w-full cursor-pointer gap-2 font-semibold disabled:cursor-not-allowed',
    TIER_BUTTON_PRIMARY[entry.tier],
  );
  const clerkPlan = findClerkPlan(clerkPlans, entry.clerkSlugs);

  // Trial wording only when that plan really has a trial configured in Clerk. See
  // TRIAL_PLAN_KEYS: nothing at runtime can verify the dashboard toggle, so the
  // claim is opt-in rather than assumed.
  const label = paidCtaLabel(entry);

  if (clerkPlan?.id) {
    return (
      <CheckoutButton
        planId={clerkPlan.id}
        planPeriod={billingPeriod}
        onSubscriptionComplete={() => onCheckoutComplete(paidKey)}
        newSubscriptionRedirectUrl="/checks"
      >
        <Button
          variant="default"
          className={primaryClass}
          disabled={submitting}
          // Fires as the Clerk checkout drawer opens. Paired with `purchase` in
          // onCheckoutComplete, this is what makes the plan step measurable: the
          // gap between the two is the checkout abandon rate.
          onClick={() => onBeginCheckout(paidKey)}
        >
          {label}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </CheckoutButton>
    );
  }

  // Plan catalogue hasn't loaded, or the slug isn't in Clerk yet. Fall back to the
  // billing page so the user can finish checkout there.
  return (
    <Button
      variant="default"
      className={primaryClass}
      onClick={() => {
        onBeginCheckout(paidKey);
        onFallback(paidKey);
      }}
      disabled={submitting}
    >
      {label}
      <ArrowRight className="h-4 w-4" />
    </Button>
  );
}

// --- GA4 sign_up conversion ------------------------------------------------
// The app end of the marketing→signup funnel. The marketing site fires
// `sign_up_click` on CTA clicks and stitches sessions cross-domain via the
// shared GA4 property (G-TW8WXE2TZP); we fire `sign_up` on genuine new-account
// creation so the two land in one session.
//
// Trigger: first authenticated load of /onboarding. Every post-auth redirect
// (email + every OAuth provider) funnels through /onboarding, and already-
// onboarded users are redirected away before this page renders — so this is the
// universal "first load of a new account" signal, not a sign-IN.
//
// Fire-once is enforced by two independent guards:
//  1. a per-user localStorage flag — covers re-render, reload, StrictMode's
//     double-mount, and the OAuth redirect round-trip (all same-browser); and
//  2. an account-age window — covers the one case the flag can't: a returning,
//     not-yet-onboarded user signing IN on a fresh browser would re-render
//     onboarding with no local flag, but their account is no longer new.
const GA_SIGNUP_FIRED_PREFIX = 'exit1_ga_signup_fired:';
const NEW_ACCOUNT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function gaSignupAlreadyFired(userId: string): boolean {
  try {
    return localStorage.getItem(`${GA_SIGNUP_FIRED_PREFIX}${userId}`) === 'true';
  } catch {
    return false;
  }
}

function markGaSignupFired(userId: string) {
  try {
    localStorage.setItem(`${GA_SIGNUP_FIRED_PREFIX}${userId}`, 'true');
  } catch {
    // Storage unavailable (private mode / quota) — the account-age window still
    // bounds re-fires to within the new-account window on this browser.
  }
}

function resolveSignUpMethod(
  user: { externalAccounts?: { provider?: string }[] } | null | undefined,
): SignUpMethod {
  const provider = user?.externalAccounts?.[0]?.provider;
  if (!provider) return 'email';
  const normalized = provider.replace(/^oauth_/, '');
  if (normalized === 'google' || normalized === 'github' || normalized === 'discord') {
    return normalized;
  }
  return 'clerk';
}

function useSignUpAnalytics({
  userId,
  user,
}: {
  userId: string | null | undefined;
  user: ReturnType<typeof useUser>['user'];
}) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (!userId || !user || firedRef.current) return;
    if (gaSignupAlreadyFired(userId)) {
      firedRef.current = true;
      return;
    }
    const createdAt = user.createdAt?.getTime();
    if (!createdAt || Date.now() - createdAt > NEW_ACCOUNT_WINDOW_MS) return;

    firedRef.current = true;
    markGaSignupFired(userId);
    trackSignUp(resolveSignUpMethod(user));
  }, [userId, user]);
}
