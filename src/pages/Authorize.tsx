import * as React from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle, Bell, Bot, Check, ListChecks, Loader2, PenLine, ShieldCheck, Trash2 } from "lucide-react";

import { apiClient } from "@/api/client";
import type { McpAuthorizationRequest } from "@/api/types";
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
  LoadingScreen,
  Separator,
} from "@/components/ui";

/**
 * OAuth consent screen for MCP clients.
 *
 * The browser lands here from GET /oauth/authorize with an opaque `request` id.
 * Because this route sits behind AuthGuard, an unauthenticated visitor gets
 * Clerk's sign-in/sign-up first and returns here afterwards — which is precisely
 * the signup path agent onboarding relies on.
 *
 * The redirect target is decided by the backend, never assembled here: the SPA
 * only ever forwards the user to the URL `approveMcpAuthorization` hands back.
 */

type ScopeCopy = {
  label: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Scopes that let the agent change or destroy things are called out visually. */
  emphasis?: "write" | "destructive";
};

const SCOPE_COPY: Record<string, ScopeCopy> = {
  "checks:read": {
    label: "Read your checks",
    detail: "See your monitors, their status, history and uptime statistics.",
    icon: ListChecks,
  },
  "checks:write": {
    label: "Create and edit checks",
    detail: "Add new monitors and change the settings of existing ones.",
    icon: PenLine,
    emphasis: "write",
  },
  "checks:delete": {
    label: "Delete checks",
    detail: "Permanently remove monitors. This cannot be undone.",
    icon: Trash2,
    emphasis: "destructive",
  },
  "alerts:read": {
    label: "Read your alert settings",
    detail: "See which email addresses and webhooks receive alerts.",
    icon: Bell,
  },
  "alerts:write": {
    label: "Configure and test alerts",
    detail: "Set alert recipients, connect webhooks, and send test alerts.",
    icon: Bell,
    emphasis: "write",
  },
};

function describeScope(scope: string): ScopeCopy {
  return (
    SCOPE_COPY[scope] || {
      label: scope,
      detail: "Access granted to this connection.",
      icon: ShieldCheck,
    }
  );
}

export default function Authorize() {
  const { requestId = "" } = useParams<{ requestId: string }>();

  const [request, setRequest] = React.useState<McpAuthorizationRequest | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<"approve" | "deny" | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    if (!requestId) {
      setLoadError("This link is missing its authorization request. Start over from your AI tool.");
      return;
    }

    (async () => {
      const result = await apiClient.getMcpAuthorizationRequest(requestId);
      if (cancelled) return;
      if (result.success && result.data) {
        setRequest(result.data);
      } else {
        setLoadError(result.error || "Failed to load the authorization request.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId]);

  async function decide(approved: boolean) {
    setSubmitting(approved ? "approve" : "deny");
    setSubmitError(null);

    const result = await apiClient.decideMcpAuthorization(requestId, approved);
    if (result.success && result.data?.redirectTo) {
      // Hard navigation, not react-router: the target is the client's own
      // callback (usually a loopback port), which is outside this app.
      window.location.replace(result.data.redirectTo);
      return;
    }

    setSubmitting(null);
    setSubmitError(result.error || "Something went wrong. Try again from your AI tool.");
  }

  if (loadError) {
    return (
      <ConsentShell>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>This request can&rsquo;t be completed</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </ConsentShell>
    );
  }

  if (!request) {
    return <LoadingScreen type="module" />;
  }

  const hasDestructive = request.scopes.some((s) => describeScope(s).emphasis === "destructive");

  return (
    <ConsentShell>
      <Card className="bg-card border-0 shadow-lg">
        <CardHeader className="p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-xl">
                Connect {request.clientName} to exit1
              </CardTitle>
              <CardDescription>
                It will be able to act on your monitors on your behalf.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 px-6 pb-6 pt-0 sm:px-8 sm:pb-8">
          <div className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              This connection will be able to
            </div>
            <ul className="space-y-3">
              {request.scopes.map((scope) => {
                const copy = describeScope(scope);
                const Icon = copy.icon;
                return (
                  <li key={scope} className="flex items-start gap-3">
                    <Icon
                      className={
                        copy.emphasis === "destructive"
                          ? "mt-0.5 h-4 w-4 shrink-0 text-destructive"
                          : "mt-0.5 h-4 w-4 shrink-0 text-primary"
                      }
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{copy.label}</div>
                      <div className="text-xs text-muted-foreground">{copy.detail}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {hasDestructive && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>This request includes delete access</AlertTitle>
              <AlertDescription>
                Only approve this if you asked your AI tool to remove monitors.
              </AlertDescription>
            </Alert>
          )}

          <Separator />

          <div className="space-y-1 text-xs text-muted-foreground">
            <div>
              You&rsquo;ll be sent back to{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{request.redirectHost}</code>{" "}
              after approving.
            </div>
            <div>
              This never grants access to your billing details, and you can revoke it any time from
              the MCP page.
            </div>
          </div>

          {submitError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Couldn&rsquo;t complete the request</AlertTitle>
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
              {submitting === "deny" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Cancel
            </Button>
            <Button
              className="cursor-pointer"
              disabled={submitting !== null}
              onClick={() => decide(true)}
            >
              {submitting === "approve" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Approve
            </Button>
          </div>
        </CardContent>
      </Card>
    </ConsentShell>
  );
}

function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">{children}</div>
    </div>
  );
}
