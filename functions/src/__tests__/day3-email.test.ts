import test from "node:test";
import assert from "node:assert/strict";

import { sendDay3Email } from "../day3-email";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Swap in a fetch that records what we sent and replies with a canned
 * response. Returns the captured calls plus a restore function.
 *
 * Day3 drops unknown top-level fields silently instead of rejecting them, so
 * a wrong field name shows up as missing data on a 200 — not as an error.
 * That makes asserting the exact wire payload the only way to catch it here.
 */
const captureFetch = (
  responses: Array<{ status: number; body: string }>,
) => {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  let index = 0;

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : {},
    });
    const response = responses[Math.min(index++, responses.length - 1)];
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.body,
      headers: { get: () => null },
    };
  }) as unknown as typeof globalThis.fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
};

const OK = { status: 200, body: JSON.stringify({ id: "em_123" }) };

// ── Payload shape ───────────────────────────────────────────────────────────

test("posts to /emails with the recipient wrapped in an array", async () => {
  const { calls, restore } = captureFetch([OK]);
  try {
    await sendDay3Email("key", {
      from: "Exit1 <alerts@updates.exit1.dev>",
      to: "ada@example.com",
      subject: "ALERT: site is DOWN",
      html: "<p>down</p>",
    });
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/emails$/);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body.to, ["ada@example.com"]);
  assert.equal(calls[0].body.from, "Exit1 <alerts@updates.exit1.dev>");
  assert.equal(calls[0].body.subject, "ALERT: site is DOWN");
  assert.equal(calls[0].body.html, "<p>down</p>");
});

test("omits body fields that were not supplied", async () => {
  const { calls, restore } = captureFetch([OK]);
  try {
    await sendDay3Email("key", {
      from: "a@b.com",
      to: "ada@example.com",
      subject: "s",
      text: "plain",
    });
  } finally {
    restore();
  }

  assert.equal(calls[0].body.text, "plain");
  assert.ok(!("html" in calls[0].body), "an empty html key would ship an empty body");
  assert.ok(!("reply_to" in calls[0].body));
});

test("reply-to travels as snake_case, matching the rest of the v1 surface", async () => {
  const { calls, restore } = captureFetch([OK]);
  try {
    await sendDay3Email("key", {
      from: "a@b.com",
      to: "connect@exit1.dev",
      subject: "Feedback",
      html: "<p>hi</p>",
      replyTo: "user@example.com",
    });
  } finally {
    restore();
  }

  assert.equal(calls[0].body.reply_to, "user@example.com");
});

// ── Headers ─────────────────────────────────────────────────────────────────

test("every send carries an Idempotency-Key so a retry replays", async () => {
  const { calls, restore } = captureFetch([OK]);
  try {
    await sendDay3Email("secret-key", {
      from: "a@b.com", to: "c@d.com", subject: "s", text: "t",
    });
  } finally {
    restore();
  }

  assert.equal(calls[0].headers.Authorization, "Bearer secret-key");
  assert.ok(calls[0].headers["Idempotency-Key"], "no key means day3Request will not retry the write");
});

test("a generated key is stable across the retry loop, not per attempt", async () => {
  // A fresh key per attempt would turn one message into several sends.
  const { calls, restore } = captureFetch([
    { status: 500, body: JSON.stringify({ error: { code: "internal_error" } }) },
    OK,
  ]);
  try {
    await sendDay3Email("key", { from: "a@b.com", to: "c@d.com", subject: "s", text: "t" });
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
});

test("distinct sends get distinct keys", async () => {
  const { calls, restore } = captureFetch([OK]);
  try {
    await sendDay3Email("key", { from: "a@b.com", to: "c@d.com", subject: "s", text: "t" });
    await sendDay3Email("key", { from: "a@b.com", to: "c@d.com", subject: "s", text: "t" });
  } finally {
    restore();
  }

  assert.notEqual(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
});

// ── Results ─────────────────────────────────────────────────────────────────

test("returns the message id from either response shape", async () => {
  for (const body of [
    JSON.stringify({ id: "em_1" }),
    JSON.stringify({ data: { id: "em_1" } }),
  ]) {
    const { restore } = captureFetch([{ status: 200, body }]);
    try {
      const result = await sendDay3Email("key", {
        from: "a@b.com", to: "c@d.com", subject: "s", text: "t",
      });
      assert.equal(result.ok, true);
      assert.equal(result.id, "em_1");
    } finally {
      restore();
    }
  }
});

test("a terminal error surfaces its Day3 code instead of throwing", async () => {
  const { calls, restore } = captureFetch([{
    status: 403,
    body: JSON.stringify({ error: { code: "domain_not_verified", message: "verify the domain" } }),
  }]);
  try {
    const result = await sendDay3Email("key", {
      from: "a@b.com", to: "c@d.com", subject: "s", text: "t",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "domain_not_verified");
    assert.equal(result.id, null);
  } finally {
    restore();
  }

  assert.equal(calls.length, 1, "a 4xx other than a conflict must not be retried");
});

test("the send profile gives up quickly rather than stalling the alert path", async () => {
  // This runs inside the VPS check loop, where a slow send delays every check
  // behind it. The contact-backfill profile would burn ~60s here.
  const { calls, restore } = captureFetch([
    { status: 500, body: JSON.stringify({ error: { code: "internal_error" } }) },
  ]);
  const startedAt = Date.now();
  try {
    const result = await sendDay3Email("key", {
      from: "a@b.com", to: "c@d.com", subject: "s", text: "t",
    });
    assert.equal(result.ok, false);
  } finally {
    restore();
  }

  assert.equal(calls.length, 3, "send profile is 3 attempts");
  assert.ok(
    Date.now() - startedAt < 5_000,
    `send retries took ${Date.now() - startedAt}ms — too slow for the alert path`,
  );
});
