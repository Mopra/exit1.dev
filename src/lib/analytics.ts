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
// creation, exactly once per account — see useSignUpAnalytics in Onboarding.tsx.
export function trackSignUp(method: SignUpMethod): void {
  trackEvent('sign_up', { method });
}
