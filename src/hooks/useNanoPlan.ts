import { useMemo } from "react";
import { useSubscription } from "@clerk/clerk-react/experimental";
import { useUser } from "@clerk/clerk-react";
import { getNanoSubscriptionItem, getScaleSubscriptionItem, isNanoPlan, isScalePlan } from "@/lib/subscription";

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

  const nanoItem = useMemo(
    () => getScaleSubscriptionItem(subscription ?? null) ?? getNanoSubscriptionItem(subscription ?? null),
    [subscription]
  );

  const scale = useMemo(
    () => isScalePlan(subscription ?? null),
    [subscription]
  );

  // nano = true for any paid plan (nano OR scale)
  const nano = useMemo(
    () => lifetimeNano || isNanoPlan(subscription ?? null) || scale,
    [subscription, lifetimeNano, scale]
  );

  return {
    subscription,
    nano,
    scale,
    nanoItem,
    isLoading,
    isFetching,
    error,
    revalidate,
  };
}
