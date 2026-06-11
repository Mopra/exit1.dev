import test from "node:test";
import assert from "node:assert/strict";

import { makeRequireAdmin } from "../require-admin";

const expectPermissionDenied = async (fn: () => Promise<void>) => {
  await assert.rejects(fn, (err: { code?: string; message?: string }) => {
    assert.equal(err.code, "permission-denied");
    assert.match(err.message ?? "", /Admin access required/);
    return true;
  });
};

test("requireAdmin resolves for an admin user", async () => {
  const requireAdmin = makeRequireAdmin(async () => true);
  await requireAdmin("user_admin");
});

test("requireAdmin throws permission-denied for a non-admin user", async () => {
  const requireAdmin = makeRequireAdmin(async () => false);
  await expectPermissionDenied(() => requireAdmin("user_pleb"));
});

test("requireAdmin fails closed when the admin check itself errors", async () => {
  const requireAdmin = makeRequireAdmin(async () => {
    throw new Error("clerk unreachable");
  });
  await expectPermissionDenied(() => requireAdmin("user_any"));
});

test("requireAdmin passes the caller uid to the checker", async () => {
  let seen: string | null = null;
  const requireAdmin = makeRequireAdmin(async (uid) => {
    seen = uid;
    return true;
  });
  await requireAdmin("user_123");
  assert.equal(seen, "user_123");
});
