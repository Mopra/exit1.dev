// ============================================================================
// PROVIDER-NEUTRAL CONTACT MODEL
//
// The shape of a marketing contact — property keys, onboarding option sets, and
// the derivation of a user's property map. Shared by the Resend adapter
// (resend-sync.ts) and the Day3 adapter (day3-sync.ts).
//
// Adding a new property? Add it to PROPERTY_DEFS here, then re-run the Resend
// resync (registers it there) and scripts/day3-scaffold.mjs (registers it in
// Day3). Both registrations are idempotent.
// ============================================================================

// Onboarding option sets — kept in sync with onboarding.ts validation.
// Each option becomes its own boolean-valued string property so the marketing
// manager can filter precisely (e.g. "users whose source includes Reddit").
export const SOURCE_KEYS = [
  "google",
  "reddit",
  "ai_assistant",
  "twitter",
  "product_hunt",
  "hacker_news",
  "friend",
  "blog",
  "other",
] as const;

export const USE_CASE_KEYS = [
  "infrastructure",
  "ecommerce",
  "client_sites",
  "saas",
  "personal",
  "agency",
  "other",
] as const;

export type UserTier = "free" | "indie" | "nano" | "pro";

export interface PropertyDef {
  key: string;
  type: "string" | "number";
  fallbackValue: string | number | null;
}

// Single source of truth for every custom property we register with an email
// provider.
export const PROPERTY_DEFS: PropertyDef[] = [
  { key: "signup_date", type: "string", fallbackValue: "" },
  { key: "plan_tier", type: "string", fallbackValue: "free" },
  { key: "team_size", type: "string", fallbackValue: "" },
  // ---- Activation state ----
  //
  // Everything above describes who the user said they were at signup. These five
  // describe what they have actually done, which is what decides whether they
  // stay. Without them you can segment "solo developers from Reddit" but not
  // "signed up eight days ago, owns one monitor, cannot be alerted", and the
  // second list is the one worth emailing.
  //
  // Refreshed by the lifecycle sweep (functions/src/lifecycle.ts), not on write,
  // so they lag by up to a day. Strings only: Day3 rejects a whole batch if any
  // attribute value is a number or boolean.
  { key: "check_count", type: "string", fallbackValue: "0" },
  { key: "checks_alertable", type: "string", fallbackValue: "0" },
  { key: "has_alert_channel", type: "string", fallbackValue: "false" },
  { key: "first_incident_date", type: "string", fallbackValue: "" },
  { key: "last_active_date", type: "string", fallbackValue: "" },
  ...SOURCE_KEYS.map((k) => ({
    key: `source_${k}`,
    type: "string" as const,
    fallbackValue: "false",
  })),
  ...USE_CASE_KEYS.map((k) => ({
    key: `use_case_${k}`,
    type: "string" as const,
    fallbackValue: "false",
  })),
];

export const PROPERTY_KEYS: string[] = PROPERTY_DEFS.map((d) => d.key);

export interface OnboardingAnswers {
  sources: string[];
  useCases: string[];
  teamSize: string | null;
}

/**
 * What the user has actually done. Every field is optional: omitting one leaves
 * the provider's existing value alone, which matters because the onboarding
 * submit path knows the answers but not the activation state, and the lifecycle
 * sweep knows the activation state but should not clobber the answers.
 */
export interface ActivationState {
  checkCount?: number;
  checksAlertable?: number;
  hasAlertChannel?: boolean;
  /**
   * Milliseconds, or null when no outage has ever been observed. Derived from
   * `lastDowntime`, so the presence of a value is exact and the date is a lower
   * bound. See UserCoverage.firstIncidentAt in alert-coverage.ts.
   */
  firstIncidentAt?: number | null;
  /** Milliseconds of last sign-in, or null when unknown. */
  lastActiveAt?: number | null;
}

export interface ContactPropertiesInput {
  signupDate?: string | null;
  tier: UserTier;
  onboarding?: OnboardingAnswers | null;
  activation?: ActivationState | null;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Produce the full property map for a user. Values that can't be derived are
 * omitted so the provider falls back to the property's registered fallback
 * instead of us writing an incorrect default (e.g. overwriting a real
 * team_size with "").
 *
 * Every value is a string. Day3 rejects an entire batch if any attribute value
 * is a number or boolean, so this invariant matters beyond just typing —
 * see assertStringAttributes in day3-sync.ts for the runtime guard.
 */
export function buildPropertiesForUser(
  input: ContactPropertiesInput,
): Record<string, string> {
  const props: Record<string, string> = {
    plan_tier: input.tier,
  };

  if (input.signupDate) {
    props.signup_date = input.signupDate;
  }

  const onboarding = input.onboarding;
  if (onboarding) {
    if (onboarding.teamSize) {
      props.team_size = onboarding.teamSize;
    }
    const sourceSet = new Set(onboarding.sources);
    for (const key of SOURCE_KEYS) {
      props[`source_${key}`] = sourceSet.has(key) ? "true" : "false";
    }
    const useCaseSet = new Set(onboarding.useCases);
    for (const key of USE_CASE_KEYS) {
      props[`use_case_${key}`] = useCaseSet.has(key) ? "true" : "false";
    }
  }

  const activation = input.activation;
  if (activation) {
    if (typeof activation.checkCount === "number") {
      props.check_count = String(activation.checkCount);
    }
    if (typeof activation.checksAlertable === "number") {
      props.checks_alertable = String(activation.checksAlertable);
    }
    if (typeof activation.hasAlertChannel === "boolean") {
      props.has_alert_channel = activation.hasAlertChannel ? "true" : "false";
    }
    // `undefined` means "not known, leave it alone"; explicit `null` means
    // "known to have never happened", which is a real value worth writing.
    if (activation.firstIncidentAt !== undefined) {
      props.first_incident_date = formatSignupDate(activation.firstIncidentAt) ?? "";
    }
    if (activation.lastActiveAt !== undefined) {
      props.last_active_date = formatSignupDate(activation.lastActiveAt) ?? "";
    }
  }

  return props;
}

/**
 * Format a Clerk createdAt timestamp (milliseconds) as an ISO date
 * (YYYY-MM-DD). Provider properties are string-typed; dropping the time
 * component keeps filters in the provider UI readable.
 *
 * This is the only place a user's original signup date survives into Day3 —
 * Day3 ignores `created_at` on import, so the contact's own creation date is
 * always the import date.
 */
export function formatSignupDate(
  createdAt: number | null | undefined,
): string | null {
  if (!createdAt || !Number.isFinite(createdAt)) return null;
  return new Date(createdAt).toISOString().slice(0, 10);
}
