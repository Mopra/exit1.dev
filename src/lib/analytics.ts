// Thin, typed wrapper around the gtag.js snippet bootstrapped in index.html
// (GA4 property G-TW8WXE2TZP, the same stream the marketing site uses so the
// signup funnel stitches into one cross-domain session).
//
// `window.gtag` is defined synchronously by the inline snippet in <head>, so it
// exists by the time any React code runs — even while the async gtag.js library
// is still downloading, calls just queue in `dataLayer`.

type GtagArgs =
  | ['js', Date]
  | ['config', string, Record<string, unknown>?]
  | ['event', string, Record<string, unknown>?];

declare global {
  interface Window {
    gtag?: (...args: GtagArgs) => void;
    dataLayer?: unknown[];
  }
}

// Methods we actually expose on the sign-up screen (SignUpForm.tsx). 'email' is
// the password path; the rest are Clerk OAuth providers.
export type SignUpMethod = 'email' | 'google' | 'github' | 'discord' | 'clerk';

export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  window.gtag('event', name, params ?? {});
}

// GA4 recommended `sign_up` conversion event. Fire ONLY on genuine new-account
// creation, exactly once per account. See useSignUpAnalytics in Onboarding.tsx.
export function trackSignUp(method: SignUpMethod): void {
  trackEvent('sign_up', { method });
}

// ---------------------------------------------------------------------------
// Onboarding funnel
// ---------------------------------------------------------------------------
//
// Until these existed the only two signals were `sign_up` on first load and the
// `submitOnboardingResponse` callable at the very end, and the BigQuery table
// only ever received completed responses. That measured survivors, not a funnel:
// there was no way to see which step people abandoned, or how many reached the
// plan picker and left. Every step now reports on view, and the plan picker
// reports the standard GA4 ecommerce trio so it shows up in the funnel report.

/** Stable slugs so a step reorder does not break historical reporting. */
export type OnboardingStepName =
  | 'sources'
  | 'use_cases'
  | 'team_size'
  | 'first_check'
  | 'alerts'
  | 'plan';

export function trackOnboardingStep(step: OnboardingStepName, index: number, total: number): void {
  trackEvent('onboarding_step_viewed', { step, step_index: index + 1, step_total: total });
}

export function trackOnboardingSkip(step: OnboardingStepName): void {
  trackEvent('onboarding_step_skipped', { step });
}

/** Fired when the alert step actually writes a channel, not when it renders. */
export function trackOnboardingAlertsEnabled(source: 'button' | 'already_configured'): void {
  trackEvent('onboarding_alerts_enabled', { source });
}

export function trackOnboardingComplete(planChoice: string, hadCheck: boolean, hadAlerts: boolean): void {
  trackEvent('onboarding_complete', {
    plan_choice: planChoice,
    had_check: hadCheck,
    had_alerts: hadAlerts,
  });
}

// GA4 ecommerce events for the plan picker. `value` is the annualised price so
// monthly and annual purchases are comparable in one report.
export function trackBeginCheckout(planKey: string, period: string, value: number): void {
  trackEvent('begin_checkout', {
    currency: 'USD',
    value,
    items: [{ item_id: planKey, item_name: planKey, item_category: 'plan', price: value }],
  });
  trackEvent('onboarding_plan_selected', { plan: planKey, period });
}

export function trackPurchase(planKey: string, period: string, value: number): void {
  trackEvent('purchase', {
    currency: 'USD',
    value,
    // GA4 dedupes `purchase` on transaction_id. Clerk owns the real subscription
    // id and does not hand it back to the CTA callback, so this is scoped to the
    // plan and period instead: good enough to stop a double-fire from one
    // checkout, and it never collides across plans.
    transaction_id: `onboarding-${planKey}-${period}`,
    items: [{ item_id: planKey, item_name: planKey, item_category: 'plan', price: value }],
  });
}
