import * as React from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth, useClerk, useSignIn, useUser } from "@clerk/clerk-react";
import { AlertTriangle, Bot, Loader2 } from "lucide-react";

import { apiClient } from "@/api/client";
import { trackEvent } from "@/lib/analytics";
import { markOnboardingCompleteLocally } from "@/hooks/useOnboardingStatus";
import type { AgentClaim } from "@/api/types";

type AgentAccount = Exclude<AgentClaim, { status: "none" }>;
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

/** Set by the inline script in index.html, which lifts the ticket out of the URL. */
const TICKET_KEY = "exit1_claim_ticket";

function readTicket(): string | null {
  try {
    return sessionStorage.getItem(TICKET_KEY);
  } catch {
    return null;
  }
}

function dropTicket() {
  try {
    sessionStorage.removeItem(TICKET_KEY);
  } catch {
    /* storage unavailable: nothing to drop */
  }
}

/**
 * Claim page for accounts an AI agent created on someone's behalf.
 *
 * The owner arrives from the claim email with a one-time Clerk sign-in ticket.
 * The ticket proves they control the inbox, so it signs them in with no
 * password, but only when they click: a mail scanner that opens the link must
 * not burn it. If someone else is already signed in on this browser, we ask
 * before switching accounts, since a ticket link from a stranger would
 * otherwise silently swap a real user into the stranger's account.
 *
 * Also reached by redirect when an unclaimed account signs in any other way.
 */
export default function Claim() {
  const navigate = useNavigate();
  const { isLoaded: authLoaded, isSignedIn, userId } = useAuth();
  const { signOut } = useClerk();
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { user } = useUser();

  const [ticket, setTicket] = React.useState<string | null>(() => readTicket());
  const [redeeming, setRedeeming] = React.useState(false);
  const [ticketError, setTicketError] = React.useState<string | null>(null);
  const [claim, setClaim] = React.useState<AgentAccount | null>(null);
  // Signed in as an account that isn't an agent signup, while holding a ticket.
  const [otherAccount, setOtherAccount] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [emailAlerts, setEmailAlerts] = React.useState(true);
  const [submitting, setSubmitting] = React.useState<"keep" | "revoke" | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const forgetTicket = React.useCallback(() => {
    dropTicket();
    setTicket(null);
  }, []);

  // Load the signed-in account's claim state.
  React.useEffect(() => {
    if (!isSignedIn || redeeming) return;
    let cancelled = false;
    setOtherAccount(false);
    (async () => {
      const result = await apiClient.getAgentClaim();
      if (cancelled) return;
      if (!result.success || !result.data) {
        setLoadError(result.error || "Failed to load this account.");
        return;
      }
      const data = result.data;
      if (data.status === "none") {
        if (ticket) {
          // A ticket for some other account, while this one is signed in.
          setOtherAccount(true);
          return;
        }
        // Not an agent signup (or a half-finished one the backend just
        // repaired): carry on as a normal account.
        await user?.reload().catch(() => {});
        navigate("/onboarding", { replace: true });
        return;
      }
      // Signed in as the account the ticket is for already.
      if (ticket) forgetTicket();
      if (data.status === "claimed") {
        navigate("/checks", { replace: true });
        return;
      }
      setClaim(data);
      trackEvent("agent_claim_viewed", { agent: data.agentName });
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, redeeming, ticket, forgetTicket, navigate, user]);

  async function redeem() {
    if (!ticket || !signIn || !setActive) return;
    setRedeeming(true);
    setTicketError(null);
    try {
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
      forgetTicket();
      setRedeeming(false);
    }
  }

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

  if (!authLoaded || !signInLoaded || redeeming) return <LoadingScreen />;

  if (ticketError) {
    return (
      <ClaimShell>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Couldn&rsquo;t open this link</AlertTitle>
          <AlertDescription>{ticketError}</AlertDescription>
        </Alert>
        <Button
          className="mt-4 cursor-pointer"
          onClick={() => navigate("/login", { state: { from: { pathname: "/claim" } } })}
        >
          Sign in
        </Button>
      </ClaimShell>
    );
  }

  // Signed out, holding a ticket: one click to use it.
  if (ticket && !isSignedIn) {
    return (
      <ClaimShell>
        <Card className="bg-card border-0 shadow-lg">
          <CardHeader className="p-6 sm:p-8">
            <CardTitle className="text-xl">Claim your exit1 account</CardTitle>
            <CardDescription>An AI agent set up uptime monitoring for you. Continue to review it.</CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6 pt-0 sm:px-8 sm:pb-8">
            <Button className="cursor-pointer" onClick={redeem}>
              Continue
            </Button>
          </CardContent>
        </Card>
      </ClaimShell>
    );
  }

  if (!isSignedIn) {
    return <Navigate to="/login" replace state={{ from: { pathname: "/claim" } }} />;
  }

  if (otherAccount) {
    const current = user?.primaryEmailAddress?.emailAddress ?? "another account";
    return (
      <ClaimShell>
        <Card className="bg-card border-0 shadow-lg">
          <CardHeader className="p-6 sm:p-8">
            <CardTitle className="text-xl">Switch accounts?</CardTitle>
            <CardDescription>
              You&rsquo;re signed in as <strong>{current}</strong>. This link opens a different account, one an AI
              agent created. Only continue if you asked for it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col-reverse gap-2 px-6 pb-6 pt-0 sm:flex-row sm:justify-end sm:px-8 sm:pb-8">
            <Button
              variant="secondary"
              className="cursor-pointer"
              onClick={() => {
                forgetTicket();
                navigate("/checks", { replace: true });
              }}
            >
              Stay as {current}
            </Button>
            <Button className="cursor-pointer" onClick={redeem}>
              Switch account
            </Button>
          </CardContent>
        </Card>
      </ClaimShell>
    );
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
  const otherRecipients = claim.emailRecipients.filter((r) => r.toLowerCase() !== claim.email.toLowerCase());
  const agentChannels = [...otherRecipients, ...claim.webhookHosts.map((h) => `a webhook at ${h}`)];

  return (
    <ClaimShell>
      <Card className="bg-card border-0 shadow-lg">
        <CardHeader className="p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-xl">An AI agent set up exit1 for you</CardTitle>
              <CardDescription>
                It calls itself <strong>{claim.agentName}</strong>. It created this account for{" "}
                <strong>{claim.email}</strong>
                {claim.checkCount > 0 ? <> and added {monitors}</> : null}.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 px-6 pb-6 pt-0 sm:px-8 sm:pb-8">
          <p className="text-sm text-muted-foreground">
            No alerts have been sent yet. They start once you claim the account. Should the agent keep access so it
            can go on managing your monitors?
          </p>

          {agentChannels.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>The agent also set alerts to go to</AlertTitle>
              <AlertDescription>
                {agentChannels.join(", ")}. Keeping the agent keeps these. Revoking it removes them.
              </AlertDescription>
            </Alert>
          )}

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
