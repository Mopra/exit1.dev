import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonPath, resolveJsonPath, assertJsonPath } from "../json-path";

// Representative provider response bodies.
const ANTHROPIC = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8-20260115",
  content: [{ type: "text", text: "PONG" }],
  usage: { input_tokens: 10, output_tokens: 1 },
};

const OPENAI = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-4o-2024-08-06",
  choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
};

const GEMINI = {
  candidates: [{ content: { parts: [{ text: "PONG" }], role: "model" } }],
};

test("parseJsonPath handles supported syntax and rejects the rest", () => {
  assert.deepEqual(parseJsonPath("$.model"), ["model"]);
  assert.deepEqual(parseJsonPath("model"), ["model"]);
  assert.deepEqual(parseJsonPath("$.choices[0].message.content"), ["choices", 0, "message", "content"]);
  assert.deepEqual(parseJsonPath("$['a-b'].c"), ["a-b", "c"]);
  assert.deepEqual(parseJsonPath("$[0]"), [0]);
  // Unsupported syntax -> null
  assert.equal(parseJsonPath("$..text"), null);
  assert.equal(parseJsonPath("$.choices[*].message"), null);
  assert.equal(parseJsonPath("$[?(@.role=='assistant')]"), null);
});

test("resolveJsonPath extracts nested values and returns undefined for misses", () => {
  assert.equal(resolveJsonPath(ANTHROPIC, "$.model"), "claude-opus-4-8-20260115");
  assert.equal(resolveJsonPath(ANTHROPIC, "$.content[0].text"), "PONG");
  assert.equal(resolveJsonPath(OPENAI, "$.choices[0].message.content"), "PONG");
  assert.equal(resolveJsonPath(GEMINI, "$.candidates[0].content.parts[0].text"), "PONG");
  assert.equal(resolveJsonPath(ANTHROPIC, "$.usage.output_tokens"), 1);
  // Misses
  assert.equal(resolveJsonPath(ANTHROPIC, "$.choices[0].message.content"), undefined);
  assert.equal(resolveJsonPath(OPENAI, "$.choices[5].message.content"), undefined);
  assert.equal(resolveJsonPath(ANTHROPIC, "$.model[0]"), undefined); // index into a string
});

test("assertJsonPath: contains catches healthy vs silent model fallback", () => {
  // Healthy: the dated model id contains the requested slug.
  assert.equal(
    assertJsonPath(ANTHROPIC, "$.model", "contains", "claude-opus-4-8").passed,
    true,
  );
  // Silent fallback: requested opus, served a different model.
  const fallback = assertJsonPath({ ...ANTHROPIC, model: "claude-haiku-4-5" }, "$.model", "contains", "claude-opus-4-8");
  assert.equal(fallback.passed, false);
  assert.match(fallback.reason ?? "", /expected to contain/);
});

test("assertJsonPath: equals is lenient across scalar types", () => {
  assert.equal(assertJsonPath(ANTHROPIC, "$.usage.output_tokens", "equals", 1).passed, true);
  assert.equal(assertJsonPath(ANTHROPIC, "$.usage.output_tokens", "equals", "1").passed, true); // form sends strings
  assert.equal(assertJsonPath(ANTHROPIC, "$.usage.output_tokens", "equals", 2).passed, false);
});

test("assertJsonPath: exists and not_equals", () => {
  assert.equal(assertJsonPath(OPENAI, "$.choices[0].message.content", "exists").passed, true);
  assert.equal(assertJsonPath(OPENAI, "$.error", "exists").passed, false);
  assert.equal(assertJsonPath(OPENAI, "$.choices[0].finish_reason", "not_equals", "length").passed, true);
  assert.equal(assertJsonPath(OPENAI, "$.choices[0].finish_reason", "not_equals", "stop").passed, false);
});

test("assertJsonPath: contains works on arrays via membership", () => {
  assert.equal(assertJsonPath({ tags: ["a", "b"] }, "$.tags", "contains", "b").passed, true);
  assert.equal(assertJsonPath({ tags: ["a", "b"] }, "$.tags", "contains", "z").passed, false);
});

test("assertJsonPath: invalid path fails closed with a reason", () => {
  const r = assertJsonPath(OPENAI, "$..content", "exists");
  assert.equal(r.passed, false);
  assert.match(r.reason ?? "", /Unsupported or invalid JSONPath/);
});
