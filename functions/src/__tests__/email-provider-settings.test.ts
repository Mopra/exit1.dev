import test from "node:test";
import assert from "node:assert/strict";

import {
  canaryBucket,
  parseEmailProviderSettings,
  resolveProvider,
  EMAIL_CATEGORIES,
  type EmailCategory,
  type EmailProvider,
} from "../email-provider-settings";

const settings = (over: {
  provider?: EmailProvider;
  categories?: Partial<Record<EmailCategory, EmailProvider>>;
  canaryPercent?: number;
} = {}) => ({
  provider: over.provider ?? ("resend" as EmailProvider),
  categories: over.categories ?? {},
  canaryPercent: over.canaryPercent ?? 0,
});

// ── Parsing ─────────────────────────────────────────────────────────────────
// A typo in the admin doc must degrade to "keep sending via Resend", never to
// a throw and never to Day3. Sending is not a place to fail closed.

test("a missing doc means everything on Resend", () => {
  const parsed = parseEmailProviderSettings(null, 1);
  assert.equal(parsed.provider, "resend");
  assert.deepEqual(parsed.categories, {});
  assert.equal(parsed.canaryPercent, 0);
  assert.equal(parsed.fallbackToResend, true);
});

test("an unrecognised provider falls back to Resend rather than throwing", () => {
  assert.equal(parseEmailProviderSettings({ provider: "sendgrid" }, 1).provider, "resend");
  assert.equal(parseEmailProviderSettings({ provider: 42 }, 1).provider, "resend");
});

test("unknown category keys and values are dropped, valid ones survive", () => {
  const parsed = parseEmailProviderSettings(
    { categories: { alerts: "day3", nonsense: "day3", test: "mailgun" } },
    1,
  );
  assert.deepEqual(parsed.categories, { alerts: "day3" });
});

test("canaryPercent is clamped to 0-100 and non-numbers become 0", () => {
  assert.equal(parseEmailProviderSettings({ canaryPercent: 150 }, 1).canaryPercent, 100);
  assert.equal(parseEmailProviderSettings({ canaryPercent: -5 }, 1).canaryPercent, 0);
  assert.equal(parseEmailProviderSettings({ canaryPercent: "10" }, 1).canaryPercent, 0);
  assert.equal(parseEmailProviderSettings({ canaryPercent: NaN }, 1).canaryPercent, 0);
});

test("only an explicit false disables the Resend fallback", () => {
  assert.equal(parseEmailProviderSettings({}, 1).fallbackToResend, true);
  assert.equal(parseEmailProviderSettings({ fallbackToResend: undefined }, 1).fallbackToResend, true);
  assert.equal(parseEmailProviderSettings({ fallbackToResend: false }, 1).fallbackToResend, false);
});

// ── Routing ─────────────────────────────────────────────────────────────────

test("with no overrides every category follows the default", () => {
  for (const category of EMAIL_CATEGORIES) {
    assert.equal(resolveProvider(settings(), category, "a@b.com"), "resend");
    assert.equal(
      resolveProvider(settings({ provider: "day3" }), category, "a@b.com"),
      "day3",
    );
  }
});

test("a category override beats the default in both directions", () => {
  assert.equal(
    resolveProvider(settings({ categories: { alerts: "day3" } }), "alerts", "a@b.com"),
    "day3",
  );
  // The important direction: pinning alerts back to Resend must survive a
  // global flip to Day3, since that is the shape of a partial rollback.
  assert.equal(
    resolveProvider(
      settings({ provider: "day3", categories: { alerts: "resend" } }),
      "alerts",
      "a@b.com",
    ),
    "resend",
  );
});

test("an override on one category does not leak into the others", () => {
  const config = settings({ categories: { internal: "day3" } });
  assert.equal(resolveProvider(config, "internal", "a@b.com"), "day3");
  assert.equal(resolveProvider(config, "alerts", "a@b.com"), "resend");
});

// ── Canary ramp ─────────────────────────────────────────────────────────────

test("0% canary keeps everyone on Resend", () => {
  const config = settings({ canaryPercent: 0 });
  for (let i = 0; i < 200; i++) {
    assert.equal(resolveProvider(config, "alerts", `user${i}@example.com`), "resend");
  }
});

test("100% canary moves everyone to Day3", () => {
  const config = settings({ canaryPercent: 100 });
  for (let i = 0; i < 200; i++) {
    assert.equal(resolveProvider(config, "alerts", `user${i}@example.com`), "day3");
  }
});

test("a recipient's provider is stable across sends", () => {
  // Splitting one person's alerts between providers would make a
  // deliverability complaint impossible to attribute, so the bucket must be a
  // pure function of the address — not a per-send coin flip.
  const config = settings({ canaryPercent: 50 });
  const first = resolveProvider(config, "alerts", "ada@example.com");
  for (let i = 0; i < 50; i++) {
    assert.equal(resolveProvider(config, "alerts", "ada@example.com"), first);
  }
});

test("bucketing ignores case and surrounding whitespace", () => {
  assert.equal(canaryBucket("Ada@Example.com"), canaryBucket("  ada@example.com "));
});

test("buckets spread across the range rather than clustering", () => {
  // A hash that piles every address into a few buckets would make a 10% ramp
  // silently mean 0% or 100%.
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(canaryBucket(`user${i}@example.com`));
  assert.ok(seen.size > 80, `only ${seen.size} distinct buckets across 500 addresses`);
});

test("the canary ramp is monotonic — raising it never moves anyone back", () => {
  const address = "ada@example.com";
  let sawDay3 = false;
  for (let percent = 0; percent <= 100; percent++) {
    const provider = resolveProvider(settings({ canaryPercent: percent }), "alerts", address);
    if (provider === "day3") sawDay3 = true;
    else assert.equal(sawDay3, false, `address fell back to Resend at ${percent}%`);
  }
});

test("the canary never pulls traffic off a category already on Day3", () => {
  const config = settings({ provider: "day3", canaryPercent: 10 });
  for (let i = 0; i < 100; i++) {
    assert.equal(resolveProvider(config, "alerts", `user${i}@example.com`), "day3");
  }
});
