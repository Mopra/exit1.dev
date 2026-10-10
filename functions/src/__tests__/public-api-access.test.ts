import test from "node:test";
import assert from "node:assert/strict";

import {
  KeyAccessError,
  canAccessCheck,
  canCreateInFolder,
  isKeyExpired,
  parseExpiresInSeconds,
  parseKeyAccess,
  readStoredAccess,
} from "../public-api-access";
import { buildSnapshot, restrictSnapshot } from "../public-api-status";
import { folderPathError } from "../public-api-folder";

test("parseKeyAccess: missing or empty means unrestricted", () => {
  assert.equal(parseKeyAccess(undefined), null);
  assert.equal(parseKeyAccess(null), null);
  assert.equal(parseKeyAccess({}), null);
  assert.equal(parseKeyAccess({ checkIds: [], folders: [] }), null);
});

test("parseKeyAccess normalizes folders and dedupes", () => {
  assert.deepEqual(
    parseKeyAccess({ checkIds: ["abc", "abc"], folders: ["/Clients//Acme/", "Clients/Acme"] }),
    { checkIds: ["abc"], folders: ["Clients/Acme"] },
  );
});

test("parseKeyAccess rejects bad input", () => {
  assert.throws(() => parseKeyAccess("Clients"), KeyAccessError);
  assert.throws(() => parseKeyAccess({ checkIds: "abc" }), KeyAccessError);
  assert.throws(() => parseKeyAccess({ checkIds: ["a/b"] }), KeyAccessError);
  assert.throws(() => parseKeyAccess({ folders: ["  "] }), KeyAccessError);
  assert.throws(() => parseKeyAccess({ checkIds: Array.from({ length: 201 }, (_, i) => `c${i}`) }), KeyAccessError);
});

test("readStoredAccess never widens a stored grant to everything", () => {
  assert.equal(readStoredAccess(null), null);
  assert.deepEqual(readStoredAccess({}), { checkIds: [], folders: [] });
  assert.equal(canAccessCheck(readStoredAccess({}), "x", "Clients"), false);
});

test("canAccessCheck: check ids, folders and subfolders", () => {
  const access = { checkIds: ["c1"], folders: ["Clients/Acme"] };
  assert.equal(canAccessCheck(null, "any", null), true);
  assert.equal(canAccessCheck(access, "c1", null), true);
  assert.equal(canAccessCheck(access, "c2", "Clients/Acme"), true);
  assert.equal(canAccessCheck(access, "c2", "Clients/Acme/Prod"), true);
  assert.equal(canAccessCheck(access, "c2", "Clients/Acme-old"), false);
  assert.equal(canAccessCheck(access, "c2", "Clients"), false);
  assert.equal(canAccessCheck(access, "c2", null), false);
});

test("canCreateInFolder needs a folder grant", () => {
  assert.equal(canCreateInFolder(null, null), true);
  assert.equal(canCreateInFolder({ checkIds: ["c1"], folders: [] }, "Clients"), false);
  const access = { checkIds: [], folders: ["Clients"] };
  assert.equal(canCreateInFolder(access, "Clients/New"), true);
  assert.equal(canCreateInFolder(access, null), false);
  assert.equal(canCreateInFolder(access, "Other"), false);
});

test("parseExpiresInSeconds bounds", () => {
  assert.equal(parseExpiresInSeconds(undefined), null);
  assert.equal(parseExpiresInSeconds(null), null);
  assert.equal(parseExpiresInSeconds(8 * 3600), 8 * 3600);
  assert.throws(() => parseExpiresInSeconds(60), KeyAccessError);
  assert.throws(() => parseExpiresInSeconds(400 * 86400), KeyAccessError);
  assert.throws(() => parseExpiresInSeconds("8h"), KeyAccessError);
});

test("isKeyExpired", () => {
  assert.equal(isKeyExpired(null, 1000), false);
  assert.equal(isKeyExpired(undefined, 1000), false);
  assert.equal(isKeyExpired(999, 1000), true);
  assert.equal(isKeyExpired(1000, 1000), true);
  assert.equal(isKeyExpired(1001, 1000), false);
});

test("restrictSnapshot filters rows and re-renders body and ETag", () => {
  const full = buildSnapshot([
    { id: "a", data: { name: "A", status: "online", folder: "Clients/Acme", orderIndex: 1 } },
    { id: "b", data: { name: "B", status: "offline", folder: "Personal", orderIndex: 2 } },
  ], 0);
  const restricted = restrictSnapshot(full, (id, folder) => canAccessCheck({ checkIds: [], folders: ["Clients"] }, id, folder));
  const parsed = JSON.parse(restricted.body);
  assert.deepEqual(parsed.data.map((e: { id: string }) => e.id), ["a"]);
  assert.equal(parsed.meta.total, 1);
  assert.notEqual(restricted.etag, full.etag);
  assert.equal(full.rows.size, 2, "the shared snapshot is not mutated");
  assert.equal("folder" in parsed.data[0], false, "folder stays out of the status body");
});

test("folderPathError mirrors the app's limits", () => {
  assert.equal(folderPathError("Clients/Acme"), null);
  assert.ok(folderPathError("a/b/c/d/e/f/g/h/i/j/k"));
  assert.ok(folderPathError("x".repeat(49)));
});
