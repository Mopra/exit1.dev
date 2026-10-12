/**
 * Pure decisions for agent-created accounts (agent-signup.ts).
 *
 * Split out so the security-relevant rules, when an agent's token may still be
 * used and when an abandoned account is paused or deleted, are testable
 * without Firebase or Clerk.
 */

/**
 * Sent with every "no credentials" 401 from the public API and the MCP server.
 * An agent probing exit1 with nothing configured is exactly the caller that
 * needs to learn it can sign its user up, and the 401 body is what it reads.
 */
export const AGENT_SIGNUP_HINT =
  "No exit1 account yet? An AI agent can create one for its user with one call: " +
  'POST https://app.exit1.dev/oauth/agent-signup with JSON {"email": "<the user\'s own email>", "agent_name": "<you>"}. ' +
  "It returns a Bearer token that works here immediately. Docs: https://docs.exit1.dev/integrations/agent-signup";

export const AGENT_SIGNUP_PAUSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_SIGNUP_DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Stored on `users/{uid}.agentSignup` for every account an agent created. */
export interface AgentSignupState {
  status: "unclaimed" | "claimed";
  agentName: string;
  email: string;
  createdAt: number;
  claimedAt?: number;
  /** Set by the claim: whether the owner let the agent keep its access. */
  keptAgentAccess?: boolean;
  /** When the expiry sweep disabled the account's checks. */
  pausedAt?: number;
}

const EMAIL_PATTERN = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

/** Trim and lowercase an address, or null if it isn't a plausible one. */
export function normalizeSignupEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

/**
 * The agent's own name for itself, shown to the owner in the claim email and
 * on the claim page. It's self-asserted, so it is length-capped and stripped
 * of anything that could break a subject line or pass for markup.
 */
export function sanitizeAgentName(raw: unknown): string {
  if (typeof raw !== "string") return "An AI agent";
  const cleaned = Array.from(raw)
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f && ch !== "<" && ch !== ">")
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || "An AI agent";
}

/**
 * May a token minted by agent signup still be used?
 *
 * Clerk marks an address on a backend-created user as verified, so nothing
 * stops an agent signing up with someone else's email. If its token outlived
 * the real owner's first sign-in, it could read whatever they add later. So:
 * while unclaimed, the token works only until anyone signs in as that user.
 * Signing in proves control of the inbox, and from then on only the owner's
 * claim decision can bring the token back.
 *
 * The decision is read from stored state rather than relying on the claim
 * having found and revoked every token: a refresh racing the revocation would
 * otherwise leave a live token behind on a "revoke" claim. And once the 7-day
 * pause lands the token stops too, or the agent could simply re-enable or
 * recreate the checks the pause just disabled.
 */
export function agentTokenAllowed(state: AgentSignupState | null | undefined, lastSignInAt: number | null): boolean {
  if (!state) return false;
  if (state.status === "claimed") return state.keptAgentAccess === true;
  if (state.pausedAt) return false;
  return lastSignInAt === null;
}

export type ExpiryAction = "none" | "pause" | "delete";

/** What the daily sweep should do to an account an agent created. */
export function agentSignupExpiryAction(state: AgentSignupState, now: number): ExpiryAction {
  if (state.status !== "unclaimed") return "none";
  const age = now - state.createdAt;
  if (age >= AGENT_SIGNUP_DELETE_AFTER_MS) return "delete";
  if (age >= AGENT_SIGNUP_PAUSE_AFTER_MS && !state.pausedAt) return "pause";
  return "none";
}

/** Escape text for the claim email's HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Domain part of an address, for the per-domain signup cap. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * The claim email. The agent's name is the only text in it an outsider picks,
 * so it stays out of the subject line and is quoted as a claim the agent made,
 * which keeps the message useless as a phishing vehicle.
 */
export function buildClaimEmail(args: { agentName: string; email: string; claimUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const agent = args.agentName;
  const subject = "An AI agent set up uptime monitoring for you on exit1";
  const text = [
    `An AI agent (it calls itself "${agent}") created an exit1 account for ${args.email} and started monitoring for you.`,
    "",
    "Claim it to start receiving alerts and decide whether the agent keeps access:",
    args.claimUrl,
    "",
    "No alerts are sent until you claim it. If you didn't ask for this, ignore this email:",
    "the account is paused after 7 days and deleted after 30.",
    "",
    "exit1.dev",
  ].join("\n");
  const html = `<p>An AI agent (it calls itself &ldquo;${escapeHtml(agent)}&rdquo;) created an exit1 account for <strong>${escapeHtml(args.email)}</strong> and started monitoring for you.</p>
<p>Claim it to start receiving alerts and decide whether the agent keeps access:</p>
<p><a href="${escapeHtml(args.claimUrl)}">Claim your account</a></p>
<p style="color:#666">No alerts are sent until you claim it. If you didn't ask for this, ignore this email: the account is paused after 7 days and deleted after 30.</p>
<p style="color:#666">exit1.dev</p>`;
  return { subject, html, text };
}
