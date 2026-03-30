import { useMemo } from "react";
import { useSubscription } from "@clerk/clerk-react/experimental";
import { useUser } from "@clerk/clerk-react";
import { getNanoSubscriptionItem, getScaleSubscriptionItem, isNanoPlan, isScalePlan } from "@/lib/subscription";
import { useAdminTierPreview } from "./useAdminTierPreview";

/**
 * Standardized hook for checking if user is on a paid plan.
 *
 * This hook ensures consistency across the codebase by:
 * - Using useSubscription() without enabled parameter (Clerk handles auth state)
 * - Checking publicMetadata.lifetimeNano for lifetime deal overrides
 * - Memoizing both nano/scale status for performance
 *
 * `nano` is true for ANY paid plan (nano or scale) — use it for feature gating.
 * `scale` is true only for scale plan — use it for scale-specific features (e.g. 15s intervals).
 *
 * @returns Object containing subscription data, nano status, scale status, and nanoItem
 */
export function useNanoPlan() {
  const { user } = useUser();
  const { data: subscription, isLoading, isFetching, error, revalidate } =
    useSubscription();

  const lifetimeNano = user?.publicMetadata?.lifetimeNano === true;
  const isAdmin = user?.publicMetadata?.admin === true;

  const { previewTier } = useAdminTierPreview();

  const nanoItem = useMemo(
    () => getScaleSubscriptionItem(subscription ?? null) ?? getNanoSubscriptionItem(subscription ?? null),
    [subscription]
  );

  // Real subscription state — never affected by admin preview. Use these in billing UI.
  const realScale = useMemo(
    () => isScalePlan(subscription ?? null),
    [subscription]
  );
  const realNano = useMemo(
    () => lifetimeNano || isNanoPlan(subscription ?? null) || realScale,
    [subscription, lifetimeNano, realScale]
  );

  // Preview-aware versions — admins use their selected preview tier for feature gates.
  const scale = useMemo(
    () => isAdmin ? previewTier === "scale" : realScale,
    [isAdmin, previewTier, realScale]
  );
  const nano = useMemo(
    () => isAdmin
      ? previewTier === "scale" || previewTier === "nano"
      : realNano,
    [isAdmin, previewTier, realNano]
  );

  return {
    subscription,
    nano,
    scale,
    realNano,
    realScale,
    nanoItem,
    isLoading,
    isFetching,
    error,
    revalidate,
  };
}
