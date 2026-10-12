import * as React from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth, useClerk, useSignIn, useUser } from "@clerk/clerk-react";
import { AlertTriangle, Bot, Loader2 } from "lucide-react";

import { apiClient } from "@/api/client";
import { trackEvent } from "@/lib/analytics";
import { markOnboardingCompleteLocally } from "@/hooks/useOnboardingStatus";
import type { AgentClaim } from "@/api/types";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  LoadingScreen,
} from "@/components/ui";

/**
 * Claim page for accounts an AI agent created on someone's behalf.
 *
 * The owner arrives from the claim email with a Clerk sign-in ticket in the
 * URL. The ticket proves they control the inbox, so it signs them straight in
 * with no password. They then decide whether the agent keeps its access. Until
 * they do, the agent's token is paused (the backend sees the sign-in) and no
 * alerts are delivered.
 *
 * Also reached by redirect when an unclaimed account signs in any other way:
 * the owner must make the same decision before using the dashboard.
 */
export default function Claim() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isLoaded: authLoaded, isSignedIn, userId } = useAuth();
  const { signOut } = useClerk();
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { user } = useUser();

  const ticket = searchParams.get("ticket");
  const [ticketError, setTicketError] = React.useState<string | null>(null);
  const [claim, setClaim] = React.useState<AgentClaim | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [emailAlerts, setEmailAlerts] = React.useState(true);
  const [submitting, setSubmitting] = React.useState<"keep" | "revoke" | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const consumingRef = React.useRef(false);

  // Step 1: trade the emailed ticket for a session.
  React.useEffect(() => {
    if (!ticket || !authLoaded || !signInLoaded || !signIn || !setActive || consumingRef.current) return;
    consumingRef.current = true;

    (async () => {
      try {
        // A different account signed in on this browser would block the ticket
        // sign-in. The link is for the agent-created account, so switch to it.
        if (isSignedIn) await signOut();
        const result = await signIn.create({ strategy: "ticket", ticket });
        if (result.status === "complete" && result.createdSessionId) {
          await setActive({ session: result.createdSessionId });
        } else {
          setTicketError("This link couldn't sign you in. Sign in with your email instead.");
        }
      } catch {
        setTicketError("This link has expired or was already used. Sign in with your email to continue.");
      } finally {
        // Never leave a live credential sitting in the address bar or history.
        const next = new URLSearchParams(searchParams);
        next.delete("ticket");
        setSearchParams(next, { replace: true });
      }
    })();
  }, [ticket, authLoaded, signInLoaded, signIn, setActive, isSignedIn, signOut, searchParams, setSearchParams]);

  // Step 2: once signed in, load what the agent set up.
  React.useEffect(() => {
    if (!isSignedIn || ticket) return;
    let cancelled = false;
    (async () => {
      const result = await apiClient.getAgentClaim();
      if (cancelled) return;
      if (result.success && result.data) {
        if (result.data.status === "claimed") {
          navigate("/checks", { replace: true });
          return;
        }
        setClaim(result.data);
        trackEvent("agent_claim_viewed", { agent: result.data.agentName });
      } else {
        setLoadError(result.error || "Failed to load this account.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, ticket, navigate]);

  async function decide(keepAgentAccess: boolean) {
    setSubmitting(keepAgentAccess ? "keep" : "revoke");
    setSubmitError(null);
    const result = await apiClient.claimAgentAccount(keepAgentAccess, emailAlerts);
    if (!result.success) {
      setSubmitError(result.error || "Something went wrong. Try again.");
      setSubmitting(null);
      return;
    }
    trackEvent("agent_claim_decided", { keep: keepAgentAccess, email_alerts: emailAlerts });
    // The claim cleared the unclaimed flag server-side; refresh Clerk's copy so
    // the onboarding gate stops sending this user back here.
    await user?.reload().catch(() => {});
    if (userId) markOnboardingCompleteLocally(userId);
    navigate("/checks", { replace: true });
  }

  if (ticketError) {
    return (
      <ClaimShell>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Couldn&rsquo;t open this link</AlertTitle>
          <AlertDescription>{ticketError}</AlertDescription>
        </Alert>
        <Button className="mt-4 cursor-pointer" onClick={() => navigate("/login", { state: { from: { pathname: "/claim" } } })}>
          Sign in
        </Button>
      </ClaimShell>
    );
  }

  if (!authLoaded || ticket) return <LoadingScreen />;

  if (!isSignedIn) {
    return <Navigate to="/login" replace state={{ from: { pathname: "/claim" } }} />;
  }

  if (loadError) {
    return (
      <ClaimShell>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Couldn&rsquo;t load this account</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </ClaimShell>
    );
  }

  if (!claim) return <LoadingScreen />;

  const monitors = claim.checkCount === 1 ? "1 monitor" : `${claim.checkCount} monitors`;

  return (
    <ClaimShell>
      <Card className="bg-card border-0 shadow-lg">
        <CardHeader className="p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-xl">{claim.agentName} set up exit1 for you</CardTitle>
              <CardDescription>
                It created this account for <strong>{claim.email}</strong>
                {claim.checkCount > 0 ? <> and added {monitors}</> : null}. It&rsquo;s yours now.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 px-6 pb-6 pt-0 sm:px-8 sm:pb-8">
          <p className="text-sm text-muted-foreground">
            No alerts have been sent yet. They start once you claim the account. Should {claim.agentName} keep
            access so it can go on managing your monitors?
          </p>

          <div className="flex items-start gap-3">
            <Checkbox
              id="claim-email-alerts"
              checked={emailAlerts}
              onCheckedChange={(v) => setEmailAlerts(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor="claim-email-alerts" className="text-sm font-normal leading-snug">
              Email me at {claim.email} when a monitor goes down or recovers
            </Label>
          </div>

          <p className="text-xs text-muted-foreground">
            By claiming the account you agree to the{" "}
            <Link to="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link to="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
              Privacy Policy
            </Link>
            .
          </p>

          {submitError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Couldn&rsquo;t claim the account</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              className="cursor-pointer"
              disabled={submitting !== null}
              onClick={() => decide(false)}
            >
              {submitting === "revoke" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Claim and revoke agent
            </Button>
            <Button className="cursor-pointer" disabled={submitting !== null} onClick={() => decide(true)}>
              {submitting === "keep" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Claim and keep agent
            </Button>
          </div>
        </CardContent>
      </Card>
    </ClaimShell>
  );
}

function ClaimShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">{children}</div>
    </div>
  );
}
