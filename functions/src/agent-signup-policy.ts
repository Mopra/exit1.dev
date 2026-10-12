/**
 * Pure decisions for agent-created accounts (agent-signup.ts).
 *
 * Split out so the security-relevant rules, when an agent's token may still be
 * used and when an abandoned account is paused or deleted, are testable
 * without Firebase or Clerk.
 */

export const AGENT_SIGNUP_PAUSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const AGENT_SIGNUP_DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Stored on `users/{uid}.agentSignup` for every account an agent created. */
export interface AgentSignupState {
  status: "unclaimed" | "claimed";
  agentName: string;
  email: string;
  createdAt: number;
  claimedAt?: number;
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
 * claim decision can bring the token back (a "revoke" claim kills it outright).
 */
export function agentTokenAllowed(state: AgentSignupState | null | undefined, lastSignInAt: number | null): boolean {
  if (!state) return false;
  if (state.status === "claimed") return true;
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

export function buildClaimEmail(args: { agentName: string; email: string; claimUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const agent = args.agentName;
  const subject = `${agent} set up uptime monitoring for you on exit1`;
  const text = [
    `${agent} created an exit1 account for ${args.email} and started monitoring for you.`,
    "",
    "Claim it to start receiving alerts and decide whether the agent keeps access:",
    args.claimUrl,
    "",
    "No alerts are sent until you claim it. If you didn't ask for this, ignore this email:",
    "the account is paused after 7 days and deleted after 30.",
    "",
    "exit1.dev",
  ].join("\n");
  const html = `<p>${escapeHtml(agent)} created an exit1 account for <strong>${escapeHtml(args.email)}</strong> and started monitoring for you.</p>
<p>Claim it to start receiving alerts and decide whether the agent keeps access:</p>
<p><a href="${escapeHtml(args.claimUrl)}">Claim your account</a></p>
<p style="color:#666">No alerts are sent until you claim it. If you didn't ask for this, ignore this email: the account is paused after 7 days and deleted after 30.</p>
<p style="color:#666">exit1.dev</p>`;
  return { subject, html, text };
}
