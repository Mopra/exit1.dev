import * as logger from "firebase-functions/logger";
import { Resend } from "resend";

// Topic IDs — Resend audience topics created manually in the Resend dashboard.
// All topics default to opt_in in Resend; we still explicitly opt new users in
// so preference-center tooling has concrete records to render.
export const RESEND_TOPICS = {
  reengagement: "96b517cd-a0ee-46c1-a024-bd71751f5d29",
  onboarding: "26b144fa-baf6-4251-9811-3abab0819aaa",
  promotions: "b4568a4b-8b6e-4979-adfb-39097cd3a72e",
  educational: "687a6891-521e-492f-b83b-77568ae471d5",
  product_updates: "750d26ea-1434-442e-b2c9-ba16feca9142",
} as const;

export const RESEND_TOPIC_IDS: string[] = Object.values(RESEND_TOPICS);

// Onboarding option sets — kept in sync with onboarding.ts validation.
// Each option becomes its own boolean-valued string property in Resend so the
// marketing manager can filter precisely (e.g. "users whose source includes Reddit").
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

export type UserTier = "free" | "nano" | "pro" | "agency";

interface PropertyDef {
  key: string;
  type: "string" | "number";
  fallbackValue: string | number | null;
}

// Single source of truth for every custom property we register in Resend.
// Adding a new property? Add it here and re-run the resync — registration is idempotent.
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

// Resend rate limit is 2 req/sec. Every API call that hits Resend should flow
// through this so we don't get 429s during backfills.
export const RESEND_RATE_LIMIT_MS = 600;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Produce the full property map for a user. Values that can't be derived are
 * omitted so Resend falls back to the property's fallbackValue instead of us
 * writing an incorrect default (e.g. overwriting a real team_size with "").
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
 * Idempotently register every property in PROPERTY_DEFS. Resend returns an
 * "already exists" style error for duplicates which we swallow. Any other
 * failure is logged but does not abort — the caller still attempts the update
 * and gets a clean error if a property is genuinely missing.
 */
export async function registerResendSchema(apiKey: string): Promise<{
  created: string[];
  existed: string[];
  failed: Array<{ key: string; error: string }>;
}> {
  const resend = new Resend(apiKey);
  const created: string[] = [];
  const existed: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const def of PROPERTY_DEFS) {
    try {
      const createOpts =
        def.type === "string"
          ? {
              key: def.key,
              type: "string" as const,
              fallbackValue:
                typeof def.fallbackValue === "string"
                  ? def.fallbackValue
                  : null,
            }
          : {
              key: def.key,
              type: "number" as const,
              fallbackValue:
                typeof def.fallbackValue === "number"
                  ? def.fallbackValue
                  : null,
            };

      const { error } = await resend.contactProperties.create(createOpts);

      if (error) {
        const msg = error.message || "";
        if (/already exists|duplicate|unique/i.test(msg)) {
          existed.push(def.key);
        } else {
          failed.push({ key: def.key, error: msg });
          logger.warn("Failed to register Resend property", {
            key: def.key,
            error: msg,
          });
        }
      } else {
        created.push(def.key);
        logger.info("Registered Resend property", { key: def.key });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ key: def.key, error: message });
      logger.warn("Exception registering Resend property", {
        key: def.key,
        error: message,
      });
    }

    await sleep(RESEND_RATE_LIMIT_MS);
  }

  return { created, existed, failed };
}

/**
 * Update a contact's custom properties. If the contact doesn't exist yet,
 * create it with the properties attached — that's the shape we want for the
 * subscription webhook where the user may not yet be in Resend (e.g. legacy
 * signups that pre-date the clerk webhook).
 */
export async function upsertContactProperties(
  resend: Resend,
  email: string,
  properties: Record<string, string>,
  fallback: {
    firstName?: string | null;
    lastName?: string | null;
  } = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await resend.contacts.update({
      email,
      properties,
    });

    if (!error) return { success: true };

    const msg = error.message || "";
    const isMissing = /not found|does not exist/i.test(msg);

    if (!isMissing) {
      return { success: false, error: msg };
    }

    // Contact missing — create with properties attached.
    const { error: createError } = await resend.contacts.create({
      email,
      firstName: fallback.firstName || undefined,
      lastName: fallback.lastName || undefined,
      properties,
    });

    if (createError) {
      return { success: false, error: createError.message };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

interface SyncTopicsOptions {
  /**
   * When true, preserves any existing subscription state — only topics without
   * an explicit record are opted in. Use for bulk resyncs to avoid overwriting
   * manual opt-outs. Adds one extra API call per user.
   */
  preserveExisting?: boolean;
}

/**
 * Opt a contact in to every tracked topic. Resend topic defaults handle this
 * for new contacts automatically, but we still write explicit records so the
 * future preference center has data to render. When preserveExisting is set,
 * any topic with an existing opt_out is left untouched.
 */
export async function syncContactTopics(
  resend: Resend,
  email: string,
  options: SyncTopicsOptions = {},
): Promise<{ success: boolean; updated: number; error?: string }> {
  try {
    let targetIds = RESEND_TOPIC_IDS;

    if (options.preserveExisting) {
      const { data, error } = await resend.contacts.topics.list({
        email,
        limit: 100,
      });
      if (error) {
        const msg = error.message || "";
        // Contact not found — nothing to preserve, fall through with full opt-in.
        if (!/not found|does not exist/i.test(msg)) {
          return { success: false, updated: 0, error: msg };
        }
      } else {
        const recorded = new Set((data?.data ?? []).map((t) => t.id));
        targetIds = RESEND_TOPIC_IDS.filter((id) => !recorded.has(id));
      }
    }

    if (targetIds.length === 0) {
      return { success: true, updated: 0 };
    }

    const { error } = await resend.contacts.topics.update({
      email,
      topics: targetIds.map((id) => ({ id, subscription: "opt_in" as const })),
    });

    if (error) {
      return { success: false, updated: 0, error: error.message };
    }
    return { success: true, updated: targetIds.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, updated: 0, error: message };
  }
}

/**
 * Format a Clerk createdAt timestamp (milliseconds) as an ISO date (YYYY-MM-DD).
 * Resend properties are string-typed; dropping the time component keeps filters
 * in the Resend UI readable.
 */
export function formatSignupDate(createdAt: number | null | undefined): string | null {
  if (!createdAt || !Number.isFinite(createdAt)) return null;
  return new Date(createdAt).toISOString().slice(0, 10);
}
