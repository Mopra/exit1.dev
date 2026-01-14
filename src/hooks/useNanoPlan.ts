import { useMemo } from "react";
import { useSubscription } from "@clerk/clerk-react/experimental";
import { getNanoSubscriptionItem, isNanoPlan } from "@/lib/subscription";

/**
 * Standardized hook for checking if user is on Nano plan.
 * 
 * This hook ensures consistency across the codebase by:
 * - Using useSubscription() without enabled parameter (Clerk handles auth state)
 * - Memoizing both nano status and nanoItem for performance
 * 
 * @returns Object containing subscription data, nano status, and nanoItem
 */
export function useNanoPlan() {
  const { data: subscription, isLoading, isFetching, error, revalidate } =
    useSubscription();

  const nanoItem = useMemo(
    () => getNanoSubscriptionItem(subscription ?? null),
    [subscription]
  );

  const nano = useMemo(() => isNanoPlan(subscription ?? null), [subscription]);

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
