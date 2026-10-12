import * as React from "react";
import { useAuth } from "@clerk/clerk-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useAuthReady } from "@/AuthReadyProvider";
import { apiClient } from "@/api/client";
import { trackEvent } from "@/lib/analytics";

export const PENDING_FOLLOW_STORAGE_KEY = "exit1_pending_follow";

/**
 * Applies a follow the visitor asked for on exit1.dev/status/<slug> before they
 * had an account. App.tsx stashes the slug; this runs it once the Firebase
 * session exists. It doesn't navigate, so a new user's onboarding carries on
 * with the follow already active.
 */
export function PendingFollow() {
  const { isSignedIn } = useAuth();
  const authReady = useAuthReady();
  const navigate = useNavigate();
  const ran = React.useRef(false);

  React.useEffect(() => {
    if (!authReady || !isSignedIn || ran.current) return;
    const slug = localStorage.getItem(PENDING_FOLLOW_STORAGE_KEY);
    if (!slug) return;
    ran.current = true;
    localStorage.removeItem(PENDING_FOLLOW_STORAGE_KEY);

    void apiClient.followPublicMonitor(slug).then((res) => {
      if (!res.success || !res.data) {
        toast.error(res.error || "Couldn't follow that service");
        return;
      }
      trackEvent("follow_service", { slug, source: "status_page" });
      toast.success(`Following ${res.data.name}`, {
        description: "We'll email you when it goes down, and when it's back.",
        action: { label: "Manage", onClick: () => navigate("/following") },
        duration: 8000,
      });
    });
  }, [authReady, isSignedIn, navigate]);

  return null;
}
