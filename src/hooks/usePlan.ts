import { useMemo } from "react";
import { useSubscription } from "@clerk/clerk-react/experimental";
import { useUser } from "@clerk/clerk-react";
import { resolvePlanKey } from "@/lib/subscription";
import { useAdminTierPreview } from "./useAdminTierPreview";

export type Tier = "free" | "nano" | "pro" | "agency";

/**
 * Clerk plan slug → resolved tier. Mirrors the backend `PLAN_KEY_TO_TIER`
 * map in `functions/src/init.ts`. Exact-key match only (no substring).
 */
const PLAN_KEY_TO_TIER: Record<string, Tier> = {
  free_user: "free",
  nano: "pro",      // Founders — grandfathered to Pro entitlements
  nanov2: "nano",   // new Nano
  pro: "pro",
  agency: "agency",
  scale: "agency",  // legacy, no subscribers
  starter: "nano",  // legacy
};

function tierFromPlanKey(planKey: string | null | undefined): Tier {
  if (!planKey) return "free";
  return PLAN_KEY_TO_TIER[planKey] ?? "free";
}

/**
 * Map admin preview values to the new tier vocabulary. `useAdminTierPreview`
 * emits the full 'agency' | 'pro' | 'nano' | 'free' enum and internally
 * migrates any legacy "scale" localStorage value to "agency" on read, so we
 * only need to guard against unexpected strings here.
 */
function normalizePreviewTier(preview: string | null | undefined): Tier {
  switch (preview) {
    case "agency":
    case "pro":
    case "nano":
    case "free":
      return preview;
    default:
      return "agency";
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
 *     'agency' and can override via the admin preview (localStorage).
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

  // Effective tier — admins default to 'agency' entitlements but can preview
  // any tier via the admin preview. Non-admins always use their real tier.
  const tier = useMemo<Tier>(() => {
    if (isAdmin) return normalizePreviewTier(previewTier);
    return realTier;
  }, [isAdmin, previewTier, realTier]);

  const paid = tier !== "free";
  // `nano` = "any paid plan" for back-compat with old useNanoPlan call sites.
  const nano = tier === "nano" || tier === "pro" || tier === "agency";
  const pro = tier === "pro" || tier === "agency";
  const agency = tier === "agency";
  // `scale` kept as a deprecated alias for `agency` so existing call sites
  // that only test `scale` (e.g. 15s intervals) keep working unchanged.
  const scale = agency;

  return {
    tier,
    realTier,
    subscribedPlanKey,
    isFounders,
    // Back-compat booleans:
    paid,
    nano,
    pro,
    agency,
    /** @deprecated alias for `agency` */
    scale,
    // Pass-through from useSubscription():
    subscription,
    isLoading,
    isFetching,
    error,
    revalidate,
  };
}
