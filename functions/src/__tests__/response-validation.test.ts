import test from "node:test";
import assert from "node:assert/strict";

import { evaluateResponseValidation, effectiveJsonAssertions } from "../response-validation";
import { assertJsonPath } from "../json-path";

// The /health payload from the feature request.
const HEALTH = JSON.stringify({
  ready: true,
  database: "ok",
  engines: {
    "mail-intake": { ok: true, sinceMs: 120000, overdue: false },
    "billing": { ok: false, sinceMs: "900000", overdue: true },
  },
});

const MAX = 1024 * 64;

test("numeric operators compare numbers and numeric strings", () => {
  const body = JSON.parse(HEALTH);
  assert.equal(assertJsonPath(body, "$.engines['mail-intake'].sinceMs", "less_than", 300000).passed, true);
  assert.equal(assertJsonPath(body, "$.engines['mail-intake'].sinceMs", "less_than", "300000").passed, true);
  assert.equal(assertJsonPath(body, "$.engines.billing.sinceMs", "less_than", 300000).passed, false);
  assert.equal(assertJsonPath(body, "$.engines.billing.sinceMs", "greater_or_equal", 900000).passed, true);
  assert.equal(assertJsonPath(body, "$.engines.billing.sinceMs", "greater_than", 900000).passed, false);
  assert.equal(assertJsonPath(body, "$.engines['mail-intake'].sinceMs", "less_or_equal", 120000).passed, true);
});

test("numeric operators fail clearly on non-numbers and missing paths", () => {
  const body = JSON.parse(HEALTH);
  const notNumber = assertJsonPath(body, "$.database", "less_than", 5);
  assert.equal(notNumber.passed, false);
  assert.match(notNumber.reason ?? "", /expected a number < 5, got "ok"/);
  assert.equal(assertJsonPath(body, "$.ready", "greater_than", 0).passed, false);
  assert.match(assertJsonPath(body, "$.nope", "less_than", 5).reason ?? "", /did not match/);
  assert.match(assertJsonPath(body, "$.engines.billing.sinceMs", "less_than", "abc").reason ?? "", /not a number/);
});

test("legacy single assertion still runs unchanged", () => {
  assert.deepEqual(
    evaluateResponseValidation(HEALTH, { jsonPath: "$.database", expectedValue: "ok" }, MAX),
    { passed: true },
  );
  const failed = evaluateResponseValidation(HEALTH, { jsonPath: "$.database", jsonPathOperator: "not_equals", expectedValue: "ok" }, MAX);
  assert.equal(failed.passed, false);
});

test("jsonAssertions replaces the legacy single assertion", () => {
  const list = effectiveJsonAssertions({
    jsonPath: "$.database",
    expectedValue: "broken",
    jsonAssertions: [{ path: "$.ready", operator: "equals", expectedValue: true }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].path, "$.ready");
});

test("jsonAssertions all mode needs every assertion and reports each failure", () => {
  const ok = evaluateResponseValidation(HEALTH, {
    jsonAssertions: [
      { path: "$.ready", operator: "equals", expectedValue: true },
      { path: "$.engines['mail-intake'].sinceMs", operator: "less_than", expectedValue: 300000 },
      { path: "$.engines['mail-intake'].overdue", operator: "equals", expectedValue: false },
    ],
  }, MAX);
  assert.deepEqual(ok, { passed: true });

  const bad = evaluateResponseValidation(HEALTH, {
    jsonAssertionsMode: "all",
    jsonAssertions: [
      { path: "$.ready", operator: "equals", expectedValue: true },
      { path: "$.engines.billing.ok", operator: "equals", expectedValue: true },
      { path: "$.engines.billing.sinceMs", operator: "less_than", expectedValue: 300000 },
    ],
  }, MAX);
  assert.equal(bad.passed, false);
  assert.match(bad.reason ?? "", /^2 JSON assertions failed: /);
});

test("jsonAssertions any mode passes when one assertion holds", () => {
  const assertions = [
    { path: "$.engines.billing.ok", operator: "equals" as const, expectedValue: true },
    { path: "$.engines['mail-intake'].ok", operator: "equals" as const, expectedValue: true },
  ];
  assert.deepEqual(evaluateResponseValidation(HEALTH, { jsonAssertionsMode: "any", jsonAssertions: assertions }, MAX), { passed: true });
  const none = evaluateResponseValidation(HEALTH, {
    jsonAssertionsMode: "any",
    jsonAssertions: [assertions[0], { path: "$.database", operator: "equals", expectedValue: "down" }],
  }, MAX);
  assert.equal(none.passed, false);
  assert.match(none.reason ?? "", /^No JSON assertion passed/);
});

test("text: contains all (default), contains any, and must not contain", () => {
  assert.equal(evaluateResponseValidation(HEALTH, { containsText: ["ready", "DATABASE"] }, MAX).passed, true);
  assert.equal(evaluateResponseValidation(HEALTH, { containsText: ["ready", "maintenance"] }, MAX).passed, false);
  assert.equal(evaluateResponseValidation(HEALTH, { containsText: ["ready", "maintenance"], containsTextMode: "any" }, MAX).passed, true);
  const anyMiss = evaluateResponseValidation(HEALTH, { containsText: ["foo", "bar"], containsTextMode: "any" }, MAX);
  assert.equal(anyMiss.passed, false);
  assert.match(anyMiss.reason ?? "", /any of the expected texts/);
  const forbidden = evaluateResponseValidation(HEALTH, { notContainsText: ["error", "Overdue"] }, MAX);
  assert.equal(forbidden.passed, false);
  assert.match(forbidden.reason ?? "", /forbidden text: "Overdue"/);
  assert.equal(evaluateResponseValidation(HEALTH, { notContainsText: ["error", ""] }, MAX).passed, true);
});

test("invalid JSON fails JSON assertions but not text-only validation", () => {
  assert.equal(evaluateResponseValidation("<html>ok</html>", { containsText: ["ok"] }, MAX).passed, true);
  const res = evaluateResponseValidation("<html>ok</html>", { jsonAssertions: [{ path: "$.a", operator: "exists" }] }, MAX);
  assert.equal(res.passed, false);
  assert.match(res.reason ?? "", /not valid JSON/);
});
