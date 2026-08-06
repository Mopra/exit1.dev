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

export interface ContactPropertiesInput {
  signupDate?: string | null;
  tier: UserTier;
  onboarding?: OnboardingAnswers | null;
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
