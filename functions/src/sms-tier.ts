/**
 * Pure SMS-eligibility tier resolution.
 *
 * SMS is the only Pro-exclusive feature gated off `check.userTier` — a
 * DENORMALISED copy of the user's tier stamped onto each check doc. That copy
 * drifts, and when it under-states the tier the SMS gate in triggerAlert
 * (`smsTier !== 'pro'`) silently drops every text while email, which has no
 * tier gate, keeps firing. Users see "email arrived, SMS didn't" with nothing
 * in the way of an error.
 *
 * How the drift happens: `backfillCheckUserTier` re-stamps check docs on
 * downgrades and on subscription-webhook upgrades. But a Pro grant made through
 * Clerk publicMetadata (`lifetimeNano`, `admin` — see init.ts
 * fetchTierFromClerk) fires NO subscription webhook, so nothing ever backfills.
 * Checks created while the user was on Nano stay stamped 'nano' indefinitely.
 *
 * The rule below therefore treats a non-Pro cached value as inconclusive rather
 * than authoritative: only 'pro' is trusted outright, because it can never
 * under-state entitlements. Anything else is re-checked against
 * `users/{uid}.tier` (and the admin flag) before SMS is denied.
 *
 * Kept IO-free so the decision is directly testable.
 */

export type SmsTier = 'free' | 'indie' | 'nano' | 'pro';

/**
 * Map any stored tier value — current, legacy, or junk — onto the current
 * lineup. Returns null for values we cannot interpret, which callers MUST treat
 * as "unknown", never as "free".
 *
 * Legacy values: 'scale'/'agency' → pro, 'premium' → nano.
 */
export function normalizeTierValue(value: unknown): SmsTier | null {
  if (value === 'pro' || value === 'agency' || value === 'scale') return 'pro';
  if (value === 'nano' || value === 'premium') return 'nano';
  if (value === 'indie') return 'indie';
  if (value === 'free') return 'free';
  return null;
}

/**
 * True when the cached check-doc value alone settles the question, so callers
 * can skip the user-doc read entirely. Only 'pro' qualifies.
 */
export function isConclusiveCachedTier(cachedCheckTier: unknown): boolean {
  return normalizeTierValue(cachedCheckTier) === 'pro';
}

/**
 * Decide the SMS tier from every source available.
 *
 * @param cachedCheckTier  `check.userTier` — the denormalised, drift-prone copy
 * @param userDocTier      `users/{uid}.tier` — authoritative; null if unreadable
 * @param isAdmin          `users/{uid}.admin` — admins are treated as Pro
 */
export function decideSmsTier(
  cachedCheckTier: unknown,
  userDocTier: unknown,
  isAdmin: boolean,
): SmsTier {
  const cached = normalizeTierValue(cachedCheckTier);
  const authoritative = normalizeTierValue(userDocTier);

  // Either source claiming Pro is enough. The check doc can lag behind an
  // upgrade; the user doc can lag behind a brand-new check that was stamped at
  // creation time. Neither can be trusted to be the fresher of the two, so take
  // the entitlement if either has it.
  if (cached === 'pro' || authoritative === 'pro') return 'pro';
  if (isAdmin) return 'pro';

  // Neither is Pro, which is all the SMS gate cares about. Prefer the
  // authoritative value for the budget-tier lookups downstream.
  return authoritative ?? cached ?? 'free';
}

/**
 * True when the check doc under-states the user's real tier — i.e. the drift
 * that suppressed SMS. Callers log this so the condition is observable rather
 * than silent.
 */
export function isTierDriftUnderstated(cachedCheckTier: unknown, userDocTier: unknown): boolean {
  const rank: Record<SmsTier, number> = { free: 0, indie: 1, nano: 2, pro: 3 };
  const cached = normalizeTierValue(cachedCheckTier);
  const authoritative = normalizeTierValue(userDocTier);
  if (authoritative === null) return false;
  if (cached === null) return true;
  return rank[cached] < rank[authoritative];
}
