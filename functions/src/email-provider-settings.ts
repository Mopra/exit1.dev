// ============================================================================
// TRANSACTIONAL EMAIL PROVIDER FLAG (Firestore: system_settings/email_provider)
//
// The switch that decides whether a transactional email leaves via Resend or
// Day3. Read on every send, so it is cached behind a TTL exactly like
// peer-settings.ts — and, like that module, it is imported by alert-email.ts
// which runs inside the VPS runner, so it must stay free of Cloud Function
// definitions (onCall/onRequest live in admin.ts).
//
// Rollback shape: set `provider` back to "resend" in Firestore and every
// sender follows within one cache TTL. POST /admin/refresh-flags on the runner
// makes it immediate.
//
// Fail-safe semantics: any read failure keeps the last good value, and with no
// last-good value we default to Resend — the provider that has been delivering
// this product's mail all along. A Firestore outage must never be able to move
// traffic onto the newer provider.
// ============================================================================

import { logger } from 'firebase-functions/v2';
import { firestore } from './init.js';
import { CONFIG } from './config.js';

export type EmailProvider = 'resend' | 'day3';

/**
 * Send sites are grouped so the migration can advance one blast radius at a
 * time instead of flipping all 15 at once. Ordered by how much a bad send
 * costs us:
 *
 *  - internal: operator/feedback/SMS-forward mail. Nobody outside the team
 *    sees it, so this is the natural canary.
 *  - test:     user-triggered "send me a test email". The user is watching,
 *    and a failure is instantly visible and harmless — the best real-world
 *    signal before touching anything automatic.
 *  - account:  quota warnings, webhook-failure notices, bounce notices.
 *    Low volume, not time-critical.
 *  - alerts:   DOWN/UP, SSL, DNS, domain expiry. The product. Highest volume,
 *    most latency-sensitive, and the one where a missed send is a real
 *    incident for a customer. Move last.
 */
export type EmailCategory = 'internal' | 'test' | 'account' | 'alerts';

export const EMAIL_CATEGORIES: EmailCategory[] = ['internal', 'test', 'account', 'alerts'];

export interface EmailProviderSettings {
  /** Default provider for any category without an explicit override. */
  provider: EmailProvider;
  /** Per-category overrides; absent keys inherit `provider`. */
  categories: Partial<Record<EmailCategory, EmailProvider>>;
  /**
   * Percentage (0-100) of recipients to route to Day3 within categories that
   * are still resolving to Resend. Lets alerts ramp 1% → 10% → 50% instead of
   * flipping a switch on the whole fleet. Hashed on the recipient address so a
   * given person consistently gets one provider rather than alternating.
   */
  canaryPercent: number;
  /**
   * When a Day3 send fails, try the same message through Resend before giving
   * up. On by default: for an uptime monitor a duplicate alert is a nuisance
   * but a missing one is the product failing. Turn it off only once Day3 has
   * earned the traffic, or when deliberately measuring Day3's true error rate.
   */
  fallbackToResend: boolean;
  /** When we last refreshed from Firestore. */
  checkedAt: number;
}

const EMAIL_PROVIDER_DOC = 'system_settings/email_provider';

export const DEFAULT_EMAIL_PROVIDER_SETTINGS: Omit<EmailProviderSettings, 'checkedAt'> = {
  provider: 'resend',
  categories: {},
  canaryPercent: 0,
  fallbackToResend: true,
};

let cached: EmailProviderSettings | null = null;
let inFlight: Promise<EmailProviderSettings> | null = null;
// Bumped on every cache invalidation. Any in-flight fetch that started before
// the bump must NOT write its (now-stale) result to `cached`.
let invalidationGeneration = 0;

const isProvider = (value: unknown): value is EmailProvider =>
  value === 'resend' || value === 'day3';

/**
 * Coerce a raw Firestore document into settings. Anything unrecognised falls
 * back to the Resend-shaped default rather than throwing — a typo in the admin
 * doc should degrade to "keep doing what we were doing", not break sending.
 */
