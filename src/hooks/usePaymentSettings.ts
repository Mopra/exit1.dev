import { useCallback } from "react"
import { useClerk } from "@clerk/clerk-react"

/**
 * Opens Clerk's account modal directly on its Billing page.
 *
 * That page is the only place a customer can add, remove or change a card and
 * see Clerk's statements. Clerk hides it two clicks deep under Profile, so every
 * "change card" and "statements" button in the app goes through this instead.
 */
export function useOpenPaymentSettings() {
  const clerk = useClerk()
  return useCallback(() => {
    clerk.openUserProfile({ __experimental_startPath: "/billing" })
  }, [clerk])
}
