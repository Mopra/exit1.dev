import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_SIGNUP_DELETE_AFTER_MS,
  AGENT_SIGNUP_PAUSE_AFTER_MS,
  agentSignupExpiryAction,
  agentTokenAllowed,
  buildClaimEmail,
  normalizeSignupEmail,
  sanitizeAgentName,
  type AgentSignupState,
} from "../agent-signup-policy";

const base: AgentSignupState = {
  status: "unclaimed",
  agentName: "Claude Code",
  email: "dev@example.com",
  createdAt: 1_000_000,
};

// ── Token gate: the pre-account-takeover defence ──

test("an unclaimed account's agent token works until anyone signs in", () => {
  assert.equal(agentTokenAllowed(base, null), true);
  // Someone proved they own the inbox and didn't approve the agent (yet).
  assert.equal(agentTokenAllowed(base, 1_234), false);
});

test("after a claim, the owner's decision governs the token, not the revocation sweep", () => {
  assert.equal(agentTokenAllowed({ ...base, status: "claimed", keptAgentAccess: true }, 1_234), true);
  // A token that slipped past revokeAgentTokens (a racing refresh) still dies.
  assert.equal(agentTokenAllowed({ ...base, status: "claimed", keptAgentAccess: false }, 1_234), false);
  assert.equal(agentTokenAllowed({ ...base, status: "claimed" }, 1_234), false);
});

test("the 7-day pause also stops the agent's token", () => {
  // Otherwise it could re-enable the paused checks or create new ones.
  assert.equal(agentTokenAllowed({ ...base, pausedAt: 5 }, null), false);
});

test("a token without signup state never works", () => {
  assert.equal(agentTokenAllowed(null, null), false);
  assert.equal(agentTokenAllowed(undefined, null), false);
});

// ── Expiry ──

test("unclaimed accounts are paused at 7 days and deleted at 30", () => {
  const t0 = base.createdAt;
  assert.equal(agentSignupExpiryAction(base, t0 + AGENT_SIGNUP_PAUSE_AFTER_MS - 1), "none");
  assert.equal(agentSignupExpiryAction(base, t0 + AGENT_SIGNUP_PAUSE_AFTER_MS), "pause");
  assert.equal(agentSignupExpiryAction({ ...base, pausedAt: t0 + 1 }, t0 + AGENT_SIGNUP_PAUSE_AFTER_MS + 1), "none");
  assert.equal(agentSignupExpiryAction({ ...base, pausedAt: t0 + 1 }, t0 + AGENT_SIGNUP_DELETE_AFTER_MS), "delete");
});

test("claimed accounts never expire", () => {
  assert.equal(agentSignupExpiryAction({ ...base, status: "claimed" }, base.createdAt + AGENT_SIGNUP_DELETE_AFTER_MS * 2), "none");
});

// ── Input hygiene ──

test("signup emails are normalised and validated", () => {
  assert.equal(normalizeSignupEmail("  Dev@Example.COM "), "dev@example.com");
  assert.equal(normalizeSignupEmail("not-an-email"), null);
  assert.equal(normalizeSignupEmail("a@b"), null);
  assert.equal(normalizeSignupEmail("Name <dev@example.com>"), null);
  assert.equal(normalizeSignupEmail(42), null);
  assert.equal(normalizeSignupEmail(`${"a".repeat(250)}@example.com`), null);
});

test("agent names are capped and stripped of markup and control characters", () => {
  assert.equal(sanitizeAgentName("  Claude   Code "), "Claude Code");
  assert.equal(sanitizeAgentName("<script>x</script>"), "scriptx/script");
  assert.equal(sanitizeAgentName("Line\r\nBreak: Subject"), "LineBreak: Subject");
  assert.equal(sanitizeAgentName("x".repeat(200)).length, 60);
  assert.equal(sanitizeAgentName(""), "An AI agent");
  assert.equal(sanitizeAgentName(undefined), "An AI agent");
});

test("the claim email escapes what the agent supplied", () => {
  const mail = buildClaimEmail({
    agentName: 'Evil "quoted" & co',
    email: "dev@example.com",
    claimUrl: "https://app.exit1.dev/claim?ticket=abc&x=1",
  });
  assert.match(mail.html, /Evil &quot;quoted&quot; &amp; co/);
  // Attacker-chosen text never reaches the subject line.
  assert.doesNotMatch(mail.subject, /Evil/);
  assert.match(mail.html, /ticket=abc&amp;x=1/);
  assert.match(mail.text, /https:\/\/app\.exit1\.dev\/claim\?ticket=abc&x=1/);
  assert.doesNotMatch(mail.subject, /[\r\n]/);
});