export function parseEmailProviderSettings(
  data: Record<string, unknown> | null | undefined,
  now: number,
): EmailProviderSettings {
  const categories: Partial<Record<EmailCategory, EmailProvider>> = {};
  const rawCategories = data?.categories;
  if (rawCategories && typeof rawCategories === 'object') {
    for (const category of EMAIL_CATEGORIES) {
      const value = (rawCategories as Record<string, unknown>)[category];
      if (isProvider(value)) categories[category] = value;
    }
  }

  const rawPercent = data?.canaryPercent;
  const canaryPercent = typeof rawPercent === 'number' && Number.isFinite(rawPercent)
    ? Math.min(100, Math.max(0, rawPercent))
    : 0;

  return {
    provider: isProvider(data?.provider) ? data.provider : 'resend',
    categories,
    canaryPercent,
    // Only an explicit `false` disables the fallback; a missing field keeps the
    // safety net on.
    fallbackToResend: data?.fallbackToResend !== false,
    checkedAt: now,
  };
}

async function fetchEmailProviderSettings(): Promise<EmailProviderSettings> {
  try {
    const doc = await firestore.doc(EMAIL_PROVIDER_DOC).get();
    return parseEmailProviderSettings(
      doc.exists ? (doc.data() as Record<string, unknown>) : null,
      Date.now(),
    );
  } catch (err) {
    logger.debug(`[email-provider] Firestore read failed: ${String(err)}`);
    // Fail-safe to last cached value, or all-Resend if we have none.
    return cached ?? { ...DEFAULT_EMAIL_PROVIDER_SETTINGS, checkedAt: Date.now() };
  }
}

export async function getEmailProviderSettings(): Promise<EmailProviderSettings> {
  const now = Date.now();
  if (cached && now - cached.checkedAt < CONFIG.EMAIL_PROVIDER_CACHE_TTL_MS) {
    return cached;
  }
  // Coalesce concurrent refreshes — an alert storm expiring the TTL would
  // otherwise fire one Firestore read per queued send.
  if (inFlight) return inFlight;
  const startedAtGen = invalidationGeneration;
  inFlight = fetchEmailProviderSettings()
    .then((next) => {
      // Drop the result if invalidate*() ran between fetch start and now — the
      // read may have observed pre-invalidation state.
      if (startedAtGen !== invalidationGeneration) {
        return next;
      }
      const before = cached;
      cached = next;
      if (
        before &&
        (before.provider !== next.provider ||
          before.canaryPercent !== next.canaryPercent ||
          JSON.stringify(before.categories) !== JSON.stringify(next.categories) ||
          before.fallbackToResend !== next.fallbackToResend)
      ) {
        logger.info('[email-provider] settings changed', {
          provider: next.provider,
          categories: next.categories,
          canaryPercent: next.canaryPercent,
          fallbackToResend: next.fallbackToResend,
        });
      }
      return next;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Force the next getEmailProviderSettings() to bypass the cache. Called from
 * the runner's /admin/refresh-flags endpoint so a rollback lands in seconds
 * rather than waiting out the TTL.
 */
export function invalidateEmailProviderCache(): void {
  cached = null;
  invalidationGeneration++;
}

/** Last cached value without triggering a refresh — for /health surfacing. */
export function peekEmailProviderSettings(): EmailProviderSettings | null {
  return cached;
}

/**
 * Stable 0-99 bucket for an address. FNV-1a: we need "the same recipient always
 * lands in the same bucket" and nothing more, so a tiny non-cryptographic hash
 * is the right tool. Deliberately not Math.random() — a per-send coin flip
 * would split one user's alerts across two providers and make a deliverability
 * problem impossible to attribute.
 */
export function canaryBucket(email: string): number {
  const normalized = email.trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/**
 * Resolve which provider should carry one message. Pure, so the routing table
 * is unit-testable without Firestore.
 */
export function resolveProvider(
  settings: Pick<EmailProviderSettings, 'provider' | 'categories' | 'canaryPercent'>,
  category: EmailCategory,
  recipient: string,
): EmailProvider {
  const resolved = settings.categories[category] ?? settings.provider;
  if (resolved === 'day3') return 'day3';
  // Still on Resend — the canary ramp is the only way onto Day3 from here.
  if (settings.canaryPercent > 0 && canaryBucket(recipient) < settings.canaryPercent) {
    return 'day3';
  }
  return 'resend';
}
