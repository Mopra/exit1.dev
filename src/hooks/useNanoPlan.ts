import { useMemo } from "react";
import { useSubscription } from "@clerk/clerk-react/experimental";
import { useUser } from "@clerk/clerk-react";
import { getNanoSubscriptionItem, isNanoPlan } from "@/lib/subscription";

/**
 * Standardized hook for checking if user is on Nano plan.
 *
 * This hook ensures consistency across the codebase by:
 * - Using useSubscription() without enabled parameter (Clerk handles auth state)
 * - Checking publicMetadata.lifetimeNano for lifetime deal overrides
 * - Memoizing both nano status and nanoItem for performance
 *
 * @returns Object containing subscription data, nano status, and nanoItem
 */
export function useNanoPlan() {
  const { user } = useUser();
  const { data: subscription, isLoading, isFetching, error, revalidate } =
    useSubscription();

  const lifetimeNano = user?.publicMetadata?.lifetimeNano === true;

  const nanoItem = useMemo(
    () => getNanoSubscriptionItem(subscription ?? null),
    [subscription]
  );

  const nano = useMemo(
    () => lifetimeNano || isNanoPlan(subscription ?? null),
    [subscription, lifetimeNano]
  );

  return {
    subscription,
    nano,
    nanoItem,
    isLoading,
    isFetching,
    error,
    revalidate,
  };
}
