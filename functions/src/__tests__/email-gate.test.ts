import test from "node:test";
import assert from "node:assert/strict";

import {
  eventAllowedForCheck,
  collectRecipients,
  resolveFolderEntry,
  type GateSettings,
} from "../email-gate";

const CHECK = { id: "check-1", folder: null };
const DOWN = "website_down" as const;
const UP = "website_up" as const;

/** A document that WOULD deliver: recipient, event listed, filter set to all. */
const working = (over: Partial<GateSettings> = {}): GateSettings => ({
  enabled: true,
  recipients: ["ops@example.com"],
  events: [DOWN, UP],
  checkFilter: { mode: "all" },
  ...over,
});

// ── The default that silently swallows everything ───────────────────────────
//
// This is the bug the whole alert-coverage effort exists for: 'include' is what
// the app writes by default, and it means "only checks I ticked". A document that
// looks completely configured delivers nothing.

test("no settings document means no delivery", () => {
  assert.equal(eventAllowedForCheck(null, CHECK, DOWN), false);
  assert.equal(eventAllowedForCheck(undefined, CHECK, DOWN), false);
});

test("mode 'include' with no per-check entry does NOT deliver", () => {
  const s = working({ checkFilter: { mode: "include" } });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), false);
});

test("absent checkFilter behaves like 'include' and does NOT deliver", () => {
  const s = working({ checkFilter: undefined });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), false);
});

test("mode 'all' delivers a listed event", () => {
  assert.equal(eventAllowedForCheck(working(), CHECK, DOWN), true);
});

test("mode 'all' does not deliver an event that is not listed", () => {
  const s = working({ events: [UP] });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), false);
});

test("mode 'all' prefers checkFilter.defaultEvents over the global list", () => {
  const s = working({ events: [DOWN, UP], checkFilter: { mode: "all", defaultEvents: [UP] } });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), false);
  assert.equal(eventAllowedForCheck(s, CHECK, UP), true);
});

// ── Recipients ──────────────────────────────────────────────────────────────

test("a document with no recipient never delivers, however it is configured", () => {
  assert.equal(eventAllowedForCheck(working({ recipients: [] }), CHECK, DOWN), false);
  assert.equal(eventAllowedForCheck(working({ recipients: undefined }), CHECK, DOWN), false);
});

test("the legacy single `recipient` field still counts", () => {
  const s = working({ recipients: undefined, recipient: "legacy@example.com" });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), true);
});

test("enabled:false kills delivery outright", () => {
  assert.equal(eventAllowedForCheck(working({ enabled: false }), CHECK, DOWN), false);
});

test("a per-check recipient is enough on its own, with no global recipient", () => {
  const s = working({
    recipients: [],
    perCheck: { "check-1": { enabled: true, recipients: ["oncall@example.com"] } },
  });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), true);
});

test("collectRecipients merges all three scopes and dedupes case-insensitively", () => {
  const s = working({
    recipients: ["Ops@Example.com"],
    perFolder: { Production: { recipients: ["folder@example.com"] } },
    perCheck: { "check-1": { recipients: ["ops@example.com", "extra@example.com"] } },
  });
  assert.deepEqual(collectRecipients(s, { id: "check-1", folder: "Production" }), [
    "Ops@Example.com",
    "folder@example.com",
    "extra@example.com",
  ]);
});

// ── Precedence ──────────────────────────────────────────────────────────────

test("perCheck.enabled true delivers even in 'include' mode", () => {
  const s = working({
    checkFilter: { mode: "include" },
    perCheck: { "check-1": { enabled: true } },
  });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), true);
});

test("perCheck.enabled false blocks even in 'all' mode", () => {
  const s = working({ perCheck: { "check-1": { enabled: false } } });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), false);
});

test("perCheck.events narrows what an enabled check delivers", () => {
  const s = working({
    checkFilter: { mode: "include" },
    perCheck: { "check-1": { enabled: true, events: [UP] } },
  });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), false);
  assert.equal(eventAllowedForCheck(s, CHECK, UP), true);
});

test("a perCheck entry with no `enabled` key falls through to the filter mode", () => {
  const s = working({
    checkFilter: { mode: "include" },
    perCheck: { "check-1": { recipients: ["x@example.com"] } },
  });
  assert.equal(eventAllowedForCheck(s, CHECK, DOWN), false);
});

test("perCheck wins over perFolder: an enabled folder cannot rescue a disabled check", () => {
  const s = working({
    checkFilter: { mode: "include" },
    perFolder: { Production: { enabled: true } },
    perCheck: { "check-1": { enabled: false } },
  });
  assert.equal(eventAllowedForCheck(s, { id: "check-1", folder: "Production" }, DOWN), false);
});

test("perFolder applies when the check has no entry of its own", () => {
  const s = working({
    checkFilter: { mode: "include" },
    perFolder: { Production: { enabled: true } },
  });
  assert.equal(eventAllowedForCheck(s, { id: "check-1", folder: "Production" }, DOWN), true);
});

test("perFolder.enabled false blocks in 'all' mode", () => {
  const s = working({ perFolder: { Production: { enabled: false } } });
  assert.equal(eventAllowedForCheck(s, { id: "check-1", folder: "Production" }, DOWN), false);
});

// ── Folder inheritance ──────────────────────────────────────────────────────

test("a nested folder inherits its parent's entry", () => {
  const s = working({ checkFilter: { mode: "include" }, perFolder: { Production: { enabled: true } } });
  assert.equal(eventAllowedForCheck(s, { id: "check-1", folder: "Production/APIs" }, DOWN), true);
});

test("an exact folder entry beats the parent", () => {
  const s = working({
    perFolder: { Production: { enabled: true }, "Production/APIs": { enabled: false } },
  });
  assert.equal(eventAllowedForCheck(s, { id: "check-1", folder: "Production/APIs" }, DOWN), false);
});

test("resolveFolderEntry walks up one level at a time", () => {
  const s = working({ perFolder: { A: { enabled: true } } });
  assert.deepEqual(resolveFolderEntry(s, "A/B/C"), { enabled: true });
  assert.equal(resolveFolderEntry(s, "B/C"), undefined);
  assert.equal(resolveFolderEntry(s, null), undefined);
});
