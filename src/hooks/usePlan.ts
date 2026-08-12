import { useMemo } from "react";
import { useSubscription } from "@clerk/clerk-react/experimental";
import { useUser } from "@clerk/clerk-react";
import { getTierLimits, resolvePlanKey } from "@/lib/subscription";
import { useAdminTierPreview } from "./useAdminTierPreview";

export type Tier = "free" | "indie" | "nano" | "pro";

/**
 * Clerk plan slug → resolved tier. Mirrors the backend `PLAN_KEY_TO_TIER`
 * map in `functions/src/init.ts`. Exact-key match only (no substring).
 */
const PLAN_KEY_TO_TIER: Record<string, Tier> = {
  free_user: "free",
  indie: "indie",   // new Indie tier
  nano: "pro",      // Founders — grandfathered to Pro entitlements
  nanov2: "nano",   // new Nano
  pro: "pro",
  agency: "pro",    // retired tier — Pro carries every Agency entitlement
  scale: "pro",     // legacy, no subscribers
  starter: "nano",  // legacy
};

function tierFromPlanKey(planKey: string | null | undefined): Tier {
  if (!planKey) return "free";
  return PLAN_KEY_TO_TIER[planKey] ?? "free";
}

/**
 * Map admin preview values to the current tier vocabulary. `useAdminTierPreview`
 * emits the full 'pro' | 'nano' | 'indie' | 'free' enum and internally migrates
 * legacy "scale"/"agency" localStorage values to "pro" on read, so we only need
 * to guard against unexpected strings here.
 */
function normalizePreviewTier(preview: string | null | undefined): Tier {
  switch (preview) {
    case "pro":
    case "nano":
    case "indie":
    case "free":
      return preview;
    default:
      return "pro";
  }
}

/**
 * Unified plan/tier hook. Returns the resolved effective tier plus a small
 * set of back-compat boolean flags so existing call sites that expected
 * `{ nano, scale }` from the old `useNanoPlan` hook still compile.
 *
 * Two separate tier values:
 *   - `realTier`: the user's *actual* subscription tier, ignoring admin
 *     status and preview overrides. Billing UI should use this.
 *   - `tier`: the *effective* tier used for entitlements. Admins default to
 *     'pro' and can override via the admin preview (localStorage).
 *
 * Resolution priority for `realTier`:
 *   1. `publicMetadata.lifetimeNano === true` → 'pro' (legacy Founders metadata)
 *   2. Active Clerk subscription item's plan slug via `PLAN_KEY_TO_TIER`
 *   3. 'free' when no active paid item
 */
export function usePlan() {
  const { user } = useUser();
  const { data: subscription, isLoading, isFetching, error, revalidate } =
    useSubscription();

  const isAdmin = user?.publicMetadata?.admin === true;
  const lifetimeNano = user?.publicMetadata?.lifetimeNano === true;

  const { previewTier } = useAdminTierPreview();

  // Raw plan slug of the active paid item (null for free).
  const subscribedPlanKey = useMemo(
    () => resolvePlanKey(subscription ?? null),
    [subscription]
  );

  const isFounders = subscribedPlanKey === "nano";

  // Real (non-preview) tier — reflects the user's actual subscription.
  // Admin status does NOT inflate this value; admins see their true billing
  // state on the Billing page while still getting elevated `tier` below.
  const realTier = useMemo<Tier>(() => {
    if (lifetimeNano) {
      if (typeof console !== "undefined" && console.debug) {
        console.debug(
          "[usePlan] lifetimeNano override → pro (legacy Founders metadata)"
        );
      }
      return "pro";
    }
    return tierFromPlanKey(subscribedPlanKey);
  }, [lifetimeNano, subscribedPlanKey]);

  // Effective tier — admins default to 'pro' entitlements but can preview
  // any tier via the admin preview. Non-admins always use their real tier.
  const tier = useMemo<Tier>(() => {
    if (isAdmin) return normalizePreviewTier(previewTier);
    return realTier;
  }, [isAdmin, previewTier, realTier]);

  /**
   * The full limit row for the effective tier. Every entitlement below is
   * derived from this rather than from a tier comparison, so a repricing only
   * has to touch `TIER_LIMITS_MIRROR`.
   */
  const limits = useMemo(() => getTierLimits(tier), [tier]);

  /** Effective check ceiling for this user — always prefer this over the tier cap. */
  const maxChecks = limits.maxChecks;

  const paid = tier !== "free";
  // `nano` = "Nano-or-better entitlements". Kept for back-compat with old
  // useNanoPlan call sites, but prefer the named entitlement flags below —
  // `nano` conflates three separate features and silently mis-gates Indie.
  const nano = tier === "nano" || tier === "pro";
  const pro = tier === "pro";
  const indie = tier === "indie";
  /** @deprecated Agency was retired and folded into Pro. Alias for `pro`. */
  const agency = pro;
  /** @deprecated legacy alias for `pro`. */
  const scale = pro;

  return {
    tier,
    realTier,
    subscribedPlanKey,
    isFounders,
    maxChecks,
    limits,
    // Named entitlements — read these, not the tier booleans. `apiAccess` in
    // particular is NOT `paid`: Free mints one API key (and therefore has MCP).
    apiAccess: limits.apiAccess,
    maxApiKeys: limits.maxApiKeys,
    statusPageBuilder: limits.statusPageBuilder,
    domainIntel: limits.domainIntel,
    maintenanceMode: limits.maintenanceMode,
    smsAlerts: limits.smsAlerts,
    csvExport: limits.csvExport,
    allAlertChannels: limits.allAlertChannels,
    regionChoice: limits.regionChoice,
    retentionDays: limits.retentionDays,
    // Back-compat booleans:
    paid,
    nano,
    pro,
    indie,
    /** @deprecated Agency was retired — alias for `pro` */
    agency,
    /** @deprecated alias for `pro` */
    scale,
    // Pass-through from useSubscription():
    subscription,
    isLoading,
    isFetching,
    error,
    revalidate,
  };
}
