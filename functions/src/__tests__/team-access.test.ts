import test from "node:test";
import assert from "node:assert/strict";

import { decideAccountAccess, membershipId, requestedAccountIdOf } from "../team-access";

const OWNER = "user_owner";
const MEMBER = "user_member";

test("no accountId means the caller's own account", () => {
  const d = decideAccountAccess({ actorUid: MEMBER, requestedAccountId: null, membership: null, ownerTier: null, need: "write" });
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.context.accountId, MEMBER);
    assert.equal(d.context.role, "owner");
    assert.equal(d.context.isMember, false);
  }
});

test("asking for your own account is the owner path", () => {
  const d = decideAccountAccess({ actorUid: OWNER, requestedAccountId: OWNER, membership: null, ownerTier: "free", need: "write" });
  assert.equal(d.ok, true);
});

test("an editor can write in a Pro owner's account", () => {
  const d = decideAccountAccess({ actorUid: MEMBER, requestedAccountId: OWNER, membership: { role: "editor" }, ownerTier: "pro", need: "write" });
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.context.accountId, OWNER);
    assert.equal(d.context.actorUid, MEMBER);
    assert.equal(d.context.role, "editor");
    assert.equal(d.context.isMember, true);
  }
});

test("a viewer can read but not write", () => {
  const read = decideAccountAccess({ actorUid: MEMBER, requestedAccountId: OWNER, membership: { role: "viewer" }, ownerTier: "pro", need: "read" });
  assert.equal(read.ok, true);
  const write = decideAccountAccess({ actorUid: MEMBER, requestedAccountId: OWNER, membership: { role: "viewer" }, ownerTier: "pro", need: "write" });
  assert.equal(write.ok, false);
  if (!write.ok) assert.equal(write.code, "permission-denied");
});

test("no membership is denied", () => {
  const d = decideAccountAccess({ actorUid: MEMBER, requestedAccountId: OWNER, membership: null, ownerTier: "pro", need: "read" });
  assert.equal(d.ok, false);
});

test("membership stops working when the owner leaves Pro", () => {
  for (const tier of ["nano", "indie", "free", null]) {
    const d = decideAccountAccess({ actorUid: MEMBER, requestedAccountId: OWNER, membership: { role: "editor" }, ownerTier: tier, need: "read" });
    assert.equal(d.ok, false, `tier ${tier}`);
  }
});

test("an unknown stored role falls back to viewer, never editor", () => {
  const d = decideAccountAccess({
    actorUid: MEMBER,
    requestedAccountId: OWNER,
    membership: { role: "admin" as never },
    ownerTier: "pro",
    need: "write",
  });
  assert.equal(d.ok, false);
});

test("requestedAccountIdOf reads only a non-empty string accountId", () => {
  assert.equal(requestedAccountIdOf({ accountId: " user_x " }), "user_x");
  assert.equal(requestedAccountIdOf({ accountId: "" }), null);
  assert.equal(requestedAccountIdOf({ accountId: 42 }), null);
  assert.equal(requestedAccountIdOf(null), null);
  assert.equal(requestedAccountIdOf("user_x"), null);
});

test("membershipId matches the id the Firestore rules look up", () => {
  assert.equal(membershipId(OWNER, MEMBER), "user_owner_user_member");
});
